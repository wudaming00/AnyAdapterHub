import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { types } from 'node:util';

const PROVIDER = 'windows-dpapi';
const MAX_CLEAR = 256 * 1024;
const MAX_PROTECTED = MAX_CLEAR + 64 * 1024;
const MAX_OUTPUT = Math.ceil(MAX_PROTECTED / 3) * 4 + 2;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ENV_KEYS = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA']);
const PURPOSE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export class SecretStoreError extends Error {
  constructor(code = 'SECRET_STORE_FAILED') { super('The protected secret operation could not be completed.'); this.name = 'SecretStoreError'; this.code = code; }
}
const fail = code => { throw new SecretStoreError(code); };
function plain(value) { return value !== null && typeof value === 'object' && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype; }
function entropyFor(purpose) {
  if (typeof purpose !== 'string' || !PURPOSE.test(purpose)) fail('INVALID_SECRET_PURPOSE');
  return createHash('sha256').update('AnyAdapterHub:' + purpose, 'utf8').digest();
}
function envelopeFor(value, provider) {
  if (!plain(value) || Reflect.ownKeys(value).length !== 3) return false;
  const entries = Object.getOwnPropertyDescriptors(value);
  if (['version', 'provider', 'protected'].some(key => !entries[key] || !Object.hasOwn(entries[key], 'value') || !entries[key].enumerable)) return false;
  const encoded = entries.protected.value;
  if (entries.version.value !== 1 || entries.provider.value !== provider || typeof encoded !== 'string' ||
    !encoded.length || encoded.length > Math.ceil(MAX_PROTECTED / 3) * 4 || !BASE64.test(encoded)) return false;
  const bytes = Buffer.from(encoded, 'base64');
  try { return bytes.length > 0 && bytes.length <= MAX_PROTECTED && bytes.toString('base64') === encoded; }
  finally { bytes.fill(0); }
}
export function isSecretEnvelope(value) { return envelopeFor(value, PROVIDER); }

function encodeJSON(value) {
  const ancestors = new WeakSet(); let nodes = 0; let textBytes = 0;
  const visit = (item, depth) => {
    if (++nodes > 32768 || depth > 64) fail('INVALID_SECRET_VALUE');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('INVALID_SECRET_VALUE'); return; }
    if (typeof item === 'string') { textBytes += Buffer.byteLength(item); if (textBytes > MAX_CLEAR) fail('INVALID_SECRET_VALUE'); return; }
    if (!item || typeof item !== 'object' || types.isProxy(item) || ancestors.has(item) || Object.getOwnPropertySymbols(item).length) fail('INVALID_SECRET_VALUE');
    const isArray = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (isArray ? Array.prototype : Object.prototype)) fail('INVALID_SECRET_VALUE');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Object.keys(descriptors).filter(key => !(isArray && key === 'length'));
    if (isArray && (keys.length !== item.length || keys.some((key, index) => key !== String(index)))) fail('INVALID_SECRET_VALUE');
    ancestors.add(item);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('INVALID_SECRET_VALUE');
      textBytes += Buffer.byteLength(key); if (textBytes > MAX_CLEAR) fail('INVALID_SECRET_VALUE');
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  const encoded = Buffer.from(JSON.stringify(value), 'utf8');
  if (encoded.length > MAX_CLEAR) { encoded.fill(0); fail('INVALID_SECRET_VALUE'); }
  return encoded;
}

