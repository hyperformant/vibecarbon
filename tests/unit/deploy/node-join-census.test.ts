/**
 * Census: a wait that needs a cluster node other than the k3s server checks
 * first that the nodes joined, and every provider can say what it knows
 * about a server that did not.
 *
 * WHY (perf run 45922250720, hetzner/k8s-ha restore-deploy, 2026-11-27): the
 * primary's database server was created and never answered ssh or joined.
 * Nothing waited for it to join, so db-0 sat Pending for awaitDbRollout's
 * 900 s, the failure named only the pod, and the rig was destroyed before
 * anyone read Hetzner's view of the server (the second time: hit 1 was
 * 2026-11-06). The check is awaitNodesJoined (src/lib/deploy/k8s/node-join.js):
 * it stops at its own deadline naming the server, with the provider's status
 * and recent actions (BaseProvider.describeServerForDiagnosis).
 *
 * What this walks (vite's parseAst over every `.js` under src/, so a comment
 * never counts):
 *   - every provider in PROVIDERS owns describeServerForDiagnosis, or is in
 *     NO_SERVER_VIEW with the reason its API has no such read; each one reads
 *     only through BaseProvider._readForDiagnosis, which sends a GET and
 *     nothing else;
 *   - every call of a wait that needs a node other than the k3s server
 *     (NODE_WAITS) sits in a function registered in WAIT_SITES, which either
 *     runs the check before it, in its own body, or says why it needs none;
 *   - every function that reads the node list (`kubectl get nodes`) is in
 *     NODE_READERS: the check itself, or a single read that is not a wait. A
 *     new hand-rolled node poll lands here and must go through the check.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';
import { BaseProvider } from '../../../src/lib/providers/base.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import {
  calleeName,
  isFunctionNode,
  type AstNode as Node,
  walkAst,
} from '../../_shared/ast-walk.js';
import { REPO_ROOT, sourceFiles } from '../../_shared/source-files.js';

const SRC = join(REPO_ROOT, 'src');

type Parsed = { path: string; ast: Node };
const FILES: Parsed[] = sourceFiles(SRC, { exts: ['.js'] }).map((abs) => ({
  path: relative(SRC, abs),
  ast: parseAst(readFileSync(abs, 'utf-8')),
}));

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * Providers whose API has no read of a server's own status, each with why.
 * Empty: all five read it. An entry here is listed in the PR that adds it.
 */
const NO_SERVER_VIEW: Record<string, string> = {};

/** The provider ids whose class neither owns the method nor is excused. */
function providersWithoutView(
  providers: Record<string, { prototype: object }>,
  excused: Record<string, string>,
): string[] {
  return Object.entries(providers)
    .filter(
      ([id, Class]) =>
        !Object.hasOwn(Class.prototype, 'describeServerForDiagnosis') && !(id in excused),
    )
    .map(([id]) => id);
}

/** Every call a method's source makes, by name. */
function callsInMethod(source: string): string[] {
  const names: string[] = [];
  walkAst(parseAst(`class X { ${source} }`), (n) => {
    if (n.type === 'CallExpression') {
      const name = calleeName(n);
      if (name) names.push(name);
    }
  });
  return names;
}

/**
 * Why a describeServerForDiagnosis source is not a read through
 * _readForDiagnosis: a request it makes some other way, or none at all.
 */
function viewReadFindings(source: string): string[] {
  const calls = callsInMethod(source);
  const findings = calls
    .filter((c) => /request|fetch|^_serverSummaryAt$/i.test(c) && c !== '_readForDiagnosis')
    .map((c) => `requests through ${c}`);
  if (!calls.includes('_readForDiagnosis')) findings.push('never calls _readForDiagnosis');
  return findings;
}

