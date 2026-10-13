import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generateEnvLocal } from '../../../src/create.js';
import { parseDotenv } from '../../../src/lib/dotenv.js';

/**
 * The template server connects to Postgres with discrete DB_* vars
 * (carbon/src/server/lib/env.ts). Both env writers must hand `npm run dev` a
 * working local connection: the dev `db` container published on localhost,
 * logging in as `postgres` with POSTGRES_PASSWORD. DB_PORT is the base port;
 * env.ts shifts it by DEV_PORT_OFFSET (or takes DEV_DB_PORT) at runtime, the
 * same way it treats SUPABASE_URL, so a later `vibecarbon up` offset change
 * cannot leave it stale.
 */

const ROOT = join(__dirname, '..', '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'dev-db-env-'));

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function expectLocalDbConnection(env: Record<string, string>) {
  expect(env.DB_HOST).toBe('localhost');
  expect(env.DB_PORT).toBe('5432');
  expect(env.DB_USER).toBe('postgres');
  expect(env.DB_NAME).toBe('postgres');
  expect(env.DB_PASSWORD).toBeTruthy();
  expect(env.DB_PASSWORD).toBe(env.POSTGRES_PASSWORD);
}

describe('local DB_* connection vars', () => {
  it('dev-init.js writes them to .env and .env.local', () => {
    // dev-init writes into its cwd; run it in a scratch dir.
    const r = spawnSync(process.execPath, [join(ROOT, 'carbon/scripts/dev-init.js')], {
      cwd: tmp,
      encoding: 'utf-8',
    });
    expect(r.status, r.stderr).toBe(0);
    for (const file of ['.env', '.env.local']) {
      expectLocalDbConnection(parseDotenv(readFileSync(join(tmp, file), 'utf-8')));
    }
  });

  it('vibecarbon create writes them', () => {
    const env = parseDotenv(
      generateEnvLocal('db-app', {
        PROJECT_NAME: 'db-app',
        PROJECT_DISPLAY_NAME: 'Db App',
        SITE_URL: 'http://localhost:5173',
        ADMIN_EMAIL: 'admin@example.com',
        DB_PASSWORD: 'generated-db-password',
      }),
    );
    expectLocalDbConnection(env);
    expect(env.DB_PASSWORD).toBe('generated-db-password');
  });
});
