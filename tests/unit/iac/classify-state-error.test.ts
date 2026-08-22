import { describe, expect, it } from 'vitest';
// @ts-expect-error — JS module without types
import { classifyStateError } from '../../../src/lib/iac/state-error.js';
import {
  STATE_ERROR_CORPUS,
  STATE_ERROR_NEGATIVES,
  type StateErrorCase,
} from './fixtures/state-error-corpus.js';

/**
 * One classifier, judged against every state-backend failure we have observed.
 *
 * The seven nested recovery branches this replaces each answered the
 * mutation-safety question separately, from a string, inside their own catch
 * block — which is why they could disagree and why a recovery invoked from
 * inside another one could not reach the handler that knew the right answer
 * (run 31898658781). Here the question is answered once and the corpus is the
 * proof that collapsing them lost nothing.
 */

const run = (c: StateErrorCase) =>
  classifyStateError({ message: c.message, operation: c.operation });

/** Fails loudly if an incident is renamed or removed, rather than silently. */
const byId = (id: string): StateErrorCase => {
  const found = [...STATE_ERROR_CORPUS, ...STATE_ERROR_NEGATIVES].find((c) => c.id === id);
  if (!found) throw new Error(`no corpus entry '${id}' — was the incident removed?`);
  return found;
};

describe('classifyStateError — observed incidents', () => {
  for (const c of STATE_ERROR_CORPUS) {
    it(`${c.id}: ${c.incident}`, () => {
      const got = run(c);
      expect(got.cause, 'cause').toBe(c.expect.cause);
      expect(got.phase, 'phase').toBe(c.expect.phase);
      expect(got.recovery, 'recovery').toBe(c.expect.recovery);
    });
  }
});

describe('classifyStateError — must stay fatal', () => {
  for (const c of STATE_ERROR_NEGATIVES) {
    it(`${c.id}: ${c.incident}`, () => {
      const got = run(c);
      expect(got.cause, 'cause').toBe(c.expect.cause);
      expect(got.phase, 'phase').toBe(c.expect.phase);
      expect(got.recovery, 'recovery').toBe(c.expect.recovery);
    });
  }
});

describe('classifyStateError — the properties the corpus exists to protect', () => {
  it('the corpus is not trivially small', () => {
    // Guards against a future edit quietly deleting incidents to make a change
    // pass. Seven recovery branches were collapsed; the evidence for each has
    // to outnumber them.
    expect(STATE_ERROR_CORPUS.length).toBeGreaterThanOrEqual(10);
    expect(STATE_ERROR_NEGATIVES.length).toBeGreaterThanOrEqual(4);
  });

  it('distinguishes server overload from our own lock contention', () => {
    // Today both match STATE_BACKEND_THROTTLE_PATTERN and both log "throttled",
    // which is why this class was mislabelled as a consistency problem for
    // months: 38 of 40 events in run 31898658781 were logged identically and we
    // could not tell which were contention we caused.
    const throttle = run(byId('throttle-slowdown'));
    const lock = run(byId('lock-contention'));
    expect(throttle.cause).not.toBe(lock.cause);
  });

  it('separates the two `no stack named` cases by verb alone', () => {
    // The ci2 failure in one assertion. Identical error text; the only
    // difference is which pulumi command produced it, and that difference is
    // the whole mutation-safety answer. Re-running the post-mutation one could
    // double-provision; polling outputs on the pre-mutation one can only ever
    // return empty.
    const atStartup = byId('stack-file-missing-at-up-startup');
    const atOutputs = byId('stack-file-missing-at-post-up-outputs');

    expect(atStartup.message).toContain('no stack named');
    expect(atOutputs.message).toContain('no stack named');

    const a = run(atStartup);
    const b = run(atOutputs);
    expect(a.cause).toBe(b.cause);
    expect(a.phase).toBe('pre-mutation');
    expect(b.phase).toBe('post-mutation');
    // Both FAIL since the 2026-08-16 band-aid removal — the recoveries are
    // deleted with their trigger. The verb-derived PHASE is what survives,
    // because it is the operator's mutation-safety answer: pre-mutation means
    // a plain re-run is safe; post-mutation means resources exist and state
    // must be inspected first.
    expect(a.recovery).toBe('fail');
    expect(b.recovery).toBe('fail');
  });

  it('treats an unrecognised failure as not provably pre-mutation', () => {
    // Fail-safe is the whole contract for anything we do not recognise: the
    // recogniser set is always a lagging subset of the failure set.
    const got = classifyStateError({
      message: 'error: something nobody has seen',
      operation: 'up',
    });
    expect(got.phase).toBe('unknown');
    expect(got.recovery).toBe('fail');
  });

  it('never reports a recovery it cannot justify with a phase', () => {
    // Any recovery that mutates or reports success must rest on a definite
    // phase. `unknown` may only ever mean fail or a retry that is idempotent
    // regardless of phase.
    for (const c of [...STATE_ERROR_CORPUS, ...STATE_ERROR_NEGATIVES]) {
      const got = run(c);
      if (got.phase === 'unknown') {
        expect(['fail', 'retry-in-place'], `${c.id}`).toContain(got.recovery);
      }
    }
  });
});
