import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { resolvePowerShell, protectedProcessEnvironment } from './system-tools.mjs';

const POSIX = process.platform !== 'win32';
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const unsafe = message => { const error = new Error(message); error.code = 'HUB_HOME_UNSAFE'; throw error; };

// Fixed script; paths enter only through the environment, never source interpolation.
// A fresh descriptor removes all previous ACEs, including explicit Everyone entries.
const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$target = $env:DEVICE_HUB_ACL_PATH
$kind = $env:DEVICE_HUB_ACL_KIND
if ([string]::IsNullOrEmpty($target) -or @('directory', 'file') -notcontains $kind) { throw 'Invalid protection target' }
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$principals = @($current)
if ($current.Value -ne $system.Value) { $principals += $system }
function Checked-Item($file, $directory) {
  $item = Get-Item -LiteralPath $file -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $directory) { throw 'Linked or unexpected protection target' }
  return $item
}
$root = Checked-Item $target ($kind -eq 'directory')
$items = @($root)
if ($kind -eq 'directory') {
  foreach ($child in @(Get-ChildItem -LiteralPath $target -Force)) { $items += Checked-Item $child.FullName $false }
}
foreach ($item in $items) {
  $directory = [bool]$item.PSIsContainer
  if ($directory) {
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $security = [System.Security.AccessControl.FileSecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($current)
  foreach ($principal in $principals) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal,
      [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow)
    [void]$security.AddAccessRule($rule)
  }
  # Persist only the descriptor sections we changed. Set-Acl may also request
  # SACL privileges when reapplying a protected descriptor as a standard user.
  if ($directory) { [System.IO.Directory]::SetAccessControl($item.FullName, $security) }
  else { [System.IO.File]::SetAccessControl($item.FullName, $security) }
  [void](Checked-Item $item.FullName $directory)
  $actual = Get-Acl -LiteralPath $item.FullName
  $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $current.Value -or $rules.Count -ne $principals.Count) { throw 'Private DACL verification failed' }
  $seen = @{}
  foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Value
    if (@($principals | ForEach-Object { $_.Value }) -notcontains $sid -or $seen.ContainsKey($sid) -or
      $rule.IsInherited -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
      $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { throw 'Private DACL verification failed' }
    $seen[$sid] = $true
  }
}
[Console]::WriteLine('ACL_OK')
`;

function windowsProtection(target, kind) {
  try {
    const env = { ...protectedProcessEnvironment(), DEVICE_HUB_ACL_PATH: target, DEVICE_HUB_ACL_KIND: kind };
    const result = execFileSync(resolvePowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_ACL_SCRIPT], {
      env,
      encoding: 'utf8', stdio: 'pipe', windowsHide: true, shell: false, timeout: 15000, maxBuffer: 64 * 1024,
    });
    if (result.trim() !== 'ACL_OK') unsafe('Private Windows permissions could not be verified.');
  } catch { unsafe('Private Windows permissions could not be verified.'); }
}

export function assertPrivateOwner(info) {
  if (POSIX && typeof process.getuid === 'function' && info.uid !== process.getuid()) unsafe('Private storage has a different owner.');
}

export function assertPrivateRegularFile(info) {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) unsafe('Private storage contains a linked or unexpected file.');
  assertPrivateOwner(info);
}

async function posixProtect(target, directory = false) {
  const handle = await open(target, constants.O_RDONLY | NOFOLLOW | (directory ? (constants.O_DIRECTORY ?? 0) : 0));
  try {
    const info = await handle.stat();
    if (directory) {
      if (!info.isDirectory()) unsafe('Hub home must be an ordinary dedicated directory.');
      assertPrivateOwner(info);
    } else assertPrivateRegularFile(info);
    await handle.chmod(directory ? 0o700 : 0o600);
    if (((await handle.stat()).mode & 0o777) !== (directory ? 0o700 : 0o600)) unsafe('Private POSIX permissions could not be verified.');
  } finally { await handle.close(); }
}

/** Protect only a directory already inspected by the shared home validator. */
export async function protectDirectoryPermissions(directory, names) {
  if (POSIX) {
    await posixProtect(directory, true);
    for (const name of names) await posixProtect(path.join(directory, name));
  } else windowsProtection(directory, 'directory');
}

/** The caller retains the checked open handle and verifies its pathname identity. */
export async function protectFilePermissions(file, handle) {
  if (POSIX) {
    await handle.chmod(0o600);
    if (((await handle.stat()).mode & 0o777) !== 0o600) unsafe('Private POSIX permissions could not be verified.');
  } else windowsProtection(file, 'file');
}
