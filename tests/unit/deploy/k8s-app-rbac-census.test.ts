/**
 * What the app's Kubernetes identity can read (security plan 2026-10-20,
 * Task 3, R11). On compose the app's Docker access is a path-allowlisted
 * proxy (list and logs only); on k8s the same narrowness comes from RBAC, and
 * this census keeps it that way:
 *   - every namespaced binding to the app ServiceAccount is a RoleBinding to
 *     a Role that grants only `get/list` on `pods` and `get` on `pods/log`:
 *     never `secrets`, `configmaps`, a wildcard, or a write verb;
 *   - the one cluster-wide grant is ClusterRole `vibecarbon-app-nodes`, bound
 *     to the app by a ClusterRoleBinding, granting `get/list` on `nodes` and
 *     nothing else (the app reads each node's host restart state from it);
 *   - pod specs reach credentials by `valueFrom` (a Secret key's name), so a
 *     pod read never carries a password: no workload under carbon/k8s/base sets
 *     a credential-looking env name as a literal `value:`.
 *
 * The base is rendered with `kubectl kustomize` (as k8s-db-statefulset.test.ts
 * does); the add-on manifests under services/*\/k8s are read as-is so an add-on
 * binding to the app's ServiceAccount is caught too.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const APP_SA = 'vibecarbon-app';

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
type Doc = any;

function kustomize(path: string): Doc[] {
  const res = spawnSync('kubectl', ['kustomize', path], { cwd: ROOT, encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`kustomize build failed:\n${res.stderr}`);
  return (loadAll(res.stdout) as Doc[]).filter(Boolean);
}

function addonDocs(): Doc[] {
  const docs: Doc[] = [];
  const services = join(ROOT, 'services');
  for (const name of readdirSync(services)) {
    const dir = join(services, name, 'k8s');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      // Some add-on manifests carry {{…}} placeholders (a PVC's storage
      // class); fill them so the file parses, as `vibecarbon add` would.
      const text = readFileSync(join(dir, file), 'utf-8').replace(/\{\{[^}]+\}\}/g, 'x');
      docs.push(...(loadAll(text) as Doc[]).filter(Boolean));
    }
  }
  return docs;
}

const base = kustomize('carbon/k8s/base');
const all = [...base, ...addonDocs()];

const bindsAppSa = (doc: Doc) =>
  (doc.subjects ?? []).some((s: Doc) => s.kind === 'ServiceAccount' && s.name === APP_SA);

describe('k8s: the app ServiceAccount reads pods and their logs, nothing else', () => {
  const bindings = all.filter(
    (d) => (d.kind === 'RoleBinding' || d.kind === 'ClusterRoleBinding') && bindsAppSa(d),
  );

  it('found the app binding', () => {
    expect(bindings.length).toBeGreaterThan(0);
  });

  const roleBindings = bindings.filter((b) => b.kind === 'RoleBinding');
  const clusterBindings = bindings.filter((b) => b.kind === 'ClusterRoleBinding');

  it('every namespaced binding is a RoleBinding to a Role', () => {
    expect(roleBindings.length).toBeGreaterThan(0);
    for (const b of roleBindings) {
      expect(b.roleRef?.kind, b.metadata?.name).toBe('Role');
    }
  });

  it('the bound Roles grant get/list on pods and get on pods/log only', () => {
    const allowed: Record<string, string[]> = { pods: ['get', 'list'], 'pods/log': ['get'] };
    for (const b of roleBindings) {
      const role = all.find((d) => d.kind === 'Role' && d.metadata?.name === b.roleRef.name);
      expect(role, `Role ${b.roleRef.name} not found`).toBeDefined();
      for (const rule of role.rules ?? []) {
        expect(rule.apiGroups, `${role.metadata.name} apiGroups`).toEqual(['']);
        expect(rule.resourceNames, `${role.metadata.name} resourceNames`).toBeUndefined();
        expect(rule.nonResourceURLs, `${role.metadata.name} nonResourceURLs`).toBeUndefined();
        for (const resource of rule.resources ?? []) {
          expect(Object.keys(allowed), `${role.metadata.name} grants ${resource}`).toContain(
            resource,
          );
          for (const verb of rule.verbs ?? []) {
            expect(
              allowed[resource],
              `${role.metadata.name} grants ${verb} on ${resource}`,
            ).toContain(verb);
          }
        }
      }
    }
  });

  it('is bound to exactly one ClusterRole, which grants get/list on nodes and nothing else', () => {
    expect(clusterBindings.map((b) => b.metadata?.name)).toEqual(['vibecarbon-app-nodes']);
    const [binding] = clusterBindings;
    expect(binding.roleRef).toEqual({
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'ClusterRole',
      name: 'vibecarbon-app-nodes',
    });
    const roles = all.filter(
      (d) => d.kind === 'ClusterRole' && d.metadata?.name === binding.roleRef.name,
    );
    expect(roles).toHaveLength(1);
    expect(roles[0].aggregationRule).toBeUndefined();
    expect(roles[0].rules).toEqual([
      { apiGroups: [''], resources: ['nodes'], verbs: ['get', 'list'] },
    ]);
  });

  it('no other subject-kind binding reaches the app through a group or the namespace', () => {
    // A ClusterRoleBinding to a broad group would also give the app power.
    for (const d of all.filter((x) => x.kind === 'ClusterRoleBinding')) {
      if (d.metadata?.name === 'vibecarbon-app-nodes') continue;
      expect(bindsAppSa(d), d.metadata?.name).toBe(false);
    }
  });
});

describe('k8s: workloads reach credentials by reference, never as a literal', () => {
  const CREDENTIAL = /PASSWORD|SECRET|TOKEN|_KEY$/;
  const podSpec = (d: Doc) =>
    d.kind === 'CronJob' ? d.spec?.jobTemplate?.spec?.template?.spec : d.spec?.template?.spec;
  const workloads = base.filter((d) =>
    ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'].includes(d.kind),
  );

  it('found the app and db workloads', () => {
    const names = workloads.map((w) => w.metadata.name);
    expect(names).toEqual(expect.arrayContaining(['app', 'db']));
  });

  it('no credential-looking env is set as a literal value', () => {
    const literals: string[] = [];
    for (const w of workloads) {
      const spec = podSpec(w);
      for (const c of [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])]) {
        for (const e of c.env ?? []) {
          if (CREDENTIAL.test(e.name) && e.value !== undefined) {
            literals.push(`${w.kind}/${w.metadata.name} ${c.name} ${e.name}`);
          }
        }
      }
    }
    expect(literals).toEqual([]);
  });
});
