import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, chmodSync } from 'node:fs';
import path from 'node:path';

const JSON_LIMIT = 256 * 1024;
const FRAME_LIMIT = 10 * 1024 * 1024;
const FRAME_TOTAL_LIMIT = 32 * 1024 * 1024;
const STATES = new Set(['queued', 'running', 'confirmed', 'unconfirmed', 'failed', 'expired', 'unknown', 'cancelled']);
const FINISHED_STATES = new Set(['confirmed', 'unconfirmed', 'failed', 'expired', 'unknown', 'cancelled']);
const PATCH_FIELDS = new Set(['state', 'result', 'error', 'startedAt', 'finishedAt']);

export class HubStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HubStoreError';
    this.code = code;
  }
}

function invalid(field) {
  throw new HubStoreError('INVALID_INPUT', `Invalid hub store ${field}.`);
}

function text(value, field, { optional = false, max = 1024 } = {}) {
  if (optional && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0')) invalid(field);
  return value;
}

function timestamp(value, field, { optional = false } = {}) {
  if (optional && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) invalid(field);
  return new Date(value).toISOString();
}

function json(value, field) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { invalid(field); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > JSON_LIMIT) invalid(field);
  return encoded;
}

function object(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  return value;
}

function strings(value, field) {
  if (!Array.isArray(value) || value.length > 256) invalid(field);
  return [...new Set(value.map(item => text(item, field, { max: 256 })))];
}

function limit(value, fallback, max = 1000) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) invalid('limit');
  return value;
}

function grantMetadata(grant) {
  if (!grant) return null;
  const { tokenHash: _tokenHash, ...metadata } = grant;
  return metadata;
}

