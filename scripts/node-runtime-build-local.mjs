#!/usr/bin/env node
/**
 * `pnpm node-runtime:build-local` — build docker/node-runtime on this machine
 * and tag it exactly as the CLI's NODE_RUNTIME_IMAGE (src/lib/images.js).
 *
 * The app image builds FROM that ref (carbon/Dockerfile, `ARG RUNTIME_IMAGE`).
 * Before a new tag is published (publish-node-runtime-image.yml runs on merge
 * to main), nothing can pull it, so a branch that moves the tag cannot build a
 * project's app image. This puts the image in the local Docker image store
 * under that ref, and `docker build` / `docker compose build` then use it
 * without contacting the registry. Same pattern as `pnpm db-image:build-local`.
 *
 * Local only: never pushes. For the native platform only, which is what the
 * local daemon runs.
 *
 * The local image SHADOWS the registry image under the same tag until removed
 * with `pnpm node-runtime:remove-local` (scripts/node-runtime-remove-local.mjs).
 * The script says so after every successful build.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_RUNTIME_IMAGE } from '../src/lib/images.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The tag alone: `docker build -t` cannot carry a digest, and a digest-pinned
// ref already names a published image this machine can pull.
const ref = NODE_RUNTIME_IMAGE.split('@')[0];
console.log(`Building ${ref} from docker/node-runtime (local only, not pushed)`);
const res = spawnSync('docker', ['build', '-t', ref, join(root, 'docker', 'node-runtime')], {
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
      'It shadows the registry image with the same tag: app images built on this machine',
      `use this local build, and never pull the published ${ref},`,
      'until you remove it:',
      '',
      '  pnpm node-runtime:remove-local',
    ].join('\n'),
  );
}
process.exit(res.status ?? 1);
