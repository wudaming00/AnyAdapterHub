import { promises as fs } from 'node:fs';
import { validateDeviceProfile } from '../lib/device-profile.mjs';

const root = new URL('../', import.meta.url);
let count = 0;
for (const file of await fs.readdir(new URL('profiles/', root))) {
  if (!file.endsWith('.json')) continue;
  const profile = validateDeviceProfile(await fs.readFile(new URL('profiles/' + file, root), 'utf8'));
  for (const item of Object.values(profile.verification)) {
    for (const evidence of item.evidence) {
      const [document, anchor] = evidence.split('#');
      const source = await fs.readFile(new URL(document, root), 'utf8');
      if (!source.includes(`id="${anchor}"`)) throw new Error(`Missing public evidence anchor: ${evidence}`);
    }
  }
  count += 1;
}
if (!count) throw new Error('No device profiles were checked.');
console.log(`Validated ${count} device profile(s) and all evidence anchors.`);
