import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the production DB connection budget + Supavisor pooler config against
 * silent drift. Raw-text assertions (the repo has no YAML parser dep) over the
 * template's compose files. Not a runtime check — see the spec's e2e caveat:
 * the db-connection-pooling-design spec
 */
const REPO_ROOT = join(__dirname, '..', '..', '..');
const base = readFileSync(join(REPO_ROOT, 'carbon/docker-compose.yml'), 'utf-8');
const prod = readFileSync(join(REPO_ROOT, 'carbon/docker-compose.prod.yml'), 'utf-8');

describe('DB connection budget (carbon/docker-compose.yml)', () => {
  it('sets an explicit Postgres max_connections=200 on the db command', () => {
    expect(base).toContain('max_connections=200');
  });

  it('caps the PostgREST connection pool explicitly', () => {
    expect(base).toMatch(/PGRST_DB_POOL:\s*["']?\d+/);
  });

  it('sets a PostgREST pool acquisition timeout (fail fast, not hang)', () => {
    expect(base).toMatch(/PGRST_DB_POOL_ACQUISITION_TIMEOUT:\s*["']?\d+/);
  });
});

describe('Supavisor external pooler (carbon/docker-compose.prod.yml)', () => {
  it('defines the supavisor service', () => {
    expect(prod).toMatch(/^\s{2}supavisor:/m);
  });

  it('exposes the transaction (5432) and session (6543) pooler ports', () => {
    expect(prod).toContain('5432:5432');
    expect(prod).toContain('6543:6543');
  });
});
