import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Supavisor config invariants — the pooler's port->mode contract.
 *
 * Supavisor's defaults put SESSION mode on 5432 and TRANSACTION mode on 6543
 * (same convention as hosted Supabase). Docs shipped for a while claiming the
 * opposite because nothing in the compose file declared the mapping — these
 * tests pin it in docker-compose.prod.yml and keep the shipped docs from
 * drifting back into the inverted claim.
 *
 * Also pins the fail-closed contract: prod secrets use `${VAR:?}` so a missing
 * value aborts `docker compose` loudly instead of booting a service on a
 * blank encryption key.
 */

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

const prodYml = read('docker-compose.prod.yml');

describe('Supavisor: port->mode mapping is declared, not inherited', () => {
  it('pins PROXY_PORT_SESSION=5432 and PROXY_PORT_TRANSACTION=6543', () => {
    // Without these, the mapping silently comes from image defaults and docs
    // have nothing to be checked against.
    expect(prodYml).toMatch(/PROXY_PORT_SESSION:\s*"5432"/);
    expect(prodYml).toMatch(/PROXY_PORT_TRANSACTION:\s*"6543"/);
  });

  it('publishes both pooler ports', () => {
    expect(prodYml).toMatch(/- "5432:5432"/);
    expect(prodYml).toMatch(/- "6543:6543"/);
  });

  it('declares a tenant id (external clients connect as postgres.<tenant>)', () => {
    expect(prodYml).toMatch(/POOLER_TENANT_ID:/);
  });
});

describe('Supavisor: boot actually provisions the pooler', () => {
  // The image's default entrypoint just starts the server: without an
  // explicit migrate + tenant-seed command the pooler boots with no
  // metadata schema and no tenant, and EVERY client connection fails.
  // Mirrors supabase/docker's self-hosted bootstrap.
  it('runs migrate, seeds the tenant from pooler.exs, then starts the server', () => {
    expect(prodYml).toContain('/app/bin/migrate');
    expect(prodYml).toContain('/etc/pooler/pooler.exs');
    expect(prodYml).toContain('/app/bin/server');
  });

  it('mounts the tenant-seed script and ships its auth plumbing', () => {
    expect(prodYml).toMatch(/volumes\/pooler\/pooler\.exs/);
    const poolerExs = read('volumes/pooler/pooler.exs');
    expect(poolerExs).toContain('POOLER_TENANT_ID');
    expect(poolerExs).toContain('pgbouncer.get_auth');
    const poolerSql = read('volumes/db/pooler.sql');
    expect(poolerSql).toContain('_supavisor');
    expect(poolerSql).toContain('pgbouncer.get_auth');
    // The db must mount the init SQL and align the manager role's password.
    const baseYml = read('docker-compose.yml');
    expect(baseYml).toMatch(/volumes\/db\/pooler\.sql/);
    expect(read('volumes/db/set-passwords.sh')).toContain('pgbouncer');
  });

  it('provides the env the tenant seed reads', () => {
    for (const key of ['POSTGRES_PORT', 'POSTGRES_DB', 'POOLER_POOL_MODE']) {
      expect(prodYml).toMatch(new RegExp(`${key}:`));
    }
  });
});

describe('Prod secrets fail closed (no dev fallbacks, `:?` required syntax)', () => {
  // `${VAR}` alone substitutes an EMPTY STRING with only a warning — a service
  // then boots with a blank encryption key. `${VAR:?msg}` makes compose abort.
  const requiredInProd = [
    'VAULT_ENC_KEY',
    'REALTIME_SECRET',
    'JWT_SECRET',
    'DB_ENC_KEY',
    'PG_META_CRYPTO_KEY',
  ];

  it.each(requiredInProd)('%s has no `:-` fallback anywhere in the prod overlay', (name) => {
    const fallback = new RegExp(`\\$\\{${name}:-`);
    expect(
      prodYml.match(fallback),
      `\${${name}:-...} found in docker-compose.prod.yml — prod must fail closed, ` +
        'use ${' + name + ':?message} instead (create writes the value to .env.local).',
    ).toBeNull();
  });

  it.each(requiredInProd)('%s is required with `:?` at least once in the prod overlay', (name) => {
    const required = new RegExp(`\\$\\{${name}:\\?`);
    expect(
      prodYml.match(required),
      `No \${${name}:?...} in docker-compose.prod.yml — the prod overlay must ` +
        'override the base file\'s dev fallback for this secret.',
    ).not.toBeNull();
  });
});

describe('Docs agree with the declared mapping', () => {
  // Drift guard: if the compose pins move, or someone "fixes" the docs back to
  // the inverted claim, this fails and points at the contract above.
  it('PRODUCTION.md states session=5432 / transaction=6543', () => {
    const md = read('PRODUCTION.md');
    expect(md).toContain('Session mode (port 5432)');
    expect(md).toContain('Transaction mode (port 6543)');
  });

  it('.env.example puts session on :5432 and transaction on :6543', () => {
    const env = read('.env.example');
    const sessionIdx = env.indexOf('Session mode');
    const transactionIdx = env.indexOf('Transaction mode');
    expect(sessionIdx).toBeGreaterThan(-1);
    expect(transactionIdx).toBeGreaterThan(-1);
    // The connection-string line follows its mode heading; check each pairing.
    expect(env.slice(sessionIdx, sessionIdx + 200)).toContain(':5432/postgres');
    expect(env.slice(transactionIdx, transactionIdx + 200)).toContain(':6543/postgres');
  });
});
