/**
 * The lean-stack verification checks: the app's real schema and a write
 * round-trip asserted as direct SQL (there is no public table API to probe
 * from outside any more), and the apex answering an unknown path with the
 * app's own HTML 404 rather than a gateway or a Traefik no-router 404.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CORE_TABLES,
  CRON_JOBS,
  DB_CONFIG_FILE,
  missingDbHandle,
  runDbChecks,
  runDbRuntimeChecks,
  type SqlRunner,
  templateMigrationCount,
} from '../../e2e/checks/app-functional.js';
import { APP_SHELL_MARKER, checkUnknownPathNotFound } from '../../e2e/checks/health.js';

const ok = (output: string) => ({ ok: true, output });

/** A fake database: every core table present, notifications rows in memory. */
function fakeDb(opts: { tables?: readonly string[]; dropInsert?: boolean } = {}) {
  const tables = opts.tables ?? CORE_TABLES;
  const rows = new Set<string>();
  const statements: string[] = [];
  const run = vi.fn<SqlRunner>(async (sql) => {
    statements.push(sql);
    if (sql.startsWith('SELECT tablename')) return ok(tables.join('\n'));
    const title = /'(e2e-probe-[0-9a-f-]+)'/.exec(sql)?.[1] ?? '';
    if (sql.startsWith('INSERT')) {
      if (!opts.dropInsert) rows.add(title);
      return ok(opts.dropInsert ? '' : title);
    }
    if (sql.startsWith('SELECT title')) return ok(rows.has(title) ? title : '');
    if (sql.startsWith('DELETE')) {
      const had = rows.delete(title);
      return ok(had ? title : '');
    }
    return { ok: false, output: '', error: `unexpected sql: ${sql}` };
  });
  return { run, rows, statements };
}

describe('runDbChecks (direct SQL)', () => {
  it('passes db_schema and db_write_roundtrip and leaves no probe row behind', async () => {
    const db = fakeDb();
    const results = await runDbChecks(db.run);
    expect(results.map((r) => [r.checkName, r.status])).toEqual([
      ['db_schema', 'pass'],
      ['db_write_roundtrip', 'pass'],
    ]);
    expect(db.rows.size).toBe(0);
  });

  it('writes the probe row inactive so no feed can surface it', async () => {
    const db = fakeDb();
    await runDbChecks(db.run);
    const insert = db.statements.find((s) => s.startsWith('INSERT'));
    expect(insert).toMatch(/is_active, visibility\) VALUES \('e2e-probe-[0-9a-f-]+', false,/);
  });

  it('emits single-line SQL with no double quotes (psql -c "…" wrapping)', async () => {
    const db = fakeDb();
    await runDbChecks(db.run);
    for (const sql of db.statements) {
      expect(sql).not.toContain('"');
      expect(sql).not.toContain('\n');
    }
  });

  it('fails db_schema naming the missing tables and skips the round-trip', async () => {
    const db = fakeDb({ tables: ['notifications', 'organizations'] });
    const [schema, roundtrip] = await runDbChecks(db.run);
    expect(schema.status).toBe('fail');
    expect(schema.errorMessage).toContain('memberships, subscriptions, app_settings');
    expect(roundtrip).toMatchObject({ checkName: 'db_write_roundtrip', status: 'skip' });
    expect(db.statements.some((s) => s.startsWith('INSERT'))).toBe(false);
  });

  it('fails db_schema when the query itself fails (never a pass)', async () => {
    const run = vi.fn<SqlRunner>(async () => ({
      ok: false,
      output: '',
      error: '[ssh-transport, 3 attempts] Connection timed out',
    }));
    const [schema, roundtrip] = await runDbChecks(run);
    expect(schema.status).toBe('fail');
    expect(schema.errorMessage).toContain('ssh-transport');
    expect(roundtrip.status).toBe('skip');
  });

  it('fails the round-trip at insert and still attempts cleanup', async () => {
    const db = fakeDb({ dropInsert: true });
    const results = await runDbChecks(db.run);
    expect(results[1]).toMatchObject({
      checkName: 'db_write_roundtrip',
      status: 'fail',
      details: { step: 'insert' },
    });
    expect(db.statements.at(-1)).toMatch(/^DELETE/);
  });

  it('FAILS both checks (never skips) when there is no SSH handle, naming it', async () => {
    const results = await runDbChecks('no sshKeyPath (serverIp present)');
    expect(results.map((r) => [r.checkName, r.status])).toEqual([
      ['db_schema', 'fail'],
      ['db_write_roundtrip', 'fail'],
    ]);
    for (const r of results) expect(r.errorMessage).toContain('no sshKeyPath (serverIp present)');
  });

  it('missingDbHandle names which handle is absent', () => {
    expect(missingDbHandle('1.2.3.4', '/k')).toBeNull();
    expect(missingDbHandle(undefined, '/k')).toBe('no serverIp (sshKeyPath present)');
    expect(missingDbHandle(undefined, null)).toBe('no serverIp and no sshKeyPath');
    expect(missingDbHandle('1.2.3.4', null)).toBe('no sshKeyPath (serverIp present)');
  });
});

