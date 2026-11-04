import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..', 'carbon', 'k8s');

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

describe('k8s manifests are HTTP-01 only', () => {
  const issuers = docs().filter((d) => d.doc.kind === 'ClusterIssuer');
  const acme = issuers.filter((d) => d.doc.spec?.acme);

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
