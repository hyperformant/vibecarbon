/**
 * CI safety-net sweep, Linode half — the Linode counterpart of
 * sweep-digitalocean-ci.ts's role in e2e-us-perf.yml's always() step.
 *
 * Sweeps every Linode resource whose label carries the active namespace's
 * scratch prefix (`citest-` in CI, `testapp-` locally), via
 * sweepOrphanedLinodeResources: instances, volumes (project-tagged pvc-*
 * only), firewalls, profile ssh keys, NodeBalancers, VPCs, Object Storage
 * buckets, and the prefix's `project:` and `cluster:` tags once nothing
 * carries them (sweep-run-tags.ts; a tag never fails the step).
 *
 * Self-skips with exit 0 when LINODE_API_TOKEN is absent, so the CI step is
 * inert until the e2e-infra environment carries the Linode secrets. Exits 1
 * when the sweep could not fully enumerate (an unverifiable sweep must not
 * pose as a clean one). Both are runCiSweep's (utils/sweep-ci.ts).
 */

import { runCiSweep } from './utils/sweep-ci.ts';
import { sweepOrphanedLinodeResources } from './utils/sweep-linode.ts';

const tag = '[sweep-linode-ci]';
await runCiSweep({
  tag,
  tokenEnv: 'LINODE_API_TOKEN',
  cloud: 'Linode',
  sweep: (prefix, token) => sweepOrphanedLinodeResources(tag, prefix, { token }),
});
