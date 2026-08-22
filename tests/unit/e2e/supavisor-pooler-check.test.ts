import { describe, expect, it, vi } from 'vitest';
import {
  buildPoolerProbeCommand,
  parsePoolerProbeOutput,
  runSupavisorPoolerChecks,
} from '../../e2e/checks/supavisor-pooler.js';

/**
 * The audit's one confirmed coverage gap: the pooler shipped "configured but
 * not yet covered by an automated end-to-end test" — and in fact could not
 * work at all (no migrate, no tenant, firewall closed). This check is the
 * live proof: tenant routing through both pooler ports from inside the rig,
 * plus a raw external dial proving the operator-scoped firewall path.
 */

const PASS_OUTPUT = ['SESSION_OUT=1', 'TRANSACTION_OUT=1'].join('\n');

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    domain: 'e1.example.dev',
    masterIp: '203.0.113.5',
    sshKeyPath: '/tmp/key',
    projectName: 'testapp-e1',
    postgresPassword: 'pw123',
    phase: 'verify-deploy',
    execRemote: vi.fn().mockReturnValue(PASS_OUTPUT),
    dialTcp: vi.fn().mockResolvedValue('S'),
    ...overrides,
  };
}

describe('buildPoolerProbeCommand', () => {
  it('probe body contains no single quotes (the bash -c wrapper owns them)', () => {
    // Same invariant as backup-evidence's probe: the remote body is wrapped
    // in single quotes, so a single quote INSIDE it would truncate the probe.
    const cmd = buildPoolerProbeCommand('testapp-e1', 'pw123');
    const body = cmd.match(/bash -c '(.*)'$/s)?.[1];
    expect(body, "probe must be wrapped as bash -c '...'").toBeDefined();
    expect(body).not.toContain("'");
  });

  it('dials both pooler ports with the tenant username', () => {
    const cmd = buildPoolerProbeCommand('testapp-e1', 'pw123');
    expect(cmd).toContain('postgres.testapp-e1');
    expect(cmd).toContain('supavisor:5432');
    expect(cmd).toContain('supavisor:6543');
  });
});

describe('parsePoolerProbeOutput', () => {
  it('reads both results', () => {
    expect(parsePoolerProbeOutput(PASS_OUTPUT)).toEqual({ session: '1', transaction: '1' });
  });

  it('captures error text for triage', () => {
    const out = ['SESSION_OUT=FATAL: Tenant or user not found', 'TRANSACTION_OUT=1'].join('\n');
    expect(parsePoolerProbeOutput(out).session).toContain('Tenant or user not found');
  });
});

describe('runSupavisorPoolerChecks', () => {
  it('passes all four checks on a healthy pooler', async () => {
    const results = await runSupavisorPoolerChecks(baseOpts() as never);
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.status === 'pass')).toBe(true);
    const names = results.map((r) => r.checkName);
    expect(names).toContain('supavisor_session_tenant_routing');
    expect(names).toContain('supavisor_transaction_tenant_routing');
    expect(names).toContain('supavisor_external_reachability_5432');
    expect(names).toContain('supavisor_external_reachability_6543');
  });

  it('fails tenant routing with the pooler error surfaced', async () => {
    const opts = baseOpts({
      execRemote: vi
        .fn()
        .mockReturnValue(
          ['SESSION_OUT=FATAL: Tenant or user not found', 'TRANSACTION_OUT=1'].join('\n'),
        ),
    });
    const results = await runSupavisorPoolerChecks(opts as never);
    const session = results.find((r) => r.checkName === 'supavisor_session_tenant_routing');
    expect(session?.status).toBe('fail');
    expect(session?.errorMessage).toContain('Tenant or user not found');
  });

  it('fails external reachability with an actionable firewall message', async () => {
    const opts = baseOpts({
      dialTcp: vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT')),
    });
    const results = await runSupavisorPoolerChecks(opts as never);
    const ext = results.find((r) => r.checkName === 'supavisor_external_reachability_5432');
    expect(ext?.status).toBe('fail');
    expect(ext?.errorMessage).toMatch(/firewall|ETIMEDOUT/i);
  });

  it("counts an 'N' SSLRequest answer as reachable (server answered)", async () => {
    const opts = baseOpts({ dialTcp: vi.fn().mockResolvedValue('N') });
    const results = await runSupavisorPoolerChecks(opts as never);
    const ext = results.filter((r) => r.checkName.startsWith('supavisor_external_reachability'));
    expect(ext.every((r) => r.status === 'pass')).toBe(true);
  });

  it('fails the on-host checks (not throws) when ssh itself dies', async () => {
    const opts = baseOpts({
      execRemote: vi.fn(() => {
        throw new Error('ssh: connect to host timed out');
      }),
    });
    const results = await runSupavisorPoolerChecks(opts as never);
    const session = results.find((r) => r.checkName === 'supavisor_session_tenant_routing');
    expect(session?.status).toBe('fail');
    expect(session?.errorMessage).toContain('timed out');
  });
});
