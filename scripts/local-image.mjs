#!/usr/bin/env node
/**
 * Build or remove a local copy of one of the two images the CLI pins
 * (src/lib/images.js), under the exact ref the published image carries.
 *
 *   pnpm db-image:build-local        node scripts/local-image.mjs db build
 *   pnpm db-image:remove-local       node scripts/local-image.mjs db remove
 *   pnpm node-runtime:build-local    node scripts/local-image.mjs node-runtime build
 *   pnpm node-runtime:remove-local   node scripts/local-image.mjs node-runtime remove
 *
 * WHY BUILD LOCALLY
 * Every compose file pulls the db image, never builds it, and the app image
 * builds FROM the node runtime ref (carbon/Dockerfile, `ARG RUNTIME_IMAGE`).
 * Before a new tag is published (publish-db-image.yml and
 * publish-node-runtime-image.yml run on merge to main), nothing can pull it,
 * so a branch that moves a tag cannot start a project's stack or build its
 * app image. `build` puts the image in the local Docker image store under
 * that ref; compose's default `pull_policy: missing` and `docker build` then
 * use it without contacting the registry.
 *
 * Local only: never pushes. For the native platform only, which is what the
 * local daemon runs.
 *
 * THE LOCAL IMAGE SHADOWS THE REGISTRY IMAGE
 * It carries the exact ref the published image will have, so once that tag
 * is published this machine keeps running the local build instead of pulling
 * it, until the local image is removed. `build` says so after every
 * successful build.
 *
 * `remove` takes the tag out of the local Docker image store only; it never
 * touches the registry. Nothing to remove is not an error. A container still
 * using the db image keeps it in use, and Docker refuses: stop the stack
 * first (`vibecarbon down`).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbImageRef, NODE_RUNTIME_IMAGE } from '../src/lib/images.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The two images. Everything that differs between them is in this table:
 * the ref, the build context under docker/, the pnpm script prefix, who
 * uses the image (for the shadow notice) and what pulls it again.
 */
export const LOCAL_IMAGES = {
  db: {
    ref: () => dbImageRef(),
    context: 'postgres-walg',
    script: 'db-image',
    shadows: ["this machine's db containers", 'run this local build'],
    pullsAgain: 'The next start pulls the published image.',
  },
  'node-runtime': {
    // The tag alone: `docker build -t` cannot carry a digest, and a
    // digest-pinned ref already names a published image this machine can pull.
    ref: () => NODE_RUNTIME_IMAGE.split('@')[0],
    context: 'node-runtime',
    script: 'node-runtime',
    shadows: ['app images built on this machine', 'use this local build'],
    pullsAgain: 'The next app build pulls the published image.',
  },
};

/** The docker argv and every line each action prints, for one image. */
export function localImagePlan(name) {
  const image = LOCAL_IMAGES[name];
  if (!image) return null;
  const ref = image.ref();
  return {
    ref,
    build: {
      argv: ['build', '-t', ref, join(root, 'docker', image.context)],
      start: `Building ${ref} from docker/${image.context} (local only, not pushed)`,
      done: [
        '',
        `Built ${ref} locally.`,
        `It shadows the registry image with the same tag: ${image.shadows[0]}`,
        `${image.shadows[1]}, and never pull the published ${ref},`,
        'until you remove it:',
        '',
        `  pnpm ${image.script}:remove-local`,
      ].join('\n'),
    },
    remove: {
      inspectArgv: ['image', 'inspect', ref],
      argv: ['image', 'rm', ref],
      absent: `No local ${ref} to remove. ${image.pullsAgain}`,
      done: `Removed local ${ref}. ${image.pullsAgain}`,
    },
  };
}

function run(argv, stdio) {
  const res = spawnSync('docker', argv, { stdio });
  if (res.error) {
    console.error(res.error.message);
    process.exit(1);
  }
  return res;
}

function main([name, action]) {
  const plan = localImagePlan(name);
  if (!plan || (action !== 'build' && action !== 'remove')) {
    console.error(
      `usage: node scripts/local-image.mjs <${Object.keys(LOCAL_IMAGES).join('|')}> <build|remove>`,
    );
    process.exit(2);
  }
  if (action === 'build') {
    console.log(plan.build.start);
    const res = run(plan.build.argv, 'inherit');
    if (res.status === 0) console.log(plan.build.done);
    process.exit(res.status ?? 1);
  }
  const present = run(plan.remove.inspectArgv, 'ignore');
  if (present.status !== 0) {
    console.log(plan.remove.absent);
    process.exit(0);
  }
  const res = run(plan.remove.argv, 'inherit');
  if (res.status === 0) console.log(plan.remove.done);
  process.exit(res.status ?? 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
