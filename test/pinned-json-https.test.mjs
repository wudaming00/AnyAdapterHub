import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createSecretStore } from '../lib/security/secret-store.mjs';
import { createHubIdentityManager } from '../lib/security/hub-identity.mjs';
import { createPinnedJsonClient } from '../lib/security/pinned-json-https.mjs';
import { validatePinnedJsonIdentity } from '../lib/security/pinned-json-https.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

function identityManager() {
  const key = randomBytes(32);
  return createHubIdentityManager(createSecretStore({ provider: 'test-aes-gcm',
    protect(clear, entropy) { const nonce=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(entropy);return Buffer.concat([nonce,cipher.update(clear),cipher.final(),cipher.getAuthTag()]); },
    unprotect(bytes, entropy) { const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAAD(entropy);decipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]); },
  }));
}
async function fixture(t, handle = (_req,res)=>{res.setHeader('Content-Type','application/json');res.end('{"state":"on"}');}) {
  const manager=identityManager(), identity=await manager.createHubIdentity(), keys=await manager.openHubIdentity(identity), seen=[];
  const server=https.createServer(keys,(req,res)=>{seen.push(req);handle(req,res);});server.on('tlsClientError',()=>{});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const config={origin:`https://127.0.0.1:${server.address().port}`,certificate:identity.certificate,certificatePin:identity.certificatePin};
  const client=createPinnedJsonClient(config);t.after(()=>client.close());
  return {manager,identity,config,client,seen};
}
const request=extra=>({method:'GET',path:'/api/states/light.fixture',headers:{Authorization:'Bearer synthetic-fixture-token'},...extra});

test('enrolled real HTTPS sends auth only after synchronous dispatch authorization',async t=>{
  const f=await fixture(t);let allowed=0;
  assert.deepEqual(await f.client.request(request({beforeDispatch(){allowed++;}})),{state:'on'});
  assert.equal(allowed,1);assert.equal(f.seen.length,1);assert.equal(f.seen[0].headers.authorization,'Bearer synthetic-fixture-token');
});
test('a denied dispatch after TLS sends zero HTTP requests',async t=>{
  const f=await fixture(t), denial=Object.assign(new Error('Fixture grant denied'),{code:'GRANT_REVOKED'});
  await assert.rejects(f.client.request(request({beforeDispatch(){throw denial;}})),error=>error===denial);
  assert.equal(f.seen.length,0);
});
test('certificate substitution never receives the authorization header',async t=>{
  const f=await fixture(t), legitimate=await f.manager.createHubIdentity();
  const client=createPinnedJsonClient({...f.config,certificate:legitimate.certificate,certificatePin:legitimate.certificatePin});t.after(()=>client.close());
  await assert.rejects(client.request(request()),error=>error.dispatched===false);
  assert.equal(f.seen.length,0);
});
test('redirects are rejected without following their destination',async t=>{
  const f=await fixture(t,(_req,res)=>{res.writeHead(302,{Location:'https://redirect-fixture.invalid/private'});res.end();});
  await assert.rejects(f.client.request(request()),error=>error.code==='HTTPS_REDIRECT_DENIED'&&error.dispatched===true);
  assert.equal(f.seen.length,1);
});
test('bounded body, malformed JSON and compression failures remain sanitized',async t=>{
  for(const [headers,body,code]of[[{'Content-Type':'application/json','Content-Length':'99999999'},'{}','HTTPS_BODY_TOO_LARGE'],[{'Content-Type':'application/json'},'fixture-private-not-json','HTTPS_JSON_INVALID'],[{'Content-Type':'application/json','Content-Encoding':'gzip'},'{}','HTTPS_ENCODING_DENIED']]){
    const f=await fixture(t,(_req,res)=>{res.writeHead(200,headers);res.end(body);});
    await assert.rejects(f.client.request(request()),error=>error.code===code&&!error.message.includes('private'));
  }
});
test('timeout and close after dispatch preserve the uncertain-effect marker',async t=>{
  const f=await fixture(t,()=>{}), client=createPinnedJsonClient({...f.config,timeoutMs:100});t.after(()=>client.close());
  await assert.rejects(client.request(request()),error=>error.code==='HTTPS_TIMEOUT'&&error.dispatched===true);
  const pending=f.client.request(request());setTimeout(()=>f.client.close(),40);
  await assert.rejects(pending,error=>error.code==='INTEGRATION_CLOSED');
  await assert.rejects(f.client.request(request()),error=>error.code==='INTEGRATION_CLOSED');
});
test('invalid origins, routes, headers and expired deadlines never dispatch',async t=>{
  const f=await fixture(t);
  assert.throws(()=>createPinnedJsonClient({...f.config,origin:'http://127.0.0.1'}));
  assert.throws(()=>createPinnedJsonClient({...f.config,certificatePin:'0'.repeat(64)}));
  for(const input of [request({path:'https://other.invalid/api/states/x'}),request({path:'/api/../config'}),request({path:'/api/states/x?token=x'}),request({headers:{Host:'other.invalid'}}),request({headers:{Authorization:'bad\r\nheader'}})])assert.throws(()=>f.client.request(input));
  await assert.rejects(f.client.request(request({deadlineAt:Date.now()-1})),error=>error.code==='DEADLINE_EXCEEDED'&&error.dispatched===false);
  assert.equal(f.seen.length,0);
});

test('exported identity and signal validation never executes hostile accessors or proxies',async t=>{
  const f=await fixture(t); let accessed=0;
  const hostile={get origin(){accessed++;return f.config.origin;}};
  assert.throws(()=>validatePinnedJsonIdentity(hostile));
  assert.throws(()=>validatePinnedJsonIdentity(new Proxy(f.config,{get(){accessed++;}})));
  for(const key of ['origin','certificatePin'])assert.throws(()=>validatePinnedJsonIdentity({...f.config,[key]:{toString(){accessed++;return f.config[key];}}}));
  for(const signal of [{get aborted(){accessed++;return false;}},new Proxy(new AbortController().signal,{get(){accessed++;}})]) {
    assert.throws(()=>f.client.request(request({signal})),{code:'INVALID_HTTPS_REQUEST'});
  }
  assert.equal(accessed,0); assert.equal(f.seen.length,0);
});

test('diagnostic environments fail before HTTPS options can leak credentials',async()=>{
  for (const variable of ['DEBUG','NODE_DEBUG','NODE_DEBUG_NATIVE']) {
    const source=`
      import {createPinnedJsonClient} from './lib/security/pinned-json-https.mjs';
      import {testIdentity,testSecretStore} from './test/helpers/secrets.mjs';
      const i=await testIdentity(testSecretStore());
      const c=createPinnedJsonClient({origin:'https://127.0.0.1:1',certificate:i.certificate,certificatePin:i.certificatePin});
      process.env.${variable}='*';
      try {await c.request({method:'GET',path:'/api/states/light.fixture',headers:{Authorization:'Bearer synthetic_secret_never_logged'}});process.exitCode=2;}
      catch(e){if(e.code!=='UNSAFE_DIAGNOSTICS')process.exitCode=3;}
      c.close();
    `;
    const child=await promisify(execFile)(process.execPath,['--input-type=module','-e',source],{cwd:new URL('../',import.meta.url),timeout:15000,windowsHide:true,maxBuffer:128*1024});
    assert.equal(child.stderr.includes('synthetic_secret_never_logged'),false);
  }
});
