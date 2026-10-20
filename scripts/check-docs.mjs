import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath, mkdtemp, mkdir, writeFile, rename, link, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_LINK_CANDIDATES = 10000;
const privatePath = /(?:^|\/)(?:node_modules|reports|captures|\.device-hub|\.git|\.venv|__pycache__|runtime|snapshots|work|outputs)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.local\.json|\.(?:sqlite(?:-wal|-shm)?|db|pem|key|bin|log)$|LOCAL-LAB|(?:^|\/)probe-[^/]+|third_party\/slopbro\//i;
const publicDocument = /^(?:(?:AGENTS|README|CONTRIBUTING|SECURITY|THIRD_PARTY_NOTICES|CHANGELOG)(?:\.[A-Za-z-]+)?\.md|docs\/[A-Za-z0-9_./-]+\.md|optional\/[A-Za-z0-9_-]+\/README\.md|\.github\/[A-Za-z0-9_./-]+\.md)$/;
const publicSource = /^(?:[A-Za-z0-9_.-]+|(?:\.github|lib|docs|profiles|schema|scripts|test|optional|integrations|third_party|privileged-probe)\/[A-Za-z0-9_./-]+)$/;
const unescape = value => value.replace(/\\([\\`*{}\[\]()#+.!_<> -])/g, '$1');
const entities = value => value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, item => {
  const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
  if (named[item.toLowerCase()]) return named[item.toLowerCase()];
  const number = /^&#x/i.test(item) ? parseInt(item.slice(3, -1), 16) : parseInt(item.slice(2, -1), 10);
  return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : item;
});
const PARSE_LIMIT = 'Public document exceeds the bounded Markdown parser work limit.';
function workBudget(length) {
  let remaining = 16 * length + 4096;
  return (count = 1) => { if ((remaining -= count) < 0) throw new Error(PARSE_LIMIT); };
}
function escapeFlags(text, consume) {
  const flags = new Uint8Array(text.length);
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    consume(); flags[index] = Number(escaped);
    escaped = text[index] === '\\' ? !escaped : false;
  }
  return flags;
}
function bracketPairs(text, flags, consume) {
  const pairs = new Int32Array(text.length).fill(-1), stack = [];
  let candidates = 0;
  for (let index = 0; index < text.length; index++) {
    consume();
    if (flags[index]) continue;
    if (text[index] === '[') {
      if (++candidates > MAX_LINK_CANDIDATES) throw new Error('Public document has too many link candidates.');
      stack.push(index);
    } else if (text[index] === ']' && stack.length) {
      const start = stack.pop(); pairs[start] = index; pairs[index] = start;
    }
  }
  return pairs;
}
function withoutInlineCode(text, consume) {
  const flags = escapeFlags(text, consume), runs = [], next = new Map();
  for (let index = 0; index < text.length;) {
    consume();
    if (text[index] !== '`' || flags[index]) { index++; continue; }
    const start = index++;
    while (text[index] === '`') { consume(); index++; }
    runs.push({ start, end: index, length: index - start });
  }
  for (let index = runs.length - 1; index >= 0; index--) {
    consume(); runs[index].next = next.get(runs[index].length); next.set(runs[index].length, index);
  }
  const output = text.split('');
  for (let index = 0; index < runs.length; index++) {
    consume();
    const closing = runs[index].next;
    if (closing === undefined) continue;
    for (let cursor = runs[index].start; cursor < runs[closing].end; cursor++) {
      consume(); if (output[cursor] !== '\n') output[cursor] = ' ';
    }
    index = closing;
  }
  return output.join('');
}
function htmlTags(text, consume) {
  const result = [];
  for (let index = 0; index < text.length; index++) {
    consume();
    if (text[index] !== '<') continue;
    const start = index;
    while (++index < text.length && text[index] !== '>') {
      consume();
      if (index - start > 4096) throw new Error(PARSE_LIMIT);
    }
    if (index < text.length) result.push({ start, end: index + 1, value: text.slice(start, index + 1) });
  }
  return result;
}

function headingText(value, consume) {
  let withoutTags = '', previous = 0;
  for (const tag of htmlTags(value, consume)) {
    withoutTags += value.slice(previous, tag.start); previous = tag.end;
  }
  withoutTags += value.slice(previous);
  const flags = escapeFlags(withoutTags, consume), pairs = bracketPairs(withoutTags, flags, consume);
  let result = '';
  for (let index = 0; index < withoutTags.length; index++) {
    consume();
    const close = pairs[index];
    if (withoutTags[index] === '[' && !flags[index] && close > index && withoutTags[close + 1] === '(') {
      let cursor = close + 2, nested = 0;
      for (; cursor < withoutTags.length; cursor++) {
        consume(); if (flags[cursor]) continue;
        if (withoutTags[cursor] === '(') nested++;
        else if (withoutTags[cursor] === ')') { if (!nested) break; nested--; }
      }
      if (cursor < withoutTags.length) {
        consume(close - index); result += withoutTags.slice(index + 1, close); index = cursor; continue;
      }
    }
    result += withoutTags[index];
  }
  return result;
}

function withoutFences(source) {
  let fence = null;
  return source.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker && !fence) { fence = marker[1]; return ''; }
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) fence = null;
      return '';
    }
    return line;
  }).join('\n');
}

