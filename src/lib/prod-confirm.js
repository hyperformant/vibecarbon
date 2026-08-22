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
 * @param {string} envName
 * @param {object} [opts]
 * @param {string} [opts.confirmValue=envName] - the exact string to type
 * @param {string} [opts.actionLabel='this operation'] - verb shown in the prompt (e.g. 'restore')
 * @param {boolean} [opts.yes=false] - whether -y was passed (only affects the warning copy)
 * @returns {Promise<void>}
 */
export async function confirmProdOrExit(envName, opts = {}) {
  const { confirmValue = envName, actionLabel = 'this operation', yes = false } = opts;
  if (!requiresProdTypeToConfirm(envName)) return;

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
