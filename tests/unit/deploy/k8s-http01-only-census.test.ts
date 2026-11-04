import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..');
const ROOT = join(REPO, 'carbon', 'k8s');
const SCANNED = [
  join(REPO, 'src'),
  join(REPO, 'carbon', 'k8s'),
  join(REPO, 'carbon', '.github'),
  join(REPO, 'carbon', 'scripts'),
];

function yamlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/.test(name) ? [path] : [];
  });
}

// Template placeholders ({{X}}) are not always valid YAML; a file that does
// not parse is skipped here and covered by the manifest dry-run.
function docs(): Array<{ file: string; doc: any }> {
  return yamlFiles(ROOT).flatMap((file) => {
    try {
      return loadAll(readFileSync(file, 'utf8'))
        .map((doc) => ({ file, doc: doc as any }))
        .filter((d) => d.doc && typeof d.doc === 'object');
    } catch {
      return [];
    }
  });
}

function textFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return textFiles(path);
    return /\.(js|mjs|ya?ml|sh|md)$/.test(name) ? [path] : [];
  });
}

describe('k8s manifests are HTTP-01 only', () => {
  const issuers = docs().filter((d) => d.doc.kind === 'ClusterIssuer');
  const acme = issuers.filter((d) => d.doc.spec?.acme);

  it('actually read the expected inputs, so the absence checks cannot pass on empty input', () => {
    expect(issuers.length).toBeGreaterThanOrEqual(2);
    expect(docs().some((d) => d.file.endsWith('certificate.yaml'))).toBe(true);
    expect(SCANNED.flatMap(textFiles).length).toBeGreaterThan(20);
  });

  it('no DNS-01 machinery survives in src, carbon/k8s, carbon/.github or carbon/scripts', () => {
    const banned: Array<[string, RegExp]> = [
      ['dns01-recursive-nameservers', /dns01-recursive-nameservers/],
      ['cert-manager-webhook-hetzner', /cert-manager-webhook-hetzner/],
      ['findStalledAcmeChallenges', /findStalledAcmeChallenges/],
      [
        'DNS provider Secret',
        /name:\s*['"]?(digitalocean-dns|cloudflare-api-token|hetzner)['"]?\s*$/m,
      ],
    ];
    const hits: string[] = [];
    for (const file of SCANNED.flatMap(textFiles)) {
      const text = readFileSync(file, 'utf8');
      for (const [label, re] of banned) if (re.test(text)) hits.push(`${file}: ${label}`);
    }
    expect(hits).toEqual([]);
  });

  it('no ClusterIssuer has a dns01 solver', () => {
    for (const { doc } of issuers) {
      for (const s of doc.spec?.acme?.solvers ?? []) expect(s.dns01).toBeUndefined();
    }
  });

  it('the only ACME ClusterIssuers are letsencrypt-prod and letsencrypt-staging, via traefik', () => {
    expect(acme.map((d) => d.doc.metadata.name).sort()).toEqual([
      'letsencrypt-prod',
      'letsencrypt-staging',
    ]);
    for (const { doc } of acme) {
      expect(doc.spec.acme.solvers).toHaveLength(1);
      expect(doc.spec.acme.solvers[0].http01.ingress.class).toBe('traefik');
      expect(doc.spec.acme.privateKeySecretRef.name).toBe(`${doc.metadata.name}-account-key`);
    }
  });

  it('no Certificate name is a wildcard', () => {
    for (const { doc } of docs()) {
      for (const n of doc.spec?.dnsNames ?? []) expect(String(n).startsWith('*.')).toBe(false);
    }
  });
});
