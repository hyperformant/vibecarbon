/**
 * CI safety-net sweep, DigitalOcean half — the DO counterpart of
 * scripts/sweep-hetzner.js's role in e2e-us-perf.yml's always() step.
 *
 * Sweeps every DigitalOcean resource whose name carries the active
 * namespace's scratch prefix (`citest-` in CI, `testapp-` locally — the
 * same scoping the runner uses for provisioning), via
 * sweepOrphanedDigitalOceanResources: droplets, volumes (project-tagged
 * pvc-* only), firewalls, ssh keys, load balancers, VPCs, and Spaces
 * buckets (with the vc-local-e2e anchor guard).
 *
 * Self-skips with exit 0 when DIGITALOCEAN_API_TOKEN is absent, so the CI
 * step is inert until the e2e-infra environment carries the DO secrets.
 * Exits 1 when the sweep could not fully enumerate (an unverifiable sweep
 * must not pose as a clean one).
 */

import { scratchNamePrefix } from './utils/namespace.ts';
import { sweepOrphanedDigitalOceanResources } from './utils/sweep-digitalocean.ts';

if (!process.env.DIGITALOCEAN_API_TOKEN) {
  console.log(
    '[sweep-do-ci] DIGITALOCEAN_API_TOKEN not set — skipping (no DO secrets configured).',
  );
  process.exit(0);
}

const prefix = scratchNamePrefix();
const { counts, enumFailed } = await sweepOrphanedDigitalOceanResources('[sweep-do-ci]', prefix, {
  token: process.env.DIGITALOCEAN_API_TOKEN,
});
console.log(`[sweep-do-ci] ${prefix}*: ${JSON.stringify(counts)}`);
if (enumFailed) process.exit(1);
