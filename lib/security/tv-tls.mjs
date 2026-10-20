import tls from 'node:tls';
import https from 'node:https';
import os from 'node:os';
import { isIP } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';

export class TVTLSError extends Error {
  constructor(code, message) { super(message); this.name = 'TVTLSError'; this.code = code; }
}
const fail = (code, message) => { throw new TVTLSError(code, message); };
function localHost(host) {
  if (typeof host !== 'string' || !isIP(host)) fail('INVALID_HOST', 'A literal local TV address is required.');
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return host;
  } else if (/^(fc|fd|fe[89ab])/i.test(host) || host === '::1') return new URL(`http://[${host}]`).hostname.slice(1, -1);
  fail('INVALID_HOST', 'A literal local TV address is required.');
}
function limits(port, timeoutMs) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) fail('INVALID_TLS_OPTIONS', 'Invalid TLS endpoint or timeout.');
}
function sourceAddress(host, value, { requireAvailable = false } = {}) {
  if (value === undefined) return undefined;
  let address;
  try { address = localHost(value); }
  catch { fail('INVALID_SOURCE_ADDRESS', 'The selected TV source address must be a literal local address.'); }
  if (isIP(address) !== isIP(host)) fail('INVALID_SOURCE_ADDRESS', 'The selected TV source and target address families must match.');
  if (requireAvailable) {
    const available = Object.values(os.networkInterfaces()).flat().some(entry => {
      try { return localHost(entry.address) === address; } catch { return false; }
    });
    if (!available) fail('SOURCE_ADDRESS_UNAVAILABLE', 'The configured TV network interface is unavailable; no alternate interface was selected.');
  }
  return address;
}
export function normalizeCertificatePin(value) {
  if (typeof value !== 'string') fail('TLS_PIN_REQUIRED', 'Enroll and explicitly trust the selected TV certificate before connecting.');
  const pin = value.trim().replaceAll(':', '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(pin)) fail('TLS_PIN_REQUIRED', 'The TV certificate pin must be a SHA-256 fingerprint.');
  return pin;
}
function peerIdentity(socket) {
  const certificate = socket.getPeerCertificate();
  if (!Buffer.isBuffer(certificate?.raw) || certificate.raw.length === 0 || certificate.raw.length > 65536) fail('TLS_CERTIFICATE_MISSING', 'The peer did not supply an acceptable certificate.');
  return { certificate, certificatePin: createHash('sha256').update(certificate.raw).digest('hex') };
}

/** Only TLS handshake bytes are exchanged until finish supplies this socket.
 * LG's self-signed certificate is authenticated by the required DER SHA-256 pin,
 * not by system-CA validation or a checkServerIdentity callback that Node skips
 * when rejectUnauthorized is false. Never return a socket before the pin check.
 */
function connectTLS({ host, port, timeoutMs, certificatePin, localAddress, probe = false }, finish) {
  let socket, complete = false;
  const done = (error, value) => {
    if (complete) return;
    complete = true; clearTimeout(timer); socket?.off('error', failed);
    if (error) socket?.destroy();
    finish(error, value);
  };
  const failed = () => done(new TVTLSError('TLS_CONNECTION_FAILED', 'The selected TV TLS connection failed.'));
  const timer = setTimeout(() => done(new TVTLSError('TLS_TIMEOUT', 'The selected TV TLS handshake timed out.')), timeoutMs);
  try {
    localAddress = sourceAddress(host, localAddress, { requireAvailable: true });
    // This is the single custom-trust exception: no HTTP/SSAP/key bytes can be
    // written until the exact pin is checked below. The probe never hands out a socket.
    socket = tls.connect({ host, port, ...(localAddress === undefined ? {} : { localAddress }),
      minVersion: 'TLSv1.2', rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    socket.once('error', failed);
    socket.once('secureConnect', () => {
      try {
        const identity = peerIdentity(socket);
        if (!probe && !timingSafeEqual(Buffer.from(identity.certificatePin, 'hex'), Buffer.from(certificatePin, 'hex'))) fail('TLS_PIN_MISMATCH', 'The TV certificate does not match the owner-enrolled pin.');
        if (probe) {
          socket.destroy();
          done(null, { host, port, certificatePin: identity.certificatePin, observedAt: new Date().toISOString(),
            validFrom: identity.certificate.valid_from ?? null, validTo: identity.certificate.valid_to ?? null,
            trust: 'unverified-first-observation', deviceIdentityVerified: false,
            note: 'First observation does not prove device identity. Factory-shared certificates/private keys and enrollment-time middlepersons remain possible.' });
        } else done(null, socket);
      } catch (error) { done(error); }
    });
  } catch (error) {
    if (error instanceof TVTLSError) done(error);
    else failed();
  }
  return () => done(new TVTLSError('TLS_CLIENT_CLOSED', 'The selected TV TLS connection was cancelled.'));
}

/** An agent scoped to one literal TV and required pin. HTTP receives the socket
 * only after authentication, so even HTTP Upgrade headers wait for the pin check.
 */
export function createPinnedTVAgent({ host, certificatePin, timeoutMs = 8000, localAddress } = {}) {
  host = localHost(host); certificatePin = normalizeCertificatePin(certificatePin); limits(443, timeoutMs);
  localAddress = sourceAddress(host, localAddress);
  const agent = new https.Agent({ keepAlive: false, maxSockets: 4 });
  const pending = new Set();
  let closed = false;
  const destroy = agent.destroy.bind(agent);
  agent.destroy = () => {
    if (closed) return;
    closed = true;
    for (const cancel of [...pending]) cancel();
    pending.clear(); destroy();
  };
  agent.createConnection = (options, callback) => {
    const requested = String(options.hostname ?? options.host ?? '').replace(/^\[|\]$/g, '');
    const port = Number(options.port ?? 443);
    try {
      if (closed) fail('TLS_CLIENT_CLOSED', 'The selected TV TLS agent is closed.');
      if (requested !== host) fail('TLS_TARGET_MISMATCH', 'The TLS agent is bound to one selected TV.');
      limits(port, timeoutMs);
      let cancel, finished = false;
      cancel = connectTLS({ host, port, timeoutMs, certificatePin, localAddress }, (error, socket) => {
        finished = true; pending.delete(cancel); callback(error, socket);
      });
      if (!finished) pending.add(cancel);
    } catch (error) { callback(error); }
    return undefined;
  };
  return agent;
}

/** Read-only enrollment aid: performs a TLS handshake and closes it without an
 * HTTP request, WebSocket upgrade, pairing, SSAP registration or key transmission.
 * An owner still has to trust/verify this first observation explicitly.
 */
export function probeTVIdentityCertificate({ host, port = 3001, timeoutMs = 8000, localAddress } = {}) {
  host = localHost(host); limits(port, timeoutMs);
  localAddress = sourceAddress(host, localAddress);
  return new Promise((resolve, reject) => connectTLS({ host, port, timeoutMs, localAddress, probe: true }, (error, value) => error ? reject(error) : resolve(value)));
}
