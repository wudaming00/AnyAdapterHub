import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Writable } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalMediaHost, byteRange, validateMediaRoots } from '../lib/media-host.mjs';

test('media cleanup has a listener deadline and a late close callback cannot erase failure', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-media-close-bound-'));
  const file = path.join(directory, 'fixture.mp4'); await fs.writeFile(file, 'fixture');
  let callback;
  const host = new LocalMediaHost({ tvHost: '192.168.77.80', bindAddress: '192.168.77.11', mediaRoots: [directory],
    serverFactory: () => {
      const server = new EventEmitter();
      server.listen = (_port, _address, done) => done(); server.address = () => ({ port: 12345 });
      server.close = done => { callback = done; }; return server;
    },
  });
  try {
    await host.serve(file);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const close = host.close(), denied = assert.rejects(close, { code: 'MEDIA_CLEANUP_FAILED' });
    t.mock.timers.tick(2000); await denied;
    callback(); await assert.rejects(host.close(), { code: 'MEDIA_CLEANUP_FAILED' });
  } finally { t.mock.timers.reset(); await fs.unlink(file); await fs.rmdir(directory); }
});

test('concurrent cleanup shares one attempt and a failed close never becomes a false later success', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-media-close-'));
  const file = path.join(directory, 'fixture.mp4'); await fs.writeFile(file, 'fixture');
  let closeCalls = 0, finish;
  const host = new LocalMediaHost({ tvHost: '192.168.77.80', bindAddress: '192.168.77.11', mediaRoots: [directory],
    serverFactory: () => {
      const server = new EventEmitter();
      server.listen = (_port, _address, callback) => callback();
      server.address = () => ({ port: 12345 });
      server.closeAllConnections = () => {};
      server.close = callback => { closeCalls++; finish = callback; };
      return server;
    },
  });
  try {
    await host.serve(file);
    const a = host.close(), b = host.close();
    const deniedA = assert.rejects(a, { code: 'MEDIA_CLEANUP_FAILED' });
    const deniedB = assert.rejects(b, { code: 'MEDIA_CLEANUP_FAILED' });
    assert.equal(closeCalls, 1);
    finish(Error('synthetic listener close failure'));
    await deniedA; await deniedB;
    await assert.rejects(host.close(), { code: 'MEDIA_CLEANUP_FAILED' });
    assert.equal(closeCalls, 1);
    await assert.rejects(host.serve(file), /fresh media host/);
  } finally { await fs.unlink(file); await fs.rmdir(directory); }
});


test('byte ranges support seeking/suffixes and reject invalid, multiple, and beyond-file requests', () => {
  assert.deepEqual(byteRange('bytes=2-4', 10), { start: 2, end: 4, partial: true });
  assert.deepEqual(byteRange('bytes=-3', 10), { start: 7, end: 9, partial: true });
  assert.deepEqual(byteRange('bytes=8-', 10), { start: 8, end: 9, partial: true });
  assert.deepEqual(byteRange('bytes=0-99', 10), { start: 0, end: 9, partial: true });
  for (const value of ['bytes=10-', 'bytes=4-2', 'bytes=-0', 'bytes=0-1,3-5', 'invalid']) assert.equal(byteRange(value, 10), null);
});

test('local file host serves only TV/selected route and valid ranges, then closes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-media-test-'));
  const file = path.join(directory, 'clip.mp4');
  await fs.writeFile(file, '0123456789');
  let handler; let closed = false;
  const host = new LocalMediaHost({ tvHost: '192.168.77.80', bindAddress: '192.168.77.11', mediaRoots: [directory], serverFactory: fn => {
    handler = fn;
    const server = new EventEmitter();
    server.listen = (port, address, done) => { assert.equal(port, 0); assert.equal(address, '192.168.77.11'); done(); };
    server.address = () => ({ port: 12345 });
    server.closeAllConnections = () => {};
    server.close = done => { closed = true; done(); };
    return server;
  } });
  try {
    const result = await host.serve(file);
    assert.equal(result.mimeType, 'video/mp4');
    assert.equal(result.bytes, 10);
    const route = new URL(result.url).pathname;
    async function request({ ip = '192.168.77.80', url = route, method = 'GET', range } = {}) {
      const chunks = [];
      const response = new Writable({ write(chunk, encoding, done) { chunks.push(chunk); done(); } });
      response.writeHead = (status, headers) => { response.status = status; response.headers = headers; };
      const finished = once(response, 'finish');
      handler({ url, method, socket: { remoteAddress: ip }, headers: { range } }, response);
      await finished;
      return { status: response.status, headers: response.headers, body: Buffer.concat(chunks).toString() };
    }
    assert.equal((await request({ ip: '192.168.77.99' })).status, 403);
    assert.equal((await request({ url: '/other-file.mp4' })).status, 404);
    assert.equal((await request({ method: 'POST' })).status, 405);
    assert.equal((await request({ range: 'bytes=20-' })).status, 416);
    const selected = await request({ range: 'bytes=2-4' });
    assert.equal(selected.status, 206); assert.equal(selected.body, '234');
    assert.equal(selected.headers['Content-Range'], 'bytes 2-4/10');
    const head = await request({ method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.body, ''); assert.equal(head.headers['Content-Length'], 10);
    // A later URL request must read the already-open selected file, even if its
    // former name is replaced between requests.
    const original = path.join(directory, 'original.mp4');
    await fs.rename(file, original);
    await fs.writeFile(file, 'replacement-secret');
    assert.equal((await request()).body, '0123456789');
    assert.equal((await request({ range: 'bytes=7-' })).body, '789');
    await fs.unlink(original);
    await host.close(); assert.equal(closed, true); await host.close();
  } finally {
    await host.close(); await fs.unlink(file);
    await fs.rm(path.join(directory, 'original.mp4'), { force: true });
    await fs.rmdir(directory);
  }
});

