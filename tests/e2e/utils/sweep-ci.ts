/**
 * What the per-provider CI safety-net sweeps (tests/e2e/sweep-<provider>-ci.ts,
 * run by e2e-us-perf.yml's always() steps) share: the skip without a token,
 * the scratch prefix, the counts line and the exit code.
 *
 * Each entry point keeps what is its own: which sweep it runs and which
 * storage companions it hands that sweep.
 */
import type { SweepBreakdown } from '../metrics/db.js';
import { scratchNamePrefix } from './namespace.ts';

/**
 * Sweep every resource whose name carries the active namespace's scratch
 * prefix (`citest-` in CI, `testapp-` locally: the scoping the runner uses
 * for provisioning).
 *
 * Without the compute token it says so and exits 0, so the workflow step is
 * inert until the e2e-infra environment carries that provider's secrets. It
 * exits 1 when the sweep could not look at everything: an unverifiable sweep
 * must not pose as a clean one.
 *
 * @param o.tag - opens every line, e.g. `[sweep-do-ci]`.
 * @param o.tokenEnv - the provider's compute token variable.
 * @param o.cloud - how the skip line names the provider, e.g. `DO`.
 * @param o.sweep - the provider's sweep, given the prefix and the token.
 */
export async function runCiSweep(o: {
  tag: string;
  tokenEnv: string;
  cloud: string;
  sweep: (
    prefix: string,
    token: string,
  ) => Promise<{ counts: SweepBreakdown; enumFailed: boolean }>;
}): Promise<void> {
  const token = process.env[o.tokenEnv];
  if (!token) {
    console.log(`${o.tag} ${o.tokenEnv} not set — skipping (no ${o.cloud} secrets configured).`);
    process.exit(0);
  }
  const prefix = scratchNamePrefix();
  const { counts, enumFailed } = await o.sweep(prefix, token);
  console.log(`${o.tag} ${prefix}*: ${JSON.stringify(counts)}`);
  if (enumFailed) process.exit(1);
}
