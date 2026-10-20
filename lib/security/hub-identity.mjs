import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, timingSafeEqual, X509Certificate } from 'node:crypto';
import { types } from 'node:util';
import { sealSecret, openSecret, isSecretStoreSupported } from './secret-store.mjs';
import { resolveOpenSSL, cryptoProcessEnvironment } from '../platform/system-tools.mjs';

const DEFAULT_PURPOSE = 'hub/tls-identity';
const PURPOSE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PIN = /^[a-f0-9]{64}$/;
const PEM_LIMIT = 16384;
const CERT_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const KEY_PATTERN = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/g;
const OPENSSL_CONFIG = '[req]\ndistinguished_name=dn\n[dn]\n';

export class HubIdentityError extends Error {
  constructor(code = 'HUB_IDENTITY_FAILED') { super('The local hub TLS identity could not be verified or protected.'); this.name = 'HubIdentityError'; this.code = code; }
}
const fail = code => { throw new HubIdentityError(code); };
function record(value, expected) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail();
  const entries = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(entries).length !== expected.length || expected.some(key => !entries[key] || !Object.hasOwn(entries[key], 'value') || !entries[key].enumerable)) fail();
  return value;
}
function purposeValue(purpose) { if (typeof purpose !== 'string' || !PURPOSE.test(purpose)) fail('INVALID_IDENTITY_PURPOSE'); return purpose; }
function certificate(value) {
  if (typeof value !== 'string' || value.length > PEM_LIMIT) fail();
  const matches = value.match(CERT_PATTERN);
  if (matches?.length !== 1 || value.replace(CERT_PATTERN, '').trim()) fail();
  let cert;
  try { cert = new X509Certificate(value); } catch { fail(); }
  if (cert.ca || cert.checkIP('127.0.0.1') !== '127.0.0.1' || cert.checkHost('localhost', { subject: 'never' }) !== 'localhost' ||
    !cert.keyUsage?.includes('1.3.6.1.5.5.7.3.1') || !cert.verify(cert.publicKey) || cert.subject !== cert.issuer ||
    !Number.isFinite(Date.parse(cert.validFrom)) || !Number.isFinite(Date.parse(cert.validTo)) || Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) fail();
  return cert;
}
function pinFor(cert) { return createHash('sha256').update(cert.raw).digest('hex'); }
function material(value) {
  record(value, ['key', 'cert']);
  if (typeof value.key !== 'string' || value.key.length > PEM_LIMIT || value.key.match(KEY_PATTERN)?.length !== 1 || value.key.replace(KEY_PATTERN, '').trim()) fail();
  const cert = certificate(value.cert);
  let key;
  try { key = createPrivateKey(value.key); } catch { fail(); }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 2048 || !cert.checkPrivateKey(key)) fail();
  return { key: value.key, cert: cert.toString(), certificatePin: pinFor(cert), certificate: cert };
}

function opensslPath() {
  try { return resolveOpenSSL(); } catch { fail('HUB_IDENTITY_UNSUPPORTED'); }
}
export function isHubIdentitySupported() { try { opensslPath(); return isSecretStoreSupported(); } catch { return false; } }

