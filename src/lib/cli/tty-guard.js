/**
 * TTY-detection guard for interactive-by-default commands.
 *
 * Vibecarbon's CLI is interactive-first: bare commands open a clack
 * prompt flow. That model breaks when stdin isn't a TTY (CI, piped
 * input, `< /dev/null` smoke tests). Rather than letting clack hang or
 * silently misbehave, every command that intends to prompt calls
 * `requireTTYOrFlags()` after parsing argv. If we're on a TTY, the call
 * is a no-op. Off a TTY, the guard checks whether the operator supplied
 * enough flags to skip every prompt the command would otherwise issue;
 * if they did, fine — proceed. If they didn't, exit 1 with a message
 * naming exactly which flags would unblock this invocation.
 *
 * Why this shape (and not "always require flags off-TTY"): some
 * commands are no-prompt by nature (e.g. `vibecarbon backup -env prod
 * -l` is a pure read). Demanding flags from those operators would be
 * theatre. The guard takes a `requirements` array describing which
 * prompts would otherwise run, and only complains about the ones the
 * operator hasn't already short-circuited.
 *
 * @typedef {object} PromptRequirement
 * @property {string} flag - the flag name that pre-fills this prompt
 *   (e.g. "env", "action").
 * @property {string} description - what this prompt would ask, in
 *   imperative form (e.g. "select an environment").
 * @property {boolean} satisfied - true if argv already supplies a
 *   value (operator pre-filled via flag or positional). When false,
 *   the command would have opened a prompt.
 */

import { c } from '../colors.js';

/**
 * Verify we're either on an interactive TTY OR the operator supplied
 * every flag needed to skip the prompts. Exits 1 with a canonical
 * "needs TTY or these flags" message otherwise. Returns void on
 * success.
 *
 * @param {object} options
 * @param {PromptRequirement[]} options.requirements - prompts the
 *   command would issue without flag short-circuits.
 * @param {NodeJS.ReadStream} [options.stdin=process.stdin] - injectable
 *   for testing.
 * @param {NodeJS.WriteStream} [options.stderr=process.stderr] -
 *   injectable for testing.
 * @param {(code: number) => never} [options.exit=process.exit] -
 *   injectable for testing.
 */
export function requireTTYOrFlags(options) {
  const {
    requirements,
    stdin = process.stdin,
    stderr = process.stderr,
    exit = /** @type {(code: number) => never} */ (process.exit.bind(process)),
  } = options;

  if (stdin.isTTY) return;

  const missing = requirements.filter((r) => !r.satisfied);
  if (missing.length === 0) return;

  // Format: one line per missing prompt with the flag that would
  // unblock it, so the operator can copy-paste a working invocation.
  const lines = [
    '',
    `${c.error('✗')} This command needs an interactive terminal, or these flags to skip prompts:`,
    '',
    ...missing.map((m) => `    -${m.flag.padEnd(10)}  ${m.description}`),
    '',
    'Run again with -h for the full flag reference.',
    '',
  ];
  stderr.write(`${lines.join('\n')}\n`);
  exit(1);
}

/**
 * Guard a prompt that argv CANNOT pre-empt — the runtime-conditional kind
 * `requireTTYOrFlags` structurally cannot see.
 *
 * That guard is argv-static: it decides up front which prompts a command
 * WILL open. Credential prompts aren't like that. `getApiToken` only opens
 * one after a live API call rejects the token, so a run that passed every
 * flag check can still arrive at a prompt ten seconds later.
 *
 * Off a TTY that arrival used to be FATAL AND SILENT: clack's prompt promise
 * neither resolves nor cancels on an EOF stdin (`< /dev/null`, CI, a piped
 * runner), so `isCancel` never fires, the event loop drains, and node exits
 * **0** mid-deploy. That is the 2026-08-11 v1/vultr silent success — a deploy
 * that "succeeded" in 1.1s having provisioned nothing.
 *
 * Throws rather than exiting so the failure travels the caller's normal
 * error path (step-name wrapping, spinner teardown, the CLI's exit-1 catch)
 * instead of tearing the process down from inside a library.
 *
 * @param {object} options
 * @param {string} options.what - what the prompt would ask for, as a noun
 *   phrase ("the Vultr API key").
 * @param {string} options.envVar - the env var that pre-empts this prompt;
 *   named in the error so the operator can fix the run in one step.
 * @param {{isTTY?: boolean}} [options.stdin=process.stdin] - injectable for
 *   testing (mirrors requireTTYOrFlags above).
 * @returns {void}
 */
export function assertInteractiveStdin(options) {
  const { what, envVar, stdin = process.stdin } = options;
  if (stdin.isTTY) return;
  throw new Error(
    `Cannot prompt for ${what}: stdin is not a TTY (non-interactive run), ` +
      `so the prompt could never be answered. Set ${envVar} to a valid value ` +
      'before re-running, or run this command in an interactive terminal.',
  );
}
