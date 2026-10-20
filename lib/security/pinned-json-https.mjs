import https from 'node:https';
import tls from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import { types } from 'node:util';

export class PinnedJsonError extends Error {
  constructor(code, dispatched = false) {
    super('The enrolled HTTPS integration request could not complete.');
    this.name = 'PinnedJsonError'; this.code = code; this.dispatched = dispatched;
  }
}
const fail = code => { throw new PinnedJsonError(code); };
function data(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail('INVALID_HTTPS_CONFIG');
  const entries = Object.getOwnPropertyDescriptors(value);
  if (Object.entries(entries).some(([key, descriptor]) => !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable || ['__proto__', 'prototype', 'constructor'].includes(key))) fail('INVALID_HTTPS_CONFIG');
  return value;
}

/** Owner-enrolled leaf trust, never automatic TOFU or a TLS downgrade. */
export function validatePinnedJsonIdentity(options = {}) {
  data(options);
  if (Object.keys(options).some(key => !['origin', 'certificate', 'certificatePin'].includes(key))) fail('INVALID_HTTPS_CONFIG');
  const { origin, certificate, certificatePin } = options;
  if (typeof origin !== 'string' || typeof certificate !== 'string' || typeof certificatePin !== 'string') fail('INVALID_HTTPS_CONFIG');
  let url, cert;
  try { url = new URL(origin); } catch { fail('INVALID_HTTPS_CONFIG'); }
  if (typeof origin !== 'string' || origin.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || ![url.origin, url.origin + '/'].includes(origin)) fail('INVALID_HTTPS_CONFIG');
  if (typeof certificate !== 'string' || Buffer.byteLength(certificate) > 16384 || certificate.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)?.length !== 1 || certificate.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim() || !/^[a-f0-9]{64}$/.test(certificatePin ?? '')) fail('INVALID_HTTPS_CONFIG');
  try { cert = new X509Certificate(certificate); } catch { fail('INVALID_HTTPS_CONFIG'); }
  if (createHash('sha256').update(cert.raw).digest('hex') !== certificatePin) fail('TLS_IDENTITY_MISMATCH');
  if (!Number.isFinite(Date.parse(cert.validFrom)) || !Number.isFinite(Date.parse(cert.validTo)) || Date.now() < Date.parse(cert.validFrom) || Date.now() > Date.parse(cert.validTo)) fail('TLS_IDENTITY_EXPIRED');
  return Object.freeze({ origin: url.origin, certificate, certificatePin });
}