function anchors(source) {
  const visible = withoutFences(source);
  const consume = workBudget(visible.length);
  const found = new Set();
  for (const tag of htmlTags(visible, consume)) {
    const match = /\s(?:id|name)\s*=\s*["']([^"']+)["']/i.exec(tag.value);
    if (match) found.add(entities(match[1]));
  }
  const used = new Set(), suffixes = new Map();
  const lines = visible.split('\n');
  for (let index = 0; index < lines.length; index++) {
    consume(lines[index].length);
    const atx = /^ {0,3}#{1,6}(?:[ \t]+|$)/.exec(lines[index]);
    const setext = index + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1]) && lines[index].trim();
    if (!atx && !setext) continue;
    let raw = atx ? lines[index].slice(atx[0].length) : lines[index];
    let end = raw.length;
    while (end > 0 && /[ \t]/.test(raw[end - 1])) { consume(); end--; }
    const trimmed = end;
    while (end > 0 && raw[end - 1] === '#') { consume(); end--; }
    if (end < trimmed && end > 0 && /[ \t]/.test(raw[end - 1])) {
      while (end > 0 && /[ \t]/.test(raw[end - 1])) { consume(); end--; }
      raw = raw.slice(0, end);
    } else raw = raw.slice(0, trimmed);
    const title = entities(unescape(headingText(raw, consume)))
      .toLowerCase().replace(/[\p{P}\p{S}]/gu, character => /[-_]/.test(character) ? character : '').replace(/\s/g, '-');
    let slug = title;
    let suffix = suffixes.get(title) ?? 0;
    while (used.has(slug)) { consume(title.length + 1); slug = title + '-' + ++suffix; }
    suffixes.set(title, suffix);
    used.add(slug); found.add(slug);
    if (setext && !atx) index++;
  }
  return found;
}

