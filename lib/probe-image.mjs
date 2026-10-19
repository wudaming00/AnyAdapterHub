// The receiver accepts one owned screenshot, either as raw JPEG or as the
// Download Manager's multipart upload. It never trusts uploaded filenames.
export function receiveProbeImage(body, contentType = '') {
  if (!Buffer.isBuffer(body)) throw new Error('Expected a bounded byte buffer.');
  let jpeg = body;
  if (/^multipart\/form-data\b/i.test(contentType)) {
    const match = /boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(contentType);
    const boundary = match?.[1] ?? match?.[2];
    if (!boundary || boundary.length > 70 || !/^[\x20-\x7e]+$/.test(boundary)) throw new Error('Invalid multipart boundary.');
    const marker = Buffer.from(`--${boundary}`);
    const next = Buffer.from(`\r\n--${boundary}`);
    if (!body.subarray(0, marker.length).equals(marker)) throw new Error('Invalid multipart start.');
    let cursor = marker.length;
    let captured;
    let parts = 0;
    for (;;) {
      if (body.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) {
        const tail = body.subarray(cursor + 2);
        if (tail.length && !tail.equals(Buffer.from('\r\n'))) throw new Error('Invalid multipart ending.');
        break;
      }
      if (++parts > 8 || !body.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n'))) throw new Error('Invalid multipart parts.');
      cursor += 2;
      const headerEnd = body.indexOf('\r\n\r\n', cursor);
      if (headerEnd < 0 || headerEnd - cursor > 8192) throw new Error('Invalid multipart headers.');
      const headers = body.subarray(cursor, headerEnd).toString('latin1');
      const disposition = /^content-disposition:\s*form-data;([^\r\n]*)$/im.exec(headers)?.[1];
      const name = /(?:^|;)\s*name="([^"\r\n]*)"/i.exec(disposition ?? '')?.[1];
      const end = body.indexOf(next, headerEnd + 4);
      if (end < 0) throw new Error('Unterminated multipart body.');
      if (name === 'capture') {
        if (captured) throw new Error('Duplicate capture part.');
        if (!/^content-type:\s*image\/jpeg\s*$/im.test(headers)) throw new Error('Unexpected capture type.');
        captured = body.subarray(headerEnd + 4, end);
      }
      cursor = end + 2 + marker.length;
    }
    if (!captured) throw new Error('Missing capture part.');
    jpeg = captured;
  } else if (!/^image\/jpeg(?:\s*;|\s*$)/i.test(contentType)) {
    throw new Error('Expected JPEG content type.');
  }
  if (jpeg.length < 4 || jpeg.length > 10 * 1024 * 1024 || jpeg[0] !== 255 || jpeg[1] !== 216 || jpeg.at(-2) !== 255 || jpeg.at(-1) !== 217) {
    throw new Error('Invalid or incomplete JPEG.');
  }
  return jpeg;
}
