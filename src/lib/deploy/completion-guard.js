/**
 * Silent-success guard for the deploy process.
 *
 * RCA (2026-07-07 k8s-ha full matrix, HEAD 8fa93b8): a k8s-ha cold deploy ran
 * 31m31s, exited 0, and persisted NO server IPs — `.vibecarbon.json` was left at
 * the skeleton (status:'deploying'). The plan itself is faithful and un-gated;
 * the fault was upstream of the plan's tail: the STANDBY cluster's `deployK3s`
 * promise (run inside `Promise.allSettled` in the provision-clusters effect)
 * silently never settled — a dropped settlement in the async SSH/kubectl exec
 * layer during `applyManifests` (the `deploy.ha.k8s.standby` perf span never
 * emitted, while `deploy.ha.k8s.primary` did). With that promise dangling and no
 * pending libuv handles left, Node drained the event loop and exited 0 — WITH
 * the replication hard-gate (verify-streaming) and config persistence never
 * reached. A deploy that skips its DR gate yet reports success is the worst
 * failure mode this codebase has.
 *
 * The runner's `required`-step throw covers the when-skip class (a load-bearing
 * step gated out). This guard covers the HARDER case that actually bit us: the
 * awaited deploy chain never settles at all, so no throw, no catch, no finalize
 * — the process just exits 0. `executeDeployment` arms the guard on entry and
 * marks completion only after the terminal `saveProjectConfig`. If the process
 * exits with a success code while armed-but-not-completed, the 'exit' handler
 * forces a non-zero code and prints an actionable diagnostic, converting a silent
 * exit-0 into a loud failure the e2e matrix (and a human) cannot miss.
 */

import { UNSETTLED_EXIT_CODE } from '../cli/exit-guard.js';

// Neutral as to the code being exited with: this fires both on a success exit
// (the original silent-exit-0 case) and on the CLI-wide guard's 70, where
// "exiting successfully" would have been simply false.
const GUARD_MESSAGE =
  '\nFATAL: the deploy process is exiting but the deployment never reached its ' +
  'terminal state, configuration was NOT persisted and the replication/DR gate was NOT ' +
  'verified. This is the silent-failure guard: the deploy did NOT complete (a deploy step ' +
  'likely hung or an awaited promise never settled). Treat this environment as NOT deployed; ' +
  're-run `vibecarbon deploy` and check the deploy log.\n';

let armed = false;
let completed = false;
let registered = false;

/**
 * Pure decision function (exported for unit tests): given the guard state and
 * the code the process is exiting with, decide whether to fail the exit.
 * @param {{armed:boolean, completed:boolean, exitCode:number|null|undefined}} state
 * @returns {{fail:boolean, message?:string}}
 */
export function evaluateExitGuard({ armed: isArmed, completed: isCompleted, exitCode }) {
  if (!isArmed || isCompleted) return { fail: false };

  // A SUCCESS exit (0 / unset) is the original silent-failure case: force a
  // non-zero code and say why.
  const isSuccessCode = exitCode === 0 || exitCode === undefined || exitCode === null;
  if (isSuccessCode) {
    return { fail: true, message: GUARD_MESSAGE, exitCode: 1 };
  }

  // The CLI-wide unsettled guard (lib/cli/exit-guard.js) gets to `beforeExit`
  // first and stamps 70 on the same drain this guard was built for. That code
  // is already loud, but it is generic — it cannot say that config was never
  // persisted or that the DR gate never ran. Keep its code, add our meaning.
  if (exitCode === UNSETTLED_EXIT_CODE) {
    return { fail: true, message: GUARD_MESSAGE, exitCode: UNSETTLED_EXIT_CODE };
  }

  // Any other non-zero code is a real failure that already reported itself —
  // never mask it.
  return { fail: false };
}

/**
 * Arm the guard for the current deploy. Call once at the top of
 * executeDeployment. Registers a single process 'exit' handler (idempotent).
 * Skips handler registration under Vitest so a test that exercises the
 * orchestrator can't flip the test runner's own exit code — the decision logic
 * is validated directly via `evaluateExitGuard`.
 */
export function armDeployCompletionGuard() {
  armed = true;
  completed = false;
  if (registered || process.env.VITEST) return;
  registered = true;
  process.on('exit', (code) => {
    // 'exit' handlers must be synchronous. For a NATURAL event-loop drain
    // (exactly tonight's failure) Node finalizes the code from process.exitCode
    // AFTER handlers run, so setting it here takes effect.
    const verdict = evaluateExitGuard({ armed, completed, exitCode: code });
    if (verdict.fail) {
      process.exitCode = verdict.exitCode;
      process.stderr.write(verdict.message);
    }
  });
}

/**
 * Mark the deploy as having reached its terminal, fully-persisted state. Call
 * once at the very end of executeDeployment (after the final saveProjectConfig).
 */
export function markDeployCompleted() {
  completed = true;
}

/** Test-only: reset module state between cases. */
export function __resetCompletionGuardForTest() {
  armed = false;
  completed = false;
}
