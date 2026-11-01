/**
 * Detach a cluster's CSI volumes from its droplets before `pulumi destroy`.
 *
 * Why (DO k8s e2e, 2026-11-01, stack d3): terraform-provider-digitalocean's
 * Droplet delete detaches every volume the droplet lists and fails the whole
 * delete if one detach fails. It reads that list LIVE, not from Pulumi
 * state: resourceDigitalOceanDropletDelete first waits for the droplet to be
 * unlocked, that wait's refresh calls setDropletAttributes, which overwrites
 * `volume_ids` from the API, and only then does detachVolumesFromDroplet
 * walk `volume_ids` (digitalocean/droplet/resource_droplet.go, pinned by
 * pulumi-digitalocean v4.84.2). destroy.js's CSI release deletes the
 * cluster's volumes asynchronously, so at that moment DO can still list a
 * volume on the droplet that the CSI driver has already deleted, and the
 * provider's detach of it is a 404:
 *
 *   Error detaching volume "5e3fafa7-..." from droplet (614810181):
 *   POST /v2/volumes/5e3fafa7-.../actions: 404
 *
 * So destroy takes the detach over: for each captured CSI volume a droplet
 * lists, ask DO to detach it and wait for the action, then wait until DO
 * lists none of them on any droplet. A 404 means the volume is gone, which is
 * done. Only volumes captured from the cluster's own PersistentVolumes are
 * touched, never one we cannot prove is this cluster's.
 *
 * Bounded by one budget for the whole step, waiting on conditions only. On
 * timeout it returns what is still listed and destroy goes on: `pulumi
 * destroy` then reports the droplet itself, and the server sweep after it
 * deletes the droplet by API.
 */
import { pollUntil } from '../retry.js';

const DEFAULT_BUDGET_MS = 180_000;
const DEFAULT_POLL_MS = 3_000;

/**
 * @param {{
 *   detachVolume(volumeId: string, serverId: number|string): Promise<{ actionId?: number|null, gone?: true, refused?: string }>,
 *   getActionStatus(actionId: number): Promise<string|null>,
 *   getServerVolumeIds(serverId: number|string): Promise<string[]|null>,
 * }} provider
 * @param {{
 *   serverIds: Array<number|string>,
 *   csiVolumeIds: string[],
 *   budgetMs?: number,
 *   pollIntervalMs?: number,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<{
 *   detached: string[],
 *   gone: string[],
 *   stillAttached: Array<{ serverId: number|string, volumeId: string }>,
 * }>}
 */
export async function detachCsiVolumesBeforeDestroy(
  provider,
  {
    serverIds,
    csiVolumeIds,
    budgetMs = DEFAULT_BUDGET_MS,
    pollIntervalMs = DEFAULT_POLL_MS,
    log = () => {},
  },
) {
  const deadline = Date.now() + budgetMs;
  const remainingMs = () => Math.max(0, deadline - Date.now());
  const poll = { initialDelayMs: pollIntervalMs, maxDelayMs: pollIntervalMs, backoffFactor: 1 };
  const owned = new Set(csiVolumeIds);
  const detached = [];
  const gone = [];

  // What DO lists right now: the same read the provider's delete will make.
  let targets = [];
  for (const serverId of new Set(serverIds)) {
    try {
      const listed = (await provider.getServerVolumeIds(serverId)) ?? [];
      for (const volumeId of listed) {
        if (owned.has(volumeId)) targets.push({ serverId, volumeId });
      }
    } catch (err) {
      log(`could not read the volumes on server ${serverId}: ${err.message}`);
    }
  }
  if (targets.length === 0) return { detached, gone, stillAttached: [] };

  // One detach at a time: DO runs one action per volume and droplet at once.
  for (const { serverId, volumeId } of targets) {
    let result;
    try {
      result = await provider.detachVolume(volumeId, serverId);
    } catch (err) {
      log(`detach request for volume ${volumeId} failed: ${err.message}`);
      continue;
    }
    if (result.gone) {
      gone.push(volumeId);
      continue;
    }
    if (result.refused) {
      // Most often the CSI driver's own detach is in flight. The wait on the
      // droplet's listing below covers it either way.
      log(`DO did not start a detach for volume ${volumeId}: ${result.refused}`);
      continue;
    }
    if (result.actionId == null) continue;
    try {
      const status = await pollUntil(
        async () => {
          const s = await provider.getActionStatus(result.actionId);
          return s === 'in-progress' ? null : (s ?? 'gone');
        },
        { ...poll, budgetMs: remainingMs(), description: `detach of volume ${volumeId}` },
      );
      if (status === 'completed') detached.push(volumeId);
      else log(`detach of volume ${volumeId} ended ${status}`);
    } catch (err) {
      log(err.message);
    }
  }

  // Done only when DO no longer lists any of them: that is the provider's read.
  try {
    await pollUntil(
      async () => {
        const still = [];
        for (const serverId of new Set(targets.map((t) => t.serverId))) {
          const listed = await provider.getServerVolumeIds(serverId);
          if (!listed) continue;
          for (const t of targets) {
            if (t.serverId === serverId && listed.includes(t.volumeId)) still.push(t);
          }
        }
        targets = still;
        return still.length === 0;
      },
      { ...poll, budgetMs: remainingMs(), description: 'DO to list the volumes as detached' },
    );
  } catch (err) {
    log(err.message);
  }
  return { detached, gone, stillAttached: targets };
}
