import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMPOSE_REQUIRED_ENV_FALLBACK, findMissingRequiredEnv } from '../../../src/lib/project.js';

// vibecarbon-web prod move, 2026-09-15: the deploy ran from a fresh worktree
// with no `.env` (gitignored). Step 0d WARNED that JWT_SECRET & co. were
// missing, then provisioned a server, pushed the image and repointed DNS
// before `docker compose up` failed on `${JWT_SECRET:?...}` — five minutes
// and a billed VM-hour into an outage. findMissingRequiredEnv is the
// preflight that turns that warning into a stop at second zero: it reads
// the same `${KEY:?}` markers compose itself enforces.
function makeProjectDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-env-required-test-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const COMPOSE = `
services:
  db:
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?POSTGRES_PASSWORD missing}
  auth:
    environment:
      GOTRUE_JWT_SECRET: \${JWT_SECRET:?JWT_SECRET missing — vibecarbon create writes it to .env.local}
      GOTRUE_SITE_URL: \${SITE_URL:-http://localhost}
  meta:
    environment:
      PG_META_CRYPTO_KEY: \${PG_META_CRYPTO_KEY:?PG_META_CRYPTO_KEY missing}
`;

describe('findMissingRequiredEnv', () => {
  const dirs: string[] = [];
  const make = (files: Record<string, string>) => {
    const dir = makeProjectDir(files);
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    while (dirs.length) {
      try {
        rmSync(dirs.pop() as string, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it('reports every compose-required key when .env is absent (the fresh-worktree case)', () => {
    const dir = make({
      'docker-compose.prod.yml': COMPOSE,
      '.env.local': 'JWT_SECRET=abc\nPOSTGRES_PASSWORD=pw\nPG_META_CRYPTO_KEY=k\n',
    });
    expect(findMissingRequiredEnv(dir)).toEqual([
      'JWT_SECRET',
      'PG_META_CRYPTO_KEY',
      'POSTGRES_PASSWORD',
    ]);
  });

  it('reports a required key that is present but empty in .env', () => {
    const dir = make({
      'docker-compose.prod.yml': COMPOSE,
      '.env': "JWT_SECRET=''\nPOSTGRES_PASSWORD=pw\nPG_META_CRYPTO_KEY=k\n",
    });
    expect(findMissingRequiredEnv(dir)).toEqual(['JWT_SECRET']);
  });

  it('returns [] when every required key is set in .env', () => {
    const dir = make({
      'docker-compose.prod.yml': COMPOSE,
      '.env': 'JWT_SECRET=abc\nPOSTGRES_PASSWORD=pw\nPG_META_CRYPTO_KEY=k\n',
    });
    expect(findMissingRequiredEnv(dir)).toEqual([]);
  });

  it('only counts `:?` (required) markers, never `:-` defaults or plain refs', () => {
    const dir = make({
      'docker-compose.prod.yml': COMPOSE,
      '.env': 'JWT_SECRET=abc\nPOSTGRES_PASSWORD=pw\nPG_META_CRYPTO_KEY=k\n',
    });
    // SITE_URL is `${SITE_URL:-…}` in the fixture and is NOT in .env.
    expect(findMissingRequiredEnv(dir)).not.toContain('SITE_URL');
  });

  it('falls back to the known compose-required set when no compose file exists', () => {
    const dir = make({ '.env': '' });
    expect(findMissingRequiredEnv(dir)).toEqual([...COMPOSE_REQUIRED_ENV_FALLBACK].sort());
    expect(COMPOSE_REQUIRED_ENV_FALLBACK).toContain('JWT_SECRET');
    expect(COMPOSE_REQUIRED_ENV_FALLBACK).toContain('POSTGRES_PASSWORD');
  });
});

describe('deploy.js wires the preflight before any provisioning', () => {
  // Static-source check (same style as no-hardcoded-provider-dispatch): the
  // whole point is ordering — the stop must come before gatherDeploymentConfig
  // (prompts, then S3/servers). A runtime harness for the deploy entrypoint
  // would need the full orchestrator mocked; the source order is the contract.
  const src = readFileSync(join(process.cwd(), 'src', 'deploy.js'), 'utf8');

  it('calls findMissingRequiredEnv and exits 1 ahead of gatherDeploymentConfig', () => {
    const preflight = src.indexOf('findMissingRequiredEnv(');
    const gather = src.indexOf('await gatherDeploymentConfig(');
    expect(preflight).toBeGreaterThan(-1);
    expect(gather).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(gather);
    const block = src.slice(preflight, gather);
    expect(block).toMatch(/process\.exit\(1\)/);
    expect(block).toMatch(/vibecarbon configure/);
  });
});
