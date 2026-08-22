/**
 * Drift guards for the Hetzner DNS-01 webhook wiring across the TWO install
 * paths (2026-07-15 multi-provider audit, bug 2).
 *
 * The runtime contract has one binding point: the ClusterIssuer's
 * `tokenSecretKeyRef` (k8s/infra/cert-manager-resources) names the Secret the
 * webhook reads at challenge time — `hetzner` / key `token` in cert-manager.
 * The chart itself reads NO secret-related Helm values (verified against
 * charts.hetzner.cloud 0.7.0 AND 0.8.0 — values.yaml differs only in image
 * tag), so any `values.secret` on the HelmRelease is inert, and a workflow
 * that creates a differently-named Secret leaves the webhook with nothing to
 * read: Orders fail on every gitops (configure cicd) deploy.
 *
 * Guards:
 *  1. The gitops workflow must create the SAME Secret the issuers reference
 *     (and that buildDnsProviderSecret creates on the dev-push path).
 *  2. Both install paths must pin the SAME chart version — bump together.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('gitops workflow creates the Secret the ClusterIssuers reference', () => {
  it('cluster-issuers-hetzner.yaml pins the tokenSecretKeyRef contract (hetzner/token)', () => {
    const issuers = read('carbon/k8s/infra/cert-manager-resources/cluster-issuers-hetzner.yaml');
    expect(issuers).toMatch(/tokenSecretKeyRef:\s*\n\s*name: hetzner\s*\n\s*key: token/);
  });

  it('deploy.yml creates Secret/hetzner with key `token` in cert-manager', () => {
    const wf = read('carbon/.github/workflows/deploy.yml');
    expect(wf).toMatch(
      /kubectl create secret generic hetzner \\\s*\n\s*--namespace=cert-manager \\\s*\n\s*--from-literal=token=/,
    );
    // The old wiring created a Secret nothing reads.
    expect(wf).not.toContain('hetzner-api-token');
  });

  it('the HelmRelease carries no secret values (the chart reads none)', () => {
    const hr = read('carbon/k8s/gitops/cert-manager-webhook-hetzner/helm-release.yaml');
    expect(hr).not.toMatch(/^\s*values:/m);
    expect(hr).not.toContain('hetzner-api-token');
  });
});

/**
 * The gitops (configure cicd) path creates the cert-manager Secrets from
 * GitHub Environment secrets instead of from buildDnsProviderSecret. Until
 * 2026-08 it had a hetzner arm and nothing else, so a cloudflare gitops
 * deploy shipped ClusterIssuers whose apiTokenSecretRef pointed at a Secret
 * no job ever created — Orders Pending, no error at apply time. This census
 * makes every issuer file's Secret reference prove it has a creating arm.
 */
describe('deploy.yml creates a Secret for every ClusterIssuer that references one', () => {
  const ISSUER_DIR = 'carbon/k8s/infra/cert-manager-resources';

  /** ClusterIssuer files that reference a Secret, with the name+key they expect. */
  function issuerSecretRefs() {
    return readdirSync(join(ROOT, ISSUER_DIR))
      .filter((f) => f.startsWith('cluster-issuers-') && f.endsWith('.yaml'))
      .map((file) => {
        const yaml = read(join(ISSUER_DIR, file));
        // Covers all three solver shapes: cloudflare apiTokenSecretRef,
        // digitalocean tokenSecretRef, hetzner webhook tokenSecretKeyRef.
        const m = yaml.match(
          /(?:apiTokenSecretRef|tokenSecretRef|tokenSecretKeyRef):\s*\n\s*name: ([\w-]+)\s*\n\s*key: ([\w-]+)/,
        );
        const provider = file.slice('cluster-issuers-'.length, -'.yaml'.length);
        return m ? { provider, name: m[1], key: m[2] } : { provider, name: null, key: null };
      });
  }

  it('found the issuer files (guards against a silently-empty census)', () => {
    const refs = issuerSecretRefs();
    expect(refs.length).toBeGreaterThanOrEqual(4);
    // manual is HTTP-01: no Secret, hence no CI arm.
    expect(refs.find((r) => r.provider === 'manual')?.name).toBeNull();
    expect(refs.filter((r) => r.name).length).toBeGreaterThanOrEqual(3);
  });

  it('has a DNS_PROVIDER-gated arm creating each referenced Secret in cert-manager', () => {
    const wf = read('carbon/.github/workflows/deploy.yml');
    for (const { provider, name, key } of issuerSecretRefs()) {
      if (!name) continue;
      expect(wf).toContain(`vars.DNS_PROVIDER == '${provider}'`);
      expect(wf).toMatch(
        new RegExp(
          `kubectl create secret generic ${name} \\\\\\s*\\n\\s*--namespace=cert-manager \\\\\\s*\\n\\s*--from-literal=${key}=`,
        ),
      );
    }
  });

  it('excludes every DNS-01 provider token from the app-facing vibecarbon-secrets bag', () => {
    // vibecarbon-secrets is envFrom'd wholesale into the app pod, and it is
    // built from toJSON(secrets) minus an exclude list. An infra credential
    // that has its own cert-manager Secret must not also be handed to
    // application code.
    const wf = read('carbon/.github/workflows/deploy.yml');
    const excludeList = wf.match(/del\(([\s\S]*?)\)/)?.[1] ?? '';
    const armTokens = [...wf.matchAll(/^\s+([A-Z0-9_]+): \$\{\{ secrets\.\1 \}\}$/gm)].map(
      (m) => m[1],
    );
    expect(armTokens).toContain('DIGITALOCEAN_TOKEN');
    for (const token of armTokens) {
      if (token === 'KUBECONFIG_B64') continue;
      expect(excludeList).toContain(`.${token}`);
    }
  });

  it('maps tokens in through env: blocks, never inlining a secret expression in run:', () => {
    // `${{ secrets.X }}` interpolated straight into a shell line lands the
    // token in the command string; the env: indirection keeps it out.
    const wf = read('carbon/.github/workflows/deploy.yml');
    for (const line of wf.split('\n')) {
      if (/kubectl create secret/.test(line) || /--from-literal=/.test(line)) {
        expect(line).not.toContain('secrets.');
      }
    }
  });
});

describe('both webhook install paths pin the same chart version', () => {
  it("HelmRelease version equals the hetzner webhook pin in dns-provider.js's DNS01_PROVIDERS", () => {
    const providers = read('src/lib/dns-provider.js');
    const imperative = providers.match(
      /chart: 'hetzner-cloud\/cert-manager-webhook-hetzner',\s*\n\s*version: '([\d.]+)'/,
    )?.[1];
    expect(imperative).toBeTruthy();

    const hr = read('carbon/k8s/gitops/cert-manager-webhook-hetzner/helm-release.yaml');
    const gitops = hr.match(/^\s+version: ([\d.]+)$/m)?.[1];
    expect(gitops).toBe(imperative);
  });
});
