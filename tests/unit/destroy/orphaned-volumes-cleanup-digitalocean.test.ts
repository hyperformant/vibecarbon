import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Task 7 fix round 1 — regression coverage for the Important finding: DO
 * CSI volumes carry no tags (verified against csi-digitalocean v4.17.0), and
 * their `pvc-<uuid>` names contain no cluster/server name, so a volume
 * DETACHED before destroy runs (pod scaled down, node already gone from a
 * partial teardown) was caught by NOTHING on DO — `clusterLocations` was
 * populated solely from Hetzner's `server.datacenter?.location?.name`, which
 * DO droplets never have, so `isPvcInClusterLocation` could never fire.
 *
 * Fix: `serverRegion(server)` (new provider accessor) feeds
 * destroyK8sTier's `clusterLocations` set for BOTH providers now. These
 * tests exercise `cleanupOrphanedVolumes` directly (not the full
 * destroyK8sTier pre-scan, which isn't exported/unit-testable) with
 * `clusterLocations` passed exactly as the fixed pre-scan would populate it
 * — i.e. via `provider.serverRegion(server)` — proving a detached DO CSI
 * volume in the cluster's region IS swept, and regression-guarding the
 * pre-fix behavior (empty clusterLocations -> never swept).
 */

const fetchWithRetryMock = vi.fn();

vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import { cleanupOrphanedVolumes } from '../../../src/destroy.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';

const TOKEN = 'test-do-token';
const provider = new DigitalOceanProvider(TOKEN);

type VolumeFixture = {
  id: string;
  name: string;
  droplet_ids: number[];
  region: { slug: string; name?: string };
  tags?: string[];
};

function jsonResp(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/**
 * Wire `fetchWithRetry` to dispatch by URL. Each call site:
 *   GET    /v2/volumes?...  -> volumes list
 *   DELETE /v2/volumes/<id> -> 204
 */
function installFetchRouter(volumes: VolumeFixture[]) {
  fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/v2/volumes') && method === 'GET') {
      return jsonResp({ volumes, links: {} });
    }
    if (url.includes('/v2/volumes/') && method === 'DELETE') {
      return jsonResp({}, 204);
    }
    throw new Error(`unexpected fetchWithRetry: ${method} ${url}`);
  });
}

// Realistic DO CSI-created volume, as confirmed against csi-digitalocean
// v4.17.0's shipped driver.yaml (no --do-tag / --extra-create-metadata): no
// tags, pvc-<uuid> name, currently unattached (empty droplet_ids).
//
// The name is the FULL `pvc-<uuid>` form external-provisioner generates. The
// heuristic arm is anchored on that form (not a bare `pvc-` prefix) so an
// operator's hand-named `pvc-backups` volume can never be swept up by it.
const CSI_NAME = 'pvc-1c3f8b2a-4d5e-4f60-9a1b-2c3d4e5f6071';
const detachedCsiVolume: VolumeFixture = {
  id: 'vol-uuid-1',
  name: CSI_NAME,
  droplet_ids: [],
  region: { slug: 'nyc3', name: 'New York 3' },
  tags: [],
};

