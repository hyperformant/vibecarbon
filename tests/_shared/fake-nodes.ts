/**
 * A fake `kubectl get nodes` that applies the label selector the way the API
 * server does, so a test of a worker lookup sees only what the cluster would
 * return. A stub that returned every node no matter the argv could not tell
 * a lookup that filters by label from one that filters by name.
 *
 * Supports the selector forms the CLI sends: `key`, `!key`, `key=value`,
 * `key!=value` (`!=` also matches a node without the key), comma-joined.
 */

export interface FakeNode {
  name: string;
  labels?: Record<string, string>;
  /** Default `Ready`. */
  status?: string;
}

/** The three node kinds of a vibecarbon k3s cluster, as the cluster labels them. */
export const MASTER_LABELS = { 'node-role.kubernetes.io/control-plane': 'true' };
export const DB_LABELS = { dedicated: 'db', 'node-pool': 'db-pool' };

export function matchesSelector(labels: Record<string, string>, selector: string): boolean {
  return selector
    .split(',')
    .filter(Boolean)
    .every((term) => {
      const ne = term.match(/^([^!=]+)!=(.*)$/);
      if (ne) return labels[ne[1]] !== ne[2];
      const eq = term.match(/^([^!=]+)==?(.*)$/);
      if (eq) return labels[eq[1]] === eq[2];
      if (term.startsWith('!')) return !(term.slice(1) in labels);
      return term in labels;
    });
}

/** The nodes `argv` (kubectl's own, no leading `kubectl`) would list. */
export function selectNodes(nodes: FakeNode[], argv: string[]): FakeNode[] {
  const i = argv.indexOf('-l');
  const selector = i >= 0 ? argv[i + 1] : '';
  return nodes.filter((n) => matchesSelector(n.labels ?? {}, selector));
}

/** `kubectl get nodes [...] --no-headers` (default columns) or `-o name`. */
export function getNodesOutput(nodes: FakeNode[], argv: string[]): string {
  const picked = selectNodes(nodes, argv);
  if (argv.includes('name')) return picked.map((n) => `node/${n.name}\n`).join('');
  return picked
    .map((n) => `${n.name}   ${n.status ?? 'Ready'}   <none>   5m   v1.37.2+k3s1`)
    .join('\n');
}
