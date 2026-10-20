import { performance } from 'node:perf_hooks';

const MAX_ATTEMPTS = 2;
const WALL_BUDGET_MS = 185000;
const OPERATION_BUDGET_MS = 45000;
const PROBE = 'non-secret-ephemeral-ci-probe';
const PURPOSE = 'test/ci-dpapi-preflight';
const CODES = new Set(['SECRET_STORE_TIMEOUT', 'SECRET_STORE_FAILED', 'SECRET_STORE_UNSUPPORTED',
  'INVALID_SECRET_ENVELOPE', 'INVALID_SECRET_PURPOSE', 'INVALID_SECRET_VALUE', 'INVALID_SECRET_PROVIDER',
  'PREFLIGHT_BUDGET_EXCEEDED', 'PREFLIGHT_VALUE_MISMATCH']);
const failure = code => Object.assign(new Error('CurrentUser DPAPI preflight failed.'), { code });

/** Fixed non-secret self-test only. Never wrap real credential access in this retry. */
export async function runDPAPIPreflight({ seal, open, onProgress = () => {}, now = () => performance.now() } = {}) {
  if (typeof seal !== 'function' || typeof open !== 'function' || typeof onProgress !== 'function' || typeof now !== 'function') throw failure('SECRET_STORE_FAILED');
  const started = now();
  const deadline = started + WALL_BUDGET_MS;
  const elapsed = () => Math.max(0, Math.floor(now() - started));
  const emit = (phase, attempt, code) => {
    const event = Object.freeze({ phase, attempt, elapsedMs: elapsed(), code });
    onProgress(event);
    return event;
  };
  const withinBudget = (starting = false) => {
    // Production seal/open each have an independent 45-second deadline. Do not
    // begin another subprocess unless that entire bound fits in the fixed
    // monotonic wall budget. No detached Promise.race/provider is left running.
    if (deadline - now() < (starting ? OPERATION_BUDGET_MS : 0)) throw failure('PREFLIGHT_BUDGET_EXCEEDED');
  };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let phase = 'protect';
    try {
      withinBudget(true); emit(phase, attempt, 'STARTED'); withinBudget(true);
      const envelope = await seal(PROBE, { purpose: PURPOSE });
      withinBudget(); emit(phase, attempt, 'OK');
      phase = 'unprotect';
      withinBudget(true); emit(phase, attempt, 'STARTED'); withinBudget(true);
      const value = await open(envelope, { purpose: PURPOSE });
      withinBudget();
      if (value !== PROBE) throw failure('PREFLIGHT_VALUE_MISMATCH');
      emit(phase, attempt, 'OK');
      return emit('complete', attempt, 'PREFLIGHT_OK');
    } catch (error) {
      const code = CODES.has(error?.code) ? error.code : 'SECRET_STORE_FAILED';
      emit(phase, attempt, code);
      if (code !== 'SECRET_STORE_TIMEOUT' || attempt === MAX_ATTEMPTS) throw failure(code);
    }
  }
  throw failure('SECRET_STORE_FAILED');
}
