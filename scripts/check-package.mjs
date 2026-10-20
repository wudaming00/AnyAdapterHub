import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Fixed command and arguments; no shell text comes from a profile or tool input.
const run = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, maxBuffer: 1024 * 1024 });
if (run.status !== 0) throw new Error('Package dry-run failed.');
const listing = JSON.parse(run.stdout)[0];
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (manifest.dependencies?.ws || manifest.optionalDependencies?.ws || manifest.peerDependencies?.ws !== '8.22.0' ||
    manifest.peerDependenciesMeta?.ws?.optional !== true) throw new Error('LG transport must remain an explicitly installed optional peer.');
if (manifest.dependencies?.mqtt || manifest.optionalDependencies?.mqtt || manifest.peerDependencies?.mqtt !== '5.16.1' ||
    manifest.peerDependenciesMeta?.mqtt?.optional !== true) throw new Error('MQTT transport must remain an explicitly installed optional peer.');
const denied = listing.files.filter(item => /(^|\/)(?:reports|captures|node_modules|\.git|\.device-hub)(\/|$)|\.local\.json|\.log$|\.sqlite(?:-wal|-shm)?$|\.tgz$|^probe-[^/]+|LOCAL-LAB|slopbro|privileged-probe\/(?:main\.js|loader\.html|cleanup-owned\.js)/i.test(item.path));
if (denied.length) throw new Error('Private or experimental files entered the package: ' + denied.map(item => item.path).join(', '));
for (const required of ['SECURITY.md', 'CONTRIBUTING.md', 'LICENSE', 'device-hub.mjs', 'lib/hub/server.mjs', 'lib/hub/client.mjs', 'lib/hub/adapters.mjs', 'lib/adapters/lg-config.mjs', 'lib/adapters/lg-webos.mjs', 'lib/adapters/ecovacs-x11.mjs', 'optional/lg-webos/README.md', 'docs/MODULAR_ARCHITECTURE.md', 'optional/ecovacs/worker.py', 'optional/ecovacs/LICENSE', 'lib/tv-observer.mjs', 'privileged-probe/capture-cleanup.js']) {
  if (!listing.files.some(item => item.path === required)) throw new Error('Missing runtime/review file: ' + required);
}
if (listing.files.some(item => /(^|\/)(?:__pycache__|\.venv)(\/|$)|\.pyc$/i.test(item.path))) throw new Error('Python caches entered the package.');
for (const name of ['philips-hue', 'shelly-gen2', 'switchbot', 'lg-thinq', 'home-assistant-sensor', 'openhab', 'plex', 'awair', 'purpleair']) {
  for (const suffix of ['', '-config']) if (!listing.files.some(item => item.path === `lib/adapters/${name}${suffix}.mjs`)) throw new Error('Missing reviewed integration source.');
}
for (const name of ['scripts/enroll-integration.mjs', 'lib/security/vendor-json-https.mjs', 'docs/COMMON_ADAPTERS.md']) if (!listing.files.some(item => item.path === name)) throw new Error('Missing common integration setup source.');
console.log(`Package boundary verified (${listing.files.length} files); nothing published.`);