/** A fake lean-stack database for the runtime checks; each field overrides one answer. */
function fakeRuntimeDb(
  opts: {
    ledger?: boolean;
    applied?: number;
    jobs?: readonly string[];
    launchers?: number;
    configFile?: string;
    preload?: string;
    paramLength?: string;
    extensions?: string;
    statsReadable?: boolean;
  } = {},
) {
  const statements: string[] = [];
  const run = vi.fn<SqlRunner>(async (sql) => {
    statements.push(sql);
    if (sql.includes('to_regclass')) return ok(opts.ledger === false ? 'f' : 't');
    if (sql.includes('FROM drizzle.__drizzle_migrations')) return ok(String(opts.applied ?? 3));
    if (sql.includes('FROM cron.job')) return ok((opts.jobs ?? CRON_JOBS).join('\n'));
    if (sql.includes('pg_cron launcher')) return ok(String(opts.launchers ?? 1));
    if (sql.includes("current_setting('config_file')")) {
      return ok(
        [
          opts.configFile ?? DB_CONFIG_FILE,
          opts.preload ?? 'pg_cron,pg_stat_statements',
          opts.paramLength ?? '0',
          opts.extensions ?? 'pg_cron,pg_stat_statements',
        ].join('|'),
      );
    }
    if (sql.includes('monitoring.pg_stat_statements')) {
      return opts.statsReadable === false
        ? { ok: false, output: '', error: '[psql] relation does not exist' }
        : ok('12');
    }
    return { ok: false, output: '', error: `unexpected sql: ${sql}` };
  });
  return { run, statements };
}

const statusOf = (results: { checkName: string; status: string }[], name: string) =>
  results.find((r) => r.checkName === name)?.status;

