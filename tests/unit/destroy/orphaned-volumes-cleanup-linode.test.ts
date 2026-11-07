import { describe, expect, it, vi } from 'vitest';
import { cleanupOrphanedVolumes } from '../../../src/destroy.js';
import { isCsiVolumeName } from '../../../src/lib/csi-volumes.js';
import { encodeLabel, LinodeProvider } from '../../../src/lib/providers/linode.js';

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
const run = (provider: LinodeProvider) =>
  cleanupOrphanedVolumes(provider, 'proj', 'prod', [], [], [], { report: () => {} });

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

  it('leaves a hand-named volume with the project tag alone', async () => {
    const { provider, deleteVolume } = setup([volume('pvc-backups', 'proj')]);
    await run(provider);
    expect(deleteVolume).not.toHaveBeenCalled();
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
