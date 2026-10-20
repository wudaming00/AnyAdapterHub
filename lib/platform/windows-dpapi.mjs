import { spawn } from 'node:child_process';
import { SecretStoreError } from '../security/secret-errors.mjs';
import { protectedProcessEnvironment, resolvePowerShell } from './system-tools.mjs';

const MAX_CLEAR = 256 * 1024;
const MAX_PROTECTED = MAX_CLEAR + 64 * 1024;
const MAX_OUTPUT = Math.ceil(MAX_PROTECTED / 3) * 4 + 2;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function powerShellExecutable() {
  try { return resolvePowerShell(); }
  catch { throw new SecretStoreError('SECRET_STORE_UNSUPPORTED'); }
}

/** Availability check, not a promise that a user's DPAPI profile is unlocked. */
export function isWindowsDpapiSupported() { try { powerShellExecutable(); return true; } catch { return false; } }

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
  const executable = powerShellExecutable();
  const wire = Buffer.from(JSON.stringify({ operation, bytes: bytes.toString('base64'), entropy: entropy.toString('base64') }), 'utf8');
  try {
    return await new Promise((resolve, reject) => {
      const output = []; let length = 0; let settled = false; let child;
      const clearOutput = () => { for (const chunk of output) chunk.fill(0); };
      const finish = (error, value) => {
        if (settled) { value?.fill?.(0); return; } settled = true; clearTimeout(timer); clearOutput();
        if (error) {
          try { child?.kill(); } catch {}
          // Only our own fixed deadline may identify a timeout. Child/process
          // errors cannot inject diagnostic codes or sensitive error messages.
          const code = error instanceof SecretStoreError && error.code === 'SECRET_STORE_TIMEOUT'
            ? 'SECRET_STORE_TIMEOUT' : 'SECRET_STORE_FAILED';
          reject(new SecretStoreError(code));
        } else resolve(value);
      };
      // A fresh Windows profile or first PowerShell/.NET startup on a busy host
      // can exceed 15 seconds. Keep a finite deadline without changing trust.
      const timer = setTimeout(() => finish(new SecretStoreError('SECRET_STORE_TIMEOUT')), 45000);
      try {
        child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], {
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: protectedProcessEnvironment(),
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

export const protectWithWindowsDpapi = (clear, entropy) => windowsOperation('protect', clear, entropy);
export const unprotectWithWindowsDpapi = (protectedBytes, entropy) => windowsOperation('unprotect', protectedBytes, entropy);
