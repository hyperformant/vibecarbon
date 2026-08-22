#!/usr/bin/env node

/**
 * Root dev entrypoint for working ON vibecarbon itself — `pnpm dev`.
 *
 * The template lives in carbon/ and is what `vibecarbon create` copies into a
 * generated project root. Generated projects get their .env/.env.local at
 * create time, so they never hit a missing-env wall. The carbon/ source tree
 * has no create step and its .env/.env.local are gitignored, so testing the
 * template in place otherwise means remembering `pnpm dev:init` first.
 *
 * This removes that step: it ensures carbon/ has a dev env, then runs the
 * working-tree CLI's `up` inside carbon/ — equivalent to
 * `cd carbon && vibecarbon up`, but self-bootstrapping and always exercising
 * THIS checkout's src/cli.js rather than whatever is globally linked.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/.. -> repo root
const carbon = join(root, 'carbon');

/** Run a command with inherited stdio (keeps clack prompts + docker output live). */
function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (res.error) {
    console.error(res.error.message);
    process.exit(1);
  }
  return res.status ?? 0;
}

// 1. Ensure carbon/ has a dev env. dev:init is idempotent (it SKIPs existing
//    files), so invoke it whenever EITHER env file is missing — it fills the
//    gap without clobbering the one that's there. docker-compose needs `.env`
//    specifically (PROJECT_NAME/POSTGRES_PASSWORD/... substitution), so a
//    lingering `.env.local` alone is NOT enough: requiring both is what keeps
//    `pnpm dev` from starting the stack against a missing `.env`. Once both
//    exist, this stays quiet and never regenerates the admin SQL again.
const hasEnv = existsSync(join(carbon, '.env')) && existsSync(join(carbon, '.env.local'));
if (!hasEnv) {
  console.log('• No dev env in carbon/ — running dev:init to generate it…\n');
  const code = run('node', ['scripts/dev-init.js'], carbon);
  if (code !== 0) {
    console.error('\n✖ dev:init failed — not starting the dev stack.');
    process.exit(code);
  }
  console.log('');
}

// 2. Run the working-tree CLI's `up` inside carbon/ (same as `vibecarbon up`
//    from that directory, but pinned to this checkout's src/cli.js).
process.exit(run('node', [join(root, 'src', 'cli.js'), 'up'], carbon));
