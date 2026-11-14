/**
 * One project's orphan sweep, on the project's own provider.
 *
 * The one dispatch every teardown path shares: the lifecycle's final cleanup
 * (tests/e2e/scenarios/_run-lifecycle.ts), `iter-step destroy -purge` on a
 * kept rig (./rig-teardown.ts), and tests/e2e/sweep-project.ts for leftovers.
 * Before this module each kept its own copy, and iter-step had none: a rig
 * torn down with iter-step was never swept, so the Linode CSI volumes its
 * destroy missed stayed on the account (2026-11-08) with nothing to say so.
 *
 * Dispatched on the provider, never defaulted: until 2026-08-07 the lifecycle
 * called the Hetzner sweep for every scenario, so DigitalOcean runs enumerated
 * the wrong cloud and printed a false "destroy worked cleanly". A provider
 * with no sweep gets a loud REGRESSION line and counts as not enumerated.
 */
import type { SweepBreakdown } from '../metrics/db.js';
import { probeFor } from './stack-probes.js';
import { e2eStateStore } from './state-store.js';
import { sweepOrphanedDigitalOceanResources } from './sweep-digitalocean.js';
import { sweepOrphanedHetznerResources } from './sweep-hetzner.js';
import { sweepOrphanedLinodeResources } from './sweep-linode.js';
import { sweepRunStacks } from './sweep-run-stacks.js';
import { sweepOrphanedScalewayResources } from './sweep-scaleway.js';
import { sweepOrphanedVultrResources } from './sweep-vultr.js';

export interface ProjectSweep {
  counts: SweepBreakdown;
  /** Some list could not be read to its end: residue cannot be ruled out. */
  enumFailed: boolean;
}

/**
 * @param o.token - the provider's compute token (the registry's
 *   computeTokenEnv). One provider's token never reaches another's API.
 * @param o.env - where the storage companions come from (Vultr's storage
 *   region, Scaleway's access key and project id).
 */
export async function sweepProjectOrphans(o: {
  tag: string;
  provider: string;
  projectName: string;
  token: string;
  env: Record<string, string | undefined>;
}): Promise<ProjectSweep> {
  const result = await sweepResources(o);
  // The stack that recorded this run's resources goes once every one of them
  // reads 404, and only after a COMPLETE resource sweep: an enumeration that
  // failed cannot vouch for anything. No age floor: this runs at the end of
  // its own run. Advisory: nothing here changes the verdict.
  if (!result.enumFailed) {
    try {
      const store = e2eStateStore(o.provider, o.env);
      if (store) {
        await sweepRunStacks(
          o.tag,
          (p) => p === o.projectName,
          store,
          probeFor(o.provider, { token: o.token, env: o.env }),
        );
      }
    } catch (e) {
      console.warn(`${o.tag} [sweep] Stack cleanup skipped: ${e instanceof Error ? e.message : e}`);
    }
  }
  return result;
}

async function sweepResources(o: {
  tag: string;
  provider: string;
  projectName: string;
  token: string;
  env: Record<string, string | undefined>;
}): Promise<ProjectSweep> {
  const { tag, provider, projectName, token, env } = o;
  switch (provider) {
    case 'hetzner':
      return sweepOrphanedHetznerResources(tag, projectName, token);
    case 'digitalocean':
      return sweepOrphanedDigitalOceanResources(tag, projectName, { token });
    case 'linode':
      return sweepOrphanedLinodeResources(tag, projectName, { token });
    case 'vultr':
      // storageRegion is load-bearing, not a nicety: Vultr object-storage
      // keys are per-subscription (one subscription = one cluster), so
      // without the cluster the bucket half cannot authenticate anywhere
      // and reports itself incomplete instead of guessing.
      return sweepOrphanedVultrResources(tag, projectName, {
        token,
        storageRegion: env.VULTR_STORAGE_REGION,
      });
    case 'scaleway':
      // The access key rides along for the bucket half (the SAME IAM pair
      // signs S3; no separate storage credential exists); the project id
      // scopes the IAM ssh-key walk to the dedicated Project the deploy
      // targets.
      return sweepOrphanedScalewayResources(tag, projectName, {
        token,
        storageKey: env.SCALEWAY_ACCESS_KEY,
        projectId: env.SCALEWAY_DEFAULT_PROJECT_ID,
      });
    default:
      console.warn(
        `${tag} [sweep] REGRESSION: no orphan sweep implemented for provider '${provider}' — nothing was checked; leaked resources cannot be ruled out.`,
      );
      // Nothing was checked: the strongest form of "could not enumerate", so
      // it gates a verdict like any other enumeration failure.
      return {
        counts: {
          servers: 0,
          volumes: 0,
          placementGroups: 0,
          firewalls: 0,
          floatingIps: 0,
          networks: 0,
          s3Buckets: 0,
          sshKeys: 0,
        },
        enumFailed: true,
      };
  }
}

/** Resources the sweep found (and deleted) that the destroy had left. */
export function orphanTotal(counts: SweepBreakdown): number {
  return Object.values(counts).reduce((sum, n) => sum + (typeof n === 'number' ? n : 0), 0);
}
