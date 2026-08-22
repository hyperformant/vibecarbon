/**
 * CI safety-net sweep, Linode half — the Linode counterpart of
 * sweep-digitalocean-ci.ts's role in e2e-us-perf.yml's always() step.
 *
 * Sweeps every Linode resource whose label carries the active namespace's
 * scratch prefix (`citest-` in CI, `testapp-` locally), via
 * sweepOrphanedLinodeResources: instances, volumes (project-tagged pvc-*
 * only), firewalls, profile ssh keys, NodeBalancers, VPCs, and Object
 * Storage buckets.
 *
 * Self-skips with exit 0 when LINODE_API_TOKEN is absent, so the CI step is
 * inert until the e2e-infra environment carries the Linode secrets. Exits 1
 * when the sweep could not fully enumerate (an unverifiable sweep must not
 * pose as a clean one).
 */

import { scratchNamePrefix } from './utils/namespace.ts';
import { sweepOrphanedLinodeResources } from './utils/sweep-linode.ts';

if (!process.env.LINODE_API_TOKEN) {
  console.log(
    '[sweep-linode-ci] LINODE_API_TOKEN not set — skipping (no Linode secrets configured).',
  );
  process.exit(0);
}

const prefix = scratchNamePrefix();
const { counts, enumFailed } = await sweepOrphanedLinodeResources('[sweep-linode-ci]', prefix, {
  token: process.env.LINODE_API_TOKEN,
});
console.log(`[sweep-linode-ci] ${prefix}*: ${JSON.stringify(counts)}`);
if (enumFailed) process.exit(1);
