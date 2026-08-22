import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The CSI-volume destroy leak, layers 1 and 2, against Hetzner wire shapes —
 * the provider all three occurrences happened on (2026-07-29 six nbg1 volumes
 * after a GREEN k8s run; 2026-07-31 three after an e3 destroy whose `pulumi
 * destroy` 403'd; 2026-08-05 five across hel1+nbg1 after a k8s-ha destroy that
 * printed "No orphaned servers found / No orphaned volumes found").
 *
 * Layer 1 is identity: volume ids captured from the cluster's own
 * PersistentVolumes. Layer 2 is the `pvc-*`-in-our-region heuristic, which is
 * GATED, because a detached `pvc-*` volume in the right region can equally
 * belong to a live parallel cluster — that is not hypothetical, it is RCA
 * 2026-07-18, where a concurrent CI sweep deleted another live rig's volumes
 * while they were detached mid-reseed.
 */

const fetchWithRetryMock = vi.fn();

vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import { cleanupOrphanedVolumes, configuredClusterRegions } from '../../../src/destroy.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

const provider = new HetznerProvider('test-hcloud-token');

const PVC_A = 'pvc-1c3f8b2a-4d5e-4f60-9a1b-2c3d4e5f6071';
const PVC_B = 'pvc-2d4e9c3b-5e6f-4071-8b2c-3d4e5f607182';

type HetznerVolume = {
  id: number;
  name: string;
  server: number | null;
  location: { name: string };
  labels?: Record<string, string>;
  created?: string;
};

const volume = (over: Partial<HetznerVolume> & { id: number; name: string }): HetznerVolume => ({
  server: null,
  location: { name: 'nbg1' },
  labels: {},
  created: '2026-08-05T09:00:00+00:00',
  ...over,
});

function jsonResp(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Serve one Hetzner volume page per GET (last listing repeats); record DELETEs. */
function installRouter(listings: HetznerVolume[][], { listStatus = 200 } = {}) {
  const deletedIds: string[] = [];
  let call = 0;
  fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/v1/volumes') && method === 'DELETE') {
      deletedIds.push(url.split('/v1/volumes/')[1]);
      return jsonResp({}, 200);
    }
    if (url.includes('/v1/volumes') && method === 'GET') {
      if (listStatus !== 200) return jsonResp({}, listStatus);
      const volumes = listings[Math.min(call, listings.length - 1)];
      call += 1;
      return jsonResp({ volumes, meta: { pagination: { next_page: null } } });
    }
    throw new Error(`unexpected fetchWithRetry: ${method} ${url}`);
  });
  return deletedIds;
}

const collectReport = () => {
  const lines: string[] = [];
  return { lines, report: (line: string) => lines.push(line) };
};

beforeEach(() => {
  fetchWithRetryMock.mockReset();
});

describe('layer 1 — identity captured from PersistentVolumes', () => {
  // The single highest-risk detail of the whole fix. hcloud CSI's
  // `spec.csi.volumeHandle` is `strconv.FormatInt(volume.ID, 10)` — a STRING —
  // while the Cloud API lists `volume.id` as a NUMBER. A Set built from the
  // captured handles would match nothing at all, silently, and every captured
  // volume would leak exactly as before.
  it('matches a string volumeHandle from a PV against the numeric id from the API', async () => {
    const deletedIds = installRouter([[volume({ id: 100604631, name: PVC_A })]]);
    const { report, lines } = collectReport();

    const { deleted } = await cleanupOrphanedVolumes(
      provider,
      'testapp',
      'prod',
      [],
      /* knownVolumeIds (as captured from spec.csi.volumeHandle) */ ['100604631'],
      /* clusterLocations */ [],
      { report },
    );

    expect(deleted).toEqual([PVC_A]);
    expect(deletedIds).toEqual(['100604631']);
    expect(lines.join('\n')).toContain('DELETED');
    expect(lines.join('\n')).toContain('captured-id');
  });

  it('deletes a captured volume in a region no surviving server occupies', async () => {
    // The pilot-light / scale-from-zero case: the volume was DETACHED long
    // before destroy ran, so the server pre-scan never saw it and its region
    // never made it into clusterLocations. Only the PV capture knows.
    installRouter([[volume({ id: 55, name: PVC_A, location: { name: 'hel1' } })]]);

    const { deleted } = await cleanupOrphanedVolumes(provider, 'testapp', 'prod', [], ['55'], [], {
      report: () => {},
    });

    expect(deleted).toEqual([PVC_A]);
  });

  it('reports every deleted volume loudly, one line each, with id and region', async () => {
    installRouter([
      [
        volume({ id: 1, name: PVC_A, location: { name: 'nbg1' } }),
        volume({ id: 2, name: PVC_B, location: { name: 'hel1' } }),
      ],
    ]);
    const { report, lines } = collectReport();

    await cleanupOrphanedVolumes(provider, 'testapp', 'prod', [], ['1', '2'], [], { report });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(PVC_A);
    expect(lines[0]).toContain('id 1');
    expect(lines[0]).toContain('nbg1');
    expect(lines[1]).toContain('hel1');
  });
});

