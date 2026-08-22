/**
 * BUG A — a killed mid-scale run's `-new` servers survived a GREEN destroy.
 *
 * Live receipt (2026-08-10 all-provider orphan audit): a compose-ha run was
 * killed during `scale`, leaving `<project>-e2-primary-new` and
 * `<project>-e2-standby-new` running. `vibecarbon destroy e2 -y -orphans -purge`
 * then reported "No leaked resources: every targeted resource was confirmed
 * deleted ... every provider listing was read in full" — with both servers
 * present in that listing. The teardown looked up exactly the two names the
 * DEPLOY creates; scale's temporary name was in no list it consulted, and in no
 * Pulumi state either (the replacement is created outside Pulumi, and a killed
 * run checkpoints nothing).
 *
 * Two layers are pinned here, because either alone still fails silently:
 *   1. NAME COVERAGE — resolveHaServers looks the `-new` twins up, so they are
 *      deleted WITH the environment on the normal path.
 *   2. BACKSTOP — a label/name sweep after the tier teardown, so anything the
 *      name lookups miss is deleted or reported LEAKED, and an unreadable
 *      listing reports UNVERIFIED instead of silence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { sweepEnvironmentServers } from '../../../src/lib/destroy/server-sweep.js';

const findServersByName = vi.fn();

beforeEach(() => {
  findServersByName.mockReset();
  findServersByName.mockResolvedValue([]);
});

describe('resolveHaServers covers scale’s mid-scale replacement names', () => {
  it('looks up the -new twin of each HA role, not just the permanent pair', async () => {
    const { resolveHaServers } = await import('../../../src/lib/deploy/compose/ha.js');

    await resolveHaServers({
      projectName: 'proj',
      environment: 'e2',
      envConfig: { servers: [] },
      provider: { findServersByName },
    });

    const asked = findServersByName.mock.calls.map(([name]) => name);
    expect(asked).toContain('proj-e2-primary-new');
    expect(asked).toContain('proj-e2-standby-new');
  });

  it('returns the -new servers for deletion even when both permanent nodes are known', async () => {
    findServersByName.mockImplementation(async (name: string) =>
      name === 'proj-e2-primary-new' ? [{ id: 301, name }] : [],
    );
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
      provider: { findServersByName },
    });

    // The killed-mid-scale shape: config still records the OLD pair (scale
    // persists only on success), and the replacement is a third live server.
    expect(result.map((s) => s.id).sort()).toEqual([101, 102, 301]);
  });
});

function stubProvider(items: object[], { complete = true, deleteServer = vi.fn() } = {}) {
  return {
    listServersDetailed: vi.fn().mockResolvedValue({ items, complete }),
    deleteServer,
    serverLabels: (s: { labels?: Record<string, string> }) => s.labels ?? {},
    serverRegion: (s: { region?: string }) => s.region ?? null,
  };
}

const ENV = {
  projectName: 'proj',
  environment: 'e2',
  deployMode: 'compose-ha',
  providerName: 'Hetzner',
};

describe('destroy backstop sweep for environment-owned servers', () => {
  it('deletes a surviving -new server the name lookups missed', async () => {
    const deleteServer = vi.fn().mockResolvedValue(true);
    const provider = stubProvider(
      [
        {
          id: 301,
          name: 'proj-e2-primary-new',
          labels: { 'managed-by': 'vibecarbon', project: 'proj', environment: 'e2' },
        },
      ],
      { deleteServer },
    );
    const leaks = createLeakLedger();

    const result = await sweepEnvironmentServers({ provider, leaks, ...ENV });

    expect(deleteServer).toHaveBeenCalledWith(301, { waitUntilGone: true });
    expect(result.deleted).toEqual(['proj-e2-primary-new']);
    expect(leaks.isClean()).toBe(true);
  });

  it('matches by NAME when the provider row carries no labels', async () => {
    const deleteServer = vi.fn().mockResolvedValue(true);
    const provider = stubProvider([{ id: 302, name: 'proj-e2-standby-new' }], { deleteServer });
    const leaks = createLeakLedger();

    await sweepEnvironmentServers({ provider, leaks, ...ENV });

    expect(deleteServer).toHaveBeenCalledWith(302, { waitUntilGone: true });
  });

  it('matches compose-ha’s per-stack environment label, not just the plain env', async () => {
    // Pulumi labels compose-ha nodes with the STACK env (`e2-primary`); scale's
    // replacement is labelled with the plain env. Both are this environment's.
    const deleteServer = vi.fn().mockResolvedValue(true);
    const provider = stubProvider(
      [
        {
          id: 303,
          name: 'renamed-by-hand',
          labels: { 'managed-by': 'vibecarbon', project: 'proj', environment: 'e2-standby' },
        },
      ],
      { deleteServer },
    );

    await sweepEnvironmentServers({ provider, leaks: createLeakLedger(), ...ENV });

    expect(deleteServer).toHaveBeenCalledWith(303, { waitUntilGone: true });
  });

  it('records a LEAK when the delete fails — never a silent pass', async () => {
    const deleteServer = vi.fn().mockRejectedValue(new Error('locked'));
    const provider = stubProvider([{ id: 304, name: 'proj-e2-new', region: 'nbg1' }], {
      deleteServer,
    });
    const leaks = createLeakLedger();

    await sweepEnvironmentServers({ provider, leaks, ...ENV });

    expect(leaks.counts().leak).toBe(1);
    expect(leaks.entries[0].resource).toContain('proj-e2-new');
    expect(leaks.exitCode()).toBe(2);
  });

  it('records UNVERIFIED when the listing came back incomplete', async () => {
    const provider = stubProvider([], { complete: false });
    const leaks = createLeakLedger();

    await sweepEnvironmentServers({ provider, leaks, ...ENV });

    expect(leaks.counts().unverified).toBe(1);
    expect(leaks.exitCode()).toBe(2);
  });

  it('records UNVERIFIED when the listing throws', async () => {
    const provider = {
      listServersDetailed: vi.fn().mockRejectedValue(new Error('429 rate limited')),
      deleteServer: vi.fn(),
      serverLabels: () => ({}),
      serverRegion: () => null,
    };
    const leaks = createLeakLedger();

    await sweepEnvironmentServers({ provider, leaks, ...ENV });

    expect(leaks.counts().unverified).toBe(1);
  });

  it('leaves another environment’s and another project’s servers alone', async () => {
    const deleteServer = vi.fn();
    const provider = stubProvider(
      [
        {
          id: 401,
          name: 'proj-e3-primary-new',
          labels: { 'managed-by': 'vibecarbon', project: 'proj', environment: 'e3' },
        },
        {
          id: 402,
          name: 'other-e2-primary-new',
          labels: { 'managed-by': 'vibecarbon', project: 'other', environment: 'e2' },
        },
      ],
      { deleteServer },
    );
    const leaks = createLeakLedger();

    const result = await sweepEnvironmentServers({ provider, leaks, ...ENV });

    expect(deleteServer).not.toHaveBeenCalled();
    expect(result.deleted).toEqual([]);
    expect(leaks.isClean()).toBe(true);
  });

  it('skips servers this destroy already deleted (no double-delete, no false leak)', async () => {
    const deleteServer = vi.fn().mockResolvedValue(true);
    const provider = stubProvider([{ id: 101, name: 'proj-e2-primary' }], { deleteServer });

    const result = await sweepEnvironmentServers({
      provider,
      leaks: createLeakLedger(),
      ...ENV,
      alreadyHandledIds: [101],
    });

    expect(deleteServer).not.toHaveBeenCalled();
    expect(result.deleted).toEqual([]);
  });
});
