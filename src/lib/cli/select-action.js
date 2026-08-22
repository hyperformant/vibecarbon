/**
 * Action-picker prompt for commands that branch on a verb.
 *
 * Some commands have multiple modes — `backup` can create, list, or
 * download; `restore` can restore from S3 or from a local file. Under
 * the new interactive-default model, these don't surface as flags;
 * the bare command opens an action menu after the env is selected.
 *
 * The seed parameter (from `-action <verb>`) lets power users skip
 * the prompt for repeatable invocations. Validation against the
 * options list catches typos loudly instead of silently dropping
 * into the prompt.
 */

import * as p from '@clack/prompts';
import { exitCancelled } from './exit-guard.js';

/**
 * @typedef {object} ActionOption
 * @property {string} value - canonical identifier; what the seed
 *   matches against and what this helper returns.
 * @property {string} label - what the operator sees in the picker.
 * @property {string} [hint] - secondary text in the picker.
 *
 * @param {object} options
 * @param {string} options.message - prompt text (e.g. "What do you
 *   want to do?").
 * @param {ActionOption[]} options.choices
 * @param {string|null} [options.seed] - operator-supplied verb (from
 *   the `-action` flag). When set, validated against choices and
 *   returned directly. When null/undefined, prompt.
 * @returns {Promise<string>} the chosen `value`.
 */
export async function selectAction(options) {
  const { message, choices, seed } = options;

  if (choices.length === 0) {
    throw new Error('selectAction called with no choices, programming error');
  }

  if (seed) {
    const known = choices.find((c) => c.value === seed);
    if (!known) {
      const valid = choices.map((c) => c.value).join(', ');
      p.log.error(`Action '${seed}' is not valid. Choose one of: ${valid}.`);
      process.exit(1);
    }
    return known.value;
  }

  if (choices.length === 1) {
    return choices[0].value;
  }

  const choice = await p.select({
    message,
    options: choices,
  });

  if (p.isCancel(choice)) {
    exitCancelled();
  }

  return /** @type {string} */ (choice);
}