describe('layer 2 — the pvc-* heuristic and its gates', () => {
  it('reaps an unattached pvc-* volume in a cluster region when identity capture was UNAVAILABLE', async () => {
    // The degraded path the three occurrences actually needed: cluster already
    // dead, nothing captured, but we know which regions the cluster occupied.
    const deletedIds = installRouter([
      [volume({ id: 9, name: PVC_A, location: { name: 'nbg1' } })],
    ]);

    const { deleted, deferred } = await cleanupOrphanedVolumes(
      provider,
      'testapp',
      'prod',
      [],
      [],
      ['nbg1'],
      { identityComplete: false, foreignRegions: [], report: () => {} },
    );

    expect(deleted).toEqual([PVC_A]);
    expect(deletedIds).toEqual(['9']);
    expect(deferred).toEqual([]);
  });

  it('DEFERS the same volume when identity capture succeeded and did not list it', async () => {
    // A complete capture IS the answer. Anything else in our region belongs to
    // somebody else — most likely a parallel rig — so deleting it on a name
    // pattern is a data-loss bug, not a cleanup.
    const deletedIds = installRouter([
      [volume({ id: 9, name: PVC_A, location: { name: 'nbg1' } })],
    ]);
    const { report, lines } = collectReport();

    const { deleted, deferred } = await cleanupOrphanedVolumes(
      provider,
      'testapp',
      'prod',
      [],
      /* captured ids, none of which is volume 9 */ ['77'],
      ['nbg1'],
      { identityComplete: true, report },
    );

    expect(deleted).toEqual([]);
    expect(deletedIds).toEqual([]);
    expect(deferred).toEqual([
      {
        id: 9,
        name: PVC_A,
        region: 'nbg1',
        createdAt: '2026-08-05T09:00:00+00:00',
        match: 'pvc-in-cluster-region',
        blocked: expect.stringContaining('PersistentVolume list'),
        // The discriminator destroy's leak report keys off: a complete capture
        // that does not list this volume PROVES it is not ours, so it is
        // reported as `foreign` and must NOT fail our exit code.
        blockedBy: 'identity-complete',
      },
    ]);
    // Deferred is not the same as ignored — it has to be visible.
    expect(lines.join('\n')).toContain('DEFERRED');
  });

  it('DEFERS when a server we do not own is still running in that region', async () => {
    // RCA 2026-07-18: a live rig's volumes are legitimately detached during a
    // reseed. A foreign server in the region is the cheapest available proof
    // that a cluster might still be there.
    const deletedIds = installRouter([
      [volume({ id: 9, name: PVC_A, location: { name: 'nbg1' } })],
    ]);

    const { deleted, deferred } = await cleanupOrphanedVolumes(
      provider,
      'testapp',
      'prod',
      [],
      [],
      ['nbg1'],
      { identityComplete: false, foreignRegions: ['nbg1'], report: () => {} },
    );

    expect(deleted).toEqual([]);
    expect(deletedIds).toEqual([]);
    expect(deferred[0].blocked).toContain('nbg1');
    // Distinct from the identity-complete case: here ownership is genuinely
    // UNKNOWN (our own capture was incomplete), so destroy reports it as
    // `unverified` and the exit code goes non-zero.
    expect(deferred[0].blockedBy).toBe('foreign-region');
  });

  it('still reaps a heuristic match in a region with no foreign servers', async () => {
    // The gate is per-region, not global: an unrelated rig in hel1 must not
    // block cleanup of our nbg1 volumes.
    installRouter([
      [
        volume({ id: 9, name: PVC_A, location: { name: 'nbg1' } }),
        volume({ id: 10, name: PVC_B, location: { name: 'hel1' } }),
      ],
    ]);

    const { deleted, deferred } = await cleanupOrphanedVolumes(
      provider,
      'testapp',
      'prod',
      [],
      [],
      ['nbg1', 'hel1'],
      { identityComplete: false, foreignRegions: ['hel1'], report: () => {} },
    );

    expect(deleted).toEqual([PVC_A]);
    expect(deferred.map((v) => v.name)).toEqual([PVC_B]);
  });

  it('never touches a volume that merely starts with pvc-', async () => {
    // `pvc-backups` is a plausible hand-created volume name. The anchored
    // pvc-<uuid> form is what separates "CSI made this" from "someone did".
    const deletedIds = installRouter([
      [volume({ id: 9, name: 'pvc-backups', location: { name: 'nbg1' } })],
    ]);

    const { deleted, deferred } = await cleanupOrphanedVolumes(
      provider,
      'testapp',
      'prod',
      [],
      [],
      ['nbg1'],
      { identityComplete: false, report: () => {} },
    );

    expect(deleted).toEqual([]);
    expect(deferred).toEqual([]);
    expect(deletedIds).toEqual([]);
  });

  it('matches the project label the CSI driver stamps, outside our regions', async () => {
    // LIVE since the csi-driver v2.9.0 -> v2.18.1 bump: volume labelling landed
    // upstream in v2.14.0 (use >= v2.15.0), so master-init.sh's
    // HCLOUD_VOLUME_EXTRA_LABELS="project=<name>" now actually reaches
    // CreateVolume. This arm was written against the pre-bump driver, when no
    // volume could carry the label; it is what turned the bump into a fix
    // rather than a prerequisite for one. Volumes created BEFORE the bump are
    // still unlabelled — hence the region heuristic below stays.
    installRouter([
      [
        volume({
          id: 9,
          name: PVC_A,
          location: { name: 'fsn1' },
          labels: { project: 'testapp' },
        }),
      ],
    ]);

    const { deleted } = await cleanupOrphanedVolumes(
      provider,
      'testapp',
      'prod',
      [],
      [],
      /* clusterLocations deliberately excludes fsn1 */ ['nbg1'],
      { identityComplete: false, report: () => {} },
    );

    expect(deleted).toEqual([PVC_A]);
  });

  it('never waits on an attached heuristic match, even ungated', async () => {
    const deletedIds = installRouter([
      [volume({ id: 9, name: PVC_A, server: 42 })],
      [volume({ id: 9, name: PVC_A, server: null })],
    ]);

    const { deleted, unresolved } = await cleanupOrphanedVolumes(
      provider,
      'testapp',
      'prod',
      [],
      [],
      ['nbg1'],
      { identityComplete: false, detachWaitMs: 10_000, pollIntervalMs: 0, sleep: async () => {} },
    );

    expect(deleted).toEqual([]);
    expect(deletedIds).toEqual([]);
    expect(unresolved).toEqual([]);
  });
});

