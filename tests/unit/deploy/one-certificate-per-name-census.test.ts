/**
 * FAMILY CENSUS: one certificate per name on k8s.
 *
 * RCA (DigitalOcean k8s-ha e2e, verify-restore `tls_reused`): the
 * observability add-on issued a second Let's Encrypt certificate,
 * `grafana-tls`, for the bare app domain. Traefik's certificate store is
 * global, so it held two certificates that both matched the domain's SNI and
 * picked either one each time it started. The TLS snapshot and restore cover
 * only `vibecarbon-tls`, so after a correct restore the domain could still
 * serve the other serial.
 *
 * The rule: `vibecarbon-tls` is the only certificate the cluster carries for
 * the app's names. Every other router takes it from Traefik's global store by
 * SNI (`tls: {}`), whatever its namespace.
 *
 * Renders what the deploy applies: `carbon/k8s/base` and every
 * `services/<name>/k8s`, following each kustomization's `resources` (files
 * and sub-directories) the way `kubectl apply -k` does. Nothing is listed by
 * hand, so a new add-on or a new file joins the census by existing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load, loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const BASE_CERTIFICATE = 'vibecarbon-tls';

type Doc = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: {
    secretName?: string;
    dnsNames?: string[];
    tls?: { secretName?: string; hosts?: string[] }[] | { secretName?: string } | null;
  };
};

// Template placeholders ({{PROJECT_NAME}}) are not valid unquoted YAML.
const readYamlText = (path: string) => readFileSync(path, 'utf8').replace(/\{\{[^}]*\}\}/g, 'x');

/** Every document a kustomization directory applies, with the file it came from. */
function renderKustomization(dir: string): { doc: Doc; file: string }[] {
  const kustPath = join(dir, 'kustomization.yaml');
  const kust = load(readYamlText(kustPath)) as { resources?: string[] };
  const out: { doc: Doc; file: string }[] = [];
  for (const res of kust.resources ?? []) {
    const path = join(dir, res);
    if (!existsSync(path)) throw new Error(`${kustPath} lists ${res}, which does not exist`);
    if (statSync(path).isDirectory()) {
      out.push(...renderKustomization(path));
      continue;
    }
    for (const doc of loadAll(readYamlText(path)) as Doc[]) {
      if (doc && typeof doc === 'object') out.push({ doc, file: path.slice(ROOT.length + 1) });
    }
  }
  return out;
}

const roots = [
  join(ROOT, 'carbon', 'k8s', 'base'),
  ...readdirSync(join(ROOT, 'services'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(ROOT, 'services', e.name, 'k8s'))
    .filter((dir) => existsSync(join(dir, 'kustomization.yaml'))),
];
const rendered = roots.flatMap(renderKustomization);

const certificates = rendered.filter(
  ({ doc }) => doc.kind === 'Certificate' && String(doc.apiVersion).startsWith('cert-manager.io/'),
);

/** The TLS secret names an IngressRoute or Ingress points at ('' for `tls: {}`). */
function tlsSecretNames(doc: Doc): string[] {
  const tls = doc.spec?.tls;
  if (!tls) return [];
  const entries = Array.isArray(tls) ? tls : [tls];
  return entries.map((t) => t?.secretName ?? '').filter(Boolean);
}

describe('one certificate per name (k8s)', () => {
  it('renders the base and every add-on that ships k8s manifests', () => {
    // A guard against a census that silently renders nothing.
    expect(roots.length).toBeGreaterThan(1);
    expect(rendered.some(({ doc }) => doc.kind === 'IngressRoute')).toBe(true);
  });

  it(`the only cert-manager Certificate is ${BASE_CERTIFICATE}`, () => {
    const names = certificates.map(({ doc, file }) => `${doc.metadata?.name} (${file})`);
    expect(names).toEqual([`${BASE_CERTIFICATE} (carbon/k8s/base/traefik/certificate.yaml)`]);
  });

  it(`no IngressRoute or Ingress names a TLS secret other than ${BASE_CERTIFICATE}`, () => {
    const routers = rendered.filter(({ doc }) =>
      /^(IngressRoute|IngressRouteTCP|Ingress)$/.test(String(doc.kind)),
    );
    expect(routers.length).toBeGreaterThan(0);
    const offenders = routers.flatMap(({ doc, file }) =>
      tlsSecretNames(doc)
        .filter((s) => s !== BASE_CERTIFICATE)
        .map((s) => `${doc.kind}/${doc.metadata?.name} in ${file} names secret ${s}`),
    );
    expect(offenders).toEqual([]);
  });

  it('a router outside the base namespace takes the certificate by SNI (tls: {})', () => {
    // Traefik reads tls.secretName from the router's own namespace only, so a
    // router in another namespace that named vibecarbon-tls would get no
    // certificate. The global store serves it by SNI instead.
    const grafana = rendered.find(
      ({ doc }) => doc.kind === 'IngressRoute' && doc.metadata?.name === 'vibecarbon-grafana',
    );
    expect(grafana?.doc.spec?.tls).toEqual({});
  });

  it('no two Certificates share a DNS name', () => {
    const seen = new Map<string, string>();
    const shared: string[] = [];
    for (const { doc } of certificates) {
      for (const name of doc.spec?.dnsNames ?? []) {
        const prior = seen.get(name);
        if (prior) shared.push(`${name}: ${prior} and ${doc.metadata?.name}`);
        else seen.set(name, String(doc.metadata?.name));
      }
    }
    expect(shared).toEqual([]);
  });
});
