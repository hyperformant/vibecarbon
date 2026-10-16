/**
 * Compose half of the local db image contract (up, down, reset) (unit half:
 * tests/unit/cli/up-db-image-env.test.ts). The db service's real `image:` line
 * from carbon/docker-compose.yml is resolved by `docker compose config` (no
 * pull) with the environment localComposeEnv() builds, against a .env that
 * either lacks the pair or holds a stale dev-channel ref. The environment
 * must win both times: that precedence is what makes the CLI, not the .env,
 * decide which db image runs locally.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DB_IMAGE, DB_IMAGE_TAG, DEV_DB_IMAGE, localComposeEnv } from '../../../src/lib/images.js';

// Skipped by default like the other docker tests; run explicitly via
// `DOCKER_INTEGRATION=true pnpm test:docker` (the script sets the variable).
const describeDocker = process.env.DOCKER_INTEGRATION === 'true' ? describe : describe.skip;

const IMAGE_LINE = readFileSync(join(process.cwd(), 'carbon', 'docker-compose.yml'), 'utf-8')
  .split('\n')
  .find((line) => /^\s+image: \$\{DB_IMAGE:\?/.test(line));

describeDocker('docker compose runs the db image up resolves, not the .env one', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const resolvedImage = (dotenv: string, base: Record<string, string | undefined>) => {
    const dir = mkdtempSync(join(tmpdir(), 'db-image-compose-'));
    dirs.push(dir);
    writeFileSync(join(dir, '.env'), dotenv);
    writeFileSync(join(dir, 'compose.yml'), `services:\n  db:\n${IMAGE_LINE}\n`);
    const out = execFileSync(
      'docker',
      ['compose', '-f', 'compose.yml', 'config', '--format', 'json'],
      {
        cwd: dir,
        encoding: 'utf-8',
        env: localComposeEnv({
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ...base,
        }) as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'inherit'],
        timeout: 60_000,
      },
    );
    return JSON.parse(out).services.db.image as string;
  };

  it('found the real image line', () => {
    expect(IMAGE_LINE).toBeTruthy();
  });

  it('.env lacking the pair: the release image', () => {
    expect(resolvedImage('PROJECT_NAME=demo\n', {})).toBe(`${DB_IMAGE}:${DB_IMAGE_TAG}`);
  });

  it('.env holding a persisted dev ref, override unset: the release image', () => {
    const stale = `DB_IMAGE=${DEV_DB_IMAGE}\nDB_IMAGE_TAG=${DB_IMAGE_TAG}-0123456789ab\n`;
    expect(resolvedImage(stale, {})).toBe(`${DB_IMAGE}:${DB_IMAGE_TAG}`);
  });

  it('override set: the override, whatever .env says', () => {
    const dev = `${DEV_DB_IMAGE}:${DB_IMAGE_TAG}-0123456789ab`;
    expect(
      resolvedImage(`DB_IMAGE=${DB_IMAGE}\nDB_IMAGE_TAG=${DB_IMAGE_TAG}\n`, {
        VIBECARBON_DB_IMAGE: dev,
      }),
    ).toBe(dev);
  });
});
