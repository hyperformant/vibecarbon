/**
 * Unit tests for the pure parts of the independent replication verification
 * checks — the query/command builders, marker-id generation, and psql-output
 * classification. These are the pieces a broken replication run leans on to
 * produce a correct verdict + actionable diagnostics, so they're worth pinning
 * down without a live cluster. We deliberately do NOT fake SSH round-trips.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCreateMarkerSql,
  buildDropProbeTableSql,
  buildLogDiagCommand,
  buildMarkerId,
  buildPsqlCommand,
  classifySshExecFailure,
  extractPgHbaRejectIps,
  hasStreamingState,
  isTransientSshError,
  parseIsInRecovery,
  parseReplicationStates,
  REPL_PROBE_TABLE,
  resolveHaDbIps,
} from '../../e2e/checks/replication.js';

describe('buildMarkerId', () => {
  it('produces an id containing only [A-Za-z0-9-] from arbitrary input', () => {
    const id = buildMarkerId('run/12:34.abc', 'verify-deploy', 1_700_000_000_000);
    expect(id).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it('strips SQL-hostile characters so a single-quoted literal cannot break out', () => {
    const id = buildMarkerId("x'; DROP TABLE users;--", 'verify-scale', 1);
    expect(id).not.toContain("'");
    expect(id).not.toContain(';');
    expect(id).not.toContain(' ');
    expect(id).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it('is deterministic for the same inputs and encodes the timestamp', () => {
    expect(buildMarkerId('abc', 'failover-continuity', 42)).toBe(
      buildMarkerId('abc', 'failover-continuity', 42),
    );
    expect(buildMarkerId('abc', 'failover-continuity', 42)).toContain('-42');
  });

  it('truncates the timestamp to an integer', () => {
    expect(buildMarkerId('r', 's', 12.9)).toContain('-12');
  });
});

describe('buildPsqlCommand', () => {
  it('uses docker compose exec for compose-ha and cds into the project dir', () => {
    const cmd = buildPsqlCommand('compose-ha', 'acme', 'SELECT 1');
    expect(cmd).toContain('cd /opt/acme');
    expect(cmd).toContain('docker compose exec -T db psql -U supabase_admin -d postgres -tAc');
    expect(cmd).toContain('"SELECT 1"');
  });

  it('uses kubectl exec into the supabase-db pod for k8s-ha', () => {
    const cmd = buildPsqlCommand('k8s-ha', 'acme', 'SELECT 1');
    expect(cmd).toContain('KUBECONFIG=/etc/rancher/k3s/k3s.yaml');
    expect(cmd).toContain('kubectl exec -n vibecarbon supabase-supabase-db-0');
    expect(cmd).toContain('psql -U supabase_admin -d postgres -tAc');
    expect(cmd).not.toContain('docker compose');
  });

  it('wraps the SQL in double quotes (single-quoted marker literals stay intact)', () => {
    const sql = `SELECT id FROM ${REPL_PROBE_TABLE} WHERE id = 'e2e-run-step-1'`;
    const cmd = buildPsqlCommand('compose-ha', 'p', sql);
    expect(cmd).toContain(`"${sql}"`);
  });
});

describe('buildLogDiagCommand', () => {
  it('greps compose db logs for replication/pg_hba and tails 20 lines', () => {
    const cmd = buildLogDiagCommand('compose-ha', 'acme');
    expect(cmd).toContain('docker compose logs');
    expect(cmd).toContain('tail -20');
    expect(cmd).toMatch(/grep -iE '[^']*pg_hba[^']*'/);
  });

  it('greps k8s pod logs for replication/pg_hba', () => {
    const cmd = buildLogDiagCommand('k8s-ha', 'acme');
    expect(cmd).toContain('kubectl logs -n vibecarbon supabase-supabase-db-0');
    expect(cmd).toContain('tail -20');
  });
});

describe('buildCreateMarkerSql', () => {
  it('creates the probe table, enables RLS, and inserts the marker — one batch, RLS before the write', () => {
    const sql = buildCreateMarkerSql('e2e-run-step-1');
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${REPL_PROBE_TABLE}`);
    expect(sql).toContain(`ALTER TABLE public.${REPL_PROBE_TABLE} ENABLE ROW LEVEL SECURITY`);
    expect(sql).toContain(`INSERT INTO public.${REPL_PROBE_TABLE}`);
    expect(sql).toContain("VALUES ('e2e-run-step-1')");
    // RLS must land before the INSERT in the batch so the table is never
    // observably unprotected at any point after creation — this is what
    // makes the probe comply with the deploy-time RLS audit
    // (src/lib/deploy/rls-audit.js) like any customer table would.
    expect(sql.indexOf('ENABLE ROW LEVEL SECURITY')).toBeLessThan(sql.indexOf('INSERT INTO'));
  });
});

describe('buildDropProbeTableSql', () => {
  it('drops the probe table outright, not just a row', () => {
    expect(buildDropProbeTableSql()).toBe(`DROP TABLE IF EXISTS public.${REPL_PROBE_TABLE};`);
  });
});

describe('parseIsInRecovery', () => {
  it('maps t/true to true and f/false to false', () => {
    expect(parseIsInRecovery('t')).toBe(true);
    expect(parseIsInRecovery(' t \n')).toBe(true);
    expect(parseIsInRecovery('true')).toBe(true);
    expect(parseIsInRecovery('f')).toBe(false);
    expect(parseIsInRecovery('false')).toBe(false);
  });

  it('returns null for empty/unparseable/absent output', () => {
    expect(parseIsInRecovery('')).toBeNull();
    expect(parseIsInRecovery('   ')).toBeNull();
    expect(parseIsInRecovery('psql: could not connect')).toBeNull();
    expect(parseIsInRecovery(null)).toBeNull();
    expect(parseIsInRecovery(undefined)).toBeNull();
  });
});

describe('parseReplicationStates / hasStreamingState', () => {
  it('parses one state per non-empty line, lowercased', () => {
    expect(parseReplicationStates('streaming')).toEqual(['streaming']);
    expect(parseReplicationStates('STREAMING\ncatchup\n')).toEqual(['streaming', 'catchup']);
    expect(parseReplicationStates('')).toEqual([]);
    expect(parseReplicationStates(null)).toEqual([]);
  });

  it('detects a streaming row', () => {
    expect(hasStreamingState(['catchup', 'streaming'])).toBe(true);
    expect(hasStreamingState(['catchup'])).toBe(false);
    expect(hasStreamingState([])).toBe(false);
  });
});

describe('isTransientSshError', () => {
  it('matches the sshRunAsync transient vocabulary', () => {
    // The exact live failure that motivated the retry: sshd MaxStartups
    // penalizing the verify-step's SSH burst.
    expect(isTransientSshError('Connection timed out during banner exchange')).toBe(true);
    expect(isTransientSshError('kex_exchange_identification: read: Connection reset by peer')).toBe(
      true,
    );
    expect(
      isTransientSshError('ssh_exchange_identification: Connection closed by remote host'),
    ).toBe(true);
    expect(isTransientSshError('connect to host 1.2.3.4 port 22: Connection refused')).toBe(true);
    expect(isTransientSshError('connect to host 1.2.3.4 port 22: No route to host')).toBe(true);
    expect(isTransientSshError('spawnSync ssh ETIMEDOUT')).toBe(true);
    expect(isTransientSshError('Operation timed out')).toBe(true);
  });

  it('does NOT match auth/host-key failures or psql errors', () => {
    expect(isTransientSshError('root@1.2.3.4: Permission denied (publickey)')).toBe(false);
    expect(isTransientSshError('REMOTE HOST IDENTIFICATION HAS CHANGED')).toBe(false);
    expect(isTransientSshError('ERROR:  relation "_e2e_repl_probe" does not exist')).toBe(false);
    expect(isTransientSshError('')).toBe(false);
    expect(isTransientSshError(null)).toBe(false);
    expect(isTransientSshError(undefined)).toBe(false);
  });
});

describe('classifySshExecFailure', () => {
  it('exit 255 + transient vocabulary => transient ssh-transport', () => {
    const cls = classifySshExecFailure(255, 'Connection timed out during banner exchange');
    expect(cls).toEqual({ kind: 'ssh-transport', transient: true });
  });

  it('exit 255 + auth failure => ssh-transport but NOT transient (retry is useless)', () => {
    const cls = classifySshExecFailure(255, 'root@1.2.3.4: Permission denied (publickey)');
    expect(cls).toEqual({ kind: 'ssh-transport', transient: false });
  });

  it('null status (local timeout kill) => transient ssh-transport even with bare error text', () => {
    expect(classifySshExecFailure(null, 'spawnSync ssh ETIMEDOUT')).toEqual({
      kind: 'ssh-transport',
      transient: true,
    });
    // execFileSync timeout kills can surface with signal-only errors
    expect(classifySshExecFailure(undefined, '')).toEqual({
      kind: 'ssh-transport',
      transient: true,
    });
  });

  it('non-255 exit => remote (psql/docker/kubectl) failure, never retried at the ssh layer', () => {
    // psql exits 1/2 on SQL errors; ssh relays the remote status verbatim.
    expect(classifySshExecFailure(1, 'ERROR:  syntax error at or near "SELEC"')).toEqual({
      kind: 'remote',
      transient: false,
    });
    // Even when the remote error TEXT contains transient-looking words
    // (postgres down => "connection refused"), a relayed remote exit is a
    // database-side problem — the check-level polling loops own that retry.
    expect(
      classifySshExecFailure(2, 'psql: error: connection to server failed: Connection refused'),
    ).toEqual({ kind: 'remote', transient: false });
  });
});

describe('extractPgHbaRejectIps', () => {
  it('pulls the quoted host IP out of a pg_hba reject line', () => {
    const log =
      'FATAL:  no pg_hba.conf entry for host "10.0.1.7", user "replicator", database "postgres", no encryption';
    expect(extractPgHbaRejectIps(log)).toEqual(['10.0.1.7']);
  });

  it('dedupes and captures multiple / IPv6 source IPs', () => {
    const log = [
      'no pg_hba.conf entry for host "10.0.1.7", user "r"',
      'no pg_hba.conf entry for host "10.0.1.7", user "r"',
      'no pg_hba.conf entry for host "fd00::1", user "r"',
    ].join('\n');
    expect(extractPgHbaRejectIps(log).sort()).toEqual(['10.0.1.7', 'fd00::1']);
  });

  it('returns [] when there is no pg_hba reject', () => {
    expect(extractPgHbaRejectIps('LOG: replication connection authorized')).toEqual([]);
    expect(extractPgHbaRejectIps('')).toEqual([]);
    expect(extractPgHbaRejectIps(null)).toEqual([]);
  });
});

describe('resolveHaDbIps', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'repl-resolve-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (obj: unknown) =>
    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify(obj), 'utf-8');

  it('prefers the nested ha.primary/ha.standby masterIp block', () => {
    write({
      environments: {
        prod: {
          ha: {
            primary: { masterIp: '1.1.1.1' },
            standby: { masterIp: '2.2.2.2' },
          },
        },
      },
    });
    expect(resolveHaDbIps(dir, 'prod')).toEqual({ primaryIp: '1.1.1.1', standbyIp: '2.2.2.2' });
  });

  it('falls back to servers[] matched by name', () => {
    write({
      environments: {
        prod: {
          region: 'nbg1',
          secondaryRegion: 'hel1',
          servers: [
            { ip: '9.9.9.9', name: 'standby' },
            { ip: '8.8.8.8', name: 'primary' },
          ],
        },
      },
    });
    expect(resolveHaDbIps(dir, 'prod')).toEqual({ primaryIp: '8.8.8.8', standbyIp: '9.9.9.9' });
  });

  it('returns nulls when config is missing or the env is absent', () => {
    expect(resolveHaDbIps(dir, 'prod')).toEqual({ primaryIp: null, standbyIp: null });
    write({ environments: { other: { ha: { primary: { masterIp: 'x' } } } } });
    expect(resolveHaDbIps(dir, 'prod')).toEqual({ primaryIp: null, standbyIp: null });
  });
});