function links(source) {
  // Preserve line breaks for diagnostics. Examples in fenced/inline code are not links.
  const fenced = withoutFences(source), consume = workBudget(fenced.length);
  const visible = withoutInlineCode(fenced, consume);
  const flags = escapeFlags(visible, consume);
  const lineNumbers = new Uint32Array(visible.length + 1);
  for (let index = 0, line = 1; index <= visible.length; index++) {
    consume(); lineNumbers[index] = line; if (visible[index] === '\n') line++;
  }
  const references = new Map();
  const labelKey = label => { consume(label.length); return unescape(label).trim().replace(/\s+/g, ' ').toLowerCase(); };
  const result = [];
  const add = (destination, index) => {
    consume(destination.length); result.push({ destination: unescape(entities(destination)), line: lineNumbers[index] });
  };
  for (const match of visible.matchAll(/^ {0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|(\S+))/gm)) {
    const destination = match[2] ?? match[3];
    references.set(labelKey(match[1]), destination); add(destination, match.index);
  }
  const text = visible.replace(/^ {0,3}\[[^\]\n]+\]:[^\n]*/gm, value => ' '.repeat(value.length));
  const pairs = bracketPairs(text, flags, consume);
  for (let index = 0; index < text.length; index++) {
    consume();
    if (text[index] !== '[' || flags[index] || pairs[index] < index) continue;
    const end = pairs[index];
    let after = end + 1;
    while (/[ \t\n]/.test(text[after] ?? '') && after < text.length) { consume(); after++; }
    if (text[after] === '(') {
      let cursor = after + 1;
      while (/\s/.test(text[cursor] ?? '') && cursor < text.length) { consume(); cursor++; }
      if (text[cursor] === '<') {
        const start = ++cursor;
        while (cursor < text.length && text[cursor] !== '>') { consume(); cursor++; }
        if (cursor < text.length) add(text.slice(start, cursor), index);
      } else {
        const start = cursor; let nested = 0;
        for (; cursor < text.length; cursor++) {
          consume(); if (flags[cursor]) continue;
          if (text[cursor] === '(') nested++;
          else if (text[cursor] === ')') { if (!nested) break; nested--; }
          else if (/\s/.test(text[cursor]) && !nested) break;
        }
        if (cursor < text.length) add(text.slice(start, cursor), index);
      }
    } else if (text[after] === '[') {
      const close = pairs[after];
      if (close > after) {
        consume(close - after + end - index);
        const key = labelKey(text.slice(after + 1, close) || text.slice(index + 1, end));
        if (references.has(key)) add(references.get(key), index);
        else result.push({ destination: null, missingReference: key, line: lineNumbers[index] });
      }
    } else {
      consume(end - index);
      const key = labelKey(text.slice(index + 1, end));
      if (references.has(key)) add(references.get(key), index);
    }
  }
  for (const tag of htmlTags(visible, consume)) {
    if (!/^<(?:a|img)\b/i.test(tag.value)) continue;
    const match = /\s(?:href|src)\s*=\s*["']([^"']+)["']/i.exec(tag.value);
    if (match) add(match[1], tag.start);
  }
  return result;
}

function localTarget(document, destination) {
  if (!destination || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination)) return null;
  // Template examples are not repository paths. They are never opened.
  if (/[<>]|\{\{.*\}\}|\$\{.*\}/.test(destination)) return null;
  let decoded;
  try { decoded = decodeURIComponent(destination); } catch { return { error: 'invalid URL encoding' }; }
  if (decoded.includes('\\') || decoded.includes('\0')) return { error: 'non-portable local path' };
  const hash = decoded.indexOf('#');
  const fragment = hash < 0 ? '' : decoded.slice(hash + 1);
  const pathname = (hash < 0 ? decoded : decoded.slice(0, hash)).split('?')[0];
  const target = pathname ? path.posix.normalize(pathname.startsWith('/') ? pathname.slice(1) : path.posix.join(path.posix.dirname(document), pathname)) : document;
  if (target === '..' || target.startsWith('../') || privatePath.test(target)) return { error: 'outside public source boundary' };
  return { target: target.replace(/\/$/, ''), fragment };
}

function verifyLink(document, link, inventory, anchorMap) {
  if (link.missingReference) return 'missing link reference [' + link.missingReference + ']';
  const target = localTarget(document, link.destination);
  if (!target) return null;
  if (target.error) return target.error;
  if (!inventory.has(target.target) && ![...inventory].some(name => name.startsWith(target.target + '/'))) return 'missing public target';
  if (target.fragment && /\.mdx?$/i.test(target.target)) {
    if (!anchorMap.has(target.target)) return 'target Markdown is outside checked public documents';
    if (!anchorMap.get(target.target).has(target.fragment)) return 'missing heading/HTML anchor';
  } else if (target.fragment && !/^L\d+(?:-L\d+)?$/.test(target.fragment)) {
    // Other file formats can have their own fragment semantics; existence is checked only.
    return null;
  }
  return null;
}

