import test from 'node:test';
import assert from 'node:assert/strict';
import { createMovieRequest, MoviePlaybackWorkflow } from '../lib/hub/movie-workflow.mjs';

const APP = 'com.disney.disneyplus-prod';
function fixture(options = {}) {
  let clock = Date.parse('2026-01-01T00:00:00Z'), next = 0, saved;
  const operations = new Map(), keys = new Map(), frames = new Map(), calls = [];
  const context = { calls, operations, frames, playing: false, deny: false, cleanup: true, lost: false, unknown: false,
    now: () => clock, advance: ms => { clock += ms; }, saveFailed: false };
  const client = {
    capabilities: async () => ({ deviceId: 'tv', actions: context.deny ? {} : Object.fromEntries(['power.wake', 'app.list', 'app.launch', 'navigation.key', 'navigation.sequence', 'media.control', 'screen.observe'].map(key => [key, {}])), read: ['state.read', 'screen.read'] }),
    state: async () => ({ deviceId: 'tv', connection: { phase: 'online' }, fields: { foreground: { value: { appId: APP }, observedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 10000).toISOString() } } }),
    submit: async (deviceId, action, args, { idempotencyKey }) => {
      if (keys.has(idempotencyKey)) return { operation: operations.get(keys.get(idempotencyKey)), created: false };
      const id = `op-${++next}`;
      calls.push({ deviceId, action, args, idempotencyKey });
      const operation = { id, deviceId, action, state: 'unconfirmed', result: { requestAccepted: true } };
      if (action === 'app.list') Object.assign(operation, { state: 'confirmed', result: { apps: [{ id: APP, launchAllowed: true }] } });
      if (action === 'app.launch') Object.assign(operation, { state: 'confirmed', result: { observedAppId: APP } });
      if (action === 'navigation.sequence') Object.assign(operation, { state: context.unknown ? 'unknown' : 'unconfirmed', result: {
        sequenceComplete: !context.unknown, transportSentCount: context.unknown ? 1 : args.keys.length, uncertain: context.unknown,
      } });
      if (action === 'screen.observe') {
        const frame = { id: `frame-${next}`, deviceId, operationId: id, mimeType: 'image/jpeg', byteLength: 4,
          createdAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 300000).toISOString() };
        frames.set(frame.id, Buffer.from([255, 216, 255, 217]));
        operation.state = 'confirmed'; operation.result = { frame, observation: { originalAppId: APP, screenshotVerified: true,
          startedAt: new Date(clock).toISOString(), imageReceivedAt: new Date(clock).toISOString(), finishedAt: new Date(clock).toISOString(),
          completed: true, cleanupVerified: context.cleanup, restored: true, overlayClosed: true, communicationVerified: true,
          sample: { appId: APP, playerAppId: APP, players: [{ isFullScreen: true, playStateNow: context.playing ? 'playing' : 'paused' }] } } };
      }
      keys.set(idempotencyKey, id); operations.set(id, operation);
      if (context.lost) { context.lost = false; throw new Error('lost response'); }
      return { operation, created: true };
    },
    operation: async id => operations.get(id),
    operationByKey: async (deviceId, key) => {
      const operation = operations.get(keys.get(key));
      if (!operation || operation.deviceId !== deviceId) throw Object.assign(new Error(), { code: 'NOT_FOUND' });
      return operation;
    },
    frame: async id => { if (context.deny) throw Object.assign(new Error(), { code: 'GRANT_REVOKED' }); return frames.get(id); },
  };
  const journal = createMovieRequest({ deviceId: 'tv', title: 'Frozen', year: 2013, requestId: 'fixture-request' }, clock);
  const save = async value => { if (context.saveFailed) throw new Error('disk failed'); saved = structuredClone(value); await context.onSave?.(value); };
  const open = journal => new MoviePlaybackWorkflow({ client, journal, save, now: () => clock, sleep: async ms => { clock += ms; } });
  Object.assign(context, { client, open, saved: () => saved, workflow: open(journal), ...options });
  return context;
}
const frameDecision = (workflow, kind, more = {}) => ({ kind, frameId: workflow.status().frame?.id, ...more });