/** Map bounded process diagnostics to static codes; never return source text. */
export function classifyIdentityProcessFailure(diagnostic) {
  if (typeof diagnostic !== 'string' || diagnostic.length > 64 * 1024) return 'HUB_IDENTITY_PROCESS_EXIT';
  if (/unknown option|unrecognized option|unrecognized flag|unknown cipher/i.test(diagnostic)) return 'HUB_IDENTITY_OPTION_UNSUPPORTED';
  if (/configuration file|config (?:file|input)|no objects specified|(?:can(?:not|'t)|could not|unable to) open[^\r\n]*(?:config|NUL|\/dev\/null)/i.test(diagnostic)) return 'HUB_IDENTITY_CONFIG_FAILED';
  return 'HUB_IDENTITY_PROCESS_EXIT';
}

async function generateIdentity() {
  const executable = opensslPath();
  // Git's native Windows OpenSSL does not support req -key - or /dev/stdin.
  // Generate inside OpenSSL and send BOTH outputs to its stdout pipe instead.
  // No -keyout filename, temp file, named pipe or OS certificate-store entry exists.
  // Fixed non-secret configuration enters stdin. Git's MSYS OpenSSL does not
  // recognize native Windows NUL paths; -config - works in MSYS and native builds
  // and prevents cwd/user OpenSSL configuration from being read.
  // OpenSSL options: https://docs.openssl.org/3.0/man1/openssl-req/
  // -nodes is the identical stdout-only unencrypted-key option accepted by both
  // OpenSSL 1.1.1 and 3.x. The newer spelling -noenc is unavailable in 1.1.1.
  const args = ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '-', '-out', '-',
    '-config', '-', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment', '-addext', 'extendedKeyUsage=serverAuth',
    '-sha256', '-days', '365', '-batch'];
  return new Promise((resolve, reject) => {
    const output = [], diagnostics = []; let size = 0, diagnosticSize = 0; let settled = false; let child;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); for (const bytes of [...output, ...diagnostics]) bytes.fill(0);
      if (error) { child?.kill(); reject(error instanceof HubIdentityError ? error : new HubIdentityError()); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new HubIdentityError('HUB_IDENTITY_TIMEOUT')), 15000);
    try {
      child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: cryptoProcessEnvironment() });
      child.on('error', () => finish(new HubIdentityError('HUB_IDENTITY_PROCESS_EXIT')));
      child.stdin.on('error', () => finish(new HubIdentityError('HUB_IDENTITY_PROCESS_EXIT')));
      child.stderr.on('data', bytes => {
        if (settled) { bytes.fill(0); return; }
        diagnosticSize += bytes.length;
        if (diagnosticSize > 64 * 1024) { bytes.fill(0); return finish(new HubIdentityError('HUB_IDENTITY_PROCESS_EXIT')); }
        diagnostics.push(bytes); // Classified below; never returned or printed.
      });
      child.stdout.on('data', bytes => {
        if (settled) { bytes.fill(0); return; }
        size += bytes.length;
        if (size > 64 * 1024) { bytes.fill(0); return finish(new HubIdentityError()); }
        output.push(bytes);
      });
      child.on('close', code => {
        let joined, diagnosticBytes;
        try {
          if (code !== 0) {
            diagnosticBytes = Buffer.concat(diagnostics);
            return finish(new HubIdentityError(classifyIdentityProcessFailure(diagnosticBytes.toString('utf8'))));
          }
          joined = Buffer.concat(output); const text = joined.toString('utf8');
          const keys = text.match(KEY_PATTERN); const certs = text.match(CERT_PATTERN);
          if (keys?.length !== 1 || certs?.length !== 1 || text.replace(KEY_PATTERN, '').replace(CERT_PATTERN, '').trim()) return finish(new HubIdentityError());
          finish(null, { key: keys[0] + '\n', cert: certs[0] + '\n' });
        } catch { finish(new HubIdentityError()); }
        finally { joined?.fill(0); diagnosticBytes?.fill(0); }
      });
      child.stdin.end(OPENSSL_CONFIG);
    } catch { finish(new HubIdentityError()); }
  });
}

/** Explicit injection supports portable tamper tests; production exports never swap providers. */
export function createHubIdentityManager({ sealSecret: seal, openSecret: open, generateIdentity: generate = generateIdentity } = {}) {
  if (typeof seal !== 'function' || typeof open !== 'function' || typeof generate !== 'function') fail();
  return Object.freeze({
    async createHubIdentity({ purpose = DEFAULT_PURPOSE } = {}) {
      purposeValue(purpose);
      let generated;
      try {
        generated = material(await generate());
        const secret = await seal({ key: generated.key, cert: generated.cert }, { purpose });
        return Object.freeze({ certificatePin: generated.certificatePin, purpose, certificate: generated.cert, secret });
      } catch (error) { if (error instanceof HubIdentityError) throw error; fail(); }
      finally { if (generated) generated.key = ''; }
    },
    async openHubIdentity(value, { purpose = DEFAULT_PURPOSE } = {}) {
      purposeValue(purpose);
      try {
        record(value, ['certificatePin', 'purpose', 'certificate', 'secret']);
        if (value.purpose !== purpose || !PIN.test(value.certificatePin ?? '')) fail();
        const publicCertificate = certificate(value.certificate); const publicPin = pinFor(publicCertificate);
        if (!timingSafeEqual(Buffer.from(publicPin, 'hex'), Buffer.from(value.certificatePin, 'hex'))) fail();
        const decrypted = await open(value.secret, { purpose });
        const verified = material(decrypted);
        try {
          if (verified.certificatePin !== publicPin || verified.cert !== publicCertificate.toString()) fail();
          return { key: verified.key, cert: verified.cert, certificatePin: publicPin };
        } finally { verified.key = ''; }
      } catch (error) { if (error instanceof HubIdentityError) throw error; fail(); }
    },
  });
}

const production = createHubIdentityManager({ sealSecret, openSecret });
export async function createHubIdentity(options) { if (!isSecretStoreSupported()) fail('HUB_IDENTITY_UNSUPPORTED'); return production.createHubIdentity(options); }
export async function openHubIdentity(value, options) { if (!isSecretStoreSupported()) fail('HUB_IDENTITY_UNSUPPORTED'); return production.openHubIdentity(value, options); }

// Key PEM strings are intentionally never written to disk or logs. JS strings
// cannot be reliably zeroized; mutable process buffers are cleared best effort.
