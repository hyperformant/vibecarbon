/**
 * vibecarbon reset
 *
 * Wrapper around `<pm> dev:reset` that auto-detects the project's package manager.
 * Removes containers, volumes, and locally-built images. Run `vibecarbon up` afterward to restart.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { exitCancelled, exitDeclined } from './lib/cli/exit-guard.js';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { runCommandThroughTaskLog } from './lib/command.js';
import { detectPackageManager } from './lib/project.js';
import { assertInProjectDir } from './lib/project-guard.js';

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string }} */
const SPEC = {
  name: 'reset',
  summary: 'Reset the local development environment',
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
  const pkgPath = join(cwd, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  if (!pkg.scripts?.['dev:reset']) {
    p.log.error('No "dev:reset" script found in package.json.');
    process.exit(1);
  }

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

  const pm = detectPackageManager(cwd);
  const spawnArgs = pm === 'npm' ? ['run', 'dev:reset'] : ['dev:reset'];
  try {
    await runCommandThroughTaskLog([pm, ...spawnArgs], {
      cwd,
      title: `Resetting dev environment with ${pm}`,
      successMessage: 'Dev environment reset',
      // See PM_RUN_CONTEXT_RE in lib/command.js.
      cleanEnv: true,
    });
  } catch (err) {
    process.exit(err?.status ?? 1);
  }
}
