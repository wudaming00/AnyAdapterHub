import { types } from 'node:util';
import { readJson } from '../hub/config.mjs';
import { validatePinnedJsonIdentity } from '../security/pinned-json-https.mjs';

export class PlexConfigError extends Error {
  constructor() { super('One owner-selected Plex HTTPS server identity and certificate are required.'); this.name = 'PlexConfigError'; this.code = 'INVALID_CONFIG'; }
}
const fail = () => { throw new PlexConfigError(); };
export function plexDataRecord(value, allowed) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) fail();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
export function validatePlexConfig(value) {
  const fields = plexDataRecord(value, ['origin', 'certificate', 'certificatePin', 'machineIdentifier', 'timeoutMs']);
  if (typeof fields.origin !== 'string' || fields.origin.length > 2048 || /[\u0000-\u0020\u007f]/.test(fields.origin) ||
      typeof fields.machineIdentifier !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(fields.machineIdentifier)) fail();
  let identity;
  try { identity = validatePinnedJsonIdentity({ origin: fields.origin, certificate: fields.certificate, certificatePin: fields.certificatePin }); }
  catch { fail(); }
  if (fields.origin !== identity.origin) fail();
  const timeoutMs = fields.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) fail();
  return Object.freeze({ ...identity, machineIdentifier: fields.machineIdentifier, timeoutMs });
}
// /identity is public by the official API contract. This adapter deliberately
// collects no Plex token; these are private owner target metadata, not secrets.
export const validateProtectedPlexConfig = validatePlexConfig;
export async function protectPlexConfig(value) { return validatePlexConfig(value); }
export async function loadPlexConfig(file) {
  let saved;
  try { saved = await readJson(file); } catch { fail(); }
  return validatePlexConfig(saved);
}
