import { Duplex, Transform } from 'node:stream';

const MAX_FRAME = 1024;
const NOOP = () => {};
export class MQTTWireError extends Error {
  constructor(code) { super('The MQTT transport rejected an invalid or oversized frame.'); this.name = 'MQTTWireError'; this.code = code; }
}

/** A complete frame is bounded before any of its bytes reach the SDK parser. */
export class MQTTFrameGuard extends Transform {
  #frame = Buffer.alloc(MAX_FRAME); #position = 0; #length = 0; #digits = 0; #multiplier = 1; #expected;
  #pending; #blocked = false; #draining = false;
  constructor() { super({ readableHighWaterMark: MAX_FRAME, writableHighWaterMark: MAX_FRAME }); }
  #reset() { this.#position = 0; this.#length = 0; this.#digits = 0; this.#multiplier = 1; this.#expected = undefined; }
  _transform(chunk, encoding, callback) { this.#pending = { chunk, offset: 0, callback }; this.#drain(); }
  _read(size) { super._read(size); this.#blocked = false; this.#drain(); }
  #drain() {
    if (this.#draining || this.#blocked || !this.#pending || this.destroyed) return;
    this.#draining = true;
    try {
      const pending = this.#pending;
      while (pending.offset < pending.chunk.length) {
        if (this.#position === 0) {
          const first = pending.chunk[pending.offset++], kind = first >> 4, flags = first & 15;
          if (kind === 0 || kind === 15 || (kind === 3 ? ((flags >> 1) & 3) === 3 : flags !== ([6, 8, 10].includes(kind) ? 2 : 0))) throw new MQTTWireError('MQTT_FRAME_INVALID');
          this.#frame[this.#position++] = first;
        } else if (this.#expected === undefined) {
          const digit = pending.chunk[pending.offset++]; this.#frame[this.#position++] = digit; this.#digits++;
          this.#length += (digit & 127) * this.#multiplier;
          if (1 + this.#digits + this.#length > MAX_FRAME) throw new MQTTWireError('MQTT_FRAME_TOO_LARGE');
          if (digit & 128) {
            if (this.#digits === 4) throw new MQTTWireError('MQTT_FRAME_INVALID');
            this.#multiplier *= 128;
            continue;
          }
          if (this.#digits > 1 && digit === 0) throw new MQTTWireError('MQTT_FRAME_INVALID');
          this.#expected = 1 + this.#digits + this.#length;
        } else {
          const count = Math.min(this.#expected - this.#position, pending.chunk.length - pending.offset);
          pending.chunk.copy(this.#frame, this.#position, pending.offset, pending.offset + count);
          pending.offset += count; this.#position += count;
        }
        if (this.#expected !== undefined && this.#position === this.#expected) {
          const frame = Buffer.from(this.#frame.subarray(0, this.#position)); this.#reset();
          if (!this.push(frame)) {
            this.#blocked = true;
            // Transform itself owns backpressure once this input chunk is fully consumed.
            if (pending.offset === pending.chunk.length) { this.#pending = undefined; pending.callback(); }
            return;
          }
        }
      }
      this.#pending = undefined; pending.callback();
    } catch (error) {
      const pending = this.#pending; this.#pending = undefined; pending?.callback(error);
    } finally { this.#draining = false; }
  }
  _flush(callback) { callback(this.#position ? new MQTTWireError('MQTT_FRAME_TRUNCATED') : undefined); }
  _destroy(error, callback) {
    const pending = this.#pending; this.#pending = undefined; this.#frame.fill(0);
    pending?.callback(error ?? new MQTTWireError('MQTT_TRANSPORT_CLOSED')); callback(error);
  }
}

/** The SDK receives this duplex, never the unbounded raw TLS readable side. */
export function createMQTTWireTransport(socket) {
  const guard = new MQTTFrameGuard(); let pumping = false; let blocked = false;
  const transport = new Duplex({ readableHighWaterMark: MAX_FRAME, writableHighWaterMark: MAX_FRAME,
    read() { blocked = false; pump(); },
    write(chunk, encoding, callback) { socket.write(chunk, encoding, callback); },
    final(callback) { socket.end(callback); },
    destroy(error, callback) {
      socket.unpipe(guard); guard.removeListener('readable', pump); guard.removeListener('end', end);
      guard.removeListener('error', failed); socket.removeListener('error', failed); socket.removeListener('close', closed);
      guard.on('error', NOOP); socket.on('error', NOOP);
      guard.destroy(); socket.destroy(); callback(error);
    },
  });
  function pump() {
    if (pumping || blocked || transport.destroyed) return; pumping = true;
    try { let chunk; while ((chunk = guard.read()) !== null) { if (!transport.push(chunk)) { blocked = true; break; } } }
    finally { pumping = false; }
  }
  function failed(error) {
    const code = typeof error?.code === 'string' && /^[A-Z_]{2,64}$/.test(error.code) ? error.code : 'MQTT_TRANSPORT_FAILED';
    transport.destroy(new MQTTWireError(code));
  }
  function end() { transport.push(null); }
  function closed() { if (!transport.destroyed) transport.destroy(); }
  guard.on('readable', pump); guard.on('end', end); guard.on('error', failed);
  socket.on('error', failed); socket.on('close', closed); socket.pipe(guard);
  return transport;
}