describe('cleanupOrphanedVolumes — DigitalOcean detached-CSI-volume fixture (Task 7 fix round 1)', () => {
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sweeps a detached DO CSI volume whose region is in clusterLocations', async () => {
    installFetchRouter([detachedCsiVolume]);

    const { deleted } = await cleanupOrphanedVolumes(
      provider,
      'proj',
      'prod',
      /* serverNames */ [],
      /* knownVolumeIds */ [],
      /* clusterLocations */ ['nyc3'],
    );

    expect(deleted).toEqual([CSI_NAME]);
  });

  it('regression guard: does NOT sweep it when clusterLocations is empty (the pre-fix bug)', async () => {
    installFetchRouter([detachedCsiVolume]);

    const { deleted } = await cleanupOrphanedVolumes(
      provider,
      'proj',
      'prod',
      [],
      [],
      /* clusterLocations */ [],
    );

    expect(deleted).toEqual([]);
  });

  it('does not sweep the same volume while still attached, even with a matching region', async () => {
    installFetchRouter([{ ...detachedCsiVolume, droplet_ids: [42] }]);

    const { deleted, unresolved } = await cleanupOrphanedVolumes(
      provider,
      'proj',
      'prod',
      [],
      [],
      ['nyc3'],
    );

    // Heuristic (region + `pvc-` prefix) match only — never waited on, never
    // deleted while in use: it could belong to a live parallel cluster.
    expect(deleted).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  it('sweeps a volume outside clusterLocations when its id is in knownVolumeIds', async () => {
    installFetchRouter([{ ...detachedCsiVolume, id: 'vol-uuid-2', region: { slug: 'sfo3' } }]);

    const { deleted } = await cleanupOrphanedVolumes(
      provider,
      'proj',
      'prod',
      [],
      /* knownVolumeIds */ ['vol-uuid-2'],
      /* clusterLocations */ ['nyc3'],
    );

    expect(deleted).toEqual([CSI_NAME]);
  });
});

/**
 * 2026-07-30 — six detached, unlabeled `pvc-*` 10GB volumes in nbg1 survived a
 * fully green Hetzner k8s e2e run's final destroy. Not a matching problem: the
 * sweep runs once, immediately after `pulumi destroy`, and both clouds clear a
 * volume's attachment ASYNCHRONOUSLY after the server delete completes — so a
 * volume that is still "in use" for that single instant was skipped forever.
 * The re-sweep waits for known cluster volumes (ids collected pre-destroy from
 * the cluster's own servers) to detach, then deletes them.
 */
