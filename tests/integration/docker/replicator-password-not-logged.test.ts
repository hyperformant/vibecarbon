/**
 * The replication password never reaches the Postgres log, against a REAL
 * Postgres at default logging.
 *
 * PR #322 dropped `-c log_min_messages=fatal` from the db command, so Postgres
 * logs a failing statement's text again (log_min_error_statement = error). A
 * write-fenced primary (default_transaction_read_only) fails the role
 * statements, and the old DO-block shape then put the password in the log via
 * the statement text and the PL/pgSQL CONTEXT line. The log reaches Loki.
 *
 * Both halves are asserted: the old shape DOES leak (so the risk is real, not
 * a fixture that cannot bite), and primaryReplicationSql does not.
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { primaryReplicationSql } from '../../../src/lib/deploy/replication-slot.js';

const shouldRunDocker = process.env.DOCKER_INTEGRATION === 'true';
const describeDocker = shouldRunDocker ? describe : describe.skip;

const NAME = `vctest-replpw-${process.pid}`;
const run = (args: string[], input?: string) =>
  execFileSync('docker', args, { encoding: 'utf-8', stdio: 'pipe', input });
const psql = (sql: string) => run(['exec', NAME, 'psql', '-U', 'postgres', '-tAc', sql]).trim();
/** Pipe SQL to psql on stdin, as both HA tiers do. A failing statement is expected, so errors are swallowed. */
const pipe = (sql: string) => {
  try {
    run(['exec', '-i', NAME, 'psql', '-U', 'postgres'], sql);
  } catch {
    // the write fence makes the role statements fail; that is the point
  }
};
/** The container's whole log (docker logs writes Postgres's stderr to stderr). */
const allLogs = () => execFileSync('sh', ['-c', `docker logs ${NAME} 2>&1`], { encoding: 'utf-8' });

/** main's shape, byte for byte in what matters: a DO block carrying the literal, no SETs. */
const oldShape = (pw: string) => `
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'replicator') THEN
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${pw}';
  ELSE
    ALTER ROLE replicator WITH PASSWORD '${pw}';
  END IF;
END $$;
`;

describeDocker('the replication password and the Postgres log', () => {
  beforeAll(async () => {
    run(['run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=pw', 'postgres:17-alpine']);
    for (let i = 0; i < 60; i++) {
      try {
        if (psql('SELECT 1') === '1') break;
      } catch {
        // still starting
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    // The write fence: every role statement now fails.
    psql('ALTER SYSTEM SET default_transaction_read_only = on');
    psql('SELECT pg_reload_conf()');
    await new Promise((r) => setTimeout(r, 1000));
  }, 120_000);

  afterAll(() => {
    try {
      run(['rm', '-f', '-v', NAME]);
    } catch {
      // already gone
    }
  });

  it('the fence is on, so the role statements fail', () => {
    expect(psql("SELECT current_setting('default_transaction_read_only')")).toBe('on');
  });

  it('the old DO-block shape leaks the password into the log (the risk is real)', () => {
    const marker = `leakmarker${process.pid}old`;
    pipe(oldShape(marker));
    expect(allLogs()).toContain(marker);
  });

  it('primaryReplicationSql keeps the password out of the log, even when it fails', () => {
    const marker = `leakmarker${process.pid}new`;
    pipe(primaryReplicationSql(marker));
    const log = allLogs();
    // It really failed (so the leak path was exercised), and said nothing of the literal.
    expect(log).toContain('read-only transaction');
    expect(log).not.toContain(marker);
  });

  it('on a writable server the new SQL still creates the role with the password', () => {
    psql('ALTER SYSTEM RESET default_transaction_read_only');
    psql('SELECT pg_reload_conf()');
    pipe(primaryReplicationSql('whatever'));
    expect(
      psql("SELECT rolreplication AND rolcanlogin FROM pg_roles WHERE rolname = 'replicator'"),
    ).toBe('t');
    expect(psql("SELECT rolpassword IS NOT NULL FROM pg_authid WHERE rolname = 'replicator'")).toBe(
      't',
    );
    // idempotent: a second run changes nothing and does not fail
    pipe(primaryReplicationSql('whatever2'));
    expect(psql("SELECT count(*) FROM pg_roles WHERE rolname = 'replicator'")).toBe('1');
  });
});