function powershellPath() {
  if (process.platform !== 'win32') fail('SECRET_STORE_UNSUPPORTED');
  const root = process.env.SystemRoot;
  if (typeof root !== 'string' || !path.win32.isAbsolute(root) || /^(?:\\\\|\/\/)/.test(root) || root.includes('\0')) fail('SECRET_STORE_UNSUPPORTED');
  try {
    const canonicalRoot = realpathSync(root);
    const executable = path.join(canonicalRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const info = lstatSync(executable);
    const canonical = realpathSync(executable);
    if (!info.isFile() || info.isSymbolicLink() || path.relative(canonicalRoot, canonical).startsWith('..')) fail('SECRET_STORE_UNSUPPORTED');
    return canonical;
  } catch { fail('SECRET_STORE_UNSUPPORTED'); }
}
/** Availability check, not a promise that a user's DPAPI profile is unlocked. */
export function isSecretStoreSupported() { try { powershellPath(); return true; } catch { return false; } }
export function isSupportedSecretProvider(provider) { return provider === PROVIDER && isSecretStoreSupported(); }

// This source is fixed. Mode, bytes and entropy enter only through stdin.
// Microsoft: https://learn.microsoft.com/dotnet/api/system.security.cryptography.protecteddata.protect
// CurrentUser: https://learn.microsoft.com/dotnet/api/system.security.cryptography.dataprotectionscope
const DPAPI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$inputBytes = $null
$entropyBytes = $null
$outputBytes = $null
$failed = $false
try {
  Add-Type -AssemblyName System.Security
  $wire = [Console]::In.ReadToEnd()
  if ($wire.Length -gt 450000) { throw 'Invalid input' }
  $request = ConvertFrom-Json -InputObject $wire
  $names = @($request.PSObject.Properties.Name)
  if ($names.Count -ne 3 -or @($names | Where-Object { @('operation','bytes','entropy') -notcontains $_ }).Count -ne 0 -or
      @('protect','unprotect') -notcontains $request.operation -or $request.bytes -isnot [string] -or $request.entropy -isnot [string]) { throw 'Invalid input' }
  $inputBytes = [Convert]::FromBase64String($request.bytes)
  $entropyBytes = [Convert]::FromBase64String($request.entropy)
  if ($entropyBytes.Length -ne 32 -or $inputBytes.Length -lt 1 -or $inputBytes.Length -gt 327680) { throw 'Invalid input' }
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($request.operation -eq 'protect') {
    if ($inputBytes.Length -gt 262144) { throw 'Invalid input' }
    $outputBytes = [System.Security.Cryptography.ProtectedData]::Protect($inputBytes, $entropyBytes, $scope)
  } else {
    $outputBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $entropyBytes, $scope)
  }
  if ($outputBytes.Length -lt 1 -or $outputBytes.Length -gt 327680) { throw 'Invalid output' }
  [Console]::WriteLine([Convert]::ToBase64String($outputBytes))
} catch { $failed = $true }
finally {
  if ($inputBytes -is [byte[]]) { [Array]::Clear($inputBytes, 0, $inputBytes.Length) }
  if ($entropyBytes -is [byte[]]) { [Array]::Clear($entropyBytes, 0, $entropyBytes.Length) }
  if ($outputBytes -is [byte[]]) { [Array]::Clear($outputBytes, 0, $outputBytes.Length) }
  $wire = $null
  $request = $null
}
if ($failed) { exit 1 }
`;

async function windowsOperation(operation, bytes, entropy) {
  const executable = powershellPath();
  const wire = Buffer.from(JSON.stringify({ operation, bytes: bytes.toString('base64'), entropy: entropy.toString('base64') }), 'utf8');
  try {
    return await new Promise((resolve, reject) => {
      const output = []; let length = 0; let settled = false; let child;
      const clearOutput = () => { for (const chunk of output) chunk.fill(0); };
      const finish = (error, value) => {
        if (settled) { value?.fill?.(0); return; } settled = true; clearTimeout(timer); clearOutput();
        if (error) { child?.kill(); reject(new SecretStoreError()); } else resolve(value);
      };
      // A fresh Windows profile or first PowerShell/.NET startup on a busy host
      // can exceed 15 seconds. Keep a finite deadline without changing trust.
      const timer = setTimeout(() => finish(new SecretStoreError()), 45000);
      try {
        child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], {
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ENV_KEYS.has(key.toUpperCase()))),
        });
        child.on('error', () => finish(new SecretStoreError()));
        child.stdin.on('error', () => finish(new SecretStoreError()));
        child.stderr.on('data', () => {}); // Never return or log process output/errors containing secret material.
        child.stdout.on('data', chunk => {
          if (settled) { chunk.fill(0); return; }
          length += chunk.length;
          if (length > MAX_OUTPUT) { chunk.fill(0); return finish(new SecretStoreError()); }
          output.push(chunk);
        });
        child.on('close', code => {
          let combined;
          try {
            if (code !== 0) return finish(new SecretStoreError());
            combined = Buffer.concat(output);
            const encoded = combined.toString('utf8').replace(/\r?\n$/, '');
            if (!encoded || !BASE64.test(encoded) || encoded.length > MAX_OUTPUT - 2) return finish(new SecretStoreError());
            const decoded = Buffer.from(encoded, 'base64');
            if (decoded.length > MAX_PROTECTED || decoded.toString('base64') !== encoded) { decoded.fill(0); return finish(new SecretStoreError()); }
            finish(null, decoded);
          } catch { finish(new SecretStoreError()); }
          finally { combined?.fill(0); }
        });
        child.stdin.end(wire);
      } catch { finish(new SecretStoreError()); }
    });
  } finally { wire.fill(0); }
}

/** Injection is explicit for portable tests; the production singleton below always uses DPAPI. */
export function createSecretStore({ protect, unprotect, provider } = {}) {
  if (typeof protect !== 'function' || typeof unprotect !== 'function' || typeof provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(provider)) fail('INVALID_SECRET_PROVIDER');
  return Object.freeze({
    isSecretEnvelope: value => envelopeFor(value, provider),
    async sealSecret(value, { purpose } = {}) {
      const entropy = entropyFor(purpose); let clear; let protectedBytes; let providerBytes;
      try {
        clear = encodeJSON(value);
        providerBytes = await protect(clear, entropy);
        if (!(providerBytes instanceof Uint8Array) || !providerBytes.length || providerBytes.length > MAX_PROTECTED) fail();
        protectedBytes = Buffer.from(providerBytes);
        return Object.freeze({ version: 1, provider, protected: protectedBytes.toString('base64') });
      } catch (error) { if (error instanceof SecretStoreError) throw error; fail(); }
      finally { clear?.fill(0); protectedBytes?.fill(0); if (providerBytes instanceof Uint8Array) providerBytes.fill(0); entropy.fill(0); }
    },
    async openSecret(envelope, { purpose } = {}) {
      const entropy = entropyFor(purpose); let protectedBytes; let clear; let providerBytes;
      try {
        if (!envelopeFor(envelope, provider)) fail('INVALID_SECRET_ENVELOPE');
        protectedBytes = Buffer.from(envelope.protected, 'base64');
        providerBytes = await unprotect(protectedBytes, entropy);
        if (!(providerBytes instanceof Uint8Array) || !providerBytes.length || providerBytes.length > MAX_CLEAR) fail();
        clear = Buffer.from(providerBytes);
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear)); } catch { fail(); }
        const checked = encodeJSON(value); checked.fill(0);
        return value;
      } catch (error) { if (error instanceof SecretStoreError) throw error; fail(); }
      finally { protectedBytes?.fill(0); clear?.fill(0); if (providerBytes instanceof Uint8Array) providerBytes.fill(0); entropy.fill(0); }
    },
  });
}

const production = createSecretStore({ provider: PROVIDER,
  protect: (clear, entropy) => windowsOperation('protect', clear, entropy),
  unprotect: (protectedBytes, entropy) => windowsOperation('unprotect', protectedBytes, entropy),
});
export const sealSecret = production.sealSecret;
export const openSecret = production.openSecret;

// Buffers are cleared on a best-effort basis. JS/.NET strings and returned values
// are garbage-collected and cannot be promised immediate or complete erasure.
