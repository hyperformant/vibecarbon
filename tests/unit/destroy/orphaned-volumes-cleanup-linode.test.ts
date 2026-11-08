import { describe, expect, it, vi } from 'vitest';
import { cleanupOrphanedVolumes } from '../../../src/destroy.js';
import { isCsiVolumeName, parseCsiPersistentVolumes } from '../../../src/lib/csi-volumes.js';
import { encodeLabel, LinodeProvider } from '../../../src/lib/providers/linode.js';
import { linodePv } from '../../_shared/linode-csi-pv.js';

/**
 * A detached Linode CSI volume is labelled `pvc-<16 hex>` and carries the
 * project tag the master's StorageClass stamps. cleanupOrphanedVolumes must
 * read that label through provider.volumeName, and match on the project tag.
 */
const volume = (label: string, project: string, over: Record<string, unknown> = {}) => ({
  id: 4242,
  label,
  region: 'us-iad',
  linode_id: null,
  tags: [encodeLabel('project', project)],
  created: '2026-11-07T10:00:00',
  ...over,
});

function setup(volumes: Array<ReturnType<typeof volume>>) {
  const provider = new LinodeProvider('token');
  vi.spyOn(provider, 'listVolumesDetailed').mockResolvedValue({ items: volumes, complete: true });
  const deleteVolume = vi.spyOn(provider, 'deleteVolume').mockResolvedValue(true);
  return { provider, deleteVolume };
}
// A real destroy passes the cluster's regions, which arms the region heuristic.
const run = (provider: LinodeProvider) =>
  cleanupOrphanedVolumes(provider, 'proj', 'prod', [], [], ['us-iad'], { report: () => {} });

describe('cleanupOrphanedVolumes on Linode', () => {
  it('deletes a detached pvc volume carrying the project tag', async () => {
    const { provider, deleteVolume } = setup([volume('pvc-0123456789abcdef', 'proj')]);
    const { deleted } = await run(provider);
    expect(deleteVolume).toHaveBeenCalledWith(4242);
    expect(deleted).toEqual(['pvc-0123456789abcdef']);
  });

  it("never deletes a pvc volume carrying another project's tag", async () => {
    const { provider, deleteVolume } = setup([volume('pvc-0123456789abcdef', 'other')]);
    const { deleted } = await run(provider);
    expect(deleteVolume).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it("in the cluster region, deletes only this project's volume of two detached pvc volumes", async () => {
    const { provider, deleteVolume } = setup([
      volume('pvc-0123456789abcdef', 'other', { id: 1 }),
      volume('pvc-fedcba9876543210', 'proj', { id: 2 }),
    ]);
    const { deleted } = await run(provider);
    expect(deleteVolume).toHaveBeenCalledExactlyOnceWith(2);
    expect(deleted).toEqual(['pvc-fedcba9876543210']);
  });

  it('leaves a hand-named volume with the project tag alone', async () => {
    const { provider, deleteVolume } = setup([volume('pvc-backups', 'proj')]);
    await run(provider);
    expect(deleteVolume).not.toHaveBeenCalled();
  });
});

// Live 2026-11-08: destroy captured the cluster's PersistentVolumes in full,
// matched none of its 3 volumes, and deferred every one as "not ours" (6 left
// behind across two clusters). The capture took Linode's volume key,
// `<volume id>-<label>`, for the id.
describe('cleanupOrphanedVolumes on Linode, with the PersistentVolumes captured', () => {
  it('deletes the volume behind a captured PersistentVolume', async () => {
    const pvName = 'pvc-3f78299e-01d6-487f-9a1b-2c3d4e5f6071';
    const { volumes: pvs } = parseCsiPersistentVolumes({
      items: [linodePv(pvName, '18990608-pvc-3f78299e01d6487f')],
    });
    const { provider, deleteVolume } = setup([
      volume('pvc-3f78299e01d6487f', 'proj', { id: 18990608 }),
    ]);
    const { deleted, deferred } = await cleanupOrphanedVolumes(
      provider,
      'proj',
      'prod',
      [],
      pvs.map((v) => v.volumeId),
      ['us-iad'],
      { identityComplete: true, report: () => {} },
    );
    expect(deferred).toEqual([]);
    expect(deleteVolume).toHaveBeenCalledWith(18990608);
    expect(deleted).toEqual(['pvc-3f78299e01d6487f']);
  });
});

describe('isCsiVolumeName', () => {
  it('accepts the Linode 16-hex label and the UUID form, nothing looser', () => {
    expect(isCsiVolumeName('pvc-0123456789abcdef')).toBe(true);
    expect(isCsiVolumeName('pvc-1c3f8b2a-4d5e-4f60-9a1b-2c3d4e5f6071')).toBe(true);
    expect(isCsiVolumeName('pvc-0123456789abcdef0')).toBe(false);
    expect(isCsiVolumeName('pvc-0123456789abcdeg')).toBe(false);
  });
});