const READ_FAILURE = 'Cannot safely read a public document.';
const regularDocument = stat => stat.isFile() && !stat.isSymbolicLink() && stat.ino > 0n && stat.nlink === 1n && stat.size <= BigInt(MAX_DOCUMENT_BYTES);
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
async function readPublicDocument(absolute, resolvedRoot, hooks = {}) {
  let handle;
  try {
    const relative = path.relative(resolvedRoot, absolute);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error();
    // Nonblocking also prevents a swapped POSIX FIFO from stalling before fstat.
    // Opening is read-only: no bytes are read before all descriptor/path checks.
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    await hooks.afterOpen?.();
    const opened = await handle.stat({ bigint: true });
    const current = await lstat(absolute, { bigint: true });
    const currentResolved = await realpath(absolute);
    // Validate the already opened inode against its canonical public path before
    // reading. This also rejects leaf/ancestor swaps without O_NOFOLLOW support.
    if (!regularDocument(opened) || !regularDocument(current) || !sameFile(current, opened) ||
        path.relative(resolvedRoot, currentResolved) !== relative) throw new Error();
    await hooks.beforeRead?.();
    const bytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const chunk = await handle.read(bytes, size, bytes.length - size, size);
      hooks.onRead?.(chunk.bytesRead);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    if (size > MAX_DOCUMENT_BYTES) throw new Error();
    const final = await handle.stat({ bigint: true });
    if (!regularDocument(final) || !sameFile(opened, final) || final.size !== BigInt(size)) throw new Error();
    return bytes.toString('utf8', 0, size);
  } catch {
    // Do not reflect absolute paths, OS error text, replacement bytes or hook errors.
    throw new Error(READ_FAILURE);
  } finally {
    if (handle) {
      try { await handle.close(); } catch { throw new Error(READ_FAILURE); }
    }
  }
}

async function descriptorSelfTest() {
  const tempBase = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(tempBase, 'anyadapter-doc-check-'));
  const fixtureRoot = await realpath(directory);
  const marker = 'private-synthetic-doc-bytes-not-for-output';
  const rejectsSafely = error => error.message === READ_FAILURE && !error.message.includes(marker) && !error.message.includes(directory);
  let serial = 0, symlinkSkipped = false;
  async function fixture() {
    const home = path.join(directory, 'case-' + ++serial);
    await mkdir(home);
    const target = path.join(home, 'guide.md'), replacement = path.join(home, 'replacement.md');
    await writeFile(target, '# Public fixture\n'); await writeFile(replacement, marker);
    return { home, target, replacement };
  }
  try {
    const stable = await fixture();
    assert.equal(await readPublicDocument(stable.target, fixtureRoot), '# Public fixture\n');
    {
      const item = await fixture(); let reads = 0;
      await assert.rejects(readPublicDocument(item.target, fixtureRoot, {
        afterOpen: async () => { await rename(item.target, item.target + '.old'); await rename(item.replacement, item.target); },
        beforeRead: () => { reads++; },
      }), rejectsSafely);
      assert.equal(reads, 0);
    }
    const hardlinked = await fixture();
    await link(hardlinked.target, hardlinked.target + '.hardlink');
    await assert.rejects(readPublicDocument(hardlinked.target, fixtureRoot), rejectsSafely);
    const linked = await fixture();
    try { await symlink(linked.replacement, linked.target + '.symlink', 'file'); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) symlinkSkipped = true; else throw error; }
    if (!symlinkSkipped) await assert.rejects(readPublicDocument(linked.target + '.symlink', fixtureRoot), rejectsSafely);
    const oversized = await fixture(); let openedOversize = false, readOversize = false;
    await writeFile(oversized.target, Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 120));
    await assert.rejects(readPublicDocument(oversized.target, fixtureRoot, {
      afterOpen: () => { openedOversize = true; },
      beforeRead: () => { readOversize = true; },
    }), rejectsSafely);
    assert.equal(openedOversize, true);
    assert.equal(readOversize, false);
    {
      const item = await fixture(); let reads = 0;
      const other = path.join(directory, 'other-' + serial); await mkdir(other); await writeFile(path.join(other, 'guide.md'), marker);
      await assert.rejects(readPublicDocument(item.target, fixtureRoot, {
        afterOpen: async () => { await rename(item.home, item.home + '.old'); await symlink(other, item.home, process.platform === 'win32' ? 'junction' : 'dir'); },
        beforeRead: () => { reads++; },
      }), rejectsSafely);
      assert.equal(reads, 0);
    }
    const growth = await fixture(); let bytesRead = 0;
    await assert.rejects(readPublicDocument(growth.target, fixtureRoot, {
      beforeRead: () => writeFile(growth.target, Buffer.alloc(MAX_DOCUMENT_BYTES + 128, 120)),
      onRead: count => { bytesRead += count; },
    }), rejectsSafely);
    assert.equal(bytesRead, MAX_DOCUMENT_BYTES + 1);
    const descriptor = await fixture();
    assert.equal(await readPublicDocument(descriptor.target, fixtureRoot, {
      beforeRead: async () => { await rename(descriptor.target, descriptor.target + '.old'); await rename(descriptor.replacement, descriptor.target); },
    }), '# Public fixture\n');
  } finally {
    // Remove only this fresh, resolved fixture directory under the OS temp root.
    if (path.dirname(fixtureRoot) !== tempBase || !path.basename(fixtureRoot).startsWith('anyadapter-doc-check-')) throw new Error('Invalid temporary fixture directory.');
    await rm(fixtureRoot, { recursive: true, force: true });
  }
  return { symlinkSkipped };
}

