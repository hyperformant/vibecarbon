/**
 * sweepProjectOrphans runs the stale-stack sweep for exactly its own project,
 * after a complete resource sweep, and never lets it change the verdict.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enumFailed: false,
  counts: {
    servers: 2,
    volumes: 0,
    placementGroups: 0,
    firewalls: 0,
    floatingIps: 0,
    networks: 0,
    s3Buckets: 0,
    sshKeys: 0,
  },
  store: { list: vi.fn(), read: vi.fn(), remove: vi.fn() } as unknown,
  hasStore: true,
  sweepRunStacks: vi.fn(async () => ({ deleted: [], kept: [] })),
  probe: vi.fn(),
}));

vi.mock('../../e2e/utils/sweep-hetzner.js', () => ({
  sweepOrphanedHetznerResources: vi.fn(async () => ({
    counts: { ...h.counts },
    enumFailed: h.enumFailed,
  })),
}));
vi.mock('../../e2e/utils/state-store.js', () => ({
  e2eStateStore: vi.fn(() => (h.hasStore ? h.store : null)),
}));
vi.mock('../../e2e/utils/sweep-run-stacks.js', () => ({ sweepRunStacks: h.sweepRunStacks }));
vi.mock('../../e2e/utils/stack-probes.js', () => ({ probeFor: vi.fn(() => h.probe) }));

const { sweepProjectOrphans } = await import('../../e2e/utils/sweep-provider.js');
const run = () =>
  sweepProjectOrphans({
    tag: '[t]',
    provider: 'hetzner',
    projectName: 'testapp-compose-1700000000000-abc123',
    token: 'tok',
    env: {},
  });

afterEach(() => {
  h.enumFailed = false;
  h.hasStore = true;
  h.sweepRunStacks.mockReset();
  h.sweepRunStacks.mockResolvedValue({ deleted: [], kept: [] });
  vi.restoreAllMocks();
});

describe('sweepProjectOrphans stack sweep', () => {
  it('runs the stack sweep for exactly the project after a complete sweep', async () => {
    await run();
    expect(h.sweepRunStacks).toHaveBeenCalledTimes(1);
    const [tag, owns, store, probe] = h.sweepRunStacks.mock.calls[0] as unknown as [
      string,
      (p: string) => boolean,
      unknown,
      unknown,
    ];
    expect(tag).toBe('[t]');
    expect(store).toBe(h.store);
    expect(probe).toBe(h.probe);
    expect(owns('testapp-compose-1700000000000-abc123')).toBe(true);
    expect(owns('testapp-compose-1700000000000-abc124')).toBe(false);
    expect(owns('testapp-compose-1700000000000-abc123x')).toBe(false);
    expect((h.sweepRunStacks.mock.calls[0] as unknown[])[4]).toBe(
      '.pulumi/stacks/testapp-compose-1700000000000-abc123/',
    );
  });

  it('skips the stack sweep when the resource sweep could not enumerate', async () => {
    h.enumFailed = true;
    const r = await run();
    expect(h.sweepRunStacks).not.toHaveBeenCalled();
    expect(r.enumFailed).toBe(true);
  });

  it('skips the stack sweep when there is no store', async () => {
    h.hasStore = false;
    await run();
    expect(h.sweepRunStacks).not.toHaveBeenCalled();
  });

  it('a stack sweep failure leaves counts and enumFailed unchanged', async () => {
    h.sweepRunStacks.mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await run();
    expect(r.counts).toEqual(h.counts);
    expect(r.enumFailed).toBe(false);
  });
});
