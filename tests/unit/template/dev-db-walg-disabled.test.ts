import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * The base compose file points WAL-G at the app's S3 vars (WALG_S3_PREFIX_BASE
 * falls back to S3_BUCKET, AWS_ENDPOINT is S3_ENDPOINT). In dev those vars
 * name the local S3 on `localhost:8333`, which from inside the db container is
 * the container itself, so every WAL segment would fail to archive. (It used
 * to also crash the first boot; that root cause is fixed in the image, see
 * tests/unit/deploy/db-image-first-boot.test.ts.) The dev-only override
 * blanks all four so WAL-G stays off in development.
 */

const ROOT = join(__dirname, '..', '..', '..');
type Compose = {
  services?: Record<string, { environment?: Record<string, string> | string[] }>;
};
const load = (rel: string) => parseYaml(readFileSync(join(ROOT, rel), 'utf-8')) as Compose;

const BLANKED = [
  'WALG_S3_PREFIX_BASE',
  'AWS_ENDPOINT',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
];

describe('dev db has WAL-G disabled', () => {
  const base = load('carbon/docker-compose.yml').services?.db?.environment;
  const override = load('carbon/docker-compose.override.yml').services?.db?.environment;

  it.each(BLANKED)('base compose wires %s for the db (so the override is load-bearing)', (name) => {
    expect(base).toBeTypeOf('object');
    expect(Object.keys(base as Record<string, string>)).toContain(name);
  });

  it.each(BLANKED)('carbon/docker-compose.override.yml blanks %s for the db', (name) => {
    expect(override, 'db.environment must be a map in the override').toBeTypeOf('object');
    expect(Array.isArray(override)).toBe(false);
    expect((override as Record<string, string>)[name]).toBe('');
  });
});
