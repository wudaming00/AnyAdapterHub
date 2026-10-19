import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Fixed command and arguments; no shell text comes from a profile or tool input.
const run = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, maxBuffer: 1024 * 1024 });
if (run.status !== 0) throw new Error('Package dry-run failed.');
const listing = JSON.parse(run.stdout)[0];
const denied = listing.files.filter(item => /(^|\/)(?:reports|captures|node_modules|\.git|\.device-hub)(\/|$)|\.local\.json|\.log$|\.sqlite(?:-wal|-shm)?$|\.tgz$|^probe-[^/]+|LOCAL-LAB|slopbro|privileged-probe\/(?:main\.js|loader\.html|cleanup-owned\.js)/i.test(item.path));
if (denied.length) throw new Error('Private or experimental files entered the package: ' + denied.map(item => item.path).join(', '));
for (const required of ['SECURITY.md', 'CONTRIBUTING.md', 'LICENSE', 'device-hub.mjs', 'lib/hub/server.mjs', 'lib/hub/client.mjs', 'lib/adapters/lg-webos.mjs', 'lib/adapters/ecovacs-x11.mjs', 'optional/ecovacs/worker.py', 'optional/ecovacs/LICENSE', 'lib/tv-observer.mjs', 'privileged-probe/capture-cleanup.js']) {
  if (!listing.files.some(item => item.path === required)) throw new Error('Missing runtime/review file: ' + required);
}
if (listing.files.some(item => /(^|\/)(?:__pycache__|\.venv)(\/|$)|\.pyc$/i.test(item.path))) throw new Error('Python caches entered the package.');
console.log(`Package boundary verified (${listing.files.length} files); nothing published.`);
