import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Traefik CRD / runtime lockstep guard.
 *
 * The CRDs installed by `kubectl apply -k k8s/infra/traefik-crds`
 * (src/lib/deploy/k8s/k3s.js) define the schema the API server validates
 * IngressRoute/Middleware/etc against. Fields newer than the CRD tag are
 * PRUNED silently rather than rejected, so a CRD tag behind the running
 * Traefik is a silent-data-loss trap, not a loud failure.
 *
 * This drifted once already: CRDs sat at v3.3.6 while Traefik ran v3.6.11
 * (same 10 CRD kinds, but v3.3.6's schemas are ~700 lines shorter). Nothing
 * broke visibly, which is exactly why it went unnoticed through several
 * Traefik image bumps.
 */

const repo = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');

const CRD_KUSTOMIZATION = 'carbon/k8s/infra/traefik-crds/kustomization.yaml';
const K8S_DEPLOYMENT = 'carbon/k8s/base/traefik/deployment.yaml';
const COMPOSE = 'carbon/docker-compose.yml';

/** Tag from the raw.githubusercontent.com CRD URL in the kustomization. */
function crdTag(): string {
  const m = repo(CRD_KUSTOMIZATION).match(
    /raw\.githubusercontent\.com\/traefik\/traefik\/(v[\d.]+)\//,
  );
  if (!m) throw new Error(`no Traefik CRD URL found in ${CRD_KUSTOMIZATION}`);
  return m[1];
}

/** Tag from an `image: traefik:vX.Y.Z` line. */
function imageTag(rel: string): string {
  const m = repo(rel).match(/image:\s*traefik:(v[\d.]+)/);
  if (!m) throw new Error(`no traefik image pin found in ${rel}`);
  return m[1];
}

describe('Traefik CRD version matches the running Traefik version', () => {
  it('k8s Traefik deployment and compose agree on one Traefik tag', () => {
    expect(imageTag(K8S_DEPLOYMENT)).toBe(imageTag(COMPOSE));
  });

  it('the installed CRD tag equals the Traefik image tag', () => {
    // Bumping Traefik? Bump the CRD URL in the same commit.
    expect(crdTag()).toBe(imageTag(K8S_DEPLOYMENT));
  });

  it('the CRD pin is an exact version tag, not a moving ref', () => {
    const tag = crdTag();
    expect(tag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(['main', 'master', 'latest']).not.toContain(tag);
  });
});
