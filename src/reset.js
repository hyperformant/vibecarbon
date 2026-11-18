/**
 * vibecarbon reset
 *
 * Wrapper around `<pm> dev:reset` that auto-detects the project's package manager.
 * Removes containers, volumes, and locally-built images. Run `vibecarbon up` afterward to restart.
 */

import * as p from '@clack/prompts';
import { requireDevScript, runDevScript } from './lib/cli/dev-script.js';
import { exitCancelled, exitDeclined } from './lib/cli/exit-guard.js';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { requireTTYOrFlags } from './lib/cli/tty-guard.js';
import { assertInProjectDir } from './lib/project-guard.js';

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string }} */
export const SPEC = {
  name: 'reset',
  summary: 'Reset the local environment (removes all data)',
  description: [
    "Detects the project's package manager and runs the dev:reset script,",
    'which removes containers, Docker volumes, and locally-built images.',
    'Run `vibecarbon up` afterward to restart.',
    '',
    'WARNING: All local database data will be lost.',
  ].join('\n'),
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
    { name: 'y', boolean: true, description: 'Skip confirmation prompt' },
  ],
};

export async function run(args = []) {
  const { values, handled } = parseFlagsOrExit(args, SPEC);
  if (handled) return;

  const yes = !!values.y;

  // Project guard runs first so an accidental `vibecarbon reset` from a
  // parent directory emits the canonical "not in a Vibecarbon project"
  // message instead of a confusing package.json error.
  assertInProjectDir();

  introCommand('reset');

  const cwd = process.cwd();
  requireDevScript(cwd, 'dev:reset');

  // Off a TTY without -y there is nobody to confirm: exit 1 with the
  // canonical message instead of the prompt library crashing (exit 70).
  requireTTYOrFlags({
    requirements: [
      { flag: 'y', description: 'confirm deleting all local database data', satisfied: yes },
    ],
  });

  if (!yes) {
    const confirmed = await p.confirm({
      message: 'All local database data will be lost. Continue?',
      initialValue: false,
    });
    // Ctrl-C/ESC and an explicit "no" are different answers: one is an
    // interrupt, the other a considered refusal. Both stop the run.
    if (p.isCancel(confirmed)) {
      exitCancelled();
    }
    if (!confirmed) {
      exitDeclined();
    }
  }

  // dev:reset runs `docker compose down -v`.
  await runDevScript(cwd, 'dev:reset', {
    title: (pm) => `Resetting dev environment with ${pm}`,
    successMessage: 'Dev environment reset',
  });
}
