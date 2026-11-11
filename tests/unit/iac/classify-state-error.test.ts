import { describe, expect, it } from 'vitest';
// @ts-expect-error — JS module without types
import {
  asStateUndecryptableError,
  classifyStateError,
  findStatePassphraseError,
  isStatePassphraseFailure,
  StateMigrationError,
  StateUndecryptableError,
} from '../../../src/lib/iac/state-error.js';
import { StatePassphraseError } from '../../../src/lib/state-passphrase.js';
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

/**
 * Two errors whose causes point at each other. Each `cause` read is counted,
 * and past 50 reads it throws: the walk is synchronous, so without its cycle
 * guard it would spin forever and vitest's timeout would never fire. This
 * turns a missing guard into a failure.
 */
function countedCauseCycle() {
  let reads = 0;
  const outer = new Error('outer');
  const inner = new Error('inner');
  const pointAt = (from: Error, to: Error) =>
    Object.defineProperty(from, 'cause', {
      get() {
        reads += 1;
        if (reads > 50) throw new Error('walked past 50 cause links: the cycle guard is gone');
        return to;
      },
    });
  pointAt(outer, inner);
  pointAt(inner, outer);
  return { head: outer, reads: () => reads };
}

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

describe('the state passphrase class', () => {
  const passphraseCases = STATE_ERROR_CORPUS.filter((c) => c.expect.cause === 'passphrase');

  it("covers each of Pulumi's refusals: on decrypt, on encrypt, and none at all", () => {
    expect(passphraseCases.some((c) => c.message.includes('failed to decrypt'))).toBe(true);
    expect(passphraseCases.some((c) => c.message.includes('failed to encrypt'))).toBe(true);
    expect(passphraseCases.some((c) => c.message.includes('passphrase must be set'))).toBe(true);
  });

  it('a retryable failure that merely mentions a passphrase is still retried', () => {
    // STATE_ERROR_NEGATIVES holds the fatal near misses; these two keep
    // their retry, so they live here. The word alone claims nothing.
    const throttled = classifyStateError({
      message:
        'Command failed with exit code 1: pulumi up --stack e1 --non-interactive\nerror: blob (key ".pulumi/stacks/passphrase-demo/e1.json") (code=Unknown): 503 SlowDown: Please reduce your request rate',
      operation: 'up',
    });
    expect(throttled.cause).toBe('throttle');
    expect(throttled.recovery).toBe('retry-in-place');
    const locked = classifyStateError({
      message:
        'Command failed with exit code 1: pulumi up --stack passphrase-e1 --non-interactive\nerror: the stack is currently locked by 1 lock(s). Either wait for the other process to finish or delete the lock file',
      operation: 'up',
    });
    expect(locked.cause).toBe('lock-contention');
    expect(locked.recovery).toBe('retry-in-place');
  });

  it('is never retried, even when the same output carries retryable wording', () => {
    // A held lock or a SlowDown in the same output must not turn a key that
    // cannot open the state into a retry: the same key gives the same answer
    // on every attempt.
    for (const c of passphraseCases) {
      for (const noise of [
        'error: the stack is currently locked by 1 lock(s). Either wait for the other process to finish or delete the lock file',
        'error: 503 SlowDown: Please reduce your request rate',
      ]) {
        const got = classifyStateError({
          message: `${c.message}\n${noise}`,
          operation: c.operation,
        });
        expect(got.cause, c.id).toBe('passphrase');
        expect(got.recovery, c.id).toBe('fail');
      }
    }
  });
});

