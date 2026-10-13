import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { oauthCallbackUrl } from '../../../src/configure.js';
import { parseDotenv } from '../../../src/lib/dotenv.js';
import { ensureBetterAuthSecret } from '../../../src/upgrade.js';

/**
 * BETTER_AUTH_SECRET signs the app's sessions (auth runs inside the app).
 * The app refuses to start in production without it (docker-compose.prod.yml
 * `:?`, env.ts min 32), so `create` writes one and `upgrade` gives one to a
 * project created before auth moved into the app.
 */
describe('BETTER_AUTH_SECRET reaches every project', () => {
  const project = (line: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-bas-'));
    const body = `PROJECT_NAME=demo\n${line ? `${line}\n` : ''}`;
    writeFileSync(join(dir, '.env.local'), body);
    writeFileSync(join(dir, '.env'), body);
    return dir;
  };
  const secretIn = (dir: string, file: string) =>
    parseDotenv(readFileSync(join(dir, file), 'utf-8')).BETTER_AUTH_SECRET ?? '';

  it('upgrade writes one to BOTH .env.local and .env when it is missing', () => {
    const dir = project(null);
    expect(ensureBetterAuthSecret(dir)).toBe(true);
    const local = secretIn(dir, '.env.local');
    expect(local.length).toBe(64);
    // .env is the file a deploy ships; the prod overlay requires it there.
    expect(secretIn(dir, '.env')).toBe(local);
  });

  it('replaces one too short for the app (min 32)', () => {
    const dir = project('BETTER_AUTH_SECRET=short');
    expect(ensureBetterAuthSecret(dir)).toBe(true);
    expect(secretIn(dir, '.env.local').length).toBe(64);
  });

  it('never rotates a valid one (that would sign everyone out)', () => {
    const existing = 'k'.repeat(40);
    const dir = project(`BETTER_AUTH_SECRET=${existing}`);
    expect(ensureBetterAuthSecret(dir)).toBe(false);
    expect(secretIn(dir, '.env.local')).toBe(existing);
    expect(secretIn(dir, '.env')).toBe(existing);
  });

  it('writes nothing under -dry', () => {
    const dir = project(null);
    expect(ensureBetterAuthSecret(dir, { dryRun: true })).toBe(true);
    expect(secretIn(dir, '.env.local')).toBe('');
  });
});

describe('configure shows the OAuth redirect URI the app serves', () => {
  it('uses the deployed domain when there is one', () => {
    expect(
      oauthCallbackUrl(
        { SITE_URL: 'http://localhost:5173' },
        { domain: 'app.example.com' },
        'google',
      ),
    ).toBe('https://app.example.com/api/auth/callback/google');
  });

  it('falls back to SITE_URL before a deploy, and to a placeholder without one', () => {
    expect(oauthCallbackUrl({ SITE_URL: 'http://localhost:5173/' }, {}, 'microsoft')).toBe(
      'http://localhost:5173/api/auth/callback/microsoft',
    );
    expect(oauthCallbackUrl({}, undefined, 'google')).toBe('<SITE_URL>/api/auth/callback/google');
  });
});