function frameMetadata(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    operationId: row.operation_id,
    mimeType: row.mime_type,
    byteLength: row.byte_length,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Durable hub state only. Opening this store never replays a device command.
 * Replay retains the newest 10,000 events globally; older cursors can have gaps.
 * Operations and their idempotency records are never pruned with the event journal.
 */
export class HubStore {
  #db;
  #filePath;
  #closed = false;

  constructor({ filePath } = {}) {
    text(filePath, 'file path', { max: 32768 });
    this.#filePath = filePath === ':memory:' ? null : path.resolve(filePath);
    try {
      if (this.#filePath) {
        mkdirSync(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
        try { closeSync(openSync(this.#filePath, 'wx', 0o600)); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        this.#permissions();
      }
      this.#db = new DatabaseSync(this.#filePath ?? ':memory:');
      this.#db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL, device_id TEXT, operation_id TEXT,
          data TEXT NOT NULL, at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_device ON events(device_id, id);
        CREATE TABLE IF NOT EXISTS snapshots (
          device_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS operations (
          id TEXT PRIMARY KEY, client_id TEXT NOT NULL, device_id TEXT NOT NULL,
          idempotency_key TEXT, request_hash TEXT NOT NULL,
          state TEXT NOT NULL, operation TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS operation_idempotency
          ON operations(client_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS operations_device ON operations(device_id, created_at);
        CREATE TABLE IF NOT EXISTS grants (
          id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
          grant_json TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS frames (
          id TEXT PRIMARY KEY, device_id TEXT NOT NULL, operation_id TEXT,
          bytes BLOB NOT NULL, mime_type TEXT NOT NULL, byte_length INTEGER NOT NULL,
          created_at TEXT NOT NULL, expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS frames_device ON frames(device_id, created_at);
      `);
      // secure_delete clears deleted SQLite cells, not historical WAL copies,
      // backups, filesystem snapshots, or physical-media traces: no forensic erasure guarantee.
      this.#permissions();
    } catch {
      try { this.#db?.close(); } catch { /* Keep the original failure private. */ }
      throw new HubStoreError('STORE_FAILURE', 'Could not open hub store.');
    }
  }

  #permissions() {
    if (!this.#filePath) return;
    for (const suffix of ['', '-wal', '-shm']) {
      try { chmodSync(this.#filePath + suffix, 0o600); } catch { /* Best effort on Windows. */ }
    }
  }

  #guard(fn) {
    if (this.#closed) throw new HubStoreError('STORE_CLOSED', 'Hub store is closed.');
    try { return fn(); }
    catch (error) {
      if (error instanceof HubStoreError) throw error;
      throw new HubStoreError('STORE_FAILURE', 'Hub store operation failed.');
    } finally { this.#permissions(); }
  }

  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* The transaction already failed. */ }
      throw error;
    }
  }

  #event({ type, deviceId = null, operationId = null, data = {}, at = new Date().toISOString() }) {
    const event = {
      type: text(type, 'event type', { max: 256 }),
      deviceId: text(deviceId, 'device ID', { optional: true, max: 256 }),
      operationId: text(operationId, 'operation ID', { optional: true, max: 256 }),
      data: JSON.parse(json(data, 'event data')),
      at: timestamp(at, 'event timestamp'),
    };
    const inserted = this.#db.prepare('INSERT INTO events(type, device_id, operation_id, data, at) VALUES (?, ?, ?, ?, ?)')
      .run(event.type, event.deviceId, event.operationId, json(event.data, 'event data'), event.at);
    this.#db.prepare('DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET 10000)').run();
    return { id: Number(inserted.lastInsertRowid), ...event };
  }

  appendEvent(event) {
    return this.#guard(() => this.#transaction(() => this.#event(object(event, 'event'))));
  }

  events({ afterId = 0, limit: requestedLimit, deviceIds } = {}) {
    return this.#guard(() => {
      if (!Number.isSafeInteger(afterId) || afterId < 0) invalid('event cursor');
      const count = limit(requestedLimit, 100);
      let sql = 'SELECT * FROM events WHERE id > ?';
      const values = [afterId];
      if (deviceIds !== undefined) {
        const ids = strings(deviceIds, 'device IDs');
        if (!ids.length) return [];
        sql += ` AND device_id IN (${ids.map(() => '?').join(',')})`;
        values.push(...ids);
      }
      sql += ' ORDER BY id ASC LIMIT ?';
      values.push(count);
      return this.#db.prepare(sql).all(...values).map(row => ({
        id: row.id, type: row.type, deviceId: row.device_id, operationId: row.operation_id,
        data: JSON.parse(row.data), at: row.at,
      }));
    });
  }

  putSnapshot(deviceId, snapshot) {
    return this.#guard(() => {
      text(deviceId, 'device ID', { max: 256 });
      const encoded = json(snapshot, 'snapshot');
      this.#db.prepare('INSERT INTO snapshots(device_id, snapshot) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET snapshot = excluded.snapshot')
        .run(deviceId, encoded);
      return JSON.parse(encoded);
    });
  }

  getSnapshot(deviceId) {
    return this.#guard(() => {
      text(deviceId, 'device ID', { max: 256 });
      const row = this.#db.prepare('SELECT snapshot FROM snapshots WHERE device_id = ?').get(deviceId);
      return row ? JSON.parse(row.snapshot) : null;
    });
  }

  #operation(id) {
    const row = this.#db.prepare('SELECT operation FROM operations WHERE id = ?').get(id);
    return row ? JSON.parse(row.operation) : null;
  }

  createOperation(input) {
    return this.#guard(() => {
      object(input, 'operation');
      const now = new Date().toISOString();
      const operation = {
        id: text(input.id, 'operation ID', { max: 256 }),
        clientId: text(input.clientId, 'client ID', { max: 256 }),
        deviceId: text(input.deviceId, 'device ID', { max: 256 }),
        action: text(input.action, 'action', { max: 256 }),
        args: input.args ?? {},
        idempotencyKey: text(input.idempotencyKey, 'idempotency key', { optional: true }),
        deadlineAt: timestamp(input.deadlineAt, 'deadline', { optional: true }),
        requestHash: text(input.requestHash, 'request hash', { max: 256 }),
        state: 'queued', createdAt: now, updatedAt: now,
        startedAt: null, finishedAt: null, result: null, error: null,
      };
      const encoded = json(operation, 'operation');
      return this.#transaction(() => {
        if (operation.idempotencyKey !== null) {
          const existing = this.#db.prepare('SELECT operation FROM operations WHERE client_id = ? AND idempotency_key = ?')
            .get(operation.clientId, operation.idempotencyKey);
          if (existing) {
            const original = JSON.parse(existing.operation);
            if (original.requestHash !== operation.requestHash) {
              throw new HubStoreError('IDEMPOTENCY_CONFLICT', 'Idempotency key already belongs to a different request.');
            }
            return { operation: original, created: false };
          }
        }
        if (this.#operation(operation.id)) throw new HubStoreError('OPERATION_EXISTS', 'Operation ID already exists.');
        this.#db.prepare('INSERT INTO operations(id, client_id, device_id, idempotency_key, request_hash, state, operation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(operation.id, operation.clientId, operation.deviceId, operation.idempotencyKey, operation.requestHash, operation.state, encoded, now);
        this.#event({ type: 'operation.created', deviceId: operation.deviceId, operationId: operation.id, data: { state: operation.state }, at: now });
        return { operation: JSON.parse(encoded), created: true };
      });
    });
  }

  getOperation(id) {
    return this.#guard(() => this.#operation(text(id, 'operation ID', { max: 256 })));
  }

  findOperationByIdempotency(clientId, key) {
    return this.#guard(() => {
      text(clientId, 'client ID', { max: 256 });
      text(key, 'idempotency key');
      const row = this.#db.prepare('SELECT operation FROM operations WHERE client_id = ? AND idempotency_key = ?')
        .get(clientId, key);
      return row ? JSON.parse(row.operation) : null;
    });
  }

  #updateOperation(id, patch, eventType = 'operation.updated') {
    const previous = this.#operation(id);
    if (!previous) return null;
    const now = new Date().toISOString();
    const next = { ...previous, ...patch, updatedAt: now };
    // A duplicate or later evidence update must not rewrite the execution clocks.
    next.startedAt = previous.startedAt ?? patch.startedAt ?? (next.state === 'running' ? now : null);
    next.finishedAt = previous.finishedAt ?? patch.finishedAt ?? (FINISHED_STATES.has(next.state) ? now : null);
    const encoded = json(next, 'operation');
    this.#db.prepare('UPDATE operations SET state = ?, operation = ? WHERE id = ?').run(next.state, encoded, id);
    this.#event({ type: eventType, deviceId: next.deviceId, operationId: id,
      data: { state: next.state, previousState: previous.state }, at: now });
    return JSON.parse(encoded);
  }

  updateOperation(id, patch) {
    return this.#guard(() => {
      text(id, 'operation ID', { max: 256 });
      object(patch, 'operation patch');
      for (const key of Object.keys(patch)) if (!PATCH_FIELDS.has(key)) invalid('operation patch');
      if (Object.hasOwn(patch, 'state') && !STATES.has(patch.state)) invalid('operation state');
      const validated = { ...patch };
      for (const field of ['startedAt', 'finishedAt']) {
        if (Object.hasOwn(validated, field)) validated[field] = timestamp(validated[field], field, { optional: true });
      }
      json(validated, 'operation patch');
      return this.#transaction(() => this.#updateOperation(id, validated));
    });
  }

  listOperations({ deviceId, limit: requestedLimit } = {}) {
    return this.#guard(() => {
      const count = limit(requestedLimit, 100);
      const rows = deviceId === undefined
        ? this.#db.prepare('SELECT operation FROM operations ORDER BY created_at DESC, rowid DESC LIMIT ?').all(count)
        : this.#db.prepare('SELECT operation FROM operations WHERE device_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
          .all(text(deviceId, 'device ID', { max: 256 }), count);
      return rows.map(row => JSON.parse(row.operation));
    });
  }

  recoverInterrupted() {
    return this.#guard(() => this.#transaction(() => {
      const rows = this.#db.prepare("SELECT id, state FROM operations WHERE state IN ('queued', 'running') ORDER BY created_at ASC, rowid ASC").all();
      return rows.map(row => this.#updateOperation(row.id, {
        state: row.state === 'queued' ? 'cancelled' : 'unknown',
        error: { code: 'HUB_RESTARTED', message: row.state === 'queued'
          ? 'Hub restarted before dispatch; command was not replayed.'
          : 'Hub restarted during execution; device outcome is unknown and command was not replayed.' },
      }, 'operation.recovered'));
    }));
  }

  putGrant(input) {
    return this.#guard(() => {
      object(input, 'grant');
      const grant = {
        id: text(input.id, 'grant ID', { max: 256 }),
        tokenHash: text(input.tokenHash, 'token hash', { max: 256 }),
        label: text(input.label, 'grant label', { max: 256 }),
        deviceIds: strings(input.deviceIds, 'device IDs'),
        capabilities: strings(input.capabilities, 'capabilities'),
        expiresAt: timestamp(input.expiresAt, 'grant expiry', { optional: true }),
        createdAt: timestamp(input.createdAt ?? new Date().toISOString(), 'grant timestamp'),
        revokedAt: timestamp(input.revokedAt, 'grant revocation', { optional: true }),
      };
      const encoded = json(grant, 'grant');
      this.#db.prepare('INSERT INTO grants(id, token_hash, grant_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, grant_json = excluded.grant_json, created_at = excluded.created_at')
        .run(grant.id, grant.tokenHash, encoded, grant.createdAt);
      return grantMetadata(JSON.parse(encoded));
    });
  }

  getGrantByHash(hash) {
    return this.#guard(() => {
      text(hash, 'token hash', { max: 256 });
      const row = this.#db.prepare('SELECT grant_json FROM grants WHERE token_hash = ?').get(hash);
      return row ? JSON.parse(row.grant_json) : null;
    });
  }

  listGrants() {
    return this.#guard(() => this.#db.prepare('SELECT grant_json FROM grants ORDER BY created_at DESC, rowid DESC').all()
      .map(row => grantMetadata(JSON.parse(row.grant_json))));
  }

  revokeGrant(id) {
    return this.#guard(() => {
      text(id, 'grant ID', { max: 256 });
      return this.#transaction(() => {
        const row = this.#db.prepare('SELECT grant_json FROM grants WHERE id = ?').get(id);
        if (!row) return null;
        const grant = JSON.parse(row.grant_json);
        grant.revokedAt ??= new Date().toISOString();
        this.#db.prepare('UPDATE grants SET grant_json = ? WHERE id = ?').run(json(grant, 'grant'), id);
        return grantMetadata(grant);
      });
    });
  }

  putFrame(input) {
    return this.#guard(() => {
      object(input, 'frame');
      if (!Buffer.isBuffer(input.bytes) || input.bytes.length < 1 || input.bytes.length > FRAME_LIMIT) invalid('frame bytes');
      if (input.mimeType !== 'image/jpeg') invalid('frame MIME type');
      const frame = {
        id: text(input.id, 'frame ID', { max: 256 }),
        deviceId: text(input.deviceId, 'device ID', { max: 256 }),
        operationId: text(input.operationId, 'operation ID', { optional: true, max: 256 }),
        mimeType: input.mimeType, byteLength: input.bytes.length,
        createdAt: timestamp(input.createdAt ?? new Date().toISOString(), 'frame timestamp'),
        expiresAt: timestamp(input.expiresAt, 'frame expiry'),
      };
      if (Date.parse(frame.expiresAt) < Date.parse(frame.createdAt)) invalid('frame expiry');
      return this.#transaction(() => {
        this.#db.prepare('INSERT INTO frames(id, device_id, operation_id, bytes, mime_type, byte_length, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(frame.id, frame.deviceId, frame.operationId, input.bytes, frame.mimeType, frame.byteLength, frame.createdAt, frame.expiresAt);
        this.#pruneFrames(5, FRAME_TOTAL_LIMIT);
        return frame;
      });
    });
  }

  getFrame(id) {
    return this.#guard(() => {
      text(id, 'frame ID', { max: 256 });
      const row = this.#db.prepare('SELECT * FROM frames WHERE id = ?').get(id);
      if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
      return { ...frameMetadata(row), bytes: Buffer.from(row.bytes) };
    });
  }

  #pruneFrames(perDevice, maxBytes) {
    const rows = this.#db.prepare('SELECT rowid, id, device_id, byte_length, created_at, expires_at FROM frames ORDER BY created_at DESC, rowid DESC').all();
    const counts = new Map();
    const keep = [];
    const remove = new Set();
    const now = Date.now();
    for (const row of rows) {
      const count = counts.get(row.device_id) ?? 0;
      if (Date.parse(row.expires_at) <= now || count >= perDevice) remove.add(row.id);
      else { counts.set(row.device_id, count + 1); keep.push(row); }
    }
    let total = keep.reduce((sum, row) => sum + row.byte_length, 0);
    for (let i = keep.length - 1; total > maxBytes && i >= 0; i -= 1) {
      remove.add(keep[i].id);
      total -= keep[i].byte_length;
    }
    const statement = this.#db.prepare('DELETE FROM frames WHERE id = ?');
    for (const id of remove) statement.run(id);
    return remove.size;
  }

  pruneFrames({ perDevice = 5, maxBytes = FRAME_TOTAL_LIMIT } = {}) {
    return this.#guard(() => {
      limit(perDevice, 5, 5);
      limit(maxBytes, FRAME_TOTAL_LIMIT, FRAME_TOTAL_LIMIT);
      return this.#transaction(() => this.#pruneFrames(perDevice, maxBytes));
    });
  }

  close() {
    if (this.#closed) return;
    this.#guard(() => this.#db.close());
    this.#closed = true;
  }
}
