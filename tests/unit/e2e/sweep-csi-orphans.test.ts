import { describe, expect, it, vi } from 'vitest';
import {
  isCsiVolumeName,
  selectCsiOrphanVolumes,
  sweepCsiOrphanVolumes,
} from '../../../scripts/sweep-hetzner.js';

/**
 * CSI-orphan volume pass. The Hetzner CSI driver names volumes `pvc-<uuid>`
 * and applies neither the managed-by label nor the scratch name prefix, so
 * the labeled/prefixed sweep is blind to them — 21 accumulated (billing)
 * before 2026-07-22. Safety rule: pvc-* volumes are only deleted when the
 * project has ZERO servers (no cluster can own them); with any server
 * present the pass defers entirely, loudly.
 */

const uuid = 'e5a3c1f0-1234-4abc-9def-0123456789ab';
const vol = (over: object) => ({ id: 1, name: `pvc-${uuid}`, server: null, size: 10, ...over });

describe('isCsiVolumeName', () => {
  it.each([
    [`pvc-${uuid}`, true],
    ['pvc-not-a-uuid', false],
    [`testapp-x-${uuid}`, false],
    ['db-volume', false],
    ['', false],
  ])('%s → %s', (name, ok) => {
    expect(isCsiVolumeName(name)).toBe(ok);
  });
});

describe('selectCsiOrphanVolumes', () => {
  it('with zero servers: selects unattached pvc-* volumes only', () => {
    const volumes = [
      vol({ id: 1 }),
      vol({ id: 2, server: 42 }), // attached — never
      vol({ id: 3, name: 'db-volume' }), // not CSI — never
    ];
    const { orphans, deferred } = selectCsiOrphanVolumes(volumes, 0);
    expect(orphans.map((v: { id: number }) => v.id)).toEqual([1]);
    expect(deferred).toBe(0);
  });

  it('with servers present: defers everything, reports the count', () => {
    const volumes = [vol({ id: 1 }), vol({ id: 2 })];
    const { orphans, deferred } = selectCsiOrphanVolumes(volumes, 3);
    expect(orphans).toEqual([]);
    expect(deferred).toBe(2);
  });
});

describe('sweepCsiOrphanVolumes', () => {
  it('deletes selected orphans through the injected deleter and reports count', async () => {
    const doDelete = vi.fn().mockResolvedValue(true);
    const touched = await sweepCsiOrphanVolumes({
      listVolumes: async () => [vol({ id: 7 }), vol({ id: 8, server: 9 })],
      countServers: async () => 0,
      doDelete,
    });
    expect(touched).toBe(1);
    expect(doDelete).toHaveBeenCalledWith('volumes', 7);
  });

  it('is a loud no-op when servers exist', async () => {
    const doDelete = vi.fn();
    const warn = vi.spyOn(console, 'log').mockImplementation(() => {});
    const touched = await sweepCsiOrphanVolumes({
      listVolumes: async () => [vol({ id: 7 })],
      countServers: async () => 2,
      doDelete,
    });
    expect(touched).toBe(0);
    expect(doDelete).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join('\n')).toContain('deferring');
    warn.mockRestore();
  });
});
