import test from 'node:test';
import assert from 'node:assert/strict';
import { receiveProbeImage } from '../lib/probe-image.mjs';

const jpeg = Buffer.from([255, 216, 255, 0, 128, 1, 255, 217]);
function multipart(parts, ending = '--\r\n') {
  return Buffer.concat([Buffer.from('--test-boundary\r\n'), ...parts.flatMap((part, index) => [
    ...(index ? [Buffer.from('\r\n--test-boundary\r\n')] : []),
    Buffer.from(`Content-Disposition: form-data; name="${part.name}"; filename="ignored.jpg"\r\nContent-Type: ${part.type ?? 'image/jpeg'}\r\n\r\n`),
    part.bytes ?? jpeg,
  ]), Buffer.from(`\r\n--test-boundary${ending}`)]);
}
const type = 'multipart/form-data; boundary=test-boundary';
test('preserves raw JPEG bytes', () => assert.deepEqual(receiveProbeImage(jpeg, 'image/jpeg'), jpeg));
test('extracts exactly the multipart capture, ignoring untrusted names and extra fields', () => {
  const body = multipart([{ name: 'runId', type: 'text/plain', bytes: Buffer.from('test') }, { name: 'capture' }]);
  assert.deepEqual(receiveProbeImage(body, type), jpeg);
});
test('rejects duplicate, wrong type, missing capture and truncated uploads', () => {
  for (const [body, contentType] of [
    [multipart([{name:'capture'}, {name:'capture'}]), type],
    [multipart([{name:'capture',type:'text/html'}]), type],
    [multipart([{name:'other'}]), type],
    [multipart([{name:'capture'}], ''), type],
    [jpeg.subarray(0, -1), 'image/jpeg'],
    [jpeg, 'text/html'],
  ]) assert.throws(() => receiveProbeImage(body, contentType));
});
