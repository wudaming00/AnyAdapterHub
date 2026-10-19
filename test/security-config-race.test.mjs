import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
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

test('replacement between initial lstat and open is rejected before any file bytes are read', async t => {
  const f = await fixture(t); let reads = 0;
  interceptOpen(t, async (original, file, ...args) => {
    if (file !== f.file) return original(file, ...args);
    await fs.rename(f.file, f.old); await fs.rename(f.replacement, f.file);
    const handle = await original(file, ...args);
    const read = handle.read.bind(handle);
    handle.read = (...values) => { reads++; return read(...values); };
    return handle;
  });
  await assert.rejects(readJson(f.file), { code: 'HUB_HOME_UNSAFE' });
  assert.equal(reads, 0);
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