test('file host rejects unspecified/public hosts, relative files, shares and non-media', async () => {
  assert.throws(() => new LocalMediaHost({ tvHost: '8.8.8.8', bindAddress: '192.168.77.11' }));
  const host = new LocalMediaHost({ tvHost: '192.168.77.80', bindAddress: '192.168.77.11' });
  await assert.rejects(host.serve('relative.mp4'), /absolute local/);
  await assert.rejects(host.serve('\\\\server\\share\\clip.mp4'), /Network shares/);
  await host.close();
});

test('mediaRoots require explicit local directory paths and default to deny', async () => {
  assert.deepEqual(validateMediaRoots(), []);
  for (const roots of ['C:\\media', null, ['relative'], ['\\\\server\\share'], [42], Array(33).fill(path.resolve('media'))]) {
    assert.throws(() => validateMediaRoots(roots), /mediaRoots/);
  }
  const host = new LocalMediaHost({ tvHost: '192.168.77.80', bindAddress: '192.168.77.11' });
  await assert.rejects(host.serve(path.resolve('clip.mp4')), /explicitly configured mediaRoots/);
  await host.close();
});

test('media host rejects rounded 64-bit identity collisions before starting a listener and closes the file', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-media-inode-'));
  const file = path.join(directory, 'fixture.mp4'); await fs.writeFile(file, 'synthetic');
  const selectedFile = await fs.realpath(file);
  const before = 9007199254740992n, opened = before + 1n;
  assert.equal(Number(before), Number(opened));
  let listeners = 0, closes = 0;
  const originalStat = fs.stat, originalOpen = fs.open;
  t.mock.method(fs, 'stat', async (target, options) => {
    const info = await originalStat(target, options); if (target === selectedFile) info.ino = options?.bigint ? before : Number(before); return info;
  });
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args); if (args[0] !== selectedFile) return handle;
    const stat = handle.stat.bind(handle), close = handle.close.bind(handle);
    handle.stat = async options => { const info = await stat(options); info.ino = options?.bigint ? opened : Number(opened); return info; };
    handle.close = async () => { closes++; return close(); }; return handle;
  });
  const host = new LocalMediaHost({ tvHost: '192.168.77.80', bindAddress: '192.168.77.11', mediaRoots: [directory],
    serverFactory: () => { listeners++; throw new Error('A changed file cannot start a listener.'); } });
  try {
    await assert.rejects(host.serve(file), /regular media file/);
    assert.equal(listeners, 0); assert.equal(closes, 1);
    await host.close(); assert.equal(closes, 1);
  } finally { await host.close(); await fs.unlink(file); await fs.rmdir(directory); }
});

test('media files must resolve inside approved directories and cannot override extension MIME types', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-media-policy-'));
  const root = path.join(directory, 'allowed');
  const sibling = path.join(directory, 'allowed-extra');
  await fs.mkdir(root); await fs.mkdir(sibling);
  const files = [path.join(root, 'credentials.json'), path.join(root, 'clip.mp4'),
    path.join(sibling, 'outside.mp4'), path.join(root, 'unknown.bin')];
  for (const file of files) await fs.writeFile(file, 'fixture-only');
  const host = new LocalMediaHost({ tvHost: '192.168.77.80', bindAddress: '192.168.77.11', mediaRoots: [root],
    serverFactory: () => assert.fail('Forbidden media must not start a listener') });
  try {
    await assert.rejects(host.serve(files[0], { mimeType: 'video/mp4' }), /extension/);
    await assert.rejects(host.serve(files[1], { mimeType: 'audio/mpeg' }), /extension/);
    await assert.rejects(host.serve(files[2]), /approved mediaRoots/);
    await assert.rejects(host.serve(files[3], { mimeType: 'video/mp4' }), /extension/);
  } finally {
    await host.close();
    for (const file of files) await fs.unlink(file);
    await fs.rmdir(root); await fs.rmdir(sibling); await fs.rmdir(directory);
  }
});

test('directory links cannot escape approved mediaRoots', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-media-link-'));
  const root = path.join(directory, 'allowed');
  const outside = path.join(directory, 'outside');
  const link = path.join(root, 'shortcut');
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'clip.mp4'), 'private-fixture');
  let linked = false;
  const host = new LocalMediaHost({ tvHost: '192.168.77.80', bindAddress: '192.168.77.11', mediaRoots: [root],
    serverFactory: () => assert.fail('Escaping links must not start a listener') });
  try {
    try { await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); linked = true; }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Directory links are unavailable in this environment.'); return; } throw error; }
    await assert.rejects(host.serve(path.join(link, 'clip.mp4')), /approved mediaRoots/);
  } finally {
    await host.close();
    if (linked) await fs.unlink(link);
    await fs.unlink(path.join(outside, 'clip.mp4'));
    await fs.rmdir(root); await fs.rmdir(outside); await fs.rmdir(directory);
  }
});
