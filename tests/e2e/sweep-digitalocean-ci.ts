/**
 * CI safety-net sweep, DigitalOcean half — the DO counterpart of
 * scripts/sweep-hetzner.js's role in e2e-us-perf.yml's always() step.
 *
 * Sweeps every DigitalOcean resource whose name carries the active
 * namespace's scratch prefix (`citest-` in CI, `testapp-` locally — the
 * same scoping the runner uses for provisioning), via
 * sweepOrphanedDigitalOceanResources: droplets, volumes (project-tagged
 * pvc-* only), firewalls, ssh keys, load balancers, VPCs, Spaces buckets
 * (with the vc-local-e2e anchor guard), and the prefix's `project:` tags once
 * nothing carries them (sweep-run-tags.ts; a tag never fails the step).
 *
 * Self-skips with exit 0 when DIGITALOCEAN_API_TOKEN is absent, so the CI
 * step is inert until the e2e-infra environment carries the DO secrets.
 * Exits 1 when the sweep could not fully enumerate (an unverifiable sweep
 * must not pose as a clean one). Both are runCiSweep's (utils/sweep-ci.ts).
 */

import { runCiSweep } from './utils/sweep-ci.ts';
import { sweepOrphanedDigitalOceanResources } from './utils/sweep-digitalocean.ts';

const tag = '[sweep-do-ci]';
await runCiSweep({
  tag,
  tokenEnv: 'DIGITALOCEAN_API_TOKEN',
  cloud: 'DO',
  sweep: (prefix, token) => sweepOrphanedDigitalOceanResources(tag, prefix, { token }),
});
