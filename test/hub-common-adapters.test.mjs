import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { enrollIntegration } from '../scripts/enroll-integration.mjs';
import { initializeHub, addHubDevice, loadHubConfig, readJson, setAdapterEnabled } from '../lib/hub/config.mjs';
import { createAdapter, validateAdapterFeatures } from '../lib/hub/adapters.mjs';
import { HomeAssistantSensorAdapter } from '../lib/adapters/home-assistant-sensor.mjs';
import { SwitchBotAdapter } from '../lib/adapters/switchbot.mjs';
import { PhilipsHueAdapter } from '../lib/adapters/philips-hue.mjs';
import { HubRuntime, tokenHash } from '../lib/hub/runtime.mjs';
import { HubStore } from '../lib/hub/store.mjs';
import { testIdentity, testSecretStore } from './helpers/secrets.mjs';

const OWNER='fixture_owner_token_abcdefghijklmnopqrstuvwxyz123456';
const UUID='00000000-0000-4000-8000-000000000001';
async function fixture(t){
  const dir=await mkdtemp(path.join(tmpdir(),'anyadapter-common-fixture-'));t.after(async()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));await rm(dir,{recursive:true,force:true});});
  const secretStore=testSecretStore(),identity=await testIdentity(secretStore),home=path.join(dir,'hub');await initializeHub({home,secretStore,identity});await writeFile(path.join(dir,'fixture.pem'),identity.certificate);
  const pin={origin:'https://127.0.0.1:8123',certificateFile:'fixture.pem',certificatePin:identity.certificatePin};
  const targets={
    'philips-hue':{...pin,lightId:UUID},
    'shelly-gen2':{...pin,expectedDeviceId:'shellyplus1pm-aabbccddeeff',componentId:0,loadClass:'ordinary-plug'},
    switchbot:{vendorDeviceId:'AABBCCDDEEFF',deviceType:'Meter'},
    'lg-thinq':{vendorDeviceId:UUID,deviceType:'DEVICE_AIR_PURIFIER',countryCode:'US'},
    'home-assistant-sensor':{...pin,entityId:'sensor.private_fixture_temperature',measurement:'temperatureC'},
    openhab:{...pin,itemName:'Fixture_Temperature',itemType:'Number:Temperature'},
    plex:{...pin,machineIdentifier:'a'.repeat(40)},
    awair:{vendorDeviceId:1,deviceType:'awair-element'},
    purpleair:{vendorDeviceId:1},
  };
  return{dir,home,identity,secretStore,targets};
}

test('all nine new adapters enroll locally through fixed trusted handlers, load inert factories and preserve default read-only authority',async t=>{
  const f=await fixture(t), token='a'.repeat(64);let prompts=0;
  for(const[adapter,metadata]of Object.entries(f.targets)){
    const target=path.join(f.dir,`${adapter}.json`);await writeFile(target,JSON.stringify(metadata));
    const result=await enrollIntegration({adapter,target,home:f.home,out:`${adapter}.local.json`},{secretStore:f.secretStore,prompt:async()=>{prompts++;return token;}});
    assert.equal(result.networkAccessed,false);assert.equal(result.enabled,false);assert.equal(result.granted,false);
    const configPath=path.join(f.home,`${adapter}.local.json`), saved=await readFile(configPath,'utf8');assert.equal(saved.includes(token),false);
    await addHubDevice({home:f.home,adapterName:adapter,configPath,id:adapter,secretStore:f.secretStore});
  }
  assert.equal(prompts,10); // Plex's public identity read asks for no credential.
  const loaded=await loadHubConfig(f.home,{secretStore:f.secretStore});assert.equal(loaded.devices.length,9);
  for(const device of loaded.devices){const adapter=await createAdapter({adapterName:device.adapterName,id:device.id,config:device.config,features:device.features});assert.deepEqual(adapter.supportedActions,[]);await adapter.close();}
  assert.equal(JSON.stringify(await readJson(path.join(f.home,'hub.json'))).includes(token),false);
  const thinQ=loaded.devices.find(device=>device.adapterName==='lg-thinq');assert.match(thinQ.config.clientId,/^[a-f0-9]{8}-[a-f0-9]{4}-4/);
  for(const adapter of ['switchbot','lg-thinq','home-assistant-sensor','openhab','plex','awair','purpleair'])assert.throws(()=>validateAdapterFeatures(adapter,['control']),{code:'INVALID_FEATURES'});
  for(const adapter of Object.keys(f.targets))await setAdapterEnabled(f.home,adapter,false,{secretStore:f.secretStore});
  // Disabled entries must not open even previously valid encrypted targets.
  for(const adapter of Object.keys(f.targets))await rm(path.join(f.home,`${adapter}.local.json`));
  assert.deepEqual((await loadHubConfig(f.home,{secretStore:f.secretStore})).devices,[]);
});