describe('runDbRuntimeChecks (migrations, cron, server config)', () => {
  it('passes all three on a healthy lean-stack database', async () => {
    const db = fakeRuntimeDb();
    const results = await runDbRuntimeChecks(db.run, 3);
    expect(results.map((r) => [r.checkName, r.status])).toEqual([
      ['db_migrations_applied', 'pass'],
      ['db_cron_jobs', 'pass'],
      ['db_server_config', 'pass'],
    ]);
  });

  it('emits single-line SQL with no double quotes or $ (psql -c "…" over SSH)', async () => {
    const db = fakeRuntimeDb();
    await runDbRuntimeChecks(db.run, 3);
    for (const sql of db.statements) {
      expect(sql).not.toMatch(/["\n$]/);
    }
  });

  it('fails db_migrations_applied when the ledger does not exist', async () => {
    const results = await runDbRuntimeChecks(fakeRuntimeDb({ ledger: false }).run, 3);
    expect(results[0]).toMatchObject({ checkName: 'db_migrations_applied', status: 'fail' });
    expect(results[0].errorMessage).toContain('never ran its migrations');
  });

  it('fails db_migrations_applied on fewer than the template ships, passes on add-on extras', async () => {
    const short = await runDbRuntimeChecks(fakeRuntimeDb({ applied: 2 }).run, 3);
    expect(short[0].status).toBe('fail');
    expect(short[0].errorMessage).toContain('Only 2 of');
    const extra = await runDbRuntimeChecks(fakeRuntimeDb({ applied: 4 }).run, 3);
    expect(extra[0].status).toBe('pass');
  });

  it('fails db_cron_jobs naming a missing job', async () => {
    const results = await runDbRuntimeChecks(
      fakeRuntimeDb({ jobs: CRON_JOBS.filter((j) => j !== 'cleanup-expired-sessions') }).run,
      3,
    );
    expect(statusOf(results, 'db_cron_jobs')).toBe('fail');
    expect(results[1].errorMessage).toContain('cleanup-expired-sessions');
  });

  it('fails db_cron_jobs when the jobs exist but the launcher is not running', async () => {
    const results = await runDbRuntimeChecks(fakeRuntimeDb({ launchers: 0 }).run, 3);
    expect(results[1].status).toBe('fail');
    expect(results[1].errorMessage).toContain('launcher is not running');
  });

  it.each([
    [{ configFile: '/var/lib/postgresql/data/postgresql.conf' }, 'config_file is'],
    [{ preload: 'pg_cron' }, 'not preloaded: pg_stat_statements'],
    [{ extensions: 'pg_cron' }, 'extension not created: pg_stat_statements'],
    [{ paramLength: '-1' }, 'bind values reach the log'],
    [{ statsReadable: false }, 'not readable'],
  ])('fails db_server_config on %o', async (override, message) => {
    const results = await runDbRuntimeChecks(fakeRuntimeDb(override).run, 3);
    expect(results[2]).toMatchObject({ checkName: 'db_server_config', status: 'fail' });
    expect(results[2].errorMessage).toContain(message);
  });

  it('FAILS all three (never skips) when there is no SSH handle', async () => {
    const results = await runDbRuntimeChecks('no serverIp and no sshKeyPath', 3);
    expect(results.map((r) => r.status)).toEqual(['fail', 'fail', 'fail']);
    for (const r of results) expect(r.errorMessage).toContain('no serverIp and no sshKeyPath');
  });

  it('CRON_JOBS matches the cron.schedule() calls in the template baseline', () => {
    const post = readFileSync(
      join(process.cwd(), 'carbon/db/migrations/0002_baseline_post.sql'),
      'utf-8',
    );
    const scheduled = [...post.matchAll(/cron\.schedule\(\s*'([^']+)'/g)].map((m) => m[1]).sort();
    expect(scheduled).toEqual([...CRON_JOBS]);
  });

  it("reads the template's migration count from drizzle's journal", () => {
    expect(templateMigrationCount()).toBeGreaterThanOrEqual(3);
  });
});

describe('checkUnknownPathNotFound', () => {
  const respond = (status: number, contentType: string, body = '') =>
    vi.fn(
      async () =>
        new Response(body, { status, headers: contentType ? { 'content-type': contentType } : {} }),
    );

  it("passes on the app's HTML 404 for /rest/v1/", async () => {
    const fetchFn = respond(
      404,
      'text/html; charset=UTF-8',
      '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
    );
    const r = await checkUnknownPathNotFound('x.example', fetchFn as never);
    expect(r).toMatchObject({ checkName: 'unknown_path_not_found', status: 'pass' });
    expect(fetchFn).toHaveBeenCalledWith('https://x.example/rest/v1/');
  });

  it("fails on Traefik's no-router 404 (text/plain): the app is not behind the apex", async () => {
    const r = await checkUnknownPathNotFound(
      'x.example',
      respond(404, 'text/plain; charset=utf-8', '404 page not found') as never,
    );
    expect(r.status).toBe('fail');
  });

  it('fails on an HTML 404 that is not the app shell (a proxy or gateway error page)', async () => {
    const r = await checkUnknownPathNotFound(
      'x.example',
      respond(404, 'text/html', '<html><body><h1>404 Not Found</h1>nginx</body></html>') as never,
    );
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toContain('without the app shell');
  });

  it('the shell marker is the one in the template index.html', () => {
    const html = readFileSync(join(process.cwd(), 'carbon/src/client/index.html'), 'utf-8');
    expect(html).toContain(APP_SHELL_MARKER);
  });

  it('fails when something still answers the path (200 / 401)', async () => {
    for (const status of [200, 401]) {
      const r = await checkUnknownPathNotFound(
        'x.example',
        respond(status, 'application/json') as never,
      );
      expect(r.status).toBe('fail');
      expect(r.errorMessage).toContain(String(status));
    }
  });

  it('fails (never throws) on a transport error, with one attempt only', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const r = await checkUnknownPathNotFound('x.example', fetchFn as never);
    expect(r).toMatchObject({ status: 'fail', errorMessage: 'fetch failed' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
