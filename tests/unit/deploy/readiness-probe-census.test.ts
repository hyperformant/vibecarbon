/**
 * Census: every long-running container we ship to a cluster says when it is
 * ready.
 *
 * A container with no readiness probe is Ready as soon as its process starts,
 * which is not when it serves. The standby image copy waits for the registry
 * relay to be Ready and then connects once; with no probe it connected before
 * socat was listening and failed the linode/k8s-ha warm deploy (2026-11-15).
 * Anything that waits on Ready (`kubectl wait`, `rollout status`, a Service's
 * endpoints) is only as right as the probe behind it.
 *
 * Walks every git-tracked manifest under carbon/k8s/base and services/<name>/k8s.
 * A container without a probe needs an entry in EXEMPT that says why nothing
 * relies on its Ready.
 */
import { execFileSync } from 'node:child_process';
import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, readRepoFile } from '../../_shared/source-files.js';

const WORKLOADS = new Set(['Pod', 'Deployment', 'StatefulSet', 'DaemonSet']);

/** `<file>:<workload>/<container>` → why its Ready is not relied on. */
const EXEMPT: Record<string, string> = {
  'carbon/k8s/base/repl-gateway/repl-gateway.yaml:repl-gateway/relay':
    'nothing waits on its Ready: the standby walreceiver dials through it and retries on its own, ' +
    'and a spec change rolls the replication relay on every existing cluster',
  'carbon/k8s/base/cluster-autoscaler/deployment.yaml:cluster-autoscaler/cluster-autoscaler':
    'nothing dials it, and its pod is Ready only once the carbon-autoscaler sidecar (the gRPC ' +
    'provider it calls) passes its own readiness probe',
};

const files = execFileSync(
  'git',
  ['ls-files', 'carbon/k8s/base/**/*.yaml', 'services/*/k8s/*.yaml'],
  { cwd: REPO_ROOT, encoding: 'utf-8' },
)
  .split('\n')
  .filter(Boolean);

interface Container {
  name: string;
  readinessProbe?: unknown;
}

function containersIn(file: string): Array<{ key: string; container: Container }> {
  // `{{TOKEN}}` placeholders are rendered at deploy time; an unquoted one is
  // a YAML flow mapping, so drop the braces before parsing the raw template.
  const text = readRepoFile(file).replace(/\{\{([A-Z0-9_]+)\}\}/g, '$1');
  const out: Array<{ key: string; container: Container }> = [];
  // biome-ignore lint/suspicious/noExplicitAny: parsed YAML
  for (const doc of loadAll(text) as any[]) {
    if (!doc || !WORKLOADS.has(doc.kind)) continue;
    const spec = doc.kind === 'Pod' ? doc.spec : doc.spec?.template?.spec;
    for (const container of (spec?.containers ?? []) as Container[]) {
      out.push({ key: `${file}:${doc.metadata?.name}/${container.name}`, container });
    }
  }
  return out;
}

describe('readiness probe census', () => {
  const all = files.flatMap(containersIn);

  it('every long-running container has a readiness probe, or a reason it needs none', () => {
    const missing = all
      .filter(({ key, container }) => !container.readinessProbe && !(key in EXEMPT))
      .map(({ key }) => key);
    expect(missing).toEqual([]);
  });

  it('every exemption still names a container that has no probe', () => {
    const byKey = new Map(all.map(({ key, container }) => [key, container]));
    for (const key of Object.keys(EXEMPT)) {
      expect(byKey.has(key), key).toBe(true);
      expect(byKey.get(key)?.readinessProbe, key).toBeUndefined();
    }
  });

  it('walks the manifests it exists for', () => {
    const keys = all.map(({ key }) => key);
    expect(keys).toContain('carbon/k8s/base/repl-gateway/registry-relay.yaml:registry-relay/relay');
    expect(keys).toContain('carbon/k8s/base/db/statefulset.yaml:db/db');
    expect(keys.some((k) => k.startsWith('services/observability/k8s/'))).toBe(true);
    expect(keys.length).toBeGreaterThanOrEqual(12);
  });
});