/** Fixed-origin JSON transport. Callers own the smaller endpoint/action allowlist. */
export function createPinnedJsonClient(options = {}) {
  data(options);
  if (Object.keys(options).some(key => !['origin', 'certificate', 'certificatePin', 'timeoutMs', 'maxBytes'].includes(key))) fail('INVALID_HTTPS_CONFIG');
  const identity = validatePinnedJsonIdentity({ origin: options.origin, certificate: options.certificate, certificatePin: options.certificatePin });
  const timeoutMs = options.timeoutMs ?? 8000, maxBytes = options.maxBytes ?? 65536;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000 || !Number.isSafeInteger(maxBytes) || maxBytes < 64 || maxBytes > 262144) fail('INVALID_HTTPS_CONFIG');
  const target = new URL(identity.origin), pending = new Set(); let closed = false;
  return Object.freeze({
    request(input = {}) {
      data(input);
      if (closed) return Promise.reject(new PinnedJsonError('INTEGRATION_CLOSED'));
      if (Object.keys(input).some(key => !['method', 'path', 'headers', 'body', 'deadlineAt', 'signal', 'beforeDispatch'].includes(key))) fail('INVALID_HTTPS_REQUEST');
      const { method, path, body, deadlineAt, signal, beforeDispatch } = input;
      // Native debug output can include authorization headers before our error
      // sanitizer runs. Fail before constructing a socket or request options.
      if (['DEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE'].some(key => typeof process.env[key] === 'string' && process.env[key].trim())) fail('UNSAFE_DIAGNOSTICS');
      const aborted = () => signal === undefined ? false : Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(signal);
      if (signal !== undefined) {
        if (!signal || typeof signal !== 'object' || types.isProxy(signal)) fail('INVALID_HTTPS_REQUEST');
        try { aborted(); } catch { fail('INVALID_HTTPS_REQUEST'); }
      }
      if (!['GET', 'POST'].includes(method) || typeof path !== 'string' || path.length > 2048 || !/^\/api\/[A-Za-z0-9_./-]+$/.test(path) || path.includes('//') || path.split('/').some(part => part === '.' || part === '..') || (method === 'GET' && body !== undefined) || (beforeDispatch !== undefined && typeof beforeDispatch !== 'function')) fail('INVALID_HTTPS_REQUEST');
      const headers = data(input.headers ?? {});
      if (Object.keys(headers).some(key => !['authorization', 'accept', 'content-type'].includes(key.toLowerCase())) || new Set(Object.keys(headers).map(key => key.toLowerCase())).size !== Object.keys(headers).length || Object.values(headers).some(value => typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value))) fail('INVALID_HTTPS_REQUEST');
      let payload;
      try { if (body !== undefined) payload = Buffer.from(JSON.stringify(data(body)), 'utf8'); } catch { fail('INVALID_HTTPS_REQUEST'); }
      if (payload?.length > maxBytes) { payload.fill(0); fail('HTTPS_BODY_TOO_LARGE'); }
      if (deadlineAt !== undefined && (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0)) { payload?.fill(0); fail('INVALID_HTTPS_REQUEST'); }
      const budget = deadlineAt === undefined ? timeoutMs : Math.min(timeoutMs, deadlineAt - Date.now());
      if (budget <= 0) { payload?.fill(0); return Promise.reject(new PinnedJsonError('DEADLINE_EXCEEDED')); }
      if (aborted()) { payload?.fill(0); return Promise.reject(new PinnedJsonError('INTEGRATION_ABORTED')); }
      return new Promise((resolve, reject) => {
        let request, response, timer, settled = false, dispatched = false;
        const finish = (error, value) => {
          if (settled) return; settled = true;
          clearTimeout(timer); pending.delete(cancel);
          if (signal !== undefined) EventTarget.prototype.removeEventListener.call(signal, 'abort', abort);
          response?.destroy(); request?.destroy(); payload?.fill(0);
          if (error) reject(error); else resolve(value);
        };
        const rejectCode = code => finish(new PinnedJsonError(code, dispatched));
        const cancel = () => rejectCode('INTEGRATION_CLOSED');
        const abort = () => rejectCode('INTEGRATION_ABORTED');
        pending.add(cancel);
        if (signal !== undefined) EventTarget.prototype.addEventListener.call(signal, 'abort', abort, { once: true });
        timer = setTimeout(() => rejectCode('HTTPS_TIMEOUT'), budget);
        try {
          request = https.request({
            protocol: 'https:', hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 443,
            method, path, agent: false, ca: identity.certificate, allowPartialTrustChain: true,
            rejectUnauthorized: true, minVersion: 'TLSv1.2', maxHeaderSize: 16384,
            checkServerIdentity(host, peer) {
              const hostnameError = tls.checkServerIdentity(host, peer);
              if (hostnameError) return hostnameError;
              if (!peer.raw || createHash('sha256').update(peer.raw).digest('hex') !== identity.certificatePin) return new PinnedJsonError('TLS_IDENTITY_MISMATCH');
            },
            headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
          }, incoming => {
            response = incoming;
            if (incoming.statusCode >= 300 && incoming.statusCode < 400) return rejectCode('HTTPS_REDIRECT_DENIED');
            if ([401, 403].includes(incoming.statusCode)) return rejectCode('INTEGRATION_ACCESS_DENIED');
            if (incoming.statusCode === 429) return rejectCode('INTEGRATION_RATE_LIMITED');
            if (incoming.statusCode < 200 || incoming.statusCode >= 300) return rejectCode('HTTPS_STATUS_ERROR');
            if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') return rejectCode('HTTPS_ENCODING_DENIED');
            if (!/^application\/json(?:\s*;|$)/i.test(incoming.headers['content-type'] ?? '')) return rejectCode('HTTPS_CONTENT_TYPE_DENIED');
            const length = incoming.headers['content-length'];
            if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return rejectCode('HTTPS_BODY_TOO_LARGE');
            const chunks = []; let size = 0;
            incoming.on('data', chunk => { size += chunk.length; if (size > maxBytes) return rejectCode('HTTPS_BODY_TOO_LARGE'); chunks.push(chunk); });
            incoming.once('error', () => rejectCode('HTTPS_RESPONSE_FAILED'));
            incoming.once('aborted', () => rejectCode('HTTPS_RESPONSE_FAILED'));
            incoming.once('end', () => {
              if (settled) return;
              const bytes = Buffer.concat(chunks, size);
              try { finish(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
              catch { rejectCode('HTTPS_JSON_INVALID'); }
              finally { bytes.fill(0); chunks.forEach(chunk => chunk.fill(0)); }
            });
          });
          request.once('error', () => rejectCode('HTTPS_CONNECTION_FAILED'));
          request.once('socket', socket => socket.once('secureConnect', () => {
            if (settled || closed || aborted()) return rejectCode('INTEGRATION_CLOSED');
            const peer = socket.getPeerCertificate();
            if (!socket.authorized || !peer.raw || createHash('sha256').update(peer.raw).digest('hex') !== identity.certificatePin) return rejectCode('TLS_IDENTITY_MISMATCH');
            if (deadlineAt !== undefined && Date.now() >= deadlineAt) return rejectCode('DEADLINE_EXCEEDED');
            try {
              const result = beforeDispatch?.();
              if (result && typeof result.then === 'function') return rejectCode('INVALID_DISPATCH_CALLBACK');
            } catch (error) { return finish(error); }
            if (settled || closed || aborted()) return rejectCode('INTEGRATION_CLOSED');
            dispatched = true; request.end(payload);
          }));
        } catch { rejectCode('HTTPS_CONNECTION_FAILED'); }
      });
    },
    close() { closed = true; for (const cancel of [...pending]) cancel(); },
  });
}