test('visual workflow completes only with matching detail, actual playing and two advancing frame assertions', async () => {
  const f = fixture(), w = f.workflow;
  await w.prepare();
  await w.step(frameDecision(w, 'details', { title: 'Frozen', year: 2013, playFocused: true }));
  f.playing = true; await w.step(frameDecision(w, 'play'));
  await w.step(frameDecision(w, 'playback', { title: 'Frozen', positionSeconds: 10 }));
  assert.equal(w.status().stage, 'verifying');
  f.advance(2000); await w.observe();
  await w.step(frameDecision(w, 'playback', { title: 'Frozen', positionSeconds: 12 }));
  assert.equal(w.status().stage, 'completed');
  assert.deepEqual(w.status().result, { completed: true, verificationScope: 'agent_visual_and_system_player',
    agentReportedTitleVerified: true, deviceReportedTitleVerified: false, progressAdvanced: true });
});

test('permission preflight and failed durable checkpoint prevent every effect', async () => {
  const f = fixture(); f.deny = true;
  await assert.rejects(f.workflow.prepare(), { code: 'MOVIE_PERMISSION_REQUIRED' });
  assert.equal(f.calls.length, 0);
  f.deny = false; f.saveFailed = true;
  await assert.rejects(f.workflow.prepare(), /disk failed/);
  assert.equal(f.calls.length, 0);
});

test('lost submission response resumes the exact original key without duplicate effect', async () => {
  const f = fixture(); await f.workflow.prepare(); f.lost = true;
  await assert.rejects(f.workflow.step(frameDecision(f.workflow, 'keys', { screen: 'home', keys: ['LEFT'] })), /lost response/);
  assert.ok(f.saved().pending); const w = f.open(f.saved()); await w.resume();
  assert.equal(f.calls.filter(call => call.action === 'navigation.sequence').length, 1);
  assert.equal(w.status().reconciliationRequired, false);
  assert.ok(w.status().frame);
});

test('unknown navigation stops its remaining batch and requires observation without replay', async () => {
  const f = fixture(); await f.workflow.prepare(); f.unknown = true;
  await assert.rejects(f.workflow.step(frameDecision(f.workflow, 'keys', { screen: 'search', keys: ['LEFT', 'ENTER'] })), { code: 'MOVIE_KEY_RECONCILE' });
  assert.equal(f.calls.filter(call => call.action === 'navigation.sequence').length, 1);
  await f.workflow.resume();
  assert.equal(f.calls.filter(call => call.action === 'navigation.sequence').length, 1);
});

test('wrong year, preview playing and stale frame cannot claim exact playback', async () => {
  const f = fixture(); await f.workflow.prepare(); f.playing = true;
  await assert.rejects(f.workflow.step(frameDecision(f.workflow, 'details', { title: 'Frozen', year: 2019, playFocused: true })), { code: 'MOVIE_TITLE_MISMATCH' });
  await assert.rejects(f.workflow.step(frameDecision(f.workflow, 'playback', { title: 'Frozen', positionSeconds: 10 })), { code: 'MOVIE_PLAYBACK_UNVERIFIED' });
  f.advance(60001);
  await assert.rejects(f.workflow.step(frameDecision(f.workflow, 'keys', { screen: 'home', keys: ['ENTER'] })), { code: 'MOVIE_FRESH_FRAME_REQUIRED' });
});

test('cross-frame substitution, unapproved keys, profile navigation and code-bearing JSON are denied', async () => {
  const f = fixture(); await f.workflow.prepare(); const w = f.workflow;
  await assert.rejects(w.step({ kind: 'keys', frameId: 'another-frame', screen: 'home', keys: ['ENTER'] }), { code: 'MOVIE_FRESH_FRAME_REQUIRED' });
  await assert.rejects(w.step(frameDecision(w, 'keys', { screen: 'home', keys: ['POWER'] })), { code: 'MOVIE_INVALID_DECISION' });
  await assert.rejects(w.step(frameDecision(w, 'keys', { screen: 'profile', keys: ['DOWN', 'ENTER'] })), { code: 'MOVIE_PROFILE_CONSENT_REQUIRED' });
  await assert.rejects(w.step(frameDecision(w, 'keys', { screen: 'home', keys: ['ENTER'], endpoint: 'execute-code' })), { code: 'MOVIE_INVALID_ARGUMENTS' });
  assert.equal(f.calls.filter(call => call.action === 'navigation.sequence').length, 0);
});

