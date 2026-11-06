import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderTraefikCrds } from '../../../src/lib/deploy/k8s/k3s.js';
import { manifestImageValues, traefikImageRef, traefikVersion } from '../../../src/lib/images.js';

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
 * Traefik image bumps. The tag now comes from the deploy's version set, so a
 * channel move carries the CRDs along.
 */

const repo = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');

const CRD_KUSTOMIZATION = 'carbon/k8s/infra/traefik-crds/kustomization.yaml';
const K8S_DEPLOYMENT = 'carbon/k8s/base/traefik/deployment.yaml';
const COMPOSE = 'carbon/docker-compose.yml';
const COMPOSE_PROD = 'carbon/docker-compose.prod.yml';
const DEPLOY_WORKFLOW = 'carbon/.github/workflows/deploy.yml';

/** Tag from an `image: traefik:vX.Y.Z` line. */
function imageTag(rel: string): string {
  const m = repo(rel).match(/image:\s*traefik:(v[\d.]+)/);
  if (!m) throw new Error(`no traefik image pin found in ${rel}`);
  return m[1];
}

describe('Traefik CRD version matches the running Traefik version', () => {
  it('servers run the version set, and local dev starts on the bundled tag', () => {
    expect(repo(K8S_DEPLOYMENT)).toContain('image: "{{TRAEFIK_IMAGE}}"');
    expect(repo(COMPOSE_PROD)).toContain('image: ${TRAEFIK_IMAGE:?');
    expect(traefikVersion()).toBe(imageTag(COMPOSE));
  });

  it('the CRD URL carries the tag of the Traefik this deploy runs', () => {
    // A channel move takes the CRDs with it: one token, no second tag to forget.
    expect(repo(CRD_KUSTOMIZATION)).toContain(
      'raw.githubusercontent.com/traefik/traefik/{{TRAEFIK_VERSION}}/',
    );
    expect(manifestImageValues().TRAEFIK_VERSION).toBe(traefikVersion());
    expect(traefikImageRef()).toContain(`:${traefikVersion()}@sha256:`);
  });

  it('the tag is an exact version, not a moving ref', () => {
    const tag = traefikVersion();
    expect(tag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(['main', 'master', 'latest']).not.toContain(tag);
  });

  it('renderTraefikCrds fills a copy and leaves the project file alone', () => {
    const project = mkdtempSync(join(tmpdir(), 'crds-'));
    try {
      const source = join(project, 'traefik-crds');
      mkdirSync(source);
      writeFileSync(join(source, 'kustomization.yaml'), repo(CRD_KUSTOMIZATION));
      const copy = renderTraefikCrds(source);
      try {
        expect(copy).not.toBe(source);
        const rendered = readFileSync(join(copy, 'kustomization.yaml'), 'utf8');
        expect(rendered).toContain(`/traefik/traefik/${traefikVersion()}/`);
        expect(rendered).not.toContain('{{');
        expect(readFileSync(join(source, 'kustomization.yaml'), 'utf8')).toContain(
          '{{TRAEFIK_VERSION}}',
        );
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('the GitOps workflow fills the same token and refuses a bad tag', () => {
    const wf = repo(DEPLOY_WORKFLOW);
    expect(wf).toMatch(/TRAEFIK_VERSION: \$\{\{ vars\.TRAEFIK_VERSION \}\}/);
    expect(wf).toContain('{{TRAEFIK_VERSION}}');
    // The tag reaches a sed and a URL, so its shape is checked before either.
    expect(wf).toMatch(/\^v\[0-9\]/);
    // Any `${{ }}` in a run script would be a shell injection, so it stays in env.
    expect(wf).not.toMatch(/run:[^\n]*\$\{\{\s*vars\.TRAEFIK_VERSION/);
  });
});
