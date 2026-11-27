/**
 * Census: nothing picks a cluster's workers by node name.
 *
 * A node's name is its server's name, and Linode cuts an instance label over
 * 50 characters to a prefix plus a hash, so `<project>-l4-standby-worker-1`
 * joined as `<project>-l4-st-d644a9d7`. Two lookups matched `-worker-` in
 * names: the failover's Ready wait (it waited 600 s for a worker that had
 * joined, then tore it down: linode/k8s-ha, 2026-11-15) and the pilot
 * standby's stale-worker reap. Both select by label now
 * (WORKER_NODE_SELECTOR, src/lib/deploy/k8s/node-roles.js).
 *
 * Flags, in src/ and the e2e harness, a string or regex literal that is a
 * bare role segment (`-worker-`, `-master`, `-db`, `-ca-`): the only use such
 * a literal has is matching a name. Building a name (`${cluster}-worker-${i}`)
 * is a template with the segment inside it, and is not flagged.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  countReadyNodes,
  isWorkerNode,
  WORKER_NODE_SELECTOR,
} from '../../../src/lib/deploy/k8s/node-roles.js';
import { loadCloudInit } from '../../../src/lib/iac/cloud-init.js';
import {
  DB_LABELS,
  type FakeNode,
  MASTER_LABELS,
  matchesSelector,
} from '../../_shared/fake-nodes.js';
import { REPO_ROOT, readRepoFile } from '../../_shared/source-files.js';
import { findWorkerNodeNames } from '../../e2e/checks/pilot-light.js';

const files = execFileSync('git', ['ls-files', 'src/*.js', 'src/**/*.js', 'tests/e2e/**/*.ts'], {
  cwd: REPO_ROOT,
  encoding: 'utf-8',
})
  .split('\n')
  .filter(Boolean);

/** A complete literal that is only a role segment: '-worker-', "-db", /-master/, `-ca-`. */
const ROLE_SEGMENT_LITERAL = /(['"`/])-(?:worker|master|db|ca)-?\1/;

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function offenders(): string[] {
  const out: string[] = [];
  for (const f of files) {
    code(readRepoFile(f))
      .split('\n')
      .forEach((line, i) => {
        if (ROLE_SEGMENT_LITERAL.test(line)) out.push(`${f}:${i + 1}: ${line.trim()}`);
      });
  }
  return out;
}

describe('worker nodes are picked by label', () => {
  it('no source matches a node by a role segment in its name', () => {
    expect(offenders()).toEqual([]);
  });

  it('flags the shapes it exists for', () => {
    const flagged = (s: string) => ROLE_SEGMENT_LITERAL.test(code(s));
    expect(flagged(".filter((l) => l.includes('-worker-'))")).toBe(true);
    expect(flagged('n.endsWith("-db")')).toBe(true);
    expect(flagged('/-master/.test(name)')).toBe(true);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: sample source text fed to the regex: building a name is not flagged
    expect(flagged('label: `${clusterName}-worker-${i + 1}`')).toBe(false);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: sample source text fed to the regex: building a name is not flagged
    expect(flagged('name: `${clusterName}-db`')).toBe(false);
    expect(flagged("// a '-worker-' node is stale")).toBe(false);
    expect(files.length).toBeGreaterThan(300);
  });

  // The cluster's three kinds of node, labelled the way k3s and the db
  // node's k3s agent label them. A worker has no role label of its own, so the
  // selector is "neither of the other two".
  const nodes: FakeNode[] = [
    { name: 'p-l4-st-2dda9ed1', labels: MASTER_LABELS },
    { name: 'p-l4-standby-db', labels: DB_LABELS },
    { name: 'p-l4-st-d644a9d7' },
    { name: 'p-l4-standby-ca-k2j4x9zq', labels: { 'node-pool': 'worker-pool' } },
  ];

  it('selects every worker and neither the master nor the db node', () => {
    const picked = nodes.filter((n) => matchesSelector(n.labels ?? {}, WORKER_NODE_SELECTOR));
    expect(picked.map((n) => n.name)).toEqual(['p-l4-st-d644a9d7', 'p-l4-standby-ca-k2j4x9zq']);
  });

  it('isWorkerNode agrees with the selector, so a node read as JSON is judged the same', () => {
    const variants: FakeNode[] = [
      ...nodes,
      { name: 'no-labels' },
      { name: 'other-dedicated', labels: { dedicated: 'gpu' } },
      { name: 'master-false', labels: { 'node-role.kubernetes.io/control-plane': '' } },
    ];
    for (const n of variants) {
      expect(isWorkerNode(n.labels), n.name).toBe(
        matchesSelector(n.labels ?? {}, WORKER_NODE_SELECTOR),
      );
    }
    expect(isWorkerNode(undefined)).toBe(true);
  });

  it("the harness's pilot-light check finds a Linode worker by label", () => {
    const json = JSON.stringify({
      items: nodes.map((n) => ({ metadata: { name: n.name, labels: n.labels ?? {} } })),
    });
    expect(findWorkerNodeNames(json)).toEqual(['p-l4-st-d644a9d7', 'p-l4-standby-ca-k2j4x9zq']);
    expect(findWorkerNodeNames('not json')).toBeNull();
  });

  it('never selects the node the database runs on', () => {
    // The db StatefulSet's nodeSelector is dedicated=db, so the node running
    // it always carries the label the selector excludes.
    const sts = readRepoFile('carbon/k8s/base/db/statefulset.yaml');
    expect(sts).toMatch(/nodeSelector:\s*\n\s+dedicated: db/);
    // Every provider's db node: its worker script loaded as the db role.
    for (const script of [
      'worker-init.sh',
      'do-worker-init.sh',
      'linode-worker-init.sh',
      'vultr-worker-init.sh',
      'scaleway-worker-init.sh',
    ]) {
      const text = loadCloudInit(script, { role: 'db' });
      expect(text, script).toContain('--node-label="dedicated=db"');
    }
    expect(WORKER_NODE_SELECTOR).toContain('dedicated!=db');
  });

  it('counts Ready rows, not NotReady ones', () => {
    const out = [
      'a   Ready   <none>   5m   v1',
      'b   NotReady   <none>   5m   v1',
      'c   Ready,SchedulingDisabled   <none>   5m   v1',
      '',
    ].join('\n');
    expect(countReadyNodes(out)).toBe(2);
    expect(countReadyNodes('')).toBe(0);
  });
});
