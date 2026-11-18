/**
 * scripts/local-image.mjs replaced four scripts (db-image-build-local,
 * db-image-remove-local, node-runtime-build-local, node-runtime-remove-local)
 * that differed in an image ref, a docker context and a few words. These pin
 * what each of the four pnpm scripts runs and prints: the docker arguments
 * and every line, written out here as the old scripts had them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain JS ops script, no types
import { LOCAL_IMAGES, localImagePlan } from '../../../scripts/local-image.mjs';
import { dbImageRef, NODE_RUNTIME_IMAGE } from '../../../src/lib/images.js';

const ROOT = join(__dirname, '..', '..', '..');

describe('local image scripts', () => {
  it('db image: builds docker/postgres-walg under the CLI ref and prints the shadow notice', () => {
    const ref = dbImageRef();
    const plan = localImagePlan('db');
    expect(plan.build.argv).toEqual(['build', '-t', ref, join(ROOT, 'docker', 'postgres-walg')]);
    expect(plan.build.start).toBe(
      `Building ${ref} from docker/postgres-walg (local only, not pushed)`,
    );
    expect(plan.build.done).toBe(
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
  });

  it('db image: remove inspects first, then removes the tag', () => {
    const ref = dbImageRef();
    const plan = localImagePlan('db');
    expect(plan.remove.inspectArgv).toEqual(['image', 'inspect', ref]);
    expect(plan.remove.argv).toEqual(['image', 'rm', ref]);
    expect(plan.remove.absent).toBe(
      `No local ${ref} to remove. The next start pulls the published image.`,
    );
    expect(plan.remove.done).toBe(
      `Removed local ${ref}. The next start pulls the published image.`,
    );
  });

  it('node runtime: builds docker/node-runtime under the tag alone (no digest)', () => {
    const ref = NODE_RUNTIME_IMAGE.split('@')[0];
    expect(ref).not.toContain('@');
    const plan = localImagePlan('node-runtime');
    expect(plan.build.argv).toEqual(['build', '-t', ref, join(ROOT, 'docker', 'node-runtime')]);
    expect(plan.build.start).toBe(
      `Building ${ref} from docker/node-runtime (local only, not pushed)`,
    );
    expect(plan.build.done).toBe(
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
  });

  it('node runtime: remove inspects first, then removes the tag', () => {
    const ref = NODE_RUNTIME_IMAGE.split('@')[0];
    const plan = localImagePlan('node-runtime');
    expect(plan.remove.inspectArgv).toEqual(['image', 'inspect', ref]);
    expect(plan.remove.argv).toEqual(['image', 'rm', ref]);
    expect(plan.remove.absent).toBe(
      `No local ${ref} to remove. The next app build pulls the published image.`,
    );
    expect(plan.remove.done).toBe(
      `Removed local ${ref}. The next app build pulls the published image.`,
    );
  });

  it('an unknown image has no plan', () => {
    expect(localImagePlan('redis')).toBeNull();
    expect(Object.keys(LOCAL_IMAGES)).toEqual(['db', 'node-runtime']);
  });

  it('the four pnpm script names still exist and run the one script', () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).scripts;
    expect(scripts['db-image:build-local']).toBe('node scripts/local-image.mjs db build');
    expect(scripts['db-image:remove-local']).toBe('node scripts/local-image.mjs db remove');
    expect(scripts['node-runtime:build-local']).toBe(
      'node scripts/local-image.mjs node-runtime build',
    );
    expect(scripts['node-runtime:remove-local']).toBe(
      'node scripts/local-image.mjs node-runtime remove',
    );
  });
});
