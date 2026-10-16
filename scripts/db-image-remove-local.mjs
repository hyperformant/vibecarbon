#!/usr/bin/env node
/**
 * `pnpm db-image:remove-local` — remove the local db image that
 * `pnpm db-image:build-local` tagged as the CLI's DB_IMAGE:DB_IMAGE_TAG
 * (src/lib/images.js), so the next start pulls the published image again.
 *
 * Removes the tag from the local Docker image store only; never touches the
 * registry. A container still using the image keeps it in use, and Docker
 * refuses: stop the stack first (`vibecarbon down`). Nothing to remove is not
 * an error.
 */
import { spawnSync } from 'node:child_process';
import { dbImageRef } from '../src/lib/images.js';

const ref = dbImageRef();
const present = spawnSync('docker', ['image', 'inspect', ref], { stdio: 'ignore' });
if (present.error) {
  console.error(present.error.message);
  process.exit(1);
}
if (present.status !== 0) {
  console.log(`No local ${ref} to remove. The next start pulls the published image.`);
  process.exit(0);
}
const res = spawnSync('docker', ['image', 'rm', ref], { stdio: 'inherit' });
if (res.error) {
  console.error(res.error.message);
  process.exit(1);
}
if (res.status === 0) {
  console.log(`Removed local ${ref}. The next start pulls the published image.`);
}
process.exit(res.status ?? 1);