test('incomplete observer cleanup and wrong frame binding stop workflow', async () => {
  const f = fixture(); f.cleanup = false;
  await assert.rejects(f.workflow.prepare(), { code: 'MOVIE_OBSERVATION_UNVERIFIED' });
  assert.equal(f.workflow.status().frame, null);
  f.cleanup = true;
  const original = f.client.submit;
  f.client.submit = async (...args) => { const out = await original(...args); if (args[1] === 'screen.observe') out.operation.result.frame.operationId = 'wrong-op'; return out; };
  await assert.rejects(f.workflow.observe(), { code: 'MOVIE_OBSERVATION_UNVERIFIED' });
});

test('PIN, login and purchase are terminal needs-user outcomes with no further effects', async () => {
  for (const reason of ['pin', 'login', 'purchase']) {
    const f = fixture(); await f.workflow.prepare();
    await f.workflow.step(frameDecision(f.workflow, 'blocked', { reason }));
    const count = f.calls.length;
    await assert.rejects(f.workflow.resume(), { code: 'MOVIE_FINISHED' });
    assert.equal(f.calls.length, count);
  }
});

test('revocation and workflow deadline are checked before the next mutation', async () => {
  const f = fixture(); await f.workflow.prepare(); const count = f.calls.length;
  f.deny = true;
  await assert.rejects(f.workflow.step(frameDecision(f.workflow, 'keys', { screen: 'home', keys: ['ENTER'] })), { code: 'MOVIE_PERMISSION_REQUIRED' });
  f.deny = false; f.advance(30 * 60000);
  await assert.rejects(f.workflow.observe(), { code: 'MOVIE_EXPIRED' });
  assert.equal(f.calls.length, count);
});

test('stationary progress and reused frame never complete the workflow', async () => {
  const f = fixture(), w = f.workflow; await w.prepare();
  await w.step(frameDecision(w, 'details', { title: 'Frozen', year: 2013, playFocused: true }));
  f.playing = true; await w.step(frameDecision(w, 'play'));
  const old = frameDecision(w, 'playback', { title: 'Frozen', positionSeconds: 10 });
  await w.step(old);
  await assert.rejects(w.step(old), { code: 'MOVIE_FRESH_FRAME_REQUIRED' });
  f.advance(3000); await w.observe();
  await w.step(frameDecision(w, 'playback', { title: 'Frozen', positionSeconds: 10 }));
  assert.equal(w.status().stage, 'verifying');
});

test('interrupted or expired detail focus is re-observed and can be confirmed again', async () => {
  const f = fixture(), w = f.workflow; await w.prepare();
  await w.step(frameDecision(w, 'details', { title: 'Frozen', year: 2013, playFocused: true }));
  f.advance(61000);
  const resumed = f.open(f.saved()); await resumed.resume();
  assert.equal(resumed.status().stage, 'navigating');
  await resumed.step(frameDecision(resumed, 'details', { title: 'Frozen', year: 2013, playFocused: true }));
  await resumed.step(frameDecision(resumed, 'play'));
  assert.equal(resumed.status().stage, 'verifying');
});

test('expiry during durable save stops dispatch and records that submission was not attempted', async () => {
  const f = fixture(), w = f.workflow; await w.prepare();
  f.onSave = value => { if (value.pending?.action === 'navigation.sequence') f.advance(30 * 60000); };
  await assert.rejects(w.step(frameDecision(w, 'keys', { screen: 'home', keys: ['ENTER'] })), { code: 'MOVIE_EXPIRED' });
  assert.equal(f.calls.filter(call => call.action === 'navigation.sequence').length, 0);
  assert.equal(f.saved().pending, null);
  assert.equal(w.status().lastOperation.state, 'cancelled');
});