describe('an unreadable listing can never produce a clean verdict', () => {
  // 2026-07-31: `pulumi destroy` itself failed on a transient 403 and the
  // volume sweep, seeing a soft-failed `[]`, reported nothing to clean. Three
  // volumes were hand-deleted afterwards.
  it('carries captured ids into the re-sweep when the first listing is incomplete', async () => {
    installRouter([[]], { listStatus: 403 });

    const { deleted, unresolved, listingComplete } = await cleanupOrphanedVolumes(
      provider,
      'testapp',
      'prod',
      [],
      ['100604631', '100604632'],
      [],
      { detachWaitMs: 5, pollIntervalMs: 1, sleep: async () => {}, report: () => {} },
    );

    expect(listingComplete).toBe(false);
    expect(deleted).toEqual([]);
    expect(unresolved.map((v) => String(v.id)).sort()).toEqual(['100604631', '100604632']);
  });

  it('stays silent when a COMPLETE listing simply no longer contains them (CSI already reaped)', async () => {
    // The normal green teardown: cleanupClusterPVCs deleted the namespace, the
    // CSI controller deleted the volumes, and there is genuinely nothing left.
    // This path must not manufacture issues or every destroy ends "with issues".
    installRouter([[]]);

    const { deleted, unresolved, deferred, listingComplete } = await cleanupOrphanedVolumes(
      provider,
      'testapp',
      'prod',
      [],
      ['100604631'],
      ['nbg1'],
      { identityComplete: true, report: () => {} },
    );

    expect(listingComplete).toBe(true);
    expect(deleted).toEqual([]);
    expect(unresolved).toEqual([]);
    expect(deferred).toEqual([]);
  });
});

describe('configuredClusterRegions — the region source that cannot go blank', () => {
  // Both live sources of `clusterLocations` return `[]` rather than throwing
  // when the API soft-fails, and an empty region set silently disarms the
  // backstop entirely — which is how a k8s-ha destroy printed "No orphaned
  // volumes found" over five stranded volumes on 2026-08-05. The persisted
  // config needs no API call and cannot go blank.
  it('collects both sides of a k8s-ha env, which can sit in different regions', () => {
    expect(
      configuredClusterRegions({
        region: 'nbg1',
        ha: { primary: { region: 'nbg1' }, standby: { region: 'hel1' } },
      }).sort(),
    ).toEqual(['hel1', 'nbg1']);
  });

  it('falls back to the top-level region for a single-cluster env', () => {
    expect(configuredClusterRegions({ region: 'fsn1' })).toEqual(['fsn1']);
  });

  it('picks up per-server regions too, under either key', () => {
    expect(
      configuredClusterRegions({
        servers: [{ region: 'ash' }, { location: 'nbg1' }, { name: 'no-region' }],
      }).sort(),
    ).toEqual(['ash', 'nbg1']);
  });

  it('returns nothing for a config that carries no region at all', () => {
    expect(configuredClusterRegions({})).toEqual([]);
    expect(configuredClusterRegions(undefined)).toEqual([]);
  });
});