describe('every provider can say what it knows about a server that never joined', () => {
  it('each provider owns describeServerForDiagnosis, or is excused with a reason', () => {
    expect(providersWithoutView(PROVIDERS, NO_SERVER_VIEW)).toEqual([]);
    for (const [id, reason] of Object.entries(NO_SERVER_VIEW)) {
      expect(id in PROVIDERS, `NO_SERVER_VIEW names ${id}, which is no provider`).toBe(true);
      expect(
        Object.hasOwn(
          PROVIDERS[id as keyof typeof PROVIDERS].prototype,
          'describeServerForDiagnosis',
        ),
        `${id} owns the read now; take it out of NO_SERVER_VIEW`,
      ).toBe(false);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('each reads only through _readForDiagnosis', () => {
    for (const [id, Class] of Object.entries(PROVIDERS)) {
      if (!Object.hasOwn(Class.prototype, 'describeServerForDiagnosis')) continue;
      const source = Class.prototype.describeServerForDiagnosis.toString();
      expect(viewReadFindings(source), id).toEqual([]);
    }
  });

  it('_readForDiagnosis sends a GET: its fetch carries headers and an abort, nothing else', () => {
    const source = (
      BaseProvider.prototype as unknown as Record<string, () => void>
    )._readForDiagnosis.toString();
    const inits: string[][] = [];
    walkAst(parseAst(`class X { ${source} }`), (n) => {
      if (n.type === 'CallExpression' && calleeName(n) === 'fetch') {
        inits.push(n.arguments[1].properties.map((p: Node) => p.key.name));
      }
    });
    expect(inits).toEqual([['headers', 'signal']]);
  });

  it("the base method says the provider has no such read, and is not the contract's abstract marker", () => {
    const source = BaseProvider.prototype.describeServerForDiagnosis.toString();
    expect(source).toContain('has no read of a server');
    // provider-contract.test.ts treats "must be implemented" as abstract and
    // would demand an override; NO_SERVER_VIEW is where an excuse lives.
    expect(source).not.toContain('must be implemented');
  });

  describe('the checks bite', () => {
    it('a provider class without the method is flagged', () => {
      class Owns extends BaseProvider {
        async describeServerForDiagnosis() {
          return null as never;
        }
      }
      class Lacks extends BaseProvider {}
      expect(providersWithoutView({ owns: Owns, lacks: Lacks }, {})).toEqual(['lacks']);
      expect(providersWithoutView({ lacks: Lacks }, { lacks: 'its API has none' })).toEqual([]);
    });

    it('a view that requests another way is flagged', () => {
      expect(
        viewReadFindings(
          'async describeServerForDiagnosis(id) { return this.apiRequest("GET", "/servers/" + id); }',
        ),
      ).toEqual(['requests through apiRequest', 'never calls _readForDiagnosis']);
      expect(
        viewReadFindings(
          'async describeServerForDiagnosis(id) { await this._readForDiagnosis("/s/" + id); return fetchWithRetry(u); }',
        ),
      ).toEqual(['requests through fetchWithRetry']);
    });
  });
});

// ---------------------------------------------------------------------------
// Node waits
// ---------------------------------------------------------------------------

/** The waits that cannot pass without a node other than the k3s server, and why. */
const NODE_WAITS: Record<string, string> = {
  awaitDbRollout: 'db-0 schedules only on the dedicated=db node',
  awaitDbPodReady: 'db-0 schedules only on the dedicated=db node',
  waitForWorkersReady: "the failover's new standby workers",
  waitForKubeletsRenewing: "every node's kubelet lease",
};

/** The check a gated wait runs first, by the name it is called as. */
const GATES = new Set(['nodesJoined', 'awaitNodesJoined']);

type Treatment = { gate: string } | { isTheCheck: string } | { exempt: string };

/** Every function that calls a NODE_WAIT, as `file:function`. */
const WAIT_SITES: Record<string, Treatment> = {
  // applyK3sManifests' db wait: the check is its first await.
  'lib/deploy/k8s/k3s.js:awaitDb': { gate: 'nodesJoined' },
  // deployK3s with the apply skipped: the check, then the db pod wait.
  'lib/deploy/k8s/k3s.js:deployK3sSteps': { gate: 'nodesJoined' },
  // The failover's worker wait: its body is the check (see below).
  'failover.js:_provisionStandbyCapacityImpl': {
    isTheCheck: 'waitForWorkersReady runs awaitNodesJoined over the new workers',
  },
  'scale.js:scaleVerifyK8sReady': {
    exempt:
      'a resize reboots servers that registered and were Ready before scale touched them, and ' +
      'its pod wait that follows reports a node that does not come back; no new node joins',
  },
  'lib/update/execute.js:restartServer': {
    exempt:
      'an update reboots nodes that registered and were Ready before it started; no new node ' +
      'joins, and the update reads each node it drained by name',
  },
};

/**
 * Every function that reads the cluster's node list (`get nodes`, or `get
 * node <name>`, in a kubectl argv), and what it is. Only the check may wait
 * for nodes to join; a wait on a node that had joined says so.
 */
const NODE_READERS: Record<string, string> = {
  'lib/deploy/k8s/k3s.js:readNodes': 'the check: deployK3s nodesJoined reads for awaitNodesJoined',
  'failover.js:readNodes': 'the check: waitForWorkersReady reads for awaitNodesJoined',
  'failover.js:reapStaleStandbyWorkers': 'one read, to delete Nodes whose machines are gone',
  'lib/deploy/k8s/k3s.js:applyK3sManifests': 'one read, the pilot standby stale-worker reap',
  'lib/deploy/k8s/k3s.js:masterNodeServerId': "one read of the master's provider id",
  'lib/deploy/k8s/k3s.js:clusterNodeListArgs': "the db wait's failure diagnosis, read once",
  'diagnose.js:diagnoseNodes': 'the diagnose report, read once',
  'lib/update/inventory.js:listClusterNodes': "update's inventory, read once",
  'lib/update/execute.js:releaseLeftoverCordons': 'one read, to release cordon marks',
  'lib/update/execute.js:restartServer':
    'waits on the one node it rebooted, by name and boot id: a node that had joined before',
  'lib/status/cluster-snapshot.js:<module>': "status' one snapshot read (SNAPSHOT_ARGV)",
};

function nameOfFn(fnNode: Node, parent: Node): string | null {
  if (fnNode.id?.name) return fnNode.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id?.name) return parent.id.name;
  if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition') && parent.key?.name) {
    return parent.key.name;
  }
  return null;
}

/** The nearest named function around a node, as `file:name`, and that function's node. */
function enclosing(path: string, ancestors: Node[]): { key: string; fn: Node | null } {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (!isFunctionNode(ancestors[i])) continue;
    const name = nameOfFn(ancestors[i], ancestors[i - 1]);
    if (name) return { key: `${path}:${name}`, fn: ancestors[i] };
  }
  return { key: `${path}:<module>`, fn: null };
}

