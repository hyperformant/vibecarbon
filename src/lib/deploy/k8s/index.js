/**
 * Kubernetes Deployment Module
 *
 * Thin destroy wrapper shared by the single-cluster and HA paths.
 * The primary deploy entry point is `deployK3s` in `./k3s.js`. All K8s
 * modes run k3s on plain Ubuntu VMs (Hetzner cx23 by default). Callers
 * should import it directly.
 *
 * This is also the paid-boundary entry point for the k8s engine (see
 * src/lib/licensing/paid-surface.js) — free code outside src/lib/deploy/k8s/
 * imports k3s.js internals through here rather than reaching in directly.
 */

import * as p from '@clack/prompts';
import { spinner } from '../../cli/progress.js';

// Re-exported so the orchestrator's public health probe (outside
// src/lib/deploy/k8s/) can watch cert-manager for terminally-failed ACME
// issuance without reaching into ./acme-order-recovery.js directly — see
// paid-boundary guard.
export { createAcmeIssuanceWatchdog } from './acme-order-recovery.js';
// Re-exported so the orchestrator's k8s DNS step (outside src/lib/deploy/k8s/)
// can start the A record at infra-ready without reaching into
// ./dns-record.js directly — see paid-boundary guard.
export { createK8sDnsWriter } from './dns-record.js';
export { reestablishReplicationTransport } from './ha/index.js';
// Re-exported so callers outside src/lib/deploy/k8s/ (e.g. src/scale.js)
// don't reach into ./k3s.js directly — see paid-boundary guard.
// Re-exported so the orchestrator's TLS phase (outside src/lib/deploy/k8s/)
// can name the deploy's issuer and save the trusted certificate without
// reaching into ./k3s.js or ./tls-restore.js directly — see paid-boundary guard.
export { K3S_VERSION, k8sTlsIdentity } from './k3s.js';
// Re-exported so src/backup.js can gate the manual backup Job on the
// exec+pg condition (RCA 2026-08-16, run 31927810430) without reaching into
// ./readiness.js directly — see paid-boundary guard.
export { awaitPostgresAccepting } from './readiness.js';
// Re-exported so the orchestrator's finalize (outside src/lib/deploy/k8s/)
// can derive the pilot-light scale-up list without reaching into
// ./standby-config.js directly — see paid-boundary guard.
export { deriveScaleUpList, failoverAddonManifests } from './standby-config.js';
export { quietKubectl, snapshotK8sTlsSecret } from './tls-restore.js';

/**
 * Destroy a K8s deployment.
 *
 * Returns destroyStack's result (`{destroyed, resourceCount}`, M3 Task 9f) —
 * the caller (destroy.js's destroyK8sTier) is the only place that can tell a
 * legitimately-empty destroy apart from a suspicious one: only it knows
 * whether this environment's envConfig records real infrastructure. Do not
 * swallow this return value; see `recordPulumiDestroyOutcome` in destroy.js.
 */
export async function destroyK8s(options) {
  const { environment, s3Config, apiToken, provider, projectName } = options;
  const s = spinner();
  s.start(`Destroying Kubernetes infrastructure: ${environment}`);

  try {
    // destroyStack signature is (stackName, program, options). The 3rd-arg
    // options.s3Config drives the backend URL — without it, resolveBackendUrl
    // falls back to the local file:// backend, the lookup finds an EMPTY
    // stack, destroy is a no-op, and Pulumi-managed resources (FloatingIp,
    // Network) silently leak. Observed 2026-04-26 matrix run #2 cleanup:
    // 10 orphan FIPs + 10 orphan Networks across multiple "successful"
    // destroys. Same class of bug as the s3Config-typo case in destroy.js.
    //
    // The 2nd-arg `program` is required for `up` (inline program runtime)
    // but not for `destroy` — the latter reads recorded state and tears
    // down what's there without re-executing the program. A no-op stub
    // satisfies the LocalWorkspace.createOrSelectStack contract.
    const { destroyStack } = await import('../../iac/index.js');
    const result = await destroyStack(environment, () => {}, {
      provider,
      providerToken: apiToken,
      s3Config,
      projectName,
    });

    s.stop(`Infrastructure destroyed: ${environment}`);
    return result;
  } catch (error) {
    s.stop('Destruction failed');
    // destroyStack's error is a one-line summary that names what is left; the
    // full Pulumi output rides on `cause`. Log both: the summary is what the
    // operator acts on, the raw output is what explains it.
    p.log.error(
      error.cause instanceof Error ? `${error.message}\n${error.cause.message}` : error.message,
    );
    throw error;
  }
}
