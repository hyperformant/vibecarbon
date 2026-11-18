/**
 * The template's local dev scripts (`dev:stop`, `dev:reset`) as `down` and
 * `reset` run them: through the project's package manager and the task log,
 * with the local compose env (the scripts run `docker compose`, which
 * interpolates the db image pair just as `up` does).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { runCommandThroughTaskLog } from '../command.js';
import { localComposeEnv } from '../images.js';
import { detectPackageManager } from '../project.js';

/**
 * Exit 1 unless the project's package.json defines `script`.
 * @param {string} cwd project root
 * @param {string} script
 */
export function requireDevScript(cwd, script) {
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
  if (!pkg.scripts?.[script]) {
    p.log.error(`No "${script}" script found in package.json.`);
    process.exit(1);
  }
}

/**
 * Run `script` with the project's package manager (`npm run <script>`, or
 * `<pm> <script>`), exiting with its status when it fails.
 * @param {string} cwd project root
 * @param {string} script
 * @param {{ title: (pm: string) => string, successMessage: string }} labels
 */
export async function runDevScript(cwd, script, { title, successMessage }) {
  const pm = detectPackageManager(cwd);
  const spawnArgs = pm === 'npm' ? ['run', script] : [script];
  try {
    await runCommandThroughTaskLog([pm, ...spawnArgs], {
      cwd,
      title: title(pm),
      successMessage,
      env: localComposeEnv(),
      // See PM_RUN_CONTEXT_RE in lib/command.js.
      cleanEnv: true,
    });
  } catch (err) {
    process.exit(err?.status ?? 1);
  }
}
