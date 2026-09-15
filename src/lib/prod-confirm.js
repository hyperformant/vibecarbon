/**
 * Shared production type-to-confirm guard.
 *
 * Destructive commands (destroy, restore, failover) must NOT let a `-y`
 * flag silently blow away a production environment. This module is the
 * single source of truth for "which envs are production" and for the
 * type-to-confirm prompt that runs UNCONDITIONALLY (independent of -y) on those
 * envs — matching `destroy`'s long-standing behavior.
 *
 * `src/destroy.js` imports requiresProdTypeToConfirm from here but keeps its
 * bespoke `projectName-envName` slug prompt (it type-confirms every env
 * interactively, not just prod).
 */

import * as p from '@clack/prompts';
import { exitCancelled } from './cli/exit-guard.js';

/**
 * Returns true for environment names that require a type-to-confirm prompt even
 * when -y is passed. Currently: `prod` and `production` (case-insensitive).
 * A trailing/leading qualifier (e.g. `prod-backup`, `production-us`) is NOT
 * treated as production — it is a distinct environment.
 *
 * @param {string | null | undefined} envName
 * @returns {boolean}
 */
export function requiresProdTypeToConfirm(envName) {
  if (!envName) return false;
  return /^(prod|production)$/i.test(envName);
}

/**
 * If `envName` is a production environment, require the operator to type a
 * confirmation string before continuing — even under -y. On cancel or a
 * non-production env with no confirmation needed, behaves correctly:
 *   - non-prod env: returns immediately (no prompt).
 *   - prod env: prompts; a cancel exits(0); a correct entry returns.
 *
 * Exits the process (code 0) on cancel — callers do not need to handle it.
 *
 * Scripted use: `-confirm <value>` supplies the typed string on the command
 * line. A matching value satisfies the gate without a prompt; a wrong one
 * exits 1 (it never falls through to the prompt — a typo in a script must not
 * turn into a hang). Off a TTY with no `-confirm`, exit 1 up front instead of
 * opening a prompt clack can never read (vibecarbon-web prod move,
 * 2026-09-15: `destroy prod -y` / `restore prod -y` both sat on the prompt
 * under a runner with no stdin until the process was reaped).
 *
 * @param {string} envName
 * @param {object} [opts]
 * @param {string} [opts.confirmValue=envName] - the exact string to type
 * @param {string} [opts.actionLabel='this operation'] - verb shown in the prompt (e.g. 'restore')
 * @param {boolean} [opts.yes=false] - whether -y was passed (only affects the warning copy)
 * @param {string} [opts.confirm] - value passed via `-confirm`, if any
 * @param {boolean} [opts.isTTY=process.stdin.isTTY] - injectable for tests
 * @returns {Promise<void>}
 */
export async function confirmProdOrExit(envName, opts = {}) {
  const {
    confirmValue = envName,
    actionLabel = 'this operation',
    yes = false,
    confirm,
    isTTY = process.stdin.isTTY === true,
  } = opts;
  if (!requiresProdTypeToConfirm(envName)) return;

  if (confirm !== undefined && confirm !== null) {
    if (confirm === confirmValue) return;
    p.log.error(
      `-confirm ${JSON.stringify(confirm)} does not match the production environment. ` +
        `Pass \`-confirm ${confirmValue}\` to ${actionLabel} it.`,
    );
    process.exit(1);
  }

  if (!isTTY) {
    p.log.error(
      `A ${actionLabel} against a production environment requires type-to-confirm, and there is no ` +
        `interactive terminal to type it in. Re-run from a terminal, or pass \`-confirm ${confirmValue}\` ` +
        'to confirm on the command line.',
    );
    process.exit(1);
  }

  if (yes) {
    p.log.warn(
      `A ${actionLabel} against a production environment still requires type-to-confirm, even with -y.`,
    );
  }

  const doubleConfirm = await p.text({
    message: `Type "${confirmValue}" to confirm ${actionLabel} of the production environment:`,
    validate: (v) => (v !== confirmValue ? `Please type "${confirmValue}" to confirm` : undefined),
  });
  if (p.isCancel(doubleConfirm)) {
    exitCancelled();
  }
}
