import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedLocalUrl, parseDescription, parseScpd, parseSsdp, parseStateVariables } from '../discover.mjs';
import { readSoap, sanitizeResponse, soapOutcome } from '../inspect-public.mjs';

test('SSDP headers are case insensitive and preserve a colon-containing LOCATION', () => {
  const packet = Buffer.from('HTTP/1.1 200 OK\r\nLoCaTiOn: http://192.168.77.80:1485/\r\nST: urn:lge-com:service:webos-second-screen:1\r\n\r\n');
  assert.equal(parseSsdp(packet, { address: '192.168.77.80' }).headers.location, 'http://192.168.77.80:1485/');
  assert.equal(parseSsdp(Buffer.from('NOTIFY * HTTP/1.1\r\n'), { address: '192.168.77.80' }), null);
});

test('embedded service schemas resolve relative URLs against advertised base', () => {
  const description = parseDescription('<root><URLBase>http://192.168.77.80:1255/</URLBase><device><friendlyName>LG &amp; TV</friendlyName><deviceList><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><SCPDURL>/av/scpd.xml</SCPDURL><controlURL>av/control</controlURL></service></serviceList></device></deviceList></device></root>', 'http://192.168.77.80:1255/root.xml');
  assert.equal(description.friendlyName, 'LG & TV');
  assert.equal(description.services[0].SCPDURL, 'http://192.168.77.80:1255/av/scpd.xml');
  assert.equal(description.services[0].controlURL, 'http://192.168.77.80:1255/av/control');
  const actions = parseScpd('<scpd><actionList><action><name>GetTransportInfo</name><argumentList><argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument></argumentList></action></actionList></scpd>');
  assert.deepEqual(actions, [{ name: 'GetTransportInfo', arguments: [{ name: 'InstanceID', direction: 'in', relatedStateVariable: 'A_ARG_TYPE_InstanceID' }] }]);
  const variables = parseStateVariables('<scpd><serviceStateTable><stateVariable sendEvents="yes"><name>TransportState</name><dataType>string</dataType><allowedValueList><allowedValue>PLAYING</allowedValue><allowedValue>STOPPED</allowedValue></allowedValueList></stateVariable></serviceStateTable></scpd>');
  assert.deepEqual(variables, [{ name: 'TransportState', dataType: 'string', allowedValues: ['PLAYING', 'STOPPED'] }]);
});

test('discovery will not follow an external or different-device descriptor', () => {
  assert.throws(() => checkedLocalUrl('https://example.com/descriptor'), /private LAN/);
  assert.throws(() => checkedLocalUrl('http://192.168.77.81/descriptor', '192.168.77.80'), /responding device/);
  assert.throws(() => checkedLocalUrl('file:///C:/secret'), /private LAN/);
});

test('inspection rejects playback mutations before any network request', async () => {
  await assert.rejects(readSoap({ serviceType: 'urn:schemas-upnp-org:service:AVTransport:1' }, 'Play'), /read-only/);
  await assert.rejects(readSoap({ serviceType: 'urn:schemas-upnp-org:service:RenderingControl:1' }, 'SetVolume'), /read-only/);
});

test('SOAP destination stays on the selected TV and faults are not counted as success', async () => {
  await assert.rejects(readSoap({ serviceType: 'urn:schemas-upnp-org:service:RenderingControl:1',
    actions: [{ name: 'GetMute', arguments: [] }], controlURL: 'http://192.168.77.81/control' }, 'GetMute', '192.168.77.80'), /responding device/);
  assert.equal(soapOutcome('GetMute', { status: 200, body: '<s:Fault><errorCode>606</errorCode><errorDescription>Action not authorized</errorDescription></s:Fault>' }).success, false);
  assert.equal(soapOutcome('GetMute', { status: 200, body: '<u:GetMuteResponse><CurrentMute>0</CurrentMute></u:GetMuteResponse>' }).success, true);
  assert.throws(() => parseScpd('<html>not a schema</html>'), /Unsupported SCPD/);
  assert.equal(parseScpd('<u:scpd><u:actionList><u:action><u:name>GetMute</u:name></u:action></u:actionList></u:scpd>')[0].name, 'GetMute');
});

test('DIAL report omits per-session metadata and authentication response headers', () => {
  const result = sanitizeResponse({ status: 200, headers: { 'content-type': 'text/xml', 'set-cookie': 'sensitive' },
    body: '<service><state>stopped</state><additionalData><session>secret</session></additionalData></service>' });
  assert.equal(result.headers['set-cookie'], undefined);
  assert.ok(!result.body.includes('secret'));
  assert.ok(result.body.includes('<state>stopped</state>'));
  const media = sanitizeResponse({ status: 200, headers: {}, body: '<CurrentURI>http://user:pass@host/file?token=secret</CurrentURI><d:additionalData>private</d:additionalData>' });
  assert.ok(!media.body.includes('secret'));
  assert.ok(!media.body.includes('private'));
});
