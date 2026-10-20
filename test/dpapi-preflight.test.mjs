import test from 'node:test';
import assert from 'node:assert/strict';
import { runDPAPIPreflight } from '../scripts/lib/dpapi-preflight.mjs';

const timeout = () => Object.assign(new Error('private-provider-message'), { code: 'SECRET_STORE_TIMEOUT' });

test('non-secret preflight uses fixed values and emits only static phase/attempt/timing/code metadata', async () => {
  let clock = 0; const events = []; const calls = [];
  const envelope = { privateFixture: 'must-not-be-logged' };
  const result = await runDPAPIPreflight({ now: () => clock, onProgress: event => events.push(event),
    async seal(value, options) { calls.push(['seal', value, options]); clock += 10; return envelope; },
    async open(value, options) { assert.equal(value, envelope); calls.push(['open', options]); clock += 8; return 'non-secret-ephemeral-ci-probe'; },
  });
  assert.deepEqual(calls, [['seal', 'non-secret-ephemeral-ci-probe', { purpose: 'test/ci-dpapi-preflight' }], ['open', { purpose: 'test/ci-dpapi-preflight' }]]);
  assert.deepEqual(result, { phase: 'complete', attempt: 1, elapsedMs: 18, code: 'PREFLIGHT_OK' });
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ['attempt', 'code', 'elapsedMs', 'phase']);
    assert.ok(Object.isFrozen(event));
  }
  assert.equal(JSON.stringify(events).includes('must-not-be-logged'), false);
});

test('one protect timeout retries only the fixed non-secret roundtrip and retains the failure event', async () => {
  let clock = 0; let seals = 0; let opens = 0; const events = [];
  const result = await runDPAPIPreflight({ now: () => clock, onProgress: event => events.push(event),
    async seal() { if (++seals === 1) { clock += 45000; throw timeout(); } clock += 10; return {}; },
    async open() { opens++; clock += 10; return 'non-secret-ephemeral-ci-probe'; },
  });
  assert.equal(seals, 2); assert.equal(opens, 1); assert.equal(result.attempt, 2);
  assert.ok(events.some(event => event.attempt === 1 && event.phase === 'protect' && event.code === 'SECRET_STORE_TIMEOUT'));
  assert.equal(JSON.stringify(events).includes('private-provider-message'), false);
});

test('an unprotect timeout restarts the full non-secret roundtrip with a new envelope', async () => {
  let clock = 0; let seals = 0; let opens = 0; const seen = [];
  await runDPAPIPreflight({ now: () => clock,
    async seal() { clock += 10; return { generation: ++seals }; },
    async open(envelope) { seen.push(envelope.generation); if (++opens === 1) { clock += 45000; throw timeout(); } return 'non-secret-ephemeral-ci-probe'; },
  });
  assert.equal(seals, 2); assert.equal(opens, 2); assert.deepEqual(seen, [1, 2]);
});

test('generic, unsupported and validation failures never retry or reflect provider messages/codes', async () => {
  for (const [code, expected] of [['SECRET_STORE_FAILED', 'SECRET_STORE_FAILED'], ['SECRET_STORE_UNSUPPORTED', 'SECRET_STORE_UNSUPPORTED'],
    ['INVALID_SECRET_ENVELOPE', 'INVALID_SECRET_ENVELOPE'], ['private-code-must-not-leak', 'SECRET_STORE_FAILED']]) {
    let calls = 0; const events = [];
    await assert.rejects(runDPAPIPreflight({ onProgress: event => events.push(event),
      async seal() { calls++; throw Object.assign(new Error('private-provider-message'), { code }); },
      async open() { assert.fail('Open must not run after failed protect'); },
    }), error => error.code === expected && error.message === 'CurrentUser DPAPI preflight failed.');
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(events).includes('private-provider-message'), false);
    assert.equal(JSON.stringify(events).includes('private-code-must-not-leak'), false);
  }
  let seals = 0;
  await assert.rejects(runDPAPIPreflight({ async seal() { seals++; return {}; }, async open() { return 'different-value'; } }), { code: 'PREFLIGHT_VALUE_MISMATCH' });
  assert.equal(seals, 1);
});

test('two deadline failures remain fatal and cannot create a third attempt', async () => {
  let clock = 0; let calls = 0;
  await assert.rejects(runDPAPIPreflight({ now: () => clock,
    async seal() { calls++; clock += 45000; throw timeout(); }, async open() { assert.fail('No envelope exists'); },
  }), { code: 'SECRET_STORE_TIMEOUT' });
  assert.equal(calls, 2); assert.equal(clock, 90000);
});

test('fixed 185-second budget reserves the complete production deadline before each new phase', async () => {
  let clock = 0; let seals = 0; let opens = 0; const events = [];
  await assert.rejects(runDPAPIPreflight({ now: () => clock,
    onProgress(event) { events.push(event); if (event.phase === 'protect' && event.attempt === 1 && event.code === 'OK') clock += 6000; },
    async seal() { seals++; clock += 45000; return {}; },
    async open() { opens++; clock += 45000; throw timeout(); },
  }), { code: 'PREFLIGHT_BUDGET_EXCEEDED' });
  assert.equal(seals, 2); assert.equal(opens, 1);
  assert.equal(clock, 141000);
  assert.deepEqual(events.at(-1), { phase: 'unprotect', attempt: 2, elapsedMs: 141000, code: 'PREFLIGHT_BUDGET_EXCEEDED' });
});
