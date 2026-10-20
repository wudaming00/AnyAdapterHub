// Informational, immutable implementation inventory. These records never select
// credential providers, load modules, grant authority or assert runtime readiness.
function descriptor(id, nodePlatform, fileProtection, secretProvider = null) {
  return Object.freeze({
    id, nodePlatform,
    secretProtection: Object.freeze({ implemented: secretProvider !== null, provider: secretProvider }),
    fileProtection,
    nativeDistribution: 'planned',
  });
}
const platforms = new Map([
  ['win32', descriptor('windows', 'win32', 'windows-dacl', 'windows-dpapi')],
  ['linux', descriptor('linux', 'linux', 'posix-mode')],
  ['darwin', descriptor('macos', 'darwin', 'posix-mode')],
]);
const unsupported = descriptor('unsupported', null, null);

/** Platform arguments describe a target; they cannot change the running host. */
export function describePlatform(platform = process.platform) { return platforms.get(platform) ?? unsupported; }
