import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateEnvLocal } from '../../../src/create.js';
import { renderBundle } from '../../../src/lib/deploy/bundle.js';
import { resolveDbImageTag } from '../../../src/lib/deploy/k8s/k3s.js';
import { parseDotenv } from '../../../src/lib/dotenv.js';
import { DB_IMAGE, DB_IMAGE_TAG, DEV_DB_IMAGE } from '../../../src/lib/images.js';
import { ensureDbImageEnv } from '../../../src/upgrade.js';

/**
 * carbon/docker-compose.yml's db service is `image: ${DB_IMAGE}:${DB_IMAGE_TAG}`
 * (both `:?`-required), so every writer of a project's .env must put the CLI's
 * own pair there: create for a new project, upgrade for an existing one, and
 * the deploy bundle for the server (where it must win over anything replayed).
 */
const dirs: string[] = [];
const scratch = (body: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'vc-db-image-env-'));
  dirs.push(dir);
  writeFileSync(join(dir, '.env.local'), body);
  writeFileSync(join(dir, '.env'), body);
  return dir;
};
const envOf = (dir: string, file: string) => parseDotenv(readFileSync(join(dir, file), 'utf-8'));

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('DB_IMAGE / DB_IMAGE_TAG reach every project .env', () => {
  it('create writes the CLI pair', () => {
    const env = parseDotenv(
      generateEnvLocal('db-app', {
        PROJECT_DISPLAY_NAME: 'Db App',
        DB_PASSWORD: 'pw',
        JWT_SECRET: 'j'.repeat(64),
        BETTER_AUTH_SECRET: 'b'.repeat(64),
        REPL_PASSWORD: 'r',
        ADMIN_EMAIL: 'a@example.com',
        ADMIN_PASSWORD: 'x',
      }),
    );
    expect(env.DB_IMAGE).toBe(DB_IMAGE);
    expect(env.DB_IMAGE_TAG).toBe(DB_IMAGE_TAG);
  });

  it('upgrade adds the pair to a project that predates it, in both files', () => {
    const dir = scratch('PROJECT_NAME=demo\n');
    expect(ensureDbImageEnv(dir)).toBe(true);
    for (const file of ['.env.local', '.env']) {
      expect(envOf(dir, file).DB_IMAGE).toBe(DB_IMAGE);
      expect(envOf(dir, file).DB_IMAGE_TAG).toBe(DB_IMAGE_TAG);
    }
  });

  it('upgrade moves an older tag to the CLI tag', () => {
    const dir = scratch(`PROJECT_NAME=demo\nDB_IMAGE=${DB_IMAGE}\nDB_IMAGE_TAG=16.0-walg0.0.1\n`);
    expect(ensureDbImageEnv(dir)).toBe(true);
    expect(envOf(dir, '.env').DB_IMAGE_TAG).toBe(DB_IMAGE_TAG);
  });

  it('upgrade reports nothing when the pair is current, and -dry writes nothing', () => {
    const current = scratch(
      `PROJECT_NAME=demo\nDB_IMAGE=${DB_IMAGE}\nDB_IMAGE_TAG=${DB_IMAGE_TAG}\n`,
    );
    expect(ensureDbImageEnv(current)).toBe(false);
    const missing = scratch('PROJECT_NAME=demo\n');
    expect(ensureDbImageEnv(missing, { dryRun: true })).toBe(true);
    expect(envOf(missing, '.env').DB_IMAGE).toBeUndefined();
  });

  it('the deploy bundle always ships the CLI pair, over the local .env and replayed overrides', () => {
    const dir = scratch(`PROJECT_NAME=demo\nDB_IMAGE=example/old\nDB_IMAGE_TAG=old\n`);
    const cwd = process.cwd();
    process.chdir(dir);
    let stage = '';
    try {
      stage = renderBundle('demo', { envOverrides: { DB_IMAGE_TAG: 'replayed' } });
    } finally {
      process.chdir(cwd);
    }
    dirs.push(stage);
    const env = envOf(stage, '.env');
    expect(env.DB_IMAGE).toBe(DB_IMAGE);
    expect(env.DB_IMAGE_TAG).toBe(DB_IMAGE_TAG);
  });
});

describe('VIBECARBON_DB_IMAGE reaches every writer through the one resolver', () => {
  const DEV_TAG = `${DB_IMAGE_TAG}-0123456789ab`;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.VIBECARBON_DB_IMAGE;
    process.env.VIBECARBON_DB_IMAGE = `${DEV_DB_IMAGE}:${DEV_TAG}`;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.VIBECARBON_DB_IMAGE;
    else process.env.VIBECARBON_DB_IMAGE = saved;
  });

  it('upgrade, the deploy bundle and k8s all take the override; unset goes back', () => {
    const dir = scratch(`PROJECT_NAME=demo
DB_IMAGE=${DB_IMAGE}
DB_IMAGE_TAG=${DB_IMAGE_TAG}
`);
    expect(ensureDbImageEnv(dir)).toBe(true);
    expect(envOf(dir, '.env')).toMatchObject({ DB_IMAGE: DEV_DB_IMAGE, DB_IMAGE_TAG: DEV_TAG });
    const cwd = process.cwd();
    process.chdir(dir);
    let stage = '';
    try {
      stage = renderBundle('demo', {});
    } finally {
      process.chdir(cwd);
    }
    dirs.push(stage);
    expect(envOf(stage, '.env')).toMatchObject({ DB_IMAGE: DEV_DB_IMAGE, DB_IMAGE_TAG: DEV_TAG });
    expect(resolveDbImageTag()).toBe(`${DEV_DB_IMAGE}:${DEV_TAG}`);

    delete process.env.VIBECARBON_DB_IMAGE;
    expect(ensureDbImageEnv(dir)).toBe(true);
    expect(envOf(dir, '.env')).toMatchObject({ DB_IMAGE, DB_IMAGE_TAG });
    expect(resolveDbImageTag()).toBe(`${DB_IMAGE}:${DB_IMAGE_TAG}`);
  });
});
