import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

const PROTECTED_ENV = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA']);
const CRYPTO_ENV = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']);
const OPENSSL_WINDOWS = Object.freeze([
  'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
]);
const OPENSSL_POSIX = Object.freeze(['/usr/bin/openssl', '/bin/openssl']);

export class PlatformToolError extends Error {
  constructor() { super('The fixed platform tool is unavailable.'); this.name = 'PlatformToolError'; this.code = 'PLATFORM_TOOL_UNAVAILABLE'; }
}
const unavailable = () => { throw new PlatformToolError(); };

/** No PATH, working-directory, profile or caller-selected executable lookup. */
export function resolvePowerShell() {
  if (process.platform !== 'win32') unavailable();
  const root = process.env.SystemRoot;
  if (typeof root !== 'string' || !/^[A-Za-z]:[\\/]/.test(root) || root.includes('\0')) unavailable();
  try {
    const canonicalRoot = realpathSync(root);
    const executable = path.join(canonicalRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const info = lstatSync(executable);
    const canonical = realpathSync(executable);
    const relative = path.relative(canonicalRoot, canonical);
    if (!info.isFile() || info.isSymbolicLink() || relative.startsWith('..') || path.isAbsolute(relative)) unavailable();
    return canonical;
  } catch { unavailable(); }
}

/** Availability alone does not establish a production credential backend. */
export function resolveOpenSSL() {
  const candidates = process.platform === 'win32' ? OPENSSL_WINDOWS
    : ['linux', 'darwin'].includes(process.platform) ? OPENSSL_POSIX : [];
  for (const file of candidates) {
    try { const info = lstatSync(file); if (info.isFile() && !info.isSymbolicLink()) return realpathSync(file); } catch {}
  }
  unavailable();
}

function environment(allowed) {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
}

// Never inherit PATH, PowerShell module paths, OpenSSL config or unrelated secrets.
export function protectedProcessEnvironment() { return environment(PROTECTED_ENV); }
export function cryptoProcessEnvironment() { return environment(CRYPTO_ENV); }
