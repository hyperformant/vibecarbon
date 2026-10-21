/**
 * Every workload that talks to the Kubernetes API needs egress to it.
 *
 * Bug: Prometheus (vibecarbon-observability) runs kubernetes_sd_configs and
 * holds a ClusterRoleBinding, but its NetworkPolicy granted no egress to the
 * API server. Service discovery failed silently and the k8s dashboards stayed
 * empty. A pod whose ServiceAccount is the subject of a RoleBinding or
 * ClusterRoleBinding is an API client, so under any egress-restricting
 * NetworkPolicy it needs the apiserver pair the Traefik policy documents:
 * TCP 443 to the kubernetes Service ClusterIP (10.43.0.1) and TCP 6443 to
 * anywhere (the post-DNAT destination is the master's node IP, which changes
 * every deploy).
 *
 * A workload that no Egress policy selects is unrestricted. That is allowed
 * only for the clients named in UNRESTRICTED_API_CLIENTS, with the reason:
 * any other unselected API client fails, so a new one gets a policy (or a
 * deliberate entry) instead of silently running with open egress. The census
 * also bans the retired "service-role" wording in manifest comments.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

// "namespace/workload" of every API client that no Egress policy selects, and why.
const UNRESTRICTED_API_CLIENTS: Record<string, string> = {
  // kube-system carries no NetworkPolicy: the autoscaler talks to the API and
  // the cloud provider's API (whose address the provider owns).
  'kube-system/cluster-autoscaler': 'kube-system has no NetworkPolicy; it calls the cloud API',
};
const DEFAULT_NAMESPACE = 'vibecarbon';

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
    // Templated placeholders do not parse; such a file holds no manifest we can check.
  }
  return docs;
}

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
    namespace: kustomizeNamespace(dirname(file)) ?? doc.metadata?.namespace ?? DEFAULT_NAMESPACE,
  })),
);

const bound = new Set<string>(); // "namespace/name" of every bound ServiceAccount
for (const { doc } of all) {
  if (doc.kind !== 'RoleBinding' && doc.kind !== 'ClusterRoleBinding') continue;
  for (const s of doc.subjects ?? []) {
    if (s.kind === 'ServiceAccount')
      bound.add(`${s.namespace ?? doc.metadata?.namespace}/${s.name}`);
  }
}

const podTemplate = (doc: Doc): Doc =>
  doc.kind === 'CronJob' ? doc.spec?.jobTemplate?.spec?.template : doc.spec?.template;

const clients = all
  .filter((m) => ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'].includes(m.doc.kind))
  .map((m) => {
    const tpl = podTemplate(m.doc);
    return {
      id: `${relative(ROOT, m.file)} ${m.doc.kind}/${m.doc.metadata?.name}`,
      key: `${m.namespace}/${m.doc.metadata?.name}`,
      namespace: m.namespace,
      labels: (tpl?.metadata?.labels ?? {}) as Record<string, string>,
      sa: tpl?.spec?.serviceAccountName as string | undefined,
    };
  })
  .filter((w) => w.sa && bound.has(`${w.namespace}/${w.sa}`));

function selects(policy: Doc, labels: Record<string, string>): boolean {
  const want = policy.spec?.podSelector?.matchLabels ?? {};
  return Object.entries(want).every(([k, v]) => labels[k] === v);
}

function egressRulesFor(w: { namespace: string; labels: Record<string, string> }): Doc[] | null {
  const policies = all.filter(
    (m) =>
      m.doc.kind === 'NetworkPolicy' &&
      m.namespace === w.namespace &&
      (m.doc.spec?.policyTypes ?? []).includes('Egress') &&
      selects(m.doc, w.labels),
  );
  if (policies.length === 0) return null; // unrestricted egress
  return policies.flatMap((m) => m.doc.spec?.egress ?? []);
}

const wideOpen = (cidr: string) => cidr === '0.0.0.0/0';
function admits(rules: Doc[], port: number, cidrOk: (c: string) => boolean): boolean {
  return rules.some(
    (r) =>
      (r.to ?? []).some((p: Doc) => p.ipBlock && cidrOk(p.ipBlock.cidr)) &&
      (r.ports ?? []).some((p: Doc) => p.port === port && (p.protocol ?? 'TCP') === 'TCP'),
  );
}

describe('every Kubernetes API client can reach the API server', () => {
  it('finds the API clients (the walk is not empty)', () => {
    const ids = clients.map((c) => c.id).join('\n');
    expect(ids).toContain('prometheus-deployment.yaml');
    expect(ids).toContain('traefik/deployment.yaml');
  });

  it('every allowlisted unrestricted client exists and is still unselected', () => {
    for (const key of Object.keys(UNRESTRICTED_API_CLIENTS)) {
      const w = clients.find((c) => c.key === key);
      expect(w, `${key} is allowlisted but is no API client in the manifests`).toBeDefined();
      expect(egressRulesFor(w as (typeof clients)[number]), `${key} is now selected`).toBeNull();
    }
  });

  it.each(clients)('$id', (w) => {
    const rules = egressRulesFor(w);
    if (rules === null) {
      expect(
        Object.keys(UNRESTRICTED_API_CLIENTS),
        `${w.id} talks to the API with no Egress NetworkPolicy selecting it. Give it one, or allowlist it with the reason.`,
      ).toContain(w.key);
      return;
    }
    expect(
      admits(rules, 6443, wideOpen),
      `No Egress NetworkPolicy in ${w.namespace} lets ${w.id} reach TCP 6443 on 0.0.0.0/0 (the apiserver).`,
    ).toBe(true);
    expect(
      admits(rules, 443, (c) => c === '10.43.0.1/32' || wideOpen(c)),
      `No Egress NetworkPolicy in ${w.namespace} lets ${w.id} reach TCP 443 on 10.43.0.1/32 (the kubernetes Service).`,
    ).toBe(true);
  });
});

describe('manifest comments name no retired service-role key', () => {
  const offenders = manifestRoots
    .flatMap((r) => yamlFiles(r))
    .flatMap((f) =>
      readFileSync(f, 'utf-8')
        .split('\n')
        .map((line, i) => ({ f, line, n: i + 1 }))
        .filter(({ line }) => /^\s*#.*service-role/i.test(line)),
    )
    .map(({ f, n }) => `${relative(ROOT, f)}:${n}`);

  it('has no comment containing service-role', () => {
    expect(offenders).toEqual([]);
  });
});
