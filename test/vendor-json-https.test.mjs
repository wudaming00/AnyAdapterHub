import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createVendorJsonClient } from '../lib/security/vendor-json-https.mjs';
import { createPinnedJsonClient } from '../lib/security/pinned-json-https.mjs';
import { testIdentity, testSecretStore } from './helpers/secrets.mjs';

const fixtures=[
  ['switchbot','api.switch-bot.com','/v1.1/devices/AABBCCDDEEFF/status',{Authorization:'synthetic-token',sign:'synthetic-sign',t:'1',nonce:'synthetic-nonce'}],
  ['lg-thinq-aic','api-aic.lgthinq.com','/devices/00000000-0000-4000-8000-000000000001/state',{'x-api-key':'synthetic-api-key','x-country':'US'}],
  ['awair','developer-apis.awair.is','/v1/users/self/devices/awair-element/1/air-data/latest?fahrenheit=false',{Authorization:'Bearer synthetic-token'}],
  ['purpleair','api.purpleair.com','/v1/sensors/1?fields=last_seen,temperature,humidity,pm2.5_atm',{'X-API-Key':'synthetic-api-key'}],
];
function intercepted(t,{authorized=true,subject}={}){
  const calls=[];let sent=0,guards=0;
  t.mock.method(https,'request',(options,respond)=>{
    calls.push(options);const request=new EventEmitter();request.destroy=()=>{};
    request.end=()=>{sent++;const response=new EventEmitter();response.statusCode=200;response.headers={'content-type':'application/json'};response.destroy=()=>{};respond(response);queueMicrotask(()=>{response.emit('data',Buffer.from('{"fixture":true}'));response.emit('end');});};
    queueMicrotask(()=>{const socket=new EventEmitter();socket.authorized=authorized;socket.getPeerCertificate=()=>({subjectaltname:`DNS:${subject??options.hostname}`});request.emit('socket',socket);socket.emit('secureConnect');});
    return request;
  });
  return{calls,sent:()=>sent,guard:()=>{guards++;},guards:()=>guards};
}
test('vendor policies fix origin, GET route and credential headers while retaining system trust',async t=>{
  const f=intercepted(t);
  for(const[vendor,host,path,headers]of fixtures){const client=createVendorJsonClient(vendor);assert.deepEqual(await client.request({method:'GET',path,headers,beforeDispatch:f.guard}),{fixture:true});client.close();assert.equal(f.calls.at(-1).hostname,host);assert.equal(f.calls.at(-1).rejectUnauthorized,true);assert.equal(f.calls.at(-1).ca,undefined);assert.equal(f.calls.at(-1).minVersion,'TLSv1.2');}
  assert.equal(f.sent(),4);assert.equal(f.guards(),4);
});
test('unauthorized TLS or wrong vendor hostname sends zero authenticated application requests',async t=>{
  for(const options of [{authorized:false},{subject:'unrelated.fixture.invalid'}]){
    const f=intercepted(t,options),client=createVendorJsonClient('switchbot');
    await assert.rejects(client.request({method:'GET',path:fixtures[0][2],headers:fixtures[0][3]}),e=>e.code==='TLS_IDENTITY_MISMATCH'&&e.dispatched===false);assert.equal(f.sent(),0);client.close();
  }
});
test('fixed cloud clients deny write, path/query/header/origin and TLS overrides before socket construction',()=>{
  for(const[vendor,,path]of fixtures){const client=createVendorJsonClient(vendor);for(const input of [{method:'POST',path},{method:'GET',path:path+'&read_key=forbidden'},{method:'GET',path:'https://other.invalid/api'},{method:'GET',path,headers:{Host:'other.invalid'}},{method:'GET',path,allowAuthChallenge:true}])assert.throws(()=>client.request(input));client.close();}
  for(const options of [{origin:'https://other.invalid'},{rejectUnauthorized:false},{ca:'other'},{certificateName:'other'}])assert.throws(()=>createVendorJsonClient('switchbot',options));
  assert.throws(()=>createVendorJsonClient('arbitrary-url'));
});
test('pinned policies cannot widen default HA routes and reject executable nested bodies and identity overrides',async()=>{
  const identity=await testIdentity(testSecretStore()),config={origin:'https://127.0.0.1:1',certificate:identity.certificate,certificatePin:identity.certificatePin};let ran=0;
  const client=createPinnedJsonClient(config);
  assert.throws(()=>client.request({method:'PUT',path:'/clip/v2/resource/light/00000000-0000-4000-8000-000000000001'}));
  for(const value of [{get secret(){ran++;return'never';}},{toJSON(){ran++;return{};}},new Proxy({},{ownKeys(){ran++;return[];}})])assert.throws(()=>client.request({method:'POST',path:'/api/services/light/turn_on',body:{nested:value}}));
  assert.equal(ran,0);client.close();
  for(const policy of ['home-assistant','shelly-gen2','plex','openhab'])assert.throws(()=>createPinnedJsonClient({...config,policy,certificateName:'001788fffe123456'}));
  assert.throws(()=>createPinnedJsonClient({...config,policy:'switchbot'}));
});
