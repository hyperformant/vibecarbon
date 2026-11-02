/**
 * One certificate per name on k8s: the observability add-on no longer issues
 * its own `grafana-tls` for the app domain (see
 * one-certificate-per-name-census.test.ts for the RCA). Two things remain for
 * an env or a project that still has it:
 *
 * - the cluster: a redeploy deletes the Certificate and its Secret,
 *   idempotently (removeRetiredObservabilityCertificate);
 * - the project tree: `vibecarbon add` copied the add-on's k8s files into
 *   k8s/base/observability, and `vibecarbon upgrade` does not refresh add-on
 *   files. A deploy of a project whose copy still issues grafana-tls is
 *   refused before anything is provisioned, with the exact edit that fixes
 *   it (staleObservabilityTlsProblem).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RETIRED_OBSERVABILITY_CERTIFICATE,
  removeRetiredObservabilityCertificate,
  staleObservabilityTlsProblem,
} from '../../../src/lib/deploy/k8s/one-certificate.js';

const ROOT = process.cwd();
const SHIPPED = join(ROOT, 'services', 'observability', 'k8s');

function projectWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-one-cert-'));
  const obs = join(dir, 'k8s', 'base', 'observability');
  mkdirSync(obs, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(obs, name), text);
  return dir;
}

const shipped = (name: string) => readFileSync(join(SHIPPED, name), 'utf8');

const STALE_KUSTOMIZATION = `namespace: vibecarbon-observability
resources:
  - middleware.yaml
  - grafana-tls-certificate.yaml
  - ingressroute.yaml
`;
const STALE_INGRESSROUTE = `apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: vibecarbon-grafana
spec:
  entryPoints:
    - websecure
  routes: []
  tls:
    secretName: grafana-tls
`;

describe('staleObservabilityTlsProblem', () => {
  it('names the retired certificate', () => {
    expect(RETIRED_OBSERVABILITY_CERTIFICATE).toEqual({
      namespace: 'vibecarbon-observability',
      name: 'grafana-tls',
    });
  });

  it('passes a project without the observability add-on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-one-cert-'));
    expect(staleObservabilityTlsProblem(dir)).toBeNull();
  });

  it('passes the files the add-on ships today', () => {
    const dir = projectWith({
      'kustomization.yaml': shipped('kustomization.yaml'),
      'ingressroute.yaml': shipped('ingressroute.yaml'),
    });
    expect(staleObservabilityTlsProblem(dir)).toBeNull();
  });

  it('refuses a copy that still lists grafana-tls-certificate.yaml, naming every edit', () => {
    const dir = projectWith({
      'kustomization.yaml': STALE_KUSTOMIZATION,
      'ingressroute.yaml': STALE_INGRESSROUTE,
      'grafana-tls-certificate.yaml': 'kind: Certificate\n',
    });
    const msg = staleObservabilityTlsProblem(dir) ?? '';
    expect(msg).toContain('grafana-tls');
    expect(msg).toContain('k8s/base/observability/grafana-tls-certificate.yaml');
    expect(msg).toContain('k8s/base/observability/kustomization.yaml');
    expect(msg).toContain('k8s/base/observability/ingressroute.yaml');
    expect(msg).toContain('tls: {}');
    expect(msg).toContain('Nothing was provisioned');
    expect(msg).not.toMatch(/—/);
  });

  it('refuses an IngressRoute that still names the grafana-tls secret on its own', () => {
    const dir = projectWith({
      'kustomization.yaml': shipped('kustomization.yaml'),
      'ingressroute.yaml': STALE_INGRESSROUTE,
    });
    expect(staleObservabilityTlsProblem(dir)).toContain('ingressroute.yaml');
  });

  it('ignores the name in a comment', () => {
    const dir = projectWith({
      'kustomization.yaml': `${shipped('kustomization.yaml')}\n# grafana-tls-certificate.yaml was retired\n`,
      'ingressroute.yaml': `${shipped('ingressroute.yaml')}\n# secretName: grafana-tls\n`,
    });
    expect(staleObservabilityTlsProblem(dir)).toBeNull();
  });
});

describe('removeRetiredObservabilityCertificate', () => {
  it('deletes the Certificate, then its Secret, idempotently', async () => {
    const calls: string[][] = [];
    await removeRetiredObservabilityCertificate({
      env: {},
      kubectl: async (argv: string[]) => {
        calls.push(argv);
        return '';
      },
    });
    expect(calls).toEqual([
      [
        '-n',
        'vibecarbon-observability',
        'delete',
        'certificate',
        'grafana-tls',
        '--ignore-not-found',
      ],
      ['-n', 'vibecarbon-observability', 'delete', 'secret', 'grafana-tls', '--ignore-not-found'],
    ]);
  });
});

describe('a k8s deploy refuses a stale add-on copy before anything is provisioned', () => {
  const k3s = readFileSync(join(ROOT, 'src', 'lib', 'deploy', 'k8s', 'k3s.js'), 'utf8');
  const orch = readFileSync(join(ROOT, 'src', 'lib', 'deploy', 'orchestrator.js'), 'utf8');

  it('checks the project in the preflight, k8s tiers only, before the operator-IP step', () => {
    const tierGate = orch.indexOf('assertTierSupported(providerFor(config), tier);');
    const check = orch.indexOf('staleObservabilityTlsProblem(process.cwd())');
    const operatorIp = orch.indexOf('// Operator-IP access:');
    expect(tierGate).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(tierGate);
    expect(check).toBeLessThan(operatorIp);
    expect(orch.slice(tierGate, check)).toContain('if (isK8sTier(tier)) {');
    expect(orch.slice(check, operatorIp)).toMatch(/throw new Error\(staleObservabilityTls\)/);
  });

  it('no longer patches or issues grafana-tls anywhere in the deploy', () => {
    expect(k3s).not.toMatch(/'patch',\s*'certificate',\s*'grafana-tls'/);
    expect(k3s).not.toContain('observabilityCertificateDnsNames');
  });
});
