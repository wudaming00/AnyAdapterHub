import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveCredential, resolveTVKeyForMigration } from '../lib/security/credentials.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const git = args => execFileSync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
const entries = git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean);
if (!entries.length) throw new Error('Public review requires a nonempty Git index. Stage the explicit public source first.');
const denied = /(^|\/)(?:node_modules|reports|captures|\.device-hub|\.git|\.venv|__pycache__|work|outputs)(\/|$)|(?:^|\/)\.env(?:\.|$)|\.local\.json|\.(?:log|sqlite(?:-wal|-shm)?|db|tgz|bin|pem|key|jpe?g|png|mp4|zip)$|^probe-|LOCAL-LAB|slopbro|^dev-observer\/|privileged-probe\/(?:main\.js|loader\.html|cleanup-owned\.js)|test\/privileged-(?:loader|probe)\.test\.mjs/i;
const allowed = /^(?:\.gitattributes|\.gitignore|(?:README(?:\.zh-CN)?|CONTRIBUTING(?:\.zh-CN)?|CHANGELOG|SECURITY|THIRD_PARTY_NOTICES)\.md|LICENSE|package(?:-lock)?\.json|(?:device-hub|lg-tv|mcp-tv|discover|inspect-public)\.mjs|(?:\.github|lib|docs|profiles|schema|scripts|test|optional|integrations|third_party|privileged-probe)\/[A-Za-z0-9_./-]+)$/;
const secrets = new Set();
function collect(value, field = '') {
  if (typeof value === 'string' && /^(?:token|clientKey|password|secret|mac|selectedDeviceSha256)$/i.test(field) && value.length >= 8) secrets.add(value);
  else if (Array.isArray(value)) value.forEach(v => collect(v));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => collect(v, k));
}
// Optional local comparison; values are never logged or written to a report.
for (const name of ['.lg-tv.local.json', '.lg-tv.legacy.local.json', '.ecovacs-x11.local.json', '.device-hub/owner.json', '.device-hub/client.json', '.device-hub/vacuum-client.json', '.device-hub/client-revoked.json']) {
  try { if (existsSync(new URL('../' + name, import.meta.url))) {
    const value = JSON.parse(readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
    collect(value);
    if (value.tokenSecret) collect(await resolveCredential(value));
    for (const [host, profile] of Object.entries(value.devices ?? {})) if (profile.clientKeySecret) secrets.add(await resolveTVKeyForMigration(profile, host));
  } }
  catch { throw new Error('A local credential comparison input could not be read.'); }
}
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{16,}/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16})\b/,
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/,
  /[A-Za-z]:[\\/]Users[\\/][^\s"'<>]+/i,
];
let count = 0;
for (const entry of entries) {
  const match = /^(\d+) [a-f0-9]+ \d\t(.+)$/s.exec(entry);
  if (!match || !['100644', '100755'].includes(match[1])) throw new Error('Git index contains unsupported entries or links.');
  const name = match[2];
  if (!allowed.test(name) || name.includes('..') || denied.test(name)) throw new Error('Private or unreviewed path in Git index: ' + name);
  const bytes = git(['show', ':' + name]);
  if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) throw new Error('Unexpected binary or oversized public source: ' + name);
  const text = bytes.toString('utf8');
  if (patterns.some(pattern => pattern.test(text)) || [...secrets].some(secret => text.includes(secret))) throw new Error('Potential private material detected in staged file: ' + name + ' (value withheld).');
  count++;
}
console.log(`Public Git index checked: ${count} text files; private paths, links, known local credentials and common secret patterns rejected.`);
console.log('This bounded check supplements human review; it does not prove that every possible secret is absent.');
