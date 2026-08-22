#!/usr/bin/env node

/**
 * Root dev-stop entrypoint — `pnpm dev:stop`, the opposite of `pnpm dev`.
 *
 * `pnpm dev` (scripts/dev.js) runs the working-tree CLI's `up` inside
 * carbon/; this runs the same CLI's `down` there, stopping the Docker
 * services the dev stack started. No env bootstrap is needed to stop
 * containers, so unlike dev.js there is no dev:init step.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/.. -> repo root
const carbon = join(root, 'carbon');

const res = spawnSync('node', [join(root, 'src', 'cli.js'), 'down'], {
  cwd: carbon,
  stdio: 'inherit',
});
if (res.error) {
  console.error(res.error.message);
  process.exit(1);
}
process.exit(res.status ?? 0);
