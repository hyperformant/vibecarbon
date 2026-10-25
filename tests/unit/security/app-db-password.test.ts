import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateEnvLocal } from '../../../src/create.js';
import { parseDotenv } from '../../../src/lib/dotenv.js';
import { ensureAppDbPassword } from '../../../src/upgrade.js';

/**
 * APP_DB_PASSWORD is the password of the app's own database role,
 * app_service (security plan 2026-10-20, R8). `create` generates it next to
 * the owner password, and `upgrade` gives one to a project created before the
 * app had its own role: compose refuses to start without it (`:?`). Values
 * here are SENTINEL_* stand-ins.
 */
describe('APP_DB_PASSWORD reaches every project', () => {
  const project = (line: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-appdb-'));
    const body = `PROJECT_NAME=demo\n${line ? `${line}\n` : ''}`;
    writeFileSync(join(dir, '.env.local'), body);
    writeFileSync(join(dir, '.env'), body);
    return dir;
  };
  const valueIn = (dir: string, file: string) =>
    parseDotenv(readFileSync(join(dir, file), 'utf-8')).APP_DB_PASSWORD ?? '';

  it('create writes it next to the owner password, and never the same value', () => {
    const env = parseDotenv(
      generateEnvLocal('demo', {
        PROJECT_DISPLAY_NAME: 'Demo',
        BETTER_AUTH_SECRET: 'SENTINEL_BETTER_AUTH_SECRET_AT_LEAST_32_CHARS',
        DB_PASSWORD: 'SENTINEL_OWNER',
        APP_DB_PASSWORD: 'SENTINEL_APP',
        REPL_PASSWORD: 'SENTINEL_REPL',
        ADMIN_EMAIL: 'admin@example.com',
        ADMIN_PASSWORD: 'SENTINEL_ADMIN',
      }),
    );
    expect(env.APP_DB_PASSWORD).toBe('SENTINEL_APP');
    expect(env.POSTGRES_PASSWORD).toBe('SENTINEL_OWNER');
  });

  it('upgrade generates one into BOTH .env.local and .env when it is missing', () => {
    const dir = project(null);
    expect(ensureAppDbPassword(dir)).toBe('generated');
    const local = valueIn(dir, '.env.local');
    expect(local.length).toBeGreaterThanOrEqual(24);
    expect(valueIn(dir, '.env')).toBe(local);
  });

  it('never rotates an existing one', () => {
    const dir = project('APP_DB_PASSWORD=SENTINEL_KEEP');
    expect(ensureAppDbPassword(dir)).toBeNull();
    expect(valueIn(dir, '.env.local')).toBe('SENTINEL_KEEP');
    expect(valueIn(dir, '.env')).toBe('SENTINEL_KEEP');
  });

  it('copies one present in only one file to the other', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-appdb-'));
    writeFileSync(join(dir, '.env.local'), 'APP_DB_PASSWORD=SENTINEL_LOCAL\n');
    writeFileSync(join(dir, '.env'), 'PROJECT_NAME=demo\n');
    expect(ensureAppDbPassword(dir)).toBe('copied');
    expect(valueIn(dir, '.env')).toBe('SENTINEL_LOCAL');
  });

  it('writes nothing under -dry', () => {
    const dir = project(null);
    expect(ensureAppDbPassword(dir, { dryRun: true })).toBe('generated');
    expect(valueIn(dir, '.env.local')).toBe('');
  });
});
