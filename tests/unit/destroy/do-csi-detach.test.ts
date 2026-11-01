import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DigitalOcean k8s destroy: vibecarbon detaches the cluster's CSI volumes
 * itself, and waits for DO to agree, before `pulumi destroy` runs.
 *
 * The failure (DO k8s e2e, 2026-11-01, stack d3, after #280): `pulumi
 * destroy` failed on `Droplet db` with
 *
 *   Error detaching volume "5e3fafa7-..." from droplet (614810181):
 *   POST /v2/volumes/5e3fafa7-.../actions: 404 not found
 *
 * terraform-provider-digitalocean's Droplet Delete reads the Droplet LIVE
 * before it detaches (resource_droplet.go: the unlock wait's refresh calls
 * setDropletAttributes, which overwrites `volume_ids` from the API), then
 * POSTs a detach for every id the API listed. The CSI release deletes those
 * volumes asynchronously, so the Droplet can still list a volume that is
 * already gone, and the detach 404s. Editing Pulumi state cannot help: the
 * provider never reads it.
 *
 * The fake DO API below models exactly that: a volume the CSI driver has
 * deleted 404s on detach, while the Droplet keeps listing it for a few more
 * reads. `providerDropletDelete` is the provider's delete path.
 */

const fetchWithRetryMock = vi.fn();

vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

const { DigitalOceanProvider } = await import('../../../src/lib/providers/digitalocean.js');
const { detachCsiVolumesBeforeDestroy } = await import('../../../src/lib/destroy/csi-detach.js');

const API = 'https://api.digitalocean.com/v2';
const DB = 614810181;
const MASTER = 614810180;
const LIVE = '66321070-d60c-11f1-bea2-2258243ee23f';
const DELETED = '5e3fafa7-d60c-11f1-bea2-2258243ee23f';
const FOREIGN = 'aaaaaaaa-0000-11f1-0000-000000000000';

function jsonResp(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

type Action = { status: 'in-progress' | 'completed'; pollsLeft: number; finish: () => void };

/** A fake DigitalOcean API with the asynchrony that bit us. */
function makeWorld({
  actionPolls = 2,
  staleReads = 2,
}: {
  actionPolls?: number;
  staleReads?: number;
} = {}) {
  const droplets = new Map<number, Set<string>>([
    [DB, new Set([LIVE, DELETED])],
    [MASTER, new Set()],
  ]);
  // Volumes that still exist. DELETED is gone: CSI finished DeleteVolume.
  const volumes = new Set([LIVE, FOREIGN]);
  // The Droplet keeps listing a deleted volume for this many more reads.
  const stale = new Map<string, number>([[DELETED, staleReads]]);
  const actions = new Map<number, Action>();
  const calls: string[] = [];
  let nextAction = 1;

  const readDroplet = (id: number) => {
    const ids = droplets.get(id);
    if (!ids) return null;
    for (const [vol, left] of stale) {
      if (!ids.has(vol)) continue;
      if (left <= 0) ids.delete(vol);
      else stale.set(vol, left - 1);
    }
    return { id, volume_ids: [...ids] };
  };

  fetchWithRetryMock.mockImplementation(
    async (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      const path = url.replace(API, '');
      calls.push(`${method} ${path}`);
      let m = path.match(/^\/droplets\/(\d+)$/);
      if (m && method === 'GET') {
        const droplet = readDroplet(Number(m[1]));
        return droplet ? jsonResp({ droplet }) : jsonResp({ message: 'not found' }, 404);
      }
      m = path.match(/^\/volumes\/([^/]+)\/actions$/);
      if (m && method === 'POST') {
        const vol = m[1];
        const body = JSON.parse(init.body ?? '{}');
        if (!volumes.has(vol)) return jsonResp({ id: 'not_found', message: 'not found' }, 404);
        const id = nextAction++;
        const action: Action = {
          status: 'in-progress',
          pollsLeft: actionPolls,
          finish: () => droplets.get(Number(body.droplet_id))?.delete(vol),
        };
        actions.set(id, action);
        return jsonResp({ action: { id, status: 'in-progress', type: body.type } }, 202);
      }
      m = path.match(/^\/actions\/(\d+)$/);
      if (m && method === 'GET') {
        const action = actions.get(Number(m[1]));
        if (!action) return jsonResp({ message: 'not found' }, 404);
        if (action.status === 'in-progress' && action.pollsLeft-- <= 0) {
          action.status = 'completed';
          action.finish();
        }
        return jsonResp({ action: { id: Number(m[1]), status: action.status } });
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
  );

  /**
   * terraform-provider-digitalocean's resourceDigitalOceanDropletDelete:
   * read the Droplet live, then detach each listed volume; a 404 fails the
   * whole delete.
   */
  const providerDropletDelete = (id: number) => {
    const droplet = readDroplet(id);
    if (!droplet) return;
    for (const vol of droplet.volume_ids) {
      if (!volumes.has(vol)) {
        throw new Error(
          `Error detaching the volumes from the droplet (${id}): Error detaching volume "${vol}" from droplet (${id}): POST ${API}/volumes/${vol}/actions: 404`,
        );
      }
      droplets.get(id)?.delete(vol);
    }
    droplets.delete(id);
  };

  return { droplets, calls, providerDropletDelete };
}

const FAST = { budgetMs: 2_000, pollIntervalMs: 1 };

describe('detachCsiVolumesBeforeDestroy', () => {
  let provider: InstanceType<typeof DigitalOceanProvider>;
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
    provider = new DigitalOceanProvider('test-do-token');
  });

  it('reproduces the failure: without the detach, the provider delete 404s', () => {
    const world = makeWorld();
    expect(() => world.providerDropletDelete(DB)).toThrow(/404/);
  });

  it('detaches and waits until DO lists nothing, so the provider delete that follows succeeds', async () => {
    const world = makeWorld();

    const out = await detachCsiVolumesBeforeDestroy(provider, {
      serverIds: [DB, MASTER],
      csiVolumeIds: [LIVE, DELETED],
      ...FAST,
    });

    // Waited: by the time the step returns, DO lists no CSI volume.
    expect([...(world.droplets.get(DB) ?? [])]).toEqual([]);
    expect(out.stillAttached).toEqual([]);
    expect(out.detached).toEqual([LIVE]);
    expect(out.gone).toEqual([DELETED]);
    // pulumi destroy runs next, and the provider's live read is clean.
    expect(() => world.providerDropletDelete(DB)).not.toThrow();
    expect(() => world.providerDropletDelete(MASTER)).not.toThrow();
  });

  it('waits on the action, not a fixed sleep: it polls the action until it completes', async () => {
    const world = makeWorld({ actionPolls: 3, staleReads: 0 });

    await detachCsiVolumesBeforeDestroy(provider, {
      serverIds: [DB],
      csiVolumeIds: [LIVE],
      ...FAST,
    });

    const polls = world.calls.filter((c) => c === 'GET /actions/1');
    expect(polls.length).toBe(4);
    // The detach was POSTed before the first poll.
    expect(world.calls.indexOf(`POST /volumes/${LIVE}/actions`)).toBeLessThan(
      world.calls.indexOf('GET /actions/1'),
    );
  });

  it('treats a 404 on detach as done, never as an error', async () => {
    makeWorld({ staleReads: 1 });

    const out = await detachCsiVolumesBeforeDestroy(provider, {
      serverIds: [DB],
      csiVolumeIds: [DELETED],
      ...FAST,
    });

    expect(out.gone).toEqual([DELETED]);
    expect(out.stillAttached).toEqual([]);
  });

  it('never detaches a volume it did not capture', async () => {
    const world = makeWorld({ staleReads: 0 });
    world.droplets.get(DB)?.add(FOREIGN);

    await detachCsiVolumesBeforeDestroy(provider, {
      serverIds: [DB],
      csiVolumeIds: [LIVE, DELETED],
      ...FAST,
    });

    expect(world.calls).not.toContain(`POST /volumes/${FOREIGN}/actions`);
    expect(world.droplets.get(DB)?.has(FOREIGN)).toBe(true);
  });

  it('is bounded: a Droplet that never lets go is reported, not waited on forever', async () => {
    makeWorld({ staleReads: Number.POSITIVE_INFINITY });

    const out = await detachCsiVolumesBeforeDestroy(provider, {
      serverIds: [DB],
      csiVolumeIds: [DELETED],
      budgetMs: 50,
      pollIntervalMs: 5,
    });

    expect(out.stillAttached).toEqual([{ serverId: DB, volumeId: DELETED }]);
  });

  it('does nothing when no captured volume is attached', async () => {
    const world = makeWorld();

    const out = await detachCsiVolumesBeforeDestroy(provider, {
      serverIds: [MASTER],
      csiVolumeIds: [LIVE],
      ...FAST,
    });

    expect(out).toEqual({ detached: [], gone: [], stillAttached: [] });
    expect(world.calls).toEqual([`GET /droplets/${MASTER}`]);
  });
});

describe('destroyK8sTier wiring', () => {
  // destroyK8sTier is not exported (it needs the whole destroy context); the
  // step's behaviour is covered above, this pins where it runs.
  it('detaches after the CSI release and before pulumi destroy', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../src/destroy.js', import.meta.url)),
      'utf8',
    );
    const body = src.slice(src.indexOf('async function destroyK8sTier('));
    const release = body.indexOf('await cleanupClusterPVCs(');
    const detach = body.indexOf('detachCsiVolumesBeforeDestroy(');
    const destroy = body.indexOf('destroyK8sStack({');
    expect(release).toBeGreaterThan(0);
    expect(detach).toBeGreaterThan(release);
    expect(destroy).toBeGreaterThan(detach);
  });
});
