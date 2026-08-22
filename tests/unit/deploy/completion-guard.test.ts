import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetCompletionGuardForTest,
  armDeployCompletionGuard,
  evaluateExitGuard,
  markDeployCompleted,
} from '../../../src/lib/deploy/completion-guard.js';

// The silent-success guard converts tonight's failure mode — a deploy process
// that exits 0 while its awaited chain never settled (standby deployK3s promise
// dangled → event loop drained → Node exit 0 with the DR gate + config-persist
// never reached) — into a non-zero exit. These tests pin the pure decision
// function `evaluateExitGuard`, which the process 'exit' handler consults.
describe('evaluateExitGuard', () => {
  afterEach(() => __resetCompletionGuardForTest());

  it('FAILS a success exit when armed but never completed (the k8s-ha silent-exit-0 case)', () => {
    expect(evaluateExitGuard({ armed: true, completed: false, exitCode: 0 })).toEqual({
      fail: true,
      message: expect.stringContaining('silent-failure guard'),
      // The verdict now carries the code to set, because the CLI-wide
      // unsettled guard can hand this one a 70 that must be kept as-is.
      exitCode: 1,
    });
    // A natural event-loop drain exits with process.exitCode unset.
    expect(evaluateExitGuard({ armed: true, completed: false, exitCode: undefined }).fail).toBe(
      true,
    );
    expect(evaluateExitGuard({ armed: true, completed: false, exitCode: null }).fail).toBe(true);
  });

  it('accepts a success exit once the deploy has completed', () => {
    expect(evaluateExitGuard({ armed: true, completed: true, exitCode: 0 }).fail).toBe(false);
  });

  it('never masks an already-failing (non-zero) exit code', () => {
    // A deploy that threw + exited 1 is loud enough; the guard must not touch it.
    expect(evaluateExitGuard({ armed: true, completed: false, exitCode: 1 }).fail).toBe(false);
    expect(evaluateExitGuard({ armed: true, completed: false, exitCode: 130 }).fail).toBe(false);
  });

  it('is inert when never armed (e.g. -h/-v/secret-refuse early exits)', () => {
    expect(evaluateExitGuard({ armed: false, completed: false, exitCode: 0 }).fail).toBe(false);
  });

  it('arm() then markDeployCompleted() flips the guard to a clean pass under Vitest (no handler registered)', () => {
    // Under Vitest, arming does NOT register a process 'exit' handler (so it can
    // never flip the test runner's own exit code), but the arm/complete state
    // still transitions so the decision function reflects a real deploy.
    armDeployCompletionGuard();
    expect(evaluateExitGuard({ armed: true, completed: false, exitCode: 0 }).fail).toBe(true);
    markDeployCompleted();
    expect(evaluateExitGuard({ armed: true, completed: true, exitCode: 0 }).fail).toBe(false);
  });
});