function selfTest() {
  // A filesystem without a usable file identity cannot validate replacements.
  assert.equal(regularDocument({ isFile: () => true, isSymbolicLink: () => false, ino: 0n, nlink: 1n, size: 1n }), false);
  const source = '# Hello, *World*!\n## 重复标题\n## 重复标题\n<a id="manual"></a>\n```md\n[ignored](missing.md)\n# hidden\n```\n[one](guide.md#hello-world) ![image](image.svg) [ref][guide]\n[guide]: guide.md#manual\n`[literal](missing.md)`\n[escaped](a\\(b\\).md)\n';
  const found = anchors(source);
  for (const value of ['hello-world', '重复标题', '重复标题-1', 'manual']) assert.ok(found.has(value));
  assert.ok(!found.has('hidden'));
  assert.ok(!links(source).some(link => link.destination === 'missing.md'));
  assert.ok(links(source).some(link => link.destination === 'a(b).md'));
  assert.ok(links('[caption](<guide.md#manual> "title")').some(link => link.destination === 'guide.md#manual'));
  assert.ok(links('[shortcut]\n[shortcut]: guide.md#manual').some(link => link.destination === 'guide.md#manual'));
  assert.ok(links('<img src="image.svg">').some(link => link.destination === 'image.svg'));
  assert.ok(anchors('Underlined\n==========\n# Hello-World\n# Hello World\n# Hello World').has('hello-world-2'));
  const inventory = new Set(['docs/guide.md', 'docs/image.svg', 'lib/code.mjs']);
  const map = new Map([['docs/guide.md', found]]);
  const check = destination => verifyLink('docs/guide.md', { destination }, inventory, map);
  assert.equal(check('#hello-world'), null);
  assert.equal(check('guide.md#%E9%87%8D%E5%A4%8D%E6%A0%87%E9%A2%98-1'), null);
  assert.equal(check('../lib/code.mjs#L10-L20'), null);
  assert.equal(check('image.svg'), null);
  assert.equal(check('/docs/guide.md#manual'), null);
  assert.equal(check('image-missing.svg'), 'missing public target');
  assert.equal(check('https://example.invalid/missing'), null);
  assert.equal(check('<EXAMPLE_PATH>'), null);
  assert.equal(check('guide.md#no-such-heading'), 'missing heading/HTML anchor');
  assert.equal(check('missing.md'), 'missing public target');
  assert.equal(check('../.device-hub/owner.json'), 'outside public source boundary');
  assert.equal(check('../reports/private.md'), 'outside public source boundary');
  assert.equal(check('../.lg-tv.local.json'), 'outside public source boundary');
  assert.equal(check('../../outside.md'), 'outside public source boundary');
  assert.ok(publicDocument.test('CONTRIBUTING.zh-CN.md'));
  assert.ok(publicDocument.test('CHANGELOG.md'));
  assert.ok(!publicDocument.test('LOCAL-LAB.md'));
  assert.equal(verifyLink('docs/guide.md', { missingReference: 'bad' }, inventory, map), 'missing link reference [bad]');

  // Untrusted PR text must not turn malformed Markdown into quadratic rescans.
  // These values are synthetic and are never included in parser error output.
  const marker = 'private-fixture-value-must-not-be-reflected';
  assert.deepEqual(links('['.repeat(MAX_LINK_CANDIDATES) + 'x'.repeat(256 * 1024)), []);
  const escapedDestination = links('[fixture](' + '\\'.repeat(256 * 1024) + 'fixture.md)');
  assert.equal(escapedDestination.length, 1);
  assert.ok(escapedDestination[0].destination.endsWith('fixture.md'));
  assert.throws(() => links('['.repeat(MAX_LINK_CANDIDATES + 1)), error => error.message === 'Public document has too many link candidates.');
  const boundedFailure = error => error.message === PARSE_LIMIT && !error.message.includes(marker);
  assert.throws(() => links('[fixture]('.repeat(512) + '('.repeat(256 * 1024) + marker), boundedFailure);
  assert.throws(() => links('[fixture](<'.repeat(512) + 'x'.repeat(256 * 1024) + marker), boundedFailure);
  assert.throws(() => links('<'.repeat(8192) + marker), boundedFailure);
  assert.throws(() => anchors('# ' + '['.repeat(512) + 'fixture]('.repeat(512) + '('.repeat(256 * 1024) + marker), boundedFailure);
}

