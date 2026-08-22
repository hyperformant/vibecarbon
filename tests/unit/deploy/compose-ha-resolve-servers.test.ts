/**
 * Regression coverage for the orphan-leak bug surfaced by the 2026-05-16
 * e2e matrix: when compose-ha deploy got canceled at "Waiting for
 * primary services to initialize", envConfig.servers was never written
 * back, so destroyComposeHA's `serversToDelete = envConfig.servers ?? []`
 * was empty and 2 Hetzner VMs leaked. The runner's sweep had to mop up.
 *
 * `resolveHaServers` is the helper that turns the canceled-deploy case
 * back into a clean cleanup by falling back to name-based discovery.
 * Since B0-3 it discovers through `provider.findServersByName` instead of
 * a raw Hetzner fetch — the wire shape is pinned in
 * tests/unit/providers/hetzner-destroy-primitives.test.ts; here the
 * provider is a stub.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findServersByName = vi.fn();
const provider = { findServersByName };

beforeEach(() => {
  findServersByName.mockReset();
});

describe('resolveHaServers', () => {
  it('uses envConfig.servers when both primary and standby are present', async () => {
    const { resolveHaServers } = await import('../../../src/lib/deploy/compose/ha.js');

    const result = await resolveHaServers({
      projectName: 'proj',
      environment: 'e2',
      envConfig: {
        servers: [
          { id: 101, ip: '1.1.1.1', providerServerName: 'proj-e2-primary' },
          { id: 102, ip: '2.2.2.2', providerServerName: 'proj-e2-standby' },
        ],
      },
      provider,
    });

    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id).sort()).toEqual([101, 102]);
    // Neither PERMANENT name needs a lookup — both matched in envConfig. The
    // `-new` twins are still probed (see the scale-replacement leak test):
    // mid-scale, a known permanent server and its live replacement coexist.
    const asked = findServersByName.mock.calls.map(([name]) => name);
    expect(asked).not.toContain('proj-e2-primary');
    expect(asked).not.toContain('proj-e2-standby');
  });

  it('discovers servers by name when envConfig.servers is empty (canceled-deploy case)', async () => {
    findServersByName.mockImplementation(async (name: string) => {
      if (name === 'proj-e2-primary') return [{ id: 201, name }];
      if (name === 'proj-e2-standby') return [{ id: 202, name }];
      return [];
    });

    const { resolveHaServers } = await import('../../../src/lib/deploy/compose/ha.js');

    const result = await resolveHaServers({
      projectName: 'proj',
      environment: 'e2',
      envConfig: { servers: [] },
      provider,
    });

    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id).sort()).toEqual([201, 202]);
    const asked = findServersByName.mock.calls.map(([name]) => name);
    expect(asked).toContain('proj-e2-primary');
    expect(asked).toContain('proj-e2-standby');
    // C10c: discovery-path entries persist the resolved name under the
    // renamed `providerServerName` key.
    expect(result.map((s) => s.providerServerName).sort()).toEqual([
      'proj-e2-primary',
      'proj-e2-standby',
    ]);
  });

  it('discovers only the missing half when envConfig has primary but not standby', async () => {
    findServersByName.mockImplementation(async (name: string) =>
      name === 'proj-e2-standby' ? [{ id: 202, name }] : [],
    );

    const { resolveHaServers } = await import('../../../src/lib/deploy/compose/ha.js');

    const result = await resolveHaServers({
      projectName: 'proj',
      environment: 'e2',
      envConfig: {
        servers: [{ id: 101, ip: '1.1.1.1', providerServerName: 'proj-e2-primary' }],
      },
      provider,
    });

    expect(result.map((s) => s.id).sort()).toEqual([101, 202]);
    const asked = findServersByName.mock.calls.map(([name]) => name);
    expect(asked).toContain('proj-e2-standby');
    expect(asked).not.toContain('proj-e2-primary');
  });

  it('returns empty when no provider and envConfig is empty (cannot discover)', async () => {
    const { resolveHaServers } = await import('../../../src/lib/deploy/compose/ha.js');

    const result = await resolveHaServers({
      projectName: 'proj',
      environment: 'e2',
      envConfig: { servers: [] },
      provider: null,
    });

    expect(result).toEqual([]);
    expect(findServersByName).not.toHaveBeenCalled();
  });

  it('swallows discovery errors and returns whatever envConfig had', async () => {
    findServersByName.mockRejectedValue(new Error('hetzner is grumpy'));

    const { resolveHaServers } = await import('../../../src/lib/deploy/compose/ha.js');

    const result = await resolveHaServers({
      projectName: 'proj',
      environment: 'e2',
      envConfig: {
        servers: [{ id: 101, ip: '1.1.1.1', providerServerName: 'proj-e2-primary' }],
      },
      provider,
    });

    expect(result.map((s) => s.id)).toEqual([101]);
  });
});
