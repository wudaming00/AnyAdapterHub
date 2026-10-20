import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { promises as fixtureFS } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { initializeHub, readJson } from '../lib/hub/config.mjs';
import { loadHomeAssistantConfig } from '../lib/adapters/home-assistant-config.mjs';
import { loadMQTTConfig } from '../lib/adapters/mqtt-config.mjs';
import { parseEnrollmentArgs, enrollIntegration, readMaskedSecret } from '../scripts/enroll-integration.mjs';
import { testIdentity, testSecretStore } from './helpers/secrets.mjs';

async function fixture(t,adapter='home-assistant') {
  const dir=await mkdtemp(path.join(tmpdir(),'anyadapter-enroll-fixture-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));await rm(dir,{recursive:true,force:true});});
  const store=testSecretStore(), identity=await testIdentity(store), home=path.join(dir,'hub');
  await initializeHub({home,secretStore:store,identity});
  await writeFile(path.join(dir,'cert.pem'),identity.certificate);
  const metadata=adapter==='home-assistant'
    ?{origin:'https://127.0.0.1:8123',entityId:'light.fixture',certificateFile:'cert.pem',certificatePin:identity.certificatePin}
    :{host:'127.0.0.1',port:8883,certificateFile:'cert.pem',certificatePin:identity.certificatePin,topic:'fixture/sensor',measurement:'temperatureC'};
  const target=path.join(dir,'target.json'); await writeFile(target,JSON.stringify(metadata));
  return {dir,store,home,target,metadata,selected:{adapter,target,home,out:'fixture.local.json'}};
}

test('trusted HA enrollment saves only purpose-bound ciphertext and does not enable or grant',async t=>{
  const f=await fixture(t), token='synthetic_fixture_token_abcdefghijklmnopqrst'; let calls=0;
  const result=await enrollIntegration(f.selected,{secretStore:f.store,prompt:async()=>{calls++;return token;}});
  assert.deepEqual(result,{saved:true,adapter:'home-assistant',networkAccessed:false,enabled:false,granted:false});
  const output=path.join(f.home,f.selected.out), saved=await readFile(output,'utf8');
  assert.equal(saved.includes(token),false);assert.equal(calls,1);
  assert.equal((await loadHomeAssistantConfig(output,{secretStore:f.store})).token,token);
  assert.deepEqual((await readJson(path.join(f.home,'hub.json'))).devices,[]);
  await assert.rejects(enrollIntegration(f.selected,{secretStore:f.store,prompt:async()=>{throw new Error('must not prompt');}}),{code:'ENROLLMENT_FILE_EXISTS'});
});

test('trusted MQTT enrollment hides both credentials, binding one exact selected topic',async t=>{
  const f=await fixture(t,'mqtt-tls'), secrets=['synthetic_fixture_username','synthetic_fixture_password'];let calls=0;
  await enrollIntegration(f.selected,{secretStore:f.store,prompt:async()=>secrets[calls++]});
  const output=path.join(f.home,f.selected.out), serialized=await readFile(output,'utf8'), resolved=await loadMQTTConfig(output,{secretStore:f.store});
  assert.equal(calls,2);for(const value of secrets)assert.equal(serialized.includes(value),false);
  assert.equal(resolved.username,secrets[0]);assert.equal(resolved.password,secrets[1]);
  assert.equal(resolved.topic,f.metadata.topic);
});

test('enrollment rejects credential flags, traversal, duplicate flags and executable metadata before prompting',async t=>{
  const f=await fixture(t);
  const args=['--adapter','home-assistant','--target',f.target,'--home',f.home,'--out','fixture.local.json'];
  assert.equal(parseEnrollmentArgs(args).adapter,'home-assistant');
  for(const bad of [[...args,'--token','secret'],args.map(x=>x==='--target'?'--adapter':x),args.map(x=>x==='fixture.local.json'?'../outside.local.json':x)])assert.throws(()=>parseEnrollmentArgs(bad));
  let calls=0;await writeFile(f.target,JSON.stringify({...f.metadata,token:'forbidden_plaintext'}));
  await assert.rejects(enrollIntegration(f.selected,{secretStore:f.store,prompt:async()=>{calls++;return 'unused';}}));
  assert.equal(calls,0);
});

test('noninteractive CLI refuses credential input and sanitizes output',async t=>{
  const f=await fixture(t), args=['scripts/enroll-integration.mjs','--adapter','home-assistant','--target',f.target,'--home',f.home,'--out','fixture.local.json'];
  await assert.rejects(promisify(execFile)(process.execPath,args,{cwd:new URL('../',import.meta.url),windowsHide:true,timeout:10000}),e=>e.code===1&&JSON.parse(e.stderr).code==='INTERACTIVE_TERMINAL_REQUIRED'&&!e.stderr.includes(f.target));
  assert.throws(()=>readMaskedSecret('Fixture',4096,{isTTY:false},{isTTY:false}),{code:'INTERACTIVE_TERMINAL_REQUIRED'});
});

test('masked terminal input never echoes credentials and restores raw mode/listeners on completion and failures',async()=>{
  const terminal=()=>{const input=new PassThrough();input.isTTY=true;input.isRaw=false;input.setRawMode=value=>{input.isRaw=value;};return input;};
  let text='';const output={isTTY:true,write:value=>{text+=value;}};
  const input=terminal(), pending=readMaskedSecret('Fixture',4096,input,output);
  input.emit('keypress','synthetic_secret',{name:'s'});input.emit('keypress','\r',{name:'return'});
  assert.equal(await pending,'synthetic_secret');assert.equal(text.includes('synthetic_secret'),false);
  assert.equal(input.isRaw,false);assert.equal(input.listenerCount('keypress'),0);assert.equal(input.listenerCount('error'),0);
  for(const setupFailure of [false,true]){
    const input=terminal(), output=setupFailure?{isTTY:true,write(){throw new Error('private diagnostic');}}:{isTTY:true,write(){}};
    const pending=readMaskedSecret('Fixture',4096,input,output);
    if(!setupFailure)input.emit('keypress','\u0003',{ctrl:true,name:'c'});
    await assert.rejects(pending,e=>e.code==='ENROLLMENT_CANCELLED'&&!e.message.includes('private'));
    assert.equal(input.isRaw,false);assert.equal(input.listenerCount('keypress'),0);assert.equal(input.listenerCount('error'),0);
  }
});

test('certificate replacement after open is rejected before bytes or credentials are read',async t=>{
  const f=await fixture(t), file=path.join(f.dir,'cert.pem'), replacement=path.join(f.dir,'replacement.pem');
  await writeFile(replacement,'not the enrolled certificate');let reads=0,prompts=0;
  const original=fixtureFS.open;
  const mock=t.mock.method(fixtureFS,'open',async(...args)=>{
    const handle=await original(...args);if(args[0]!==file)return handle;
    const stat=handle.stat.bind(handle),read=handle.read.bind(handle);
    handle.stat=async options=>{const info=await stat(options);await fixtureFS.rename(file,path.join(f.dir,'original.pem'));await fixtureFS.rename(replacement,file);return info;};
    handle.read=(...values)=>{reads++;return read(...values);};return handle;
  });
  syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  await assert.rejects(enrollIntegration(f.selected,{secretStore:f.store,prompt:async()=>{prompts++;return 'unused';}}),{code:'INVALID_ENROLLMENT'});
  assert.equal(reads,0);assert.equal(prompts,0);
});

test('certificate identity checks distinguish 64-bit inode values that round to the same Number',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'cert.pem');let reads=0,prompts=0;
  const selected=9007199254740992n,replaced=selected+1n;
  assert.equal(Number(selected),Number(replaced));
  const originalOpen=fixtureFS.open,originalLstat=fixtureFS.lstat;
  const openMock=t.mock.method(fixtureFS,'open',async(...args)=>{
    const handle=await originalOpen(...args);if(args[0]!==file)return handle;
    const stat=handle.stat.bind(handle),read=handle.read.bind(handle);
    handle.stat=async options=>{const info=await stat(options);info.ino=options?.bigint?selected:Number(selected);return info;};
    handle.read=(...values)=>{reads++;return read(...values);};return handle;
  });
  const statMock=t.mock.method(fixtureFS,'lstat',async(target,options)=>{
    const info=await originalLstat(target,options);if(target===file)info.ino=options?.bigint?replaced:Number(replaced);return info;
  });
  syncBuiltinESMExports();t.after(()=>{openMock.mock.restore();statMock.mock.restore();syncBuiltinESMExports();});
  await assert.rejects(enrollIntegration(f.selected,{secretStore:f.store,prompt:async()=>{prompts++;return 'unused';}}),{code:'INVALID_ENROLLMENT'});
  assert.equal(reads,0);assert.equal(prompts,0);
});

test('a hard-linked certificate is rejected before asking for credentials',async t=>{
  const f=await fixture(t);await fixtureFS.link(path.join(f.dir,'cert.pem'),path.join(f.dir,'alias.pem'));let prompts=0;
  await assert.rejects(enrollIntegration(f.selected,{secretStore:f.store,prompt:async()=>{prompts++;return 'unused';}}),{code:'INVALID_ENROLLMENT'});
  assert.equal(prompts,0);
});
