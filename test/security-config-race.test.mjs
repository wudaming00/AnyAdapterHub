import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readJson } from '../lib/hub/config.mjs';

// Only temporary fixture files are touched. Updating the built-in export keeps
// the production named import intact while making a specific race deterministic.
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'anyadapter-config-race-'));
  const file = path.join(directory, 'config.json');
  const replacement = path.join(directory, 'replacement.json');
  await fs.writeFile(file, '{"fixture":"selected"}');
  await fs.writeFile(replacement, '{"fixture":"substituted"}');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file, replacement, old: path.join(directory, 'old.json') };
}

function interceptOpen(t, hook) {
  const original = fs.open;
  const mocked = t.mock.method(fs, 'open', async (...args) => hook(original, ...args));
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
}

test('stable configuration is read from the verified open file handle', async t => {
  const f = await fixture(t);
  assert.deepEqual(await readJson(f.file), { fixture: 'selected' });
});

test('configuration opens only for reading with nonblocking/no-follow guards and explicit private mode', async t => {
  const f = await fixture(t); let opens = 0;
  interceptOpen(t, async (original, file, flags, mode) => {
    if (file === f.file) {
      opens++;
      assert.equal(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND), 0);
      assert.equal(flags & (constants.O_NOFOLLOW ?? 0), constants.O_NOFOLLOW ?? 0);
      assert.equal(flags & (constants.O_NONBLOCK ?? 0), constants.O_NONBLOCK ?? 0);
      assert.equal(mode, 0o600);
    }
    return original(file, flags, mode);
  });
  assert.deepEqual(await readJson(f.file), { fixture: 'selected' });
  assert.equal(opens, 1);
});

test('a missing configuration cannot create or chmod a file', async t => {
  const f = await fixture(t), missing = path.join(f.directory, 'missing.json');
  await assert.rejects(readJson(missing), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(missing), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['config.json', 'replacement.json']);
});

test('configuration hard links and directories are rejected before reading bytes', async t => {
  const f = await fixture(t), linked = path.join(f.directory, 'hardlink.json');
  await fs.link(f.file, linked);
  for (const file of [f.file, linked]) await assert.rejects(readJson(file), { code: 'HUB_HOME_UNSAFE' });
  await assert.rejects(readJson(f.directory));
  assert.equal(await fs.readFile(f.file, 'utf8'), '{"fixture":"selected"}');
});

test('a FIFO configuration is rejected within a bounded child instead of waiting for a writer', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), fifo = path.join(f.directory, 'fixture.fifo');
  execFileSync('mkfifo', [fifo], { shell: false, timeout: 3000, stdio: 'pipe' });
  const source = `import { readJson } from ${JSON.stringify(pathToFileURL(path.resolve('lib/hub/config.mjs')).href)};
    try { await readJson(process.argv[1]); process.exitCode = 2; }
    catch (error) { if (error.code !== 'HUB_HOME_UNSAFE') throw error; }`;
  execFileSync(process.execPath, ['--input-type=module', '-e', source, fifo], { shell: false, timeout: 5000, stdio: 'pipe' });
  assert.equal((await fs.lstat(fifo)).isFIFO(), true);
});

test('replacement after opening but before the final path check is rejected without reading', async t => {
  const f = await fixture(t); let reads = 0;
  interceptOpen(t, async (original, file, ...args) => {
    const handle = await original(file, ...args);
    if (file !== f.file) return handle;
    const stat = handle.stat.bind(handle), read = handle.read.bind(handle);
    handle.stat = async () => {
      const info = await stat();
      await fs.rename(f.file, f.old); await fs.rename(f.replacement, f.file);
      return info;
    };
    handle.read = (...values) => { reads++; return read(...values); };
    return handle;
  });
  await assert.rejects(readJson(f.file), { code: 'HUB_HOME_UNSAFE' });
  assert.equal(reads, 0);
});

test('a pre-existing symbolic configuration link is refused', async t => {
  const f = await fixture(t); const link = path.join(f.directory, 'linked.json');
  try { await fs.symlink(f.file, link, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('File symlinks unavailable for this OS account.'); return; } throw error; }
  await assert.rejects(readJson(link), { code: 'HUB_HOME_UNSAFE' });
});
