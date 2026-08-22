/**
 * CI safety-net sweep, Scaleway half — the Scaleway counterpart of
 * sweep-vultr-ci.ts's role in e2e-us-perf.yml's always() step.
 *
 * Sweeps every Scaleway resource whose name carries the active namespace's
 * scratch prefix (`citest-` in CI, `testapp-` locally), via
 * sweepOrphanedScalewayResources: instances (with the terminate → detached-
 * SBS-volume → flexible-IP chain), volumes (Instance + Block APIs),
 * security groups, Project IAM ssh keys, flexible IPs, load balancers,
 * Private Networks, and Object Storage buckets in both regions.
 *
 * Self-skips with exit 0 when SCALEWAY_SECRET_KEY is absent, so the CI step is
 * inert until the e2e-infra environment carries the Scaleway secrets.
 * Exits 1 when the sweep could not fully enumerate (an unverifiable sweep
 * must not pose as a clean one).
 */

import { scratchNamePrefix } from './utils/namespace.ts';
import { sweepOrphanedScalewayResources } from './utils/sweep-scaleway.ts';

if (!process.env.SCALEWAY_SECRET_KEY) {
  console.log(
    '[sweep-scaleway-ci] SCALEWAY_SECRET_KEY not set — skipping (no Scaleway secrets configured).',
  );
  process.exit(0);
}

const prefix = scratchNamePrefix();
const { counts, enumFailed } = await sweepOrphanedScalewayResources('[sweep-scaleway-ci]', prefix, {
  token: process.env.SCALEWAY_SECRET_KEY,
  storageKey: process.env.SCALEWAY_ACCESS_KEY,
  projectId: process.env.SCALEWAY_DEFAULT_PROJECT_ID,
});
console.log(`[sweep-scaleway-ci] ${prefix}*: ${JSON.stringify(counts)}`);
if (enumFailed) process.exit(1);