test('slow frame fetch and slow checkpoint invalidate visual focus before sending any key', async () => {
  for (const delayAt of ['fetch', 'checkpoint']) {
    const f = fixture(), w = f.workflow; await w.prepare();
    if (delayAt === 'fetch') { const read = f.client.frame; f.client.frame = async id => { const bytes = await read(id); f.advance(61000); return bytes; }; }
    else f.onSave = value => { if (value.pending?.action === 'navigation.sequence') f.advance(61000); };
    await assert.rejects(w.step(frameDecision(w, 'keys', { screen: 'home', keys: ['ENTER'] })), { code: 'MOVIE_FRESH_FRAME_REQUIRED' });
    assert.equal(f.calls.filter(call => call.action === 'navigation.sequence').length, 0);
    f.onSave = undefined;
    f.client.frame = async id => f.frames.get(id);
    await w.resume();
    assert.ok(w.status().frame);
  }
});

test('recently stored frame with an old underlying capture cannot authorize navigation', async () => {
  const f = fixture(), w = f.workflow; await w.prepare();
  const journal = f.saved();
  journal.observation.startedAt = journal.observation.imageReceivedAt = new Date(f.now() - 61000).toISOString();
  const reopened = f.open(journal);
  await assert.rejects(reopened.step(frameDecision(reopened, 'keys', { screen: 'home', keys: ['ENTER'] })), { code: 'MOVIE_FRESH_FRAME_REQUIRED' });
  assert.equal(f.calls.filter(call => call.action === 'navigation.sequence').length, 0);
});

test('lost-response recovery after visual expiry looks up the original operation without any submission', async () => {
  const f = fixture(); await f.workflow.prepare(); f.lost = true;
  await assert.rejects(f.workflow.step(frameDecision(f.workflow, 'keys', { screen: 'home', keys: ['LEFT'] })), /lost response/);
  f.advance(61000);
  const original = f.client.submit; let submits = 0;
  f.client.submit = async (...args) => { submits++; return original(...args); };
  const resumed = f.open(f.saved()); await resumed.resume();
  assert.equal(submits, 1); // fresh observation only
  assert.equal(f.calls.filter(call => call.action === 'navigation.sequence').length, 1);
  assert.ok(resumed.status().frame);
});

test('missing original submission pauses instead of dispatching an unseen stale key', async () => {
  const f = fixture(); await f.workflow.prepare();
  f.client.submit = async () => { throw new Error('lost before submission'); };
  await assert.rejects(f.workflow.step(frameDecision(f.workflow, 'keys', { screen: 'home', keys: ['LEFT'] })), /lost before submission/);
  f.advance(61000);
  const resumed = f.open(f.saved()); const outcome = await resumed.resume();
  assert.equal(outcome.stage, 'needs_user');
  assert.equal(outcome.result.reason, 'submission_not_found');
  assert.equal(f.calls.filter(call => call.action === 'navigation.sequence').length, 0);
});

test('twelve navigation keys use one Hub operation and two pending-operation checkpoints rather than twelve operations', async () => {
  const f = fixture(), w = f.workflow; await w.prepare(); let checkpoints = 0;
  f.onSave = journal => { if (journal.pending?.action === 'navigation.sequence') checkpoints++; };
  const before = f.calls.length, sequence = w.status().sequence;
  await w.step(frameDecision(w, 'keys', { screen: 'home', keys: Array(12).fill('LEFT') }));
  const added = f.calls.slice(before); assert.deepEqual(added.map(call => call.action), ['navigation.sequence', 'screen.observe']);
  assert.equal(added[0].args.keys.length, 12); assert.equal(checkpoints, 2); assert.equal(w.status().sequence - sequence, 2);
  assert.equal(added[0].args.notAfter, new Date(Date.parse('2026-01-01T00:00:00Z') + 60000).toISOString());
});

test('missing sequence authority fails clearly without falling back to per-key submissions or modifying grants', async () => {
  const f = fixture(); const caps = f.client.capabilities;
  f.client.capabilities = async () => { const result = await caps(); delete result.actions['navigation.sequence']; return result; };
  await assert.rejects(f.workflow.prepare(), { code: 'MOVIE_PERMISSION_REQUIRED' }); assert.deepEqual(f.calls, []);
});

