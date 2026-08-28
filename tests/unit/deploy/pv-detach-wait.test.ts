/**
 * DO-CSI stale-VolumeAttachment class (d4 run 6, 2026-08-28).
 *
 * Live evidence, both directions: k8s VolumeAttachments said `attached:
 * true` while DigitalOcean's API showed the volumes attached to NO droplet
 * (`droplet_ids: []`); NodeStage probed the missing device as unformatted
 * and ran `mkfs.ext4` against a path that does not exist, forever. A pod
 * bounce did NOT heal it (the fresh attach reused the stale record);
 * deleting the VolumeAttachment forced a real ControllerPublishVolume and
 * the pod went Ready in 150s. Trigger: the reseed's four attach/detach
 * transitions on one volume in ~2 minutes.
 *
 * Three pieces under test: the detach-settle wait (prevention at both churn
 * points), the PV-name resolver, and the one-shot stale-attachment repair.
 * All fail OPEN — a reseed must never die on a diagnostic read.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  deleteStaleDbVolumeAttachments,
  listDbPvNames,
  STALE_ATTACH_EVENT_PATTERN,
  waitForPvDetach,
} from '../../../src/lib/deploy/replication.js';

const PVC_LIST = JSON.stringify({
  items: [
    {
      metadata: { name: 'data-supabase-supabase-db-0' },
      spec: { volumeName: 'pvc-data-111' },
    },
    {
      metadata: { name: 'pgsodium-supabase-supabase-db-0' },
      spec: { volumeName: 'pvc-sodium-222' },
    },
    { metadata: { name: 'storage-something-else' }, spec: { volumeName: 'pvc-other-333' } },
  ],
});

const VA_LIST = (pvs: string[]) =>
  JSON.stringify({
    items: pvs.map((pv, i) => ({
      metadata: { name: `csi-att-${i}` },
      spec: { source: { persistentVolumeName: pv } },
    })),
  });

describe('listDbPvNames', () => {
  it('returns only the db StatefulSet claims’ PVs', async () => {
    const kubectl = vi.fn(async () => PVC_LIST);
    await expect(listDbPvNames(kubectl)).resolves.toEqual(['pvc-data-111', 'pvc-sodium-222']);
  });

  it('fails open on unreadable output', async () => {
    await expect(listDbPvNames(vi.fn(async () => ''))).resolves.toEqual([]);
    await expect(
      listDbPvNames(
        vi.fn(async () => {
          throw new Error('ssh died');
        }),
      ),
    ).resolves.toEqual([]);
  });
});

describe('waitForPvDetach', () => {
  it('polls until no attachment references the PVs', async () => {
    let polls = 0;
    const kubectl = vi.fn(async () => {
      polls += 1;
      return polls < 3 ? VA_LIST(['pvc-data-111']) : VA_LIST([]);
    });
    const res = await waitForPvDetach(kubectl, {
      pvNames: ['pvc-data-111'],
      sleep: async () => {},
    });
    expect(res).toEqual({ detached: true });
    expect(polls).toBe(3);
  });

  it('ignores attachments for OTHER PVs (a live app tier keeps its volumes)', async () => {
    const kubectl = vi.fn(async () => VA_LIST(['pvc-other-333']));
    await expect(
      waitForPvDetach(kubectl, { pvNames: ['pvc-data-111'], sleep: async () => {} }),
    ).resolves.toEqual({ detached: true });
    expect(kubectl).toHaveBeenCalledTimes(1);
  });

  it('resolves {detached:false} with a log line on budget lapse — never throws', async () => {
    const logs: string[] = [];
    const kubectl = vi.fn(async () => VA_LIST(['pvc-data-111']));
    const res = await waitForPvDetach(kubectl, {
      pvNames: ['pvc-data-111'],
      budgetMs: 1,
      sleep: async () => {},
      log: (m) => logs.push(m),
    });
    expect(res).toEqual({ detached: false });
    expect(logs.join('\n')).toContain('did not clear');
  });

  it('no PVs = nothing to wait for (local-path clusters)', async () => {
    const kubectl = vi.fn();
    await expect(waitForPvDetach(kubectl, { pvNames: [] })).resolves.toEqual({ detached: true });
    expect(kubectl).not.toHaveBeenCalled();
  });
});

describe('deleteStaleDbVolumeAttachments', () => {
  it('deletes exactly the attachments referencing db PVs and reports them', async () => {
    const deleted: string[] = [];
    const kubectl = vi.fn(async (argv: string[]) => {
      if (argv.includes('pvc')) return PVC_LIST;
      if (argv.includes('volumeattachment') && argv.includes('get'))
        return VA_LIST(['pvc-data-111', 'pvc-other-333', 'pvc-sodium-222']);
      if (argv.includes('delete')) {
        deleted.push(argv[2]);
        return '';
      }
      return '';
    });
    const res = await deleteStaleDbVolumeAttachments(kubectl, { log: () => {} });
    expect(res).toHaveLength(2);
    // csi-att-1 references pvc-other-333 — a foreign volume, never touched.
    expect(deleted).toEqual(['csi-att-0', 'csi-att-2']);
  });

  it('fails open when listings are unreadable', async () => {
    await expect(deleteStaleDbVolumeAttachments(vi.fn(async () => ''))).resolves.toEqual([]);
  });
});

describe('STALE_ATTACH_EVENT_PATTERN', () => {
  it('matches the live kubelet event verbatim', () => {
    const live =
      'MountVolume.MountDevice failed for volume "pvc-d37e3ce6" : rpc error: code = Internal ' +
      "desc = formatting disk failed: exit status 1 cmd: 'mkfs.ext4 -F /dev/disk/by-id/..." +
      '\' output: "mke2fs 1.46.6\\nThe file /dev/disk/by-id/scsi-0DO_Volume_pvc-d37e3ce6 ' +
      'does not exist and no size was specified.\\n"';
    expect(STALE_ATTACH_EVENT_PATTERN.test(live)).toBe(true);
  });

  it('does not match ordinary mount noise', () => {
    expect(STALE_ATTACH_EVENT_PATTERN.test('Unable to attach or mount volumes: timed out')).toBe(
      false,
    );
  });
});
