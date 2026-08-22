/**
 * Last-resort backstop against SILENT SUCCESS.
 *
 * Node exits 0 when its event loop drains, whether or not the work it was
 * doing ever finished. An unsettled `await` with nothing left to keep the
 * loop alive therefore reads to a caller — a CI job, the e2e harness, an
 * operator's `&&` chain — as a completed, successful run. The 2026-08-11
 * v1/vultr matrix hit exactly that: a clack password prompt on an EOF stdin
 * neither resolved nor cancelled, the loop drained, and `vibecarbon deploy`
 * exited 0 in 1.1s having provisioned nothing. Only the e2e's own "no server
 * IPs in .vibecarbon.json" check noticed.
 *
 * `assertInteractiveStdin` fixes the prompt case at its source with a real
 * error message. This module fixes the DRAIN class: if the command promise
 * has not settled by the time node runs out of work, the run did not
 * complete and must not report success.
 *
 * SCOPE — this catches the event-loop DRAIN only. A hang that keeps a
 * referenced handle alive (an open socket, a pending timer, a child process
 * still attached) never reaches `beforeExit` at all: that process hangs
 * forever rather than exiting, which is a different failure mode and out of
 * scope here — an external timeout is what catches those.
 *
 * `beforeExit` is the right hook precisely because it does NOT fire for
 * `process.exit()` — deliberate exits (including the cancel/decline paths
 * below) stay untouched. It fires only on the natural drain.
 *
 * The cancel and decline paths below are the same class seen from the other
 * side: a run the operator aborted, or explicitly refused, must not report
 * success either.
 */
import * as p from '@clack/prompts';

/** Exit code for "the command never finished" — distinct from a normal
 *  failure (1) so operators and CI can tell a hang from a real error. */
export const UNSETTLED_EXIT_CODE = 70;

/** Exit code for an operator-cancelled prompt (Ctrl-C / ESC). 130 is the
 *  POSIX convention for "terminated by SIGINT" and is what a shell reports
 *  for a real Ctrl-C, so `&&` chains and CI stop instead of continuing. */
export const CANCELLED_EXIT_CODE = 130;

/**
 * Abort the run because the operator cancelled a prompt.
 *
 * This used to be `p.cancel(...); process.exit(0)` at 59 sites, which told
 * every caller the command had SUCCEEDED — a cancelled `deploy` and a
 * finished `deploy` were indistinguishable to a script. Cancelling is a
 * non-completion, so it exits 130 like the Ctrl-C it almost always is.
 *
 * @param {string} [message='Operation cancelled.'] - shown via clack.
 * @returns {never}
 */
export function exitCancelled(message = 'Operation cancelled.') {
  p.cancel(message);
  process.exit(CANCELLED_EXIT_CODE);
}

/** Exit code for an explicit "no" at a confirmation prompt. A DECLINE is not
 *  an INTERRUPT: the operator was present, read the question, and answered.
 *  That is an ordinary failed precondition (1), not a SIGINT (130) — but it
 *  is still a non-completion, so it must stop an `&&` chain just the same. */
export const DECLINED_EXIT_CODE = 1;

/**
 * Abort the run because the operator answered "no" to a confirmation.
 *
 * Kept distinct from `exitCancelled` because the two used to be conflated as
 * `if (p.isCancel(x) || !x)`, which forced one exit code onto two different
 * operator intents. Ctrl-C and "no" both stop the run, but only one of them
 * is an interrupt, and a caller inspecting `$?` deserves to tell them apart.
 *
 * @param {string} [message='Aborted: not confirmed.'] - shown via clack.
 * @returns {never}
 */
export function exitDeclined(message = 'Aborted: not confirmed.') {
  p.cancel(message);
  process.exit(DECLINED_EXIT_CODE);
}

/**
 * Arm the guard. Call once, as early in the CLI as possible, then hand the
 * returned `done` to BOTH arms of the command promise.
 *
 * @param {object} [options]
 * @param {NodeJS.WriteStream|{write: (s: string) => unknown}} [options.stderr=process.stderr]
 * @param {{isTTY?: boolean}} [options.stdin=process.stdin]
 * @param {NodeJS.EventEmitter} [options.proc=process] - injectable for testing.
 * @returns {{done: () => void}} `done` marks the command settled.
 */
export function installUnsettledExitGuard(options = {}) {
  const { stderr = process.stderr, stdin = process.stdin, proc = process } = options;
  let settled = false;

  // Tracks whether WE set the exit code, so `done` can only ever undo its own
  // verdict — never someone else's deliberate failure code.
  let markedExitCode = false;

  proc.on('beforeExit', () => {
    if (settled) return;
    // Re-entrancy: a beforeExit handler that itself queues work fires again.
    // Mark settled so the diagnostic prints exactly once.
    settled = true;
    const hint = stdin.isTTY
      ? 'Something the command was waiting on can never finish.'
      : 'stdin is not a TTY, so an interactive prompt opened here could never be answered.';
    stderr.write(
      '\nvibecarbon exited without completing: the command never completed, and node ran ' +
        `out of work while it was still in flight.\n${hint}\n` +
        'Nothing here should be treated as a successful run.\n',
    );
    // exitCode (not process.exit) so any pending stderr flush completes.
    process.exitCode = UNSETTLED_EXIT_CODE;
    markedExitCode = true;
  });

  return {
    done: () => {
      settled = true;
      // A command CAN settle after a beforeExit verdict: `beforeExit` fires on
      // a drain, and a handler elsewhere may then queue work that lets the
      // command finish after all. Retract our verdict in that case — but only
      // ours, and only if nothing has since set a different code.
      if (markedExitCode && process.exitCode === UNSETTLED_EXIT_CODE) {
        process.exitCode = 0;
      }
      markedExitCode = false;
    },
  };
}
