/**
 * One certificate per name on k8s: the observability add-on no longer issues
 * its own `grafana-tls` for the app domain (see
 * one-certificate-per-name-census.test.ts for the RCA). Two things remain for
 * an env or a project that still has it:
 *
 * - the cluster: a redeploy deletes the Certificate and its Secret,
 *   idempotently (removeRetiredObservabilityCertificate);
 * - the project tree: `vibecarbon add` copied the add-on's k8s files into
 *   k8s/base/observability, and `vibecarbon upgrade` refreshes them. A
 *   deploy of a project whose copy still issues grafana-tls is refused
 *   before anything is provisioned, naming `vibecarbon upgrade`
 *   (staleObservabilityTlsProblem).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RETIRED_OBSERVABILITY_CERTIFICATE,
  removeRetiredObservabilityCertificate,
  retireObservabilityCertificateIfPresent,
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

  it('refuses a copy that still lists grafana-tls-certificate.yaml: one line, run upgrade', () => {
    const dir = projectWith({
      'kustomization.yaml': STALE_KUSTOMIZATION,
      'ingressroute.yaml': STALE_INGRESSROUTE,
      'grafana-tls-certificate.yaml': 'kind: Certificate\n',
    });
    expect(staleObservabilityTlsProblem(dir)).toBe(
      'Your observability add-on files are out of date. Run `vibecarbon upgrade`, then deploy again.',
    );
  });

  it('refuses an IngressRoute that still names the grafana-tls secret on its own', () => {
    const dir = projectWith({
      'kustomization.yaml': shipped('kustomization.yaml'),
      'ingressroute.yaml': STALE_INGRESSROUTE,
    });
    expect(staleObservabilityTlsProblem(dir)).toContain('`vibecarbon upgrade`');
  });

  it('ignores the name in a comment', () => {
    const dir = projectWith({
      'kustomization.yaml': `${shipped('kustomization.yaml')}\n# grafana-tls-certificate.yaml was retired\n`,
      'ingressroute.yaml': `${shipped('ingressroute.yaml')}\n# secretName: grafana-tls\n`,
    });
    expect(staleObservabilityTlsProblem(dir)).toBeNull();
  });
});

const NS = 'vibecarbon-observability';
const routeList = (routes: { name: string; secretName?: string }[]) =>
  JSON.stringify({
    items: routes.map((r) => ({
      metadata: { name: r.name },
      spec: { tls: r.secretName ? { secretName: r.secretName } : {} },
    })),
  });

/** A kubectl stand-in: the namespace exists when `namespace` is set; routes answer the list. */
function fakeKubectl({ namespace = true, routes = '' } = {}) {
  const calls: string[][] = [];
  const kubectl = async (argv: string[]) => {
    calls.push(argv);
    if (argv.includes('namespace')) return namespace ? `namespace/${NS}\n` : '';
    if (argv.includes('ingressroute') && argv.includes('get')) return routes;
    return '';
  };
  return { calls, kubectl };
}

describe('removeRetiredObservabilityCertificate', () => {
  it('deletes any IngressRoute naming grafana-tls, then the Certificate, then its Secret', async () => {
    const { calls, kubectl } = fakeKubectl({
      routes: routeList([
        { name: 'vibecarbon-grafana', secretName: 'grafana-tls' },
        { name: 'other', secretName: 'vibecarbon-tls' },
        { name: 'sni' },
      ]),
    });
    await removeRetiredObservabilityCertificate({ env: {}, kubectl });
    expect(calls).toEqual([
      ['-n', NS, 'get', 'ingressroute', '-o', 'json'],
      ['-n', NS, 'delete', 'ingressroute', 'vibecarbon-grafana', '--ignore-not-found'],
      ['-n', NS, 'delete', 'certificate', 'grafana-tls', '--ignore-not-found'],
      ['-n', NS, 'delete', 'secret', 'grafana-tls', '--ignore-not-found'],
    ]);
  });

  it('an empty or unreadable route list deletes no route, still the Certificate and Secret', async () => {
    for (const routes of ['', 'not json', routeList([])]) {
      const { calls, kubectl } = fakeKubectl({ routes });
      await removeRetiredObservabilityCertificate({ env: {}, kubectl });
      expect(calls.filter((a) => a.includes('delete')).map((a) => a[3])).toEqual([
        'certificate',
        'secret',
      ]);
    }
  });
});

describe('retireObservabilityCertificateIfPresent', () => {
  it('gated on the observability namespace, not on the project files', async () => {
    const absent = fakeKubectl({ namespace: false });
    expect(
      await retireObservabilityCertificateIfPresent({ env: {}, kubectl: absent.kubectl }),
    ).toBe(false);
    expect(absent.calls).toEqual([['get', 'namespace', NS, '--ignore-not-found', '-o', 'name']]);

    const present = fakeKubectl({ namespace: true });
    expect(
      await retireObservabilityCertificateIfPresent({ env: {}, kubectl: present.kubectl }),
    ).toBe(true);
    expect(present.calls.filter((a) => a.includes('delete')).map((a) => a[3])).toEqual([
      'certificate',
      'secret',
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