describe('cleanupOrphanedVolumes — detach re-sweep for known cluster volumes', () => {
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fast = { pollIntervalMs: 0, sleep: async () => {} };

  /** Volume listings served one per GET, in order (last repeats). */
  function installSequencedRouter(listings: VolumeFixture[][]) {
    const deletedIds: string[] = [];
    let call = 0;
    fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/v2/volumes') && method === 'GET') {
        const volumes = listings[Math.min(call, listings.length - 1)];
        call += 1;
        return jsonResp({ volumes, links: {} });
      }
      if (url.includes('/v2/volumes/') && method === 'DELETE') {
        deletedIds.push(url.split('/v2/volumes/')[1]);
        return jsonResp({}, 204);
      }
      throw new Error(`unexpected fetchWithRetry: ${method} ${url}`);
    });
    return deletedIds;
  }

  it('waits for a known cluster volume to detach, then deletes it', async () => {
    const attached = { ...detachedCsiVolume, droplet_ids: [42] };
    const deletedIds = installSequencedRouter([[attached], [attached], [detachedCsiVolume]]);

    const { deleted, unresolved } = await cleanupOrphanedVolumes(
      provider,
      'proj',
      'prod',
      [],
      /* knownVolumeIds */ ['vol-uuid-1'],
      /* clusterLocations */ [],
      { detachWaitMs: 10_000, ...fast },
    );

    expect(deleted).toEqual([CSI_NAME]);
    expect(deletedIds).toEqual(['vol-uuid-1']);
    expect(unresolved).toEqual([]);
  });

  it('reports a known volume that never detaches within the budget', async () => {
    const attached = { ...detachedCsiVolume, droplet_ids: [42] };
    const deletedIds = installSequencedRouter([[attached]]);

    const { deleted, unresolved } = await cleanupOrphanedVolumes(
      provider,
      'proj',
      'prod',
      [],
      ['vol-uuid-1'],
      [],
      { detachWaitMs: 10, pollIntervalMs: 5, sleep: async () => {} },
    );

    expect(deleted).toEqual([]);
    expect(deletedIds).toEqual([]);
    expect(unresolved.map((v) => v.name)).toEqual([CSI_NAME]);
  });

  it('stops waiting on a known volume that disappears from a non-empty listing', async () => {
    const attached = { ...detachedCsiVolume, droplet_ids: [42] };
    const unrelated = {
      ...detachedCsiVolume,
      id: 'vol-other',
      name: 'db-data',
      region: { slug: 'ams3' },
    };
    installSequencedRouter([[attached], [unrelated]]);

    const { deleted, unresolved } = await cleanupOrphanedVolumes(
      provider,
      'proj',
      'prod',
      [],
      ['vol-uuid-1'],
      [],
      { detachWaitMs: 10_000, ...fast },
    );

    // Gone from a listing we could actually read = reaped elsewhere (CSI
    // finalizer, provider GC).
    expect(deleted).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  // A volume listing soft-fails to `[]` on a non-ok response, so an API blip
  // inside the poll used to look exactly like "everything was reaped
  // elsewhere": the pruning cleared the map, the loop exited, and destroy
  // reported a clean teardown over leaked volumes with no issue recorded. The
  // sweep now reads listVolumesDetailed, whose `complete: false` distinguishes
  // an unreadable listing from a genuinely empty account.
  it('treats an UNREADABLE listing as no information, not as proof the volume is gone', async () => {
    const attached = { ...detachedCsiVolume, droplet_ids: [42] };
    let call = 0;
    fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/v2/volumes') && method === 'GET') {
        call += 1;
        // First look succeeds (volume attached); every poll after it 503s.
        return call === 1 ? jsonResp({ volumes: [attached], links: {} }) : jsonResp({}, 503);
      }
      throw new Error(`unexpected fetchWithRetry: ${method} ${url}`);
    });

    const { deleted, unresolved } = await cleanupOrphanedVolumes(
      provider,
      'proj',
      'prod',
      [],
      ['vol-uuid-1'],
      [],
      { detachWaitMs: 10, pollIntervalMs: 5 },
    );

    expect(deleted).toEqual([]);
    expect(unresolved.map((v) => v.name)).toEqual([CSI_NAME]);
  });

  // The complement: a listing we could read in full, with the volume absent,
  // IS evidence — the CSI finalizer reaped it. That is the normal green
  // teardown and must stay quiet, or every destroy ends "with issues".
  it('treats a COMPLETE empty listing as proof the volume was reaped elsewhere', async () => {
    const attached = { ...detachedCsiVolume, droplet_ids: [42] };
    installSequencedRouter([[attached], []]);

    const { deleted, unresolved } = await cleanupOrphanedVolumes(
      provider,
      'proj',
      'prod',
      [],
      ['vol-uuid-1'],
      [],
      { detachWaitMs: 10_000, ...fast },
    );

    expect(deleted).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  it('keeps a volume unresolved when the delete itself fails', async () => {
    let call = 0;
    fetchWithRetryMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/v2/volumes') && method === 'GET') {
        call += 1;
        // Attached on the first look, detached from then on.
        const volumes =
          call === 1 ? [{ ...detachedCsiVolume, droplet_ids: [42] }] : [detachedCsiVolume];
        return jsonResp({ volumes, links: {} });
      }
      if (url.includes('/v2/volumes/') && method === 'DELETE') return jsonResp({}, 500);
      throw new Error(`unexpected fetchWithRetry: ${method} ${url}`);
    });

    const { deleted, unresolved } = await cleanupOrphanedVolumes(
      provider,
      'proj',
      'prod',
      [],
      ['vol-uuid-1'],
      [],
      { detachWaitMs: 10, pollIntervalMs: 5 },
    );

    // Neither deleted nor silently dropped — a failed delete is reported.
    expect(deleted).toEqual([]);
    expect(unresolved.map((v) => v.name)).toEqual([CSI_NAME]);
  });

  it('does not re-sweep an attached volume that is only a heuristic match', async () => {
    const attached = { ...detachedCsiVolume, droplet_ids: [42] };
    const deletedIds = installSequencedRouter([[attached], [detachedCsiVolume]]);

    const { deleted, unresolved } = await cleanupOrphanedVolumes(
      provider,
      'proj',
      'prod',
      [],
      /* knownVolumeIds */ [],
      /* clusterLocations */ ['nyc3'],
      { detachWaitMs: 10_000, ...fast },
    );

    expect(deleted).toEqual([]);
    expect(deletedIds).toEqual([]);
    expect(unresolved).toEqual([]);
  });
});
