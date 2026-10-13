/**
 * vibecarbon down
 *
 * Wrapper around `<pm> dev:stop` that auto-detects the project's package manager.
 * Stops Docker services (Supabase, Traefik, etc.) for the current project.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { requireTTYOrFlags } from './lib/cli/tty-guard.js';
import { runCommandThroughTaskLog } from './lib/command.js';
import { findOrphanStacks, formatStackPath, listVibecarbonStacks } from './lib/local-stacks.js';
import { detectPackageManager } from './lib/project.js';
import { assertInProjectDir } from './lib/project-guard.js';

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string }} */
export const SPEC = {
  name: 'down',
  summary: 'Stop the local development environment',
  description: [
    "Detects the project's package manager and runs the dev:stop script,",
    'which stops all Docker Compose services for this project.',
  ].join('\n'),
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
    {
      name: 'orphans',
      boolean: true,
      featured: true,
      description: 'Remove local stacks whose project folder is gone',
    },
    { name: 'y', boolean: true, description: 'Skip the confirmation' },
  ],
};

/**
 * Remove local stacks whose project folder is gone. Containers and the network
 * go after one confirmation; data volumes only after a separate interactive
 * yes (default no). `-y` and non-interactive runs always keep volumes.
 */
export async function removeOrphanStacks({
  list = listVibecarbonStacks,
  find = findOrphanStacks,
  run: exec = execFileSync,
  confirm = p.confirm,
  isTTY = Boolean(process.stdin.isTTY),
  yes = false,
  log = p.log,
  home,
  guard = requireTTYOrFlags,
} = {}) {
  const orphans = find(list());
  if (orphans.length === 0) {
    log.info('no orphaned local stacks found');
    return { removed: [], keptVolumes: [], failed: [] };
  }

  for (const s of orphans) {
    const reason =
      s.reason === 'files-missing'
        ? 'started from files that are no longer there'
        : 'folder is gone';
    log.info(`${s.project} (${formatStackPath(s.workingDir, home)}), ${reason}`);
  }

  // Off a TTY without -y there is nobody to confirm: exit 1 with the canonical message.
  guard({
    requirements: [
      { flag: 'y', description: 'confirm removing the listed stacks', satisfied: yes },
    ],
    stdin: { isTTY },
  });

  if (!yes) {
    const ok = await confirm({
      message: 'remove these stacks (containers and network, not data)?',
      initialValue: true,
    });
    if (ok !== true) {
      log.info('nothing removed');
      return { removed: [], keptVolumes: [], failed: [] };
    }
  }

  const removed = [];
  const keptVolumes = [];
  const failed = [];
  const errMsg = (e) => String(e?.stderr || e?.message || e).trim();
  for (const { project } of orphans) {
    try {
      // Works without the compose files. Never -v: volumes are handled below.
      exec('docker', ['compose', '-p', project, 'down', '--remove-orphans'], { stdio: 'ignore' });
    } catch (e) {
      log.warn(`couldn't remove ${project}: ${errMsg(e)}`);
      failed.push(project);
      continue;
    }
    removed.push(project);

    let names = [];
    try {
      names = String(
        exec(
          'docker',
          ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`],
          { encoding: 'utf8' },
        ),
      )
        .split('\n')
        .map((n) => n.trim())
        .filter(Boolean);
    } catch (e) {
      log.warn(`couldn't remove ${project}: ${errMsg(e)}`);
      failed.push(project);
      continue;
    }
    if (names.length === 0) continue;

    let deleteThem = false;
    if (!yes && isTTY) {
      log.info(
        `if you moved this project, keep them, then set COMPOSE_PROJECT_NAME=${project} in the new folder's .env before \`vibecarbon up\` there to reuse them`,
      );
      deleteThem =
        (await confirm({
          message: `delete ${project}'s data volumes too? this can't be undone`,
          initialValue: false,
        })) === true;
    }
    if (deleteThem) {
      try {
        exec('docker', ['volume', 'rm', ...names], { stdio: 'ignore' });
        log.info(`deleted ${names.join(', ')}`);
      } catch (e) {
        log.warn(`couldn't remove ${project}: ${errMsg(e)}`);
        failed.push(project);
        keptVolumes.push(...names);
      }
    } else {
      keptVolumes.push(...names);
      log.info(`kept ${names.join(', ')}; remove later with docker volume rm ${names.join(' ')}`);
    }
  }
  return { removed, keptVolumes, failed };
}

export async function run(args = []) {
  const { handled, values } = parseFlagsOrExit(args, SPEC);
  if (handled) return;

  if (values.orphans) {
    introCommand('down');
    const result = await removeOrphanStacks({ yes: Boolean(values.y) });
    if (result.failed.length > 0) process.exitCode = 1;
    return;
  }

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
