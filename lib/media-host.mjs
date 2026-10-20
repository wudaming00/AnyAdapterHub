import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { isPrivateIPv4 } from '../discover.mjs';

const TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav' };

function localPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32768 &&
    path.isAbsolute(value) && !/^(?:\\\\|\/\/)/.test(value) && !value.includes('\0');
}
export function validateMediaRoots(value = []) {
  if (!Array.isArray(value) || value.length > 32 || value.some(root => !localPath(root))) {
    throw new Error('mediaRoots must be an array of at most 32 absolute local directory paths without network shares.');
  }
  return [...new Set(value.map(root => path.resolve(root)))];
}
function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function fileRange(file, start, end) {
  return Readable.from((async function* () {
    let position = start;
    while (position <= end) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - position + 1));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) throw new Error('Selected media was truncated while streaming.');
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  })(), { objectMode: false });
}

export function byteRange(value, size) {
  if (value === undefined) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  let start; let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return null;
  return { start, end, partial: true };
}

// One explicitly selected file, reachable only by the selected TV address.
// The owning agent keeps this instance alive until playback is stopped/replaced.
export class LocalMediaHost {
  #server;
  #file;
  #streams = new Set();
  #closed = false;
  #closePromise;
  constructor({ tvHost, bindAddress, mediaRoots = [], serverFactory = handler => http.createServer(handler) } = {}) {
    if (!isPrivateIPv4(tvHost) || !isPrivateIPv4(bindAddress)) throw new Error('Select private LAN TV and computer IPv4 addresses.');
    if (tvHost === bindAddress) throw new Error('TV and computer addresses must differ.');
    this.tvHost = tvHost; this.bindAddress = bindAddress; this.serverFactory = serverFactory;
    this.mediaRoots = validateMediaRoots(mediaRoots);
  }
  async serve(filePath, { mimeType } = {}) {
    if (this.#closed || this.#server) throw new Error('Use a fresh media host for each selected file.');
    if (!localPath(filePath)) throw new Error('Select an absolute local file path. Network shares are not supported.');
    if (!this.mediaRoots.length) throw new Error('Local file casting requires explicitly configured mediaRoots.');
    const expectedType = TYPES[path.extname(filePath).toLowerCase()];
    if (!expectedType || (mimeType !== undefined && mimeType !== expectedType)) {
      throw new Error('Select a supported media file whose MIME type matches its audio/video extension.');
    }
    mimeType = expectedType;
    let info;
    try {
      const [realFile, roots] = await Promise.all([fs.realpath(filePath), Promise.all(this.mediaRoots.map(async root => {
        const real = await fs.realpath(root);
        if (!localPath(real) || !(await fs.stat(real)).isDirectory()) throw new Error('Invalid media directory.');
        return real;
      }))]);
      if (!localPath(realFile) || !roots.some(root => within(root, realFile))) throw new Error('Media file is outside approved mediaRoots.');
      if (TYPES[path.extname(realFile).toLowerCase()] !== expectedType) throw new Error('Media link target has an unsupported or mismatched extension.');
      // Inspect the opened handle first; NONBLOCK also makes a FIFO substitution
      // rejectable before it can stall. Ancestry still requires trusted roots.
      this.#file = await fs.open(realFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      info = await this.#file.stat({ bigint: true });
      const current = await fs.lstat(realFile, { bigint: true });
      if (!info.isFile() || info.size < 1n || info.size > BigInt(Number.MAX_SAFE_INTEGER) ||
        !current.isFile() || current.isSymbolicLink() || info.dev !== current.dev || info.ino !== current.ino) throw new Error('The selected media file changed while opening it.');
    } catch {
      await this.#file?.close(); this.#file = undefined;
      throw new Error('The selected media file must be a nonempty regular media file inside an approved mediaRoots directory.');
    }
    // Range arithmetic uses Number only after exact identity and size checks.
    const fileSize = Number(info.size);
    const mediaPath = `/media/${randomBytes(18).toString('hex')}${path.extname(filePath).toLowerCase()}`;
    this.#server = this.serverFactory((request, response) => {
      if (request.socket.remoteAddress?.replace(/^::ffff:/, '') !== this.tvHost) {
        response.writeHead(403); response.end(); return;
      }
      let requestPath;
      try { requestPath = new URL(request.url, 'http://local').pathname; } catch { response.writeHead(400); response.end(); return; }
      if (requestPath !== mediaPath) { response.writeHead(404); response.end(); return; }
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
      const range = byteRange(request.headers.range, fileSize);
      if (!range) { response.writeHead(416, { 'Content-Range': `bytes */${fileSize}` }); response.end(); return; }
      response.writeHead(range.partial ? 206 : 200, {
        'Content-Type': mimeType, 'Content-Length': range.end - range.start + 1, 'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store', 'transferMode.dlna.org': 'Streaming',
        'contentFeatures.dlna.org': 'DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000',
        ...(range.partial ? { 'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}` } : {}),
      });
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = fileRange(this.#file, range.start, range.end);
      this.#streams.add(stream);
      stream.on('close', () => this.#streams.delete(stream));
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    });
    try {
      await new Promise((resolve, reject) => {
        this.#server.once('error', reject);
        this.#server.listen(0, this.bindAddress, resolve);
      });
      return { url: `http://${this.bindAddress}:${this.#server.address().port}${mediaPath}`, mimeType, bytes: fileSize };
    } catch {
      await this.close(); throw new Error('Cannot start the local media listener on the selected computer interface.');
    }
  }
  async close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      const tasks = [];
      for (const stream of this.#streams) tasks.push(Promise.resolve().then(() => stream.destroy()));
      this.#streams.clear();
      if (this.#server) tasks.push(new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Media listener cleanup timed out.')), 2000);
        const finish = error => { clearTimeout(timer); if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve(); };
        try { this.#server.closeAllConnections?.(); this.#server.close(finish); } catch (error) { finish(error); }
      }));
      if (this.#file) tasks.push(Promise.resolve().then(() => this.#file.close()).then(() => { this.#file = undefined; }));
      const settled = await Promise.allSettled(tasks);
      if (settled.some(result => result.status === 'rejected')) {
        const error = new Error('The owned local media resources could not be fully closed.');
        error.code = 'MEDIA_CLEANUP_FAILED'; throw error;
      }
    })();
    return this.#closePromise;
  }
}
