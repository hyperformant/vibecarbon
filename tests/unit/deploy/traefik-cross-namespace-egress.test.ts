/**
 * Every IngressRoute Traefik serves from another namespace needs an egress
 * rule letting Traefik reach that backend.
 *
 * Bug: Grafana's IngressRoute lives in vibecarbon-observability (it must sit
 * beside its Service; Traefik has no allowCrossNamespace), and grafana-policy
 * admits Traefik's ingress, but traefik-policy only allowed egress to its own
 * namespace. A NetworkPolicy path needs BOTH ends, so every request to
 * /admin/grafana died between Traefik and Grafana with a 502, from the first
 * public release on. The e2e Grafana check passed anyway on the app's SPA page
 * at the wrong path, which hid it until the check was made real.
 *
 * This walks every IngressRoute in the repo, so an add-on that moves to its
 * own namespace is drafted into the check automatically.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const TRAEFIK_NAMESPACE = 'vibecarbon';
const TRAEFIK_LABELS = { app: 'vibecarbon-traefik' };

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
type Doc = any;

function yamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...yamlFiles(path));
    else if (/\.ya?ml$/.test(name)) out.push(path);
  }
  return out;
}

function docsIn(path: string): Doc[] {
  const docs: Doc[] = [];
  try {
    loadAll(readFileSync(path, 'utf-8'), (d) => {
      if (d && typeof d === 'object') docs.push(d);
    });
  } catch {
    // Not every .yaml under k8s/ is a plain manifest (templated placeholders);
    // a file that does not parse holds no IngressRoute we could check anyway.
  }
  return docs;
}

/** The namespace a kustomization transformer forces on this directory, if any. */
function kustomizeNamespace(dir: string): string | undefined {
  for (const name of ['kustomization.yaml', 'kustomization.yml']) {
    const k = docsIn(join(dir, name))[0];
    if (k?.namespace) return k.namespace;
  }
  return undefined;
}

const manifestRoots = [join(ROOT, 'carbon/k8s'), join(ROOT, 'services')];
const files = manifestRoots
  .flatMap((r) => yamlFiles(r))
  .filter((f) => f.includes('/k8s/') || f.startsWith(join(ROOT, 'carbon/k8s')));
const all = files.flatMap((file) =>
  docsIn(file).map((doc) => ({
    file,
    doc,
    namespace: kustomizeNamespace(dirname(file)) ?? doc.metadata?.namespace ?? TRAEFIK_NAMESPACE,
  })),
);

/** Target port a Service port forwards to (the pod port a NetworkPolicy sees). */
function targetPort(service: string, namespace: string, port: number): number {
  const svc = all.find(
    (m) =>
      m.doc.kind === 'Service' && m.doc.metadata?.name === service && m.namespace === namespace,
  );
  const p = svc?.doc.spec?.ports?.find((x: Doc) => x.port === port);
  return typeof p?.targetPort === 'number' ? p.targetPort : port;
}

const crossNamespaceBackends = all
  .filter((m) => m.doc.kind === 'IngressRoute' && m.namespace !== TRAEFIK_NAMESPACE)
  .flatMap((m) =>
    (m.doc.spec?.routes ?? []).flatMap((route: Doc) =>
      (route.services ?? []).map((s: Doc) => ({
        route: `${relative(ROOT, m.file)} ${route.match}`,
        namespace: m.namespace,
        port: targetPort(s.name, m.namespace, s.port),
      })),
    ),
  );

const selectsTraefik = (policy: Doc) =>
  Object.entries(TRAEFIK_LABELS).every(
    ([k, v]) => policy.spec?.podSelector?.matchLabels?.[k] === v,
  );

function traefikMayReach(namespace: string, port: number): boolean {
  return all
    .filter(
      (m) =>
        m.doc.kind === 'NetworkPolicy' &&
        m.namespace === TRAEFIK_NAMESPACE &&
        selectsTraefik(m.doc),
    )
    .some((m) =>
      (m.doc.spec?.egress ?? []).some(
        (rule: Doc) =>
          (rule.to ?? []).some(
            (peer: Doc) =>
              peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === namespace,
          ) &&
          (!rule.ports || rule.ports.some((p: Doc) => p.port === port)),
      ),
    );
}

describe('Traefik can reach every backend it routes to in another namespace', () => {
  it('finds the cross-namespace routes (the walk is not empty)', () => {
    expect(crossNamespaceBackends.map((b) => b.namespace)).toContain('vibecarbon-observability');
  });

  it.each(crossNamespaceBackends)('$route -> $namespace:$port', ({ namespace, port }) => {
    expect(
      traefikMayReach(namespace, port),
      `No NetworkPolicy in ${TRAEFIK_NAMESPACE} lets app=vibecarbon-traefik egress to ` +
        `namespace ${namespace} on TCP ${port}; Traefik answers 502 for this route.`,
    ).toBe(true);
  });
});
