/**
 * The persisted standby entry records the STANDBY's own server type.
 *
 * Two bugs live at this seam, and the second was caused by fixing the first:
 *
 * 1. compose-HA persisted the PRIMARY's serverType on both server entries.
 *    scale and failover read that back, so a later resize aimed at a type the
 *    standby's region may not stock.
 * 2. The fix referenced `standbyServerType` as a bare identifier here, but
 *    this is a DIFFERENT effect function from the one that computes it —
 *    `standbyServerType is not defined` killed a live CI deploy at
 *    persist-pending-config (l2, 2026-08-20), AFTER both servers were already
 *    provisioned and paid for.
 *
 * The provisioning test's harness stops before this effect runs (it throws
 * from generateSSHKeyPair), so it could not have caught (2). This one drives
 * haPersistPendingConfig directly.
 */
import { describe, expect, it, vi } from 'vitest';

const saved = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    loadProjectConfig: () => ({ projectName: 'testapp', environments: {} }),
    saveProjectConfig: (cfg: Record<string, unknown>) => {
      saved.last = cfg;
    },
    registerProject: () => {},
  };
});

const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');

function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    projectConfig: { projectName: 'testapp' },
    environment: 'production',
    envConfig: { provider: 'linode' },
    region: 'us-iad',
    standbyRegion: 'us-ord',
    serverType: 'g6-standard-4',
    standbyServerType: 'g6-standard-2',
    primary: { serverId: '1', ip: '10.0.0.1' },
    standby: { serverId: '2', ip: '10.0.0.2' },
    domain: 'example.com',
    dnsProvider: 'linode',
    services: {},
    ...overrides,
  } as Record<string, unknown>;
}

const serversOf = (ctx: Record<string, unknown>) =>
  (ctx.pendingEnvConfig as { servers: { role: string; serverType: string }[] }).servers;

describe('haPersistPendingConfig — standby server type', () => {
  it('runs at all (the bare-identifier ReferenceError regression)', async () => {
    // This is the whole point: the previous version threw
    // `standbyServerType is not defined` before writing anything.
    const ctx = baseCtx();
    await expect(COMPOSE_HA_EFFECTS.haPersistPendingConfig(ctx)).resolves.not.toThrow();
  });

  it("records each node its OWN type, not the primary's for both", async () => {
    const ctx = baseCtx();
    await COMPOSE_HA_EFFECTS.haPersistPendingConfig(ctx);
    const servers = serversOf(ctx);
    expect(servers.find((s) => s.role === 'primary')?.serverType).toBe('g6-standard-4');
    expect(servers.find((s) => s.role === 'standby')?.serverType).toBe('g6-standard-2');
  });

  it("keeps the env-level serverType as the PRIMARY's", async () => {
    // The env-level field is the deploy's requested type; only the per-server
    // entry carries the standby's substitution.
    const ctx = baseCtx();
    await COMPOSE_HA_EFFECTS.haPersistPendingConfig(ctx);
    expect((ctx.pendingEnvConfig as { serverType: string }).serverType).toBe('g6-standard-4');
  });
});