type Site = { key: string; fn: Node | null; call: Node; wait: string };

/** Every call of a NODE_WAIT in `files`, with the function it sits in. */
function waitSites(files: Parsed[]): Site[] {
  const out: Site[] = [];
  for (const { path, ast } of files) {
    walkAst(ast, (n, ancestors) => {
      if (n.type !== 'CallExpression') return;
      const wait = calleeName(n);
      if (wait && Object.hasOwn(NODE_WAITS, wait))
        out.push({ ...enclosing(path, ancestors), call: n, wait });
    });
  }
  return out;
}

/** Why a site breaks its registered treatment, or null when it keeps it. */
function siteFinding(site: Site, registry: Record<string, Treatment>): string | null {
  const t = Object.hasOwn(registry, site.key) ? registry[site.key] : undefined;
  if (!t) return `${site.key} calls ${site.wait} and is not in WAIT_SITES`;
  if (!('gate' in t)) return null;
  if (!site.fn) return `${site.key} has no function body to hold the check`;
  let gateAt = -1;
  walkAst(site.fn, (n) => {
    if (n.type === 'CallExpression' && calleeName(n) === t.gate && gateAt < 0) gateAt = n.start;
  });
  if (gateAt < 0) return `${site.key} never calls ${t.gate} before ${site.wait}`;
  if (gateAt > site.call.start) return `${site.key} calls ${t.gate} after ${site.wait}`;
  return null;
}

/** An argv array literal that runs `get nodes` (`get node <name>`, `get nodes,pods,...`). */
function readsNodeList(n: Node): boolean {
  if (n.type !== 'ArrayExpression') return false;
  const els = n.elements;
  return els.some(
    (e: Node, i: number) =>
      e?.type === 'Literal' &&
      e.value === 'get' &&
      els[i + 1]?.type === 'Literal' &&
      /^nodes?(,|$)/.test(String(els[i + 1].value)),
  );
}

function nodeReaders(files: Parsed[]): string[] {
  const keys = new Set<string>();
  for (const { path, ast } of files) {
    walkAst(ast, (n, ancestors) => {
      if (readsNodeList(n)) keys.add(enclosing(path, ancestors).key);
    });
  }
  return [...keys].sort();
}

/** Parse a synthetic source as if it were a file under src/. */
const fake = (path: string, code: string): Parsed[] => [{ path, ast: parseAst(code) }];

