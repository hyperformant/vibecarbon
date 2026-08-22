/**
 * vibecarbon down
 *
 * Wrapper around `<pm> dev:stop` that auto-detects the project's package manager.
 * Stops Docker services (Supabase, Traefik, etc.) for the current project.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { runCommandThroughTaskLog } from './lib/command.js';
import { detectPackageManager } from './lib/project.js';
import { assertInProjectDir } from './lib/project-guard.js';

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string }} */
const SPEC = {
  name: 'down',
  summary: 'Stop the local development environment',
  description: [
    "Detects the project's package manager and runs the dev:stop script,",
    'which stops all Docker Compose services for this project.',
  ].join('\n'),
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
  ],
};

export async function run(args = []) {
  const { handled } = parseFlagsOrExit(args, SPEC);
  if (handled) return;

  // Project guard runs first so an accidental `vibecarbon down` from a
  // parent directory emits the canonical "not in a Vibecarbon project"
  // message instead of a confusing package.json error.
  assertInProjectDir();

  introCommand('down');

  const cwd = process.cwd();
  const pkgPath = join(cwd, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  if (!pkg.scripts?.['dev:stop']) {
    p.log.error('No "dev:stop" script found in package.json.');
    process.exit(1);
  }

  const pm = detectPackageManager(cwd);
  const spawnArgs = pm === 'npm' ? ['run', 'dev:stop'] : ['dev:stop'];
  try {
    await runCommandThroughTaskLog([pm, ...spawnArgs], {
      cwd,
      title: `Stopping dev environment with ${pm}`,
      successMessage: 'Dev environment stopped',
      // See PM_RUN_CONTEXT_RE in lib/command.js.
      cleanEnv: true,
    });
  } catch (err) {
    process.exit(err?.status ?? 1);
  }
}
