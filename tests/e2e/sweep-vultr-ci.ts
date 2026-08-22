/**
 * CI safety-net sweep, Vultr half — the Vultr counterpart of
 * sweep-linode-ci.ts's role in e2e-us-perf.yml's always() step.
 *
 * Sweeps every Vultr resource whose name carries the active namespace's
 * scratch prefix (`citest-` in CI, `testapp-` locally), via
 * sweepOrphanedVultrResources: instances, block storage (project-tagged
 * pvc-* only), firewall groups, account ssh keys, load balancers, VPCs, and
 * Object Storage buckets.
 *
 * Self-skips with exit 0 when VULTR_API_TOKEN is absent, so the CI step is
 * inert until the e2e-infra environment carries the Vultr secrets. Exits 1
 * when the sweep could not fully enumerate (an unverifiable sweep must not
 * pose as a clean one) — including when VULTR_STORAGE_REGION is
 * unset, since per-subscription keys cannot reach any other cluster.
 */

import { scratchNamePrefix } from './utils/namespace.ts';
import { sweepOrphanedVultrResources } from './utils/sweep-vultr.ts';

if (!process.env.VULTR_API_TOKEN) {
  console.log('[sweep-vultr-ci] VULTR_API_TOKEN not set — skipping (no Vultr secrets configured).');
  process.exit(0);
}

const prefix = scratchNamePrefix();
const { counts, enumFailed } = await sweepOrphanedVultrResources('[sweep-vultr-ci]', prefix, {
  token: process.env.VULTR_API_TOKEN,
  storageRegion: process.env.VULTR_STORAGE_REGION,
});
console.log(`[sweep-vultr-ci] ${prefix}*: ${JSON.stringify(counts)}`);
if (enumFailed) process.exit(1);
