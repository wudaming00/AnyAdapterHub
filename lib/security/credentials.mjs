import * as systemStore from './secret-store.mjs';
import { createHash, X509Certificate } from 'node:crypto';
import { validatePrivateHost as validateLocalHost } from '../hub/adapters.mjs';
import { normalizeCertificatePin } from './tv-tls.mjs';

const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const PIN = /^[a-f0-9]{64}$/;
const fail = () => { const error = new Error('Encrypted credential required. Run the explicit local security migration.'); error.code = 'ENCRYPTED_CREDENTIAL_REQUIRED'; throw error; };
function origin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) fail();
  return url.origin;
}

function credentialIdentity(record) {
  if (!PIN.test(record.certificatePin ?? '') || typeof record.certificate !== 'string' || record.certificate.length > 16384 ||
    record.certificate.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)?.length !== 1 ||
    record.certificate.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim()) fail();
  try {
    const cert = new X509Certificate(record.certificate);
    if (createHash('sha256').update(cert.raw).digest('hex') !== record.certificatePin || cert.checkIP('127.0.0.1') !== '127.0.0.1') fail();
  } catch { fail(); }
}
function tvBinding(profile, host) {
  try { validateLocalHost(host); } catch { fail(); }
  if (profile.certificatePin === undefined && profile.certificateTrust?.method === 'pending-tv-tls-enrollment') return 'pending-enrollment';
  if (profile.certificateTrust?.method === 'pending-tv-tls-enrollment') fail();
  try { return normalizeCertificatePin(profile.certificatePin); } catch { fail(); }
}
function keyValue(key) { if (typeof key !== 'string' || !key || key.length > 4096) fail(); return key; }

export async function protectCredential(record, { secretStore = systemStore } = {}) {
  if (!record || typeof record.token !== 'string' || !TOKEN.test(record.token)) fail();
  const url = origin(record.url);
  credentialIdentity(record);
  const secret = await secretStore.sealSecret(record.token, { purpose: `hub/token:${url}/${record.certificatePin}` });
  const result = { ...record, url, tokenSecret: secret };
  delete result.token;
  return result;
}

export async function resolveCredential(record, { secretStore = systemStore } = {}) {
  if (!record || Object.hasOwn(record, 'token') || !secretStore.isSecretEnvelope(record.tokenSecret)) fail();
  const url = origin(record.url);
  credentialIdentity(record);
  const token = await secretStore.openSecret(record.tokenSecret, { purpose: `hub/token:${url}/${record.certificatePin}` });
  if (typeof token !== 'string' || !TOKEN.test(token)) fail();
  const result = { ...record, url, token }; delete result.tokenSecret;
  return result;
}

export async function protectTVKey(profile, host, { secretStore = systemStore } = {}) {
  keyValue(profile?.clientKey);
  const binding = tvBinding(profile, host);
  const result = { ...profile, clientKeyPurposeVersion: 2,
    ...(binding === 'pending-enrollment' ? {} : { certificatePin: binding }),
    clientKeySecret: await secretStore.sealSecret(profile.clientKey, { purpose: `lg/client-key:${host}/${binding}` }) };
  delete result.clientKey;
  return result;
}

export async function resolveTVKey(profile, host, { secretStore = systemStore } = {}) {
  if (!profile || profile.clientKeyPurposeVersion !== 2 || Object.hasOwn(profile, 'clientKey') || !secretStore.isSecretEnvelope(profile.clientKeySecret)) fail();
  const binding = tvBinding(profile, host);
  return keyValue(await secretStore.openSecret(profile.clientKeySecret, { purpose: `lg/client-key:${host}/${binding}` }));
}

/** Explicit owner migration only: production resolution never silently opens host-only envelopes. */
export async function resolveTVKeyForMigration(profile, host, { secretStore = systemStore } = {}) {
  if (profile?.clientKeyPurposeVersion === 2) return resolveTVKey(profile, host, { secretStore });
  if (!profile || profile.clientKeyPurposeVersion !== undefined || Object.hasOwn(profile, 'clientKey') || !secretStore.isSecretEnvelope(profile.clientKeySecret)) fail();
  try { validateLocalHost(host); } catch { fail(); }
  return keyValue(await secretStore.openSecret(profile.clientKeySecret, { purpose: `lg/client-key:${host}` }));
}
