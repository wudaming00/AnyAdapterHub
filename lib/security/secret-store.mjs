import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { SecretStoreError } from './secret-errors.mjs';
import { isWindowsDpapiSupported, protectWithWindowsDpapi, unprotectWithWindowsDpapi } from '../platform/windows-dpapi.mjs';

const PROVIDER = 'windows-dpapi';
const MAX_CLEAR = 256 * 1024;
const MAX_PROTECTED = MAX_CLEAR + 64 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PURPOSE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export { SecretStoreError } from './secret-errors.mjs';
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

/** Availability check, not a promise that a user's DPAPI profile is unlocked. */
export const isSecretStoreSupported = isWindowsDpapiSupported;
export function isSupportedSecretProvider(provider) { return provider === PROVIDER && isSecretStoreSupported(); }

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
  protect: protectWithWindowsDpapi,
  unprotect: unprotectWithWindowsDpapi,
});
export const sealSecret = production.sealSecret;
export const openSecret = production.openSecret;

// Buffers are cleared on a best-effort basis. JS/.NET strings and returned values
// are garbage-collected and cannot be promised immediate or complete erasure.