test('cloud enrollment rejects owner-supplied origins and plaintext secrets before any credential prompt',async t=>{
  const f=await fixture(t);let prompts=0;
  for(const adapter of ['switchbot','lg-thinq','awair','purpleair']){
    const target=path.join(f.dir,`${adapter}.json`);
    for(const extra of [{origin:'https://unselected.fixture.invalid'},{token:'forbidden_plaintext'}]){
      await writeFile(target,JSON.stringify({...f.targets[adapter],...extra}));
      await assert.rejects(enrollIntegration({adapter,target,home:f.home,out:`${adapter}.local.json`},{secretStore:f.secretStore,prompt:async()=>{prompts++;return'never';}}),{code:'INVALID_ENROLLMENT'});
    }
  }
  assert.equal(prompts,0);
});

test('actual HA sensor, cloud sensor and Hue adapters preserve per-device state privacy and distinct action grants in HubRuntime',async t=>{
  const f=await fixture(t), token='synthetic_private_token_abcdefghijklmnopqrstuvwxyz';let hueOn=false,writes=0;
  const pinned={origin:'https://127.0.0.1:8123',certificate:f.identity.certificate,certificatePin:f.identity.certificatePin};
  const ha=new HomeAssistantSensorAdapter({deviceId:'ha-sensor',config:{...pinned,entityId:'sensor.private_fixture_temperature',measurement:'temperatureC',token},request:async input=>{input.beforeDispatch();return{entity_id:'sensor.private_fixture_temperature',state:'22.5',attributes:{device_class:'temperature',unit_of_measurement:'°C',friendly_name:'private_household_name'}};}});
  const cloud=new SwitchBotAdapter({deviceId:'cloud-sensor',config:{vendorDeviceId:'AABBCCDDEEFF',deviceType:'Meter',token,secret:token},request:async input=>{input.beforeDispatch();return{statusCode:100,body:{deviceId:'AABBCCDDEEFF',deviceType:'Meter',temperature:21.5,humidity:40,battery:80,deviceName:'private_household_name'}};}});
  const hue=new PhilipsHueAdapter({deviceId:'hue-light',config:{...pinned,lightId:UUID,applicationKey:'b'.repeat(64)},features:['control'],request:async input=>{input.beforeDispatch();if(input.method==='PUT'){writes++;hueOn=input.body.on.on;return{errors:[],data:[{rid:UUID,rtype:'light'}]};}return{errors:[],data:[{id:UUID,type:'light',on:{on:hueOn},mode:'normal',metadata:{archetype:'classic_bulb'},dimming:{brightness:50,min_dim_level:1}}]};}});
  const runtime=new HubRuntime({store:new HubStore({filePath:':memory:'}),ownerTokenHash:tokenHash(OWNER),devices:[{id:'ha-sensor',label:'HA sensor',adapter:ha},{id:'cloud-sensor',label:'Cloud sensor',adapter:cloud},{id:'hue-light',label:'Hue light',adapter:hue}]});t.after(()=>runtime.close());await runtime.start();const owner=runtime.authenticate(OWNER);
  const issued=runtime.issueGrant(owner,{label:'Read sensors',deviceIds:['ha-sensor','cloud-sensor'],capabilities:['state.read','events.read'],expiresAt:new Date(Date.now()+60000).toISOString()}),reader=runtime.authenticate(issued.token);
  assert.deepEqual(runtime.listDevices(reader).map(value=>value.id),['ha-sensor','cloud-sensor']);assert.throws(()=>runtime.state(reader,'hue-light'),{code:'ACCESS_DENIED'});
  assert.equal(runtime.state(reader,'ha-sensor').fields.temperatureC.value,22.5);
  assert.equal(runtime.state(reader,'cloud-sensor').fields.environment.value.temperatureC,21.5);
  assert.throws(()=>runtime.submit(reader,'ha-sensor',{action:'switch.power.set',args:{on:true},idempotencyKey:'forbidden'}),{code:'ACCESS_DENIED'});
  assert.throws(()=>runtime.issueGrant(owner,{label:'Denied',deviceIds:['ha-sensor'],capabilities:['switch.power.set'],expiresAt:new Date(Date.now()+60000).toISOString()}),{code:'INVALID_ARGUMENTS'});
  const serialized=JSON.stringify(runtime.listDevices(reader));for(const value of[token,'AABBCCDDEEFF','sensor.private_fixture_temperature','private_household_name'])assert.equal(serialized.includes(value),false);
  const grant=runtime.issueGrant(owner,{label:'Hue only',deviceIds:['hue-light'],capabilities:['state.read','light.power.set'],expiresAt:new Date(Date.now()+60000).toISOString()}),controller=runtime.authenticate(grant.token);
  const input={action:'light.power.set',args:{on:true},idempotencyKey:'hue-once'},submission=runtime.submit(controller,'hue-light',input),result=await runtime.wait(controller,submission.operation.id,{timeoutMs:2000});
  assert.equal(result.state,'confirmed');assert.equal(writes,1);assert.equal(runtime.submit(controller,'hue-light',input).created,false);assert.equal(writes,1);
});