describe('every wait that needs a node other than the k3s server checks the nodes joined first', () => {
  const sites = waitSites(FILES);

  it('finds the waits (a walk that finds none proves nothing)', () => {
    for (const wait of Object.keys(NODE_WAITS)) {
      expect(
        sites.some((s) => s.wait === wait),
        `no call of ${wait} found`,
      ).toBe(true);
    }
  });

  it('each call sits in a registered function that keeps its treatment', () => {
    expect(sites.map((s) => siteFinding(s, WAIT_SITES)).filter(Boolean)).toEqual([]);
  });

  it('WAIT_SITES holds no entry for a function that no longer calls a wait', () => {
    const live = new Set(sites.map((s) => s.key));
    expect(Object.keys(WAIT_SITES).filter((k) => !live.has(k))).toEqual([]);
  });

  it('waitForWorkersReady is the check: its body runs awaitNodesJoined', () => {
    const fn = FILES.find((f) => f.path === 'failover.js');
    let calls = 0;
    walkAst(fn?.ast, (n, ancestors) => {
      if (n.type === 'CallExpression' && calleeName(n) === 'awaitNodesJoined') {
        if (enclosing('failover.js', ancestors).key === 'failover.js:waitForWorkersReady') calls++;
      }
    });
    expect(calls).toBe(1);
  });

  it('deployK3s builds nodesJoined from awaitNodesJoined and hands it to applyK3sManifests', () => {
    const k3s = FILES.find((f) => f.path === 'lib/deploy/k8s/k3s.js');
    let built = false;
    let handed = false;
    walkAst(k3s?.ast, (n, ancestors) => {
      const inDeploy = enclosing('lib/deploy/k8s/k3s.js', ancestors).key.endsWith(
        ':deployK3sSteps',
      );
      if (n.type === 'VariableDeclarator' && n.id?.name === 'nodesJoined' && inDeploy) {
        walkAst(n.init, (m) => {
          if (m.type === 'CallExpression' && calleeName(m) === 'awaitNodesJoined') built = true;
        });
      }
      if (n.type === 'CallExpression' && calleeName(n) === 'applyK3sManifests' && inDeploy) {
        handed = n.arguments[0]?.properties?.some((p: Node) => p.key?.name === 'nodesJoined');
      }
    });
    expect(built).toBe(true);
    expect(handed).toBe(true);
  });

  it('every reader of the node list is classified, and none is stale', () => {
    const readers = nodeReaders(FILES);
    expect(readers.filter((k) => !Object.hasOwn(NODE_READERS, k))).toEqual([]);
    expect(Object.keys(NODE_READERS).filter((k) => !readers.includes(k))).toEqual([]);
    for (const [key, why] of Object.entries(NODE_READERS)) {
      expect(why.length, key).toBeGreaterThan(10);
    }
  });

  it('every gate named is one the check exports', () => {
    for (const t of Object.values(WAIT_SITES))
      if ('gate' in t) expect(GATES.has(t.gate)).toBe(true);
  });

  describe('the checks bite', () => {
    it('a new wait in an unregistered function is flagged', () => {
      const [site] = waitSites(
        fake('lib/new.js', 'async function grow() { await awaitDbRollout({ env }); }'),
      );
      expect(siteFinding(site, WAIT_SITES)).toBe(
        'lib/new.js:grow calls awaitDbRollout and is not in WAIT_SITES',
      );
    });

    it('a gated wait without the check, or with it after the wait, is flagged', () => {
      const registry = { 'lib/new.js:grow': { gate: 'nodesJoined' } };
      const [none] = waitSites(
        fake('lib/new.js', 'async function grow() { await awaitDbPodReady({ env }); }'),
      );
      expect(siteFinding(none, registry)).toBe(
        'lib/new.js:grow never calls nodesJoined before awaitDbPodReady',
      );
      const [late] = waitSites(
        fake(
          'lib/new.js',
          'async function grow() { await awaitDbPodReady({ env }); await nodesJoined(); }',
        ),
      );
      expect(siteFinding(late, registry)).toBe(
        'lib/new.js:grow calls nodesJoined after awaitDbPodReady',
      );
      const [ok] = waitSites(
        fake(
          'lib/new.js',
          'async function grow() { await nodesJoined(); await awaitDbPodReady({ env }); }',
        ),
      );
      expect(siteFinding(ok, registry)).toBeNull();
    });

    it('a new node-list poll is found', () => {
      expect(
        nodeReaders(
          fake(
            'lib/new.js',
            "async function waitForNodes() { for (;;) { await kubectl(['get', 'nodes', '-o', 'json']); } }",
          ),
        ),
      ).toEqual(['lib/new.js:waitForNodes']);
    });
  });
});
