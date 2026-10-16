#!/usr/bin/env node
/**
 * `pnpm db-image:build-local` — build docker/postgres-walg on this machine and
 * tag it exactly as the CLI's DB_IMAGE:DB_IMAGE_TAG (src/lib/images.js).
 *
 * Every compose file pulls the db image, never builds it. Before a new tag is
 * published (publish-db-image.yml runs on merge to main), nothing can pull it,
 * so a branch that moves the tag cannot start a project's stack. This puts the
 * image in the local Docker image store under that ref, and compose's default
 * `pull_policy: missing` then uses it without contacting the registry.
 *
 * Local only: never pushes. For the native platform only, which is what the
 * local daemon runs.
 *
 * The local image SHADOWS the registry image: it carries the exact ref the
 * published image will have, so once that tag is published this machine keeps
 * running the local build instead of pulling it, until the local image is
 * removed. `pnpm db-image:remove-local` (scripts/db-image-remove-local.mjs)
 * removes it. The script says so after every successful build.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbImageRef } from '../src/lib/images.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ref = dbImageRef();
console.log(`Building ${ref} from docker/postgres-walg (local only, not pushed)`);
const res = spawnSync('docker', ['build', '-t', ref, join(root, 'docker', 'postgres-walg')], {
  stdio: 'inherit',
});
if (res.error) {
  console.error(res.error.message);
  process.exit(1);
}
if (res.status === 0) {
  console.log(
    [
      '',
      `Built ${ref} locally.`,
      `It shadows the registry image with the same tag: this machine's db containers`,
      `run this local build, and never pull the published ${ref},`,
      'until you remove it:',
      '',
      '  pnpm db-image:remove-local',
    ].join('\n'),
  );
}
process.exit(res.status ?? 1);
