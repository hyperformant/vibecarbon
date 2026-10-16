import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatDotenvLine } from '../../../src/lib/dotenv.js';
import { COMPOSE_REQUIRED_ENV_FALLBACK, findMissingRequiredEnv } from '../../../src/lib/project.js';

// vibecarbon-web prod move, 2026-09-15: the deploy ran from a fresh worktree
// with no `.env` (gitignored). Step 0d WARNED that the required secrets were
// missing, then provisioned a server, pushed the image and repointed DNS
// before `docker compose up` failed on a `${KEY:?...}` marker — five minutes
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
  app:
    environment:
      - BETTER_AUTH_SECRET=\${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET missing — vibecarbon create writes it to .env.local}
      - SITE_URL=\${SITE_URL:-http://localhost}
      - ADMIN_EMAIL=\${ADMIN_EMAIL:?ADMIN_EMAIL missing}
`;

// What the shipped template's docker-compose.prod.yml requires. The removed
// services' secrets (gateway JWT keys, realtime, vault, meta, ...) are not
// among them: nothing in the stack reads them any more.
const LEAN_REQUIRED = ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'BETTER_AUTH_SECRET', 'POSTGRES_PASSWORD'];
const TEMPLATE_PROD_COMPOSE = readFileSync(
  join(process.cwd(), 'carbon', 'docker-compose.prod.yml'),
  'utf8',
);
// Secrets an older project's .env still carries after the services that read
// them were removed.
const DELETED_SECRETS = {
  ANON_KEY: 'a',
  SUPABASE_ANON_KEY: 'a',
  SUPABASE_SERVICE_ROLE_KEY: 's',
  SUPABASE_URL: 'http://kong:8000',
  REALTIME_SECRET: 'r',
  LOGFLARE_API_KEY: 'l',
  VAULT_ENC_KEY: 'v',
  PG_META_CRYPTO_KEY: 'm',
  DB_ENC_KEY: 'd',
  SECRET_KEY_BASE: 'k',
};
const dotenv = (vars: Record<string, string>) =>
  `${Object.entries(vars)
    .map(([k, v]) => formatDotenvLine(k, v))
    .join('\n')}\n`;
const LEAN_ENV = Object.fromEntries(LEAN_REQUIRED.map((k) => [k, 'set']));

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
      '.env.local': 'BETTER_AUTH_SECRET=abc\nPOSTGRES_PASSWORD=pw\nADMIN_EMAIL=a@b.co\n',
    });
    expect(findMissingRequiredEnv(dir)).toEqual([
      'ADMIN_EMAIL',
      'BETTER_AUTH_SECRET',
      'POSTGRES_PASSWORD',
    ]);
  });

  it('reports a required key that is present but empty in .env', () => {
    const dir = make({
      'docker-compose.prod.yml': COMPOSE,
      '.env': "BETTER_AUTH_SECRET=''\nPOSTGRES_PASSWORD=pw\nADMIN_EMAIL=a@b.co\n",
    });
    expect(findMissingRequiredEnv(dir)).toEqual(['BETTER_AUTH_SECRET']);
  });

  it('returns [] when every required key is set in .env', () => {
    const dir = make({
      'docker-compose.prod.yml': COMPOSE,
      '.env': 'BETTER_AUTH_SECRET=abc\nPOSTGRES_PASSWORD=pw\nADMIN_EMAIL=a@b.co\n',
    });
    expect(findMissingRequiredEnv(dir)).toEqual([]);
  });

  it('only counts `:?` (required) markers, never `:-` defaults or plain refs', () => {
    const dir = make({
      'docker-compose.prod.yml': COMPOSE,
      '.env': 'BETTER_AUTH_SECRET=abc\nPOSTGRES_PASSWORD=pw\nADMIN_EMAIL=a@b.co\n',
    });
    // SITE_URL is `${SITE_URL:-…}` in the fixture and is NOT in .env.
    expect(findMissingRequiredEnv(dir)).not.toContain('SITE_URL');
  });

  it('falls back to the known compose-required set when no compose file exists', () => {
    const dir = make({ '.env': '' });
    expect(findMissingRequiredEnv(dir)).toEqual([...COMPOSE_REQUIRED_ENV_FALLBACK].sort());
    expect(COMPOSE_REQUIRED_ENV_FALLBACK).toContain('POSTGRES_PASSWORD');
  });

  it('the fallback set mirrors the shipped docker-compose.prod.yml markers', () => {
    const dir = make({ 'docker-compose.prod.yml': TEMPLATE_PROD_COMPOSE, '.env': '' });
    expect(findMissingRequiredEnv(dir)).toEqual(LEAN_REQUIRED);
    expect([...COMPOSE_REQUIRED_ENV_FALLBACK].sort()).toEqual(LEAN_REQUIRED);
  });

  describe("an .env that still carries the removed services' secrets", () => {
    for (const [label, files] of [
      ['shipped compose file', { 'docker-compose.prod.yml': TEMPLATE_PROD_COMPOSE }],
      ['no compose file (fallback set)', {}],
    ] as const) {
      it(`neither requires nor rejects them (${label})`, () => {
        // Leftovers alongside every required key: nothing is reported.
        const full = make({ ...files, '.env': dotenv({ ...DELETED_SECRETS, ...LEAN_ENV }) });
        expect(findMissingRequiredEnv(full)).toEqual([]);
        // Leftovers alone: only the lean stack's keys are asked for.
        const leftovers = make({ ...files, '.env': dotenv(DELETED_SECRETS) });
        expect(findMissingRequiredEnv(leftovers)).toEqual(LEAN_REQUIRED);
        // And none of them is required when absent.
        const lean = make({ ...files, '.env': dotenv(LEAN_ENV) });
        expect(findMissingRequiredEnv(lean)).toEqual([]);
      });
    }
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