test('profile and player sequence restrictions stay narrow and Play remains its independent single-key operation', async () => {
  const f = fixture(), w = f.workflow; await w.prepare();
  await assert.rejects(w.step(frameDecision(w, 'keys', { screen: 'profile', selectedProfileUnlocked: true, keys: ['DOWN', 'ENTER'] })), { code: 'MOVIE_PROFILE_CONSENT_REQUIRED' });
  await w.step(frameDecision(w, 'keys', { screen: 'profile', selectedProfileUnlocked: true, keys: ['ENTER'] }));
  assert.deepEqual(f.calls.find(call => call.action === 'navigation.sequence').args.keys, ['ENTER']);
  await w.step(frameDecision(w, 'details', { title: 'Frozen', year: 2013, playFocused: true })); await w.step(frameDecision(w, 'play'));
  assert.equal(f.calls.filter(call => call.action === 'navigation.key' && call.args.key === 'ENTER').length, 1);
  await assert.rejects(w.step(frameDecision(w, 'keys', { screen: 'player', keys: ['UP', 'UP'] })), { code: 'MOVIE_INVALID_DECISION' });
  await w.step(frameDecision(w, 'keys', { screen: 'player', keys: ['UP'] }));
  assert.deepEqual(f.calls.filter(call => call.action === 'navigation.sequence').at(-1).args.keys, ['UP']);
});

test('workflow key arrays are copied before durable writes and reject accessors, holes and proxies without execution', async () => {
  const f = fixture(), w = f.workflow; await w.prepare(); let invoked = 0;
  const accessor = ['LEFT']; Object.defineProperty(accessor, '0', { enumerable: true, get() { invoked++; return 'ENTER'; } });
  for (const keys of [accessor, Array(1), new Proxy(['LEFT'], { ownKeys() { invoked++; return []; } })]) {
    await assert.rejects(w.step(frameDecision(w, 'keys', { screen: 'home', keys })), { code: 'MOVIE_INVALID_DECISION' });
  }
  const keys = ['LEFT', 'RIGHT']; f.onSave = () => { keys[1] = 'POWER'; };
  await w.step(frameDecision(w, 'keys', { screen: 'home', keys }));
  assert.deepEqual(f.calls.find(call => call.action === 'navigation.sequence').args.keys, ['LEFT', 'RIGHT']); assert.equal(invoked, 0);
});

test('a checkpoint that consumes the bounded frame dispatch budget records cancellation without submitting', async () => {
  const f = fixture(), w = f.workflow; await w.prepare(); f.advance(58500);
  f.onSave = journal => { if (journal.pending?.action === 'navigation.sequence') f.advance(1100); };
  await assert.rejects(w.step(frameDecision(w, 'keys', { screen: 'home', keys: ['LEFT', 'ENTER'] })), { code: 'MOVIE_FRESH_FRAME_REQUIRED' });
  assert.equal(f.calls.some(call => call.action === 'navigation.sequence'), false); assert.equal(w.status().lastOperation.state, 'cancelled'); assert.equal(f.saved().pending, null);
});

test('restart recovery of an unknown sequence never invents progress or submits the unobserved suffix', async () => {
  const f = fixture(), w = f.workflow; await w.prepare(); f.lost = true;
  await assert.rejects(w.step(frameDecision(w, 'keys', { screen: 'home', keys: ['LEFT', 'RIGHT', 'ENTER'] })), /lost response/);
  const original = f.calls.find(call => call.action === 'navigation.sequence');
  const operation = [...f.operations.values()].find(operation => operation.action === 'navigation.sequence');
  operation.state = 'unknown'; delete operation.result;
  let recoveredProgress;
  f.onSave = journal => { if (journal.lastOperation?.action === 'navigation.sequence') recoveredProgress = journal.lastOperation; };
  const reopened = f.open(f.saved()); await reopened.resume();
  assert.equal(recoveredProgress.progressAvailable, false); assert.equal(recoveredProgress.transportSentCount, null); assert.equal(recoveredProgress.sequenceComplete, false);
  assert.equal(f.calls.filter(call => call.action === 'navigation.sequence').length, 1); assert.equal(original.args.keys.length, 3);
});
