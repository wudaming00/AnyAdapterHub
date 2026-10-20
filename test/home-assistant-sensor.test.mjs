import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HomeAssistantSensorAdapter, projectHASensor } from '../lib/adapters/home-assistant-sensor.mjs';
import { HA_SENSOR_TYPES, validateHASensorConfig, protectHASensorConfig, loadHASensorConfig } from '../lib/adapters/home-assistant-sensor-config.mjs';
import { testIdentity, testSecretStore } from './helpers/secrets.mjs';
const store=testSecretStore(), identity=testIdentity(store);
async function config(extra={}) {const i=await identity;return {origin:'https://127.0.0.1:8123',certificate:i.certificate,certificatePin:i.certificatePin,entityId:'sensor.private_fixture',measurement:'temperatureC',token:'synthetic_fixture_token_abcdefghijklmnop',...extra};}
const row=(c,state='23.5',attributes={device_class:'temperature',unit_of_measurement:'°C'})=>({entity_id:c.entityId,state,attributes,context:{user_id:'private_fixture_user'},last_updated:'1900-01-01',friendly_name:'private_fixture_name'});

test('HA sensor accepts only explicitly selected numeric/binary contracts, units and bounded values',async()=>{
  for(const[measurement,type]of Object.entries(HA_SENSOR_TYPES)){
    const c=await config({measurement,entityId:`${type.domain}.private_fixture`}),binary=type.domain==='binary_sensor';
    const source=row(c,binary?'on':'25',{device_class:type.classes[0],...(binary?{}:{unit_of_measurement:type.unit})});
    assert.deepEqual(projectHASensor(source,c),{available:true,value:binary?true:25});
    assert.throws(()=>projectHASensor({...source,entity_id:'sensor.other'},c));
    assert.throws(()=>projectHASensor({...source,attributes:{...source.attributes,device_class:'unselected'}},c));
  }
  const c=await config();for(const state of ['NaN','Infinity','{"value":2}','200','1e999'])assert.throws(()=>projectHASensor(row(c,state),c));
  assert.throws(()=>projectHASensor(row(c,'20',{device_class:'temperature',unit_of_measurement:'°F'}),c));
});
test('HA sensor config rejects other entity domains, plaintext loads and target/measurement credential reuse',async t=>{
  const c=await config(),dir=await mkdtemp(path.join(tmpdir(),'anyadapter-ha-sensor-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const extra of [{entityId:'camera.front'},{entityId:'binary_sensor.front'},{measurement:'arbitrary'},{origin:'http://127.0.0.1'},{url:'https://other.invalid'}])assert.throws(()=>validateHASensorConfig({...c,...extra}));
  const protectedConfig=await protectHASensorConfig(c,{secretStore:store});assert.equal(JSON.stringify(protectedConfig).includes(c.token),false);
  const file=path.join(dir,'fixture.json');await writeFile(file,JSON.stringify(protectedConfig));assert.equal((await loadHASensorConfig(file,{secretStore:store})).token,c.token);
  for(const patch of [{entityId:'sensor.other'},{measurement:'humidityPercent'}]){await writeFile(file,JSON.stringify({...protectedConfig,...patch}));await assert.rejects(loadHASensorConfig(file,{secretStore:store}),{code:'CREDENTIAL_UNAVAILABLE'});}
  await writeFile(file,JSON.stringify(c));await assert.rejects(loadHASensorConfig(file,{secretStore:store}));
});
test('constructor and hostile source objects never execute getters or proxy traps',async()=>{
  const c=await config();let calls=0;
  for(const value of [new Proxy({},{ownKeys(){calls++;return[];}}),{get deviceId(){calls++;return'x';}}])assert.throws(()=>new HomeAssistantSensorAdapter(value));
  for(const raw of [new Proxy({},{ownKeys(){calls++;return[];}}),{get entity_id(){calls++;return c.entityId;}}])assert.throws(()=>projectHASensor(raw,c));
  assert.equal(calls,0);
});
test('sensor observation is read-only, privacy-filtered and receipt freshness expires on unavailable/failure',async()=>{
  const c=await config();let response=row(c),requests=0;const events=[];
  const adapter=new HomeAssistantSensorAdapter({deviceId:'room-sensor',config:c,request:async input=>{requests++;assert.equal(input.method,'GET');assert.equal(input.path,`/api/states/${c.entityId}`);input.beforeDispatch();if(response instanceof Error)throw response;return response;}});
  adapter.subscribe(event=>events.push(event));assert.equal(requests,0);await adapter.refresh();
  let snapshot=adapter.snapshot();assert.equal(snapshot.fields.temperatureC.value,23.5);assert.equal(Date.parse(snapshot.fields.temperatureC.expiresAt)-Date.parse(snapshot.fields.temperatureC.observedAt),15000);
  for(const secret of [c.token,c.entityId,'private_fixture_user','private_fixture_name','1900-01-01'])assert.equal(JSON.stringify(events).includes(secret),false);
  assert.deepEqual(adapter.supportedActions,[]);await assert.rejects(adapter.execute('light.power.set',{on:true}),{code:'UNSUPPORTED_ACTION'});
  response=row(c,'unavailable',{});await adapter.refresh();snapshot=adapter.snapshot();assert.equal(snapshot.fields.available.value,false);assert.equal(Date.parse(snapshot.fields.temperatureC.expiresAt),0);
  response=new Error('private_vendor_error');await assert.rejects(adapter.refresh(),e=>e.code==='SENSOR_READ_FAILED'&&!e.message.includes('private'));
  assert.equal(Date.parse(adapter.snapshot().fields.available.expiresAt),0);await adapter.close();
});
test('read concurrency coalesces and close cancels stalled/late replies without publication or later request',async()=>{
  const c=await config();let resolve,requests=0;const events=[];
  const adapter=new HomeAssistantSensorAdapter({deviceId:'sensor-a',config:c,request:()=>{requests++;return new Promise(yes=>{resolve=yes;});}});
  adapter.subscribe(e=>events.push(e));const pending=adapter.refresh();assert.equal(adapter.refresh(),pending);await Promise.resolve();await adapter.close();await assert.rejects(pending,{code:'ADAPTER_CLOSED'});
  const count=events.length;resolve(row(c));await new Promise(yes=>setImmediate(yes));assert.equal(events.length,count);assert.equal(requests,1);
  await assert.rejects(adapter.refresh(),{code:'ADAPTER_CLOSED'});
  let late=0;const immediate=new HomeAssistantSensorAdapter({deviceId:'sensor-b',config:c,request:()=>{late++;return row(c);}});const queued=immediate.refresh();await immediate.close();await assert.rejects(queued);assert.equal(late,0);
});