async function main() {
  selfTest();
  const descriptorTests = await descriptorSelfTest();
  if (descriptorTests.symlinkSkipped) console.log('Leaf file-symlink test skipped: this OS account cannot create file symlinks; ancestor junction tests passed.');
  if (process.argv.includes('--self-test')) {
    console.log('Documentation parser, public-boundary and descriptor race/size self-tests passed.');
    return;
  }
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean);
  const entries = git(['ls-files', '--stage', '-z']);
  const inventory = new Set(); const documents = new Set();
  for (const entry of entries) {
    const match = /^(\d+) [a-f0-9]+ \d\t(.+)$/s.exec(entry);
    if (!match || !publicSource.test(match[2]) || privatePath.test(match[2])) continue;
    if (!['100644', '100755'].includes(match[1])) throw new Error('Public links cannot target Git links/submodules: ' + match[2]);
    inventory.add(match[2]); if (publicDocument.test(match[2])) documents.add(match[2]);
  }
  // Include only explicit public documentation/source trees, never ignored local files.
  for (const name of git(['ls-files', '--others', '--exclude-standard', '-z', '--', 'docs', '.github', 'optional', 'scripts', 'AGENTS.md', 'README*.md', 'CONTRIBUTING*.md', 'SECURITY*.md', 'THIRD_PARTY_NOTICES*.md', 'CHANGELOG*.md'])) {
    if (!publicSource.test(name) || privatePath.test(name)) continue;
    inventory.add(name); if (publicDocument.test(name)) documents.add(name);
  }
  if (!documents.size) throw new Error('No public Markdown files were found.');
  const sourceMap = new Map(); const anchorMap = new Map();
  const resolvedRoot = await realpath(root);
  for (const name of inventory) {
    let stat;
    try { stat = await lstat(path.join(root, ...name.split('/'))); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot inspect public source target: ' + name);
      inventory.delete(name); documents.delete(name); continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing nonregular public source target: ' + name);
  }
  for (const name of [...documents].sort()) {
    const absolute = path.join(root, ...name.split('/'));
    const source = await readPublicDocument(absolute, resolvedRoot);
    sourceMap.set(name, source); anchorMap.set(name, anchors(source));
  }
  const failures = []; let count = 0;
  for (const [name, source] of sourceMap) for (const link of links(source)) {
    count++;
    const error = verifyLink(name, link, inventory, anchorMap);
    if (error) failures.push(`${name}:${link.line}: ${error}: ${(link.destination ?? link.missingReference).slice(0, 240)}`);
  }
  if (failures.length) throw new Error('Documentation links failed:\n' + failures.join('\n'));
  console.log(`Documentation checked: ${documents.size} public Markdown files, ${count} links; local targets and Markdown anchors resolve.`);
  console.log('Offline only: external URLs, CLI behavior and factual support claims require separate review. Profile evidence is validated by check:profiles.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
