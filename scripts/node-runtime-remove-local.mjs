#!/usr/bin/env node
/**
 * `pnpm node-runtime:remove-local` — remove the local node runtime base that
 * `pnpm node-runtime:build-local` tagged as the CLI's NODE_RUNTIME_IMAGE
 * (src/lib/images.js), so the next app build pulls the published image.
 *
 * Removes the tag from the local Docker image store only; never touches the
 * registry. Nothing to remove is not an error.
 */
import { spawnSync } from 'node:child_process';
import { NODE_RUNTIME_IMAGE } from '../src/lib/images.js';

const ref = NODE_RUNTIME_IMAGE;
const present = spawnSync('docker', ['image', 'inspect', ref], { stdio: 'ignore' });
if (present.error) {
  console.error(present.error.message);
  process.exit(1);
}
if (present.status !== 0) {
  console.log(`No local ${ref} to remove. The next app build pulls the published image.`);
  process.exit(0);
}
const res = spawnSync('docker', ['image', 'rm', ref], { stdio: 'inherit' });
if (res.error) {
  console.error(res.error.message);
  process.exit(1);
}
if (res.status === 0) {
  console.log(`Removed local ${ref}. The next app build pulls the published image.`);
}
process.exit(res.status ?? 1);