describe('isStatePassphraseFailure', () => {
  it('recognises every passphrase corpus entry, raw or wrapped by a caller', () => {
    for (const c of STATE_ERROR_CORPUS.filter((e) => e.expect.cause === 'passphrase')) {
      const raw = new Error(c.message);
      expect(isStatePassphraseFailure(raw), c.id).toBe(true);
      // destroyStack wraps a failed destroy with `{ cause }`.
      const wrapped = new Error('pulumi destroy for stack "e1" failed', { cause: raw });
      expect(isStatePassphraseFailure(wrapped), `${c.id} wrapped`).toBe(true);
    }
  });

  it('recognises the passphrase check that runs before Pulumi does', () => {
    const err = new StatePassphraseError('missing', "This project's state passphrase isn't set.");
    expect(isStatePassphraseFailure(err)).toBe(true);
    expect(isStatePassphraseFailure(new StateUndecryptableError('e1'))).toBe(true);
  });

  it('is false for every other state failure and for nothing at all', () => {
    for (const c of [...STATE_ERROR_CORPUS, ...STATE_ERROR_NEGATIVES]) {
      if (c.expect.cause === 'passphrase') continue;
      expect(isStatePassphraseFailure(new Error(c.message)), c.id).toBe(false);
    }
    expect(isStatePassphraseFailure(undefined)).toBe(false);
    expect(isStatePassphraseFailure(null)).toBe(false);
  });

  it('is false for a legacy migration that stopped, whatever its cause says', () => {
    // The migration names its own step; a refusal it carries as the cause
    // (a re-encryption that ended with the project passphrase still refused)
    // proves '' read the state, so nothing about it is a lost passphrase.
    const refusal = new Error(
      STATE_ERROR_CORPUS.find((c) => c.id === 'passphrase-incorrect-on-export')?.message,
    );
    expect(isStatePassphraseFailure(refusal)).toBe(true);
    const stopped = new StateMigrationError('Stopped after re-encrypting the state for e1', {
      cause: refusal,
    });
    expect(isStatePassphraseFailure(stopped)).toBe(false);
    expect(isStatePassphraseFailure(new Error('wrapped', { cause: stopped }))).toBe(false);
  });

  it('survives a cause cycle, visiting each error once', () => {
    const cycle = countedCauseCycle();
    expect(isStatePassphraseFailure(cycle.head)).toBe(false);
    expect(cycle.reads()).toBe(2);
  });
});

describe('StateUndecryptableError', () => {
  it('says what happened, what it means, and what still works', () => {
    const err = new StateUndecryptableError('prod');
    expect(err.message).toBe(
      "vibecarbon can't decrypt the Pulumi state for prod with this project's passphrase. If it was written with a passphrase you no longer have, that state can't be recovered. You can still remove the servers with `vibecarbon destroy prod` and deploy again.",
    );
    expect(err.message).not.toContain('—');
    expect(err.stackName).toBe('prod');
  });

  it('names the environment, not the HA stack, in the destroy command', () => {
    expect(new StateUndecryptableError('prod-primary').message).toContain(
      'Pulumi state for prod-primary',
    );
    expect(new StateUndecryptableError('prod-standby').message).toContain(
      '`vibecarbon destroy prod`',
    );
  });

  it('asStateUndecryptableError wraps only a raw Pulumi refusal', () => {
    const raw = new Error(
      STATE_ERROR_CORPUS.find((c) => c.id === 'passphrase-incorrect-on-outputs')?.message,
    );
    const typed = asStateUndecryptableError(raw, 'e1');
    expect(typed).toBeInstanceOf(StateUndecryptableError);
    expect(typed.stackName).toBe('e1');
    expect(typed.cause).toBe(raw);

    // Already typed, or not about the passphrase: handed back untouched.
    const precheck = new StatePassphraseError('mismatch', 'mismatch');
    expect(asStateUndecryptableError(precheck, 'e1')).toBe(precheck);
    expect(asStateUndecryptableError(typed, 'e2')).toBe(typed);
    const other = new Error("error: no stack named 'e1' found");
    expect(asStateUndecryptableError(other, 'e1')).toBe(other);
  });
});

describe('findStatePassphraseError', () => {
  const precheck = () =>
    new StatePassphraseError('missing', "This project's state passphrase isn't set.");

  it('finds the precheck error at the top or anywhere down the cause chain', () => {
    const top = precheck();
    expect(findStatePassphraseError(top)).toBe(top);
    const deep = precheck();
    const wrapped = new Error('outer', { cause: new Error('middle', { cause: deep }) });
    expect(findStatePassphraseError(wrapped)).toBe(deep);
  });

  it("is null for Pulumi's own refusal, plain errors and non-errors", () => {
    expect(
      findStatePassphraseError(new StateUndecryptableError('e1', { cause: new Error('x') })),
    ).toBeNull();
    expect(findStatePassphraseError(new Error('boom'))).toBeNull();
    expect(findStatePassphraseError(undefined)).toBeNull();
    expect(findStatePassphraseError('StatePassphraseError')).toBeNull();
  });

  it('stops on a cause cycle, visiting each error once', () => {
    const cycle = countedCauseCycle();
    expect(findStatePassphraseError(cycle.head)).toBeNull();
    expect(cycle.reads()).toBe(2);
  });
});
