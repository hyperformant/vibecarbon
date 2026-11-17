/**
 * Every deploy sets net.core.txrehash=0 on every node it reaches over SSH,
 * before any image pull it makes there.
 *
 * Since v0.54.1 a server sets it at boot (stable-flowlabel-census.test.ts
 * holds every cloud-init to that, and has the RCA). A server made before then
 * never reads new user data, so it pulls with the kernel default: a socket's
 * IPv6 flow label changes when duplicate data arrives, GitHub's CDN routes
 * our ACKs to a server without the connection, and the pull is reset. The
 * k8s runtime base pull has no retry, so on k8s that fails the deploy.
 *
 * The setting rides the first remote command each node runs on the deploy's
 * way to its pulls, in the same ssh session, so no round trip is added:
 *   compose, compose-ha  check-db-ledger's read, on every server, ahead of
 *                        every step that pulls
 *   k8s, k8s-ha          the runtime base pull on the master (the pull with no
 *                        retry) and the pre-pull on every node, master, db and
 *                        static workers, both clusters on k8s-ha
 *   k8s-ha failover      the same pre-pull, on the standby's nodes
 *
 * What this walks, so a new path is drafted in rather than missed:
 *   - every tier the deploy knows (TIERS) names its carrier step, and every
 *     step its plan runs ahead of that carrier is named here as pulling
 *     nothing; the carrier itself has no when-gate, so it runs on every
 *     deploy, warm ones included;
 *   - each carrier's remote command as ssh receives it (runCommandAsync
 *     mocked), on every server or node, starts with the setting;
 *   - deployK3s pre-pulls every node address its infra outputs name;
 *   - every remote image pull command written in src/ is registered below
 *     with the step that runs it, which must come after its tier's carrier.
 *
 * Not walked: pulls nobody writes as a command (kubelet's, `compose up` of an
 * image the explicit pull already fetched, dockerd's FROM in a direct-mode
 * build). Each runs on a node a carrier above already reached, after it.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { parseAst } from 'vite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sourceFiles } from '../../_shared/source-files.js';

// Every carrier bottoms out here (compose's sshRunAsync, lib/ssh.js's sshRun,
// prePullImages' own ssh), so the mock sees what each node is sent.
const runCommandAsync = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/command.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runCommandAsync,
}));

const { dbLedgerProbeCommand } = await import(
  '../../../src/lib/deploy/compose/db-ledger-preflight.js'
);
const { EFFECTS } = await import('../../../src/lib/deploy/effects/index.js');
const { prePullImages, pullK3sRuntimeBase } = await import('../../../src/lib/deploy/k8s/k3s.js');
const { planDeploy } = await import('../../../src/lib/deploy/plan/deploy-plan.js');
const { stableFlowLabelPrefix } = await import('../../../src/lib/deploy/stable-flowlabel.js');
const { TIERS } = await import('../../../src/lib/deploy/tier-registry.js');

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');
const SNIPPET = read('carbon/cloud-init/k3s/_stable-flowlabel.sh');
const PREFIX = stableFlowLabelPrefix();

type Tier = 'compose' | 'compose-ha' | 'k8s' | 'k8s-ha';

describe('one source: the deploy writes what every cloud-init copy writes', () => {
  it("is the k3s snippet's own commands, its comments left out", () => {
    const commands = SNIPPET.split('\n').filter((l) => l.trim() && !l.trimStart().startsWith('#'));
    expect(commands.length).toBeGreaterThan(0);
    expect(PREFIX).toBe(`${commands.join('\n')}\n`);
    // Quiet (-q): a carrier's stdout is parsed, and this adds nothing to it.
    expect(PREFIX).toContain('sysctl -q -w net.core.txrehash=0');
  });

  it('writes the file and line the compose cloud-init writes, and applies it as its bootcmd does', () => {
    const write = /^printf '(.+)\\n' > (\S+)$/m.exec(PREFIX);
    expect(write, 'the prefix persists the setting with one printf').not.toBeNull();
    const [, line, path] = write as RegExpExecArray;
    const doc = loadYaml(read('carbon/cloud-init/docker-ce-setup.yaml')) as {
      bootcmd: unknown[];
      write_files: Array<{ path: string; content: string }>;
    };
    const file = doc.write_files.find((f) => f.path === path);
    expect(file, `docker-ce-setup.yaml writes ${path}`).toBeDefined();
    expect(file?.content).toBe(`${line}\n`);

    // The prefix's apply block, as one line, is the compose bootcmd's command.
    const apply = PREFIX.slice(PREFIX.indexOf('\nif ') + 1)
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .join('\n')
      .replace(/then\n/g, 'then ')
      .replace(/\n/g, '; ');
    const boot = doc.bootcmd.map((c) => (Array.isArray(c) ? String(c.at(-1)) : String(c)));
    expect(boot).toContain(apply);
  });
});

/**
 * Per tier: the step that carries the setting to its nodes, and every step
 * the plan runs ahead of it, each with why it pulls nothing. A step added
 * ahead of a carrier fails here until it is named, or the setting moves ahead
 * of it.
 */
const CARRIERS: Record<Tier, { carrier: string; before: Record<string, string> }> = {
  compose: {
    carrier: 'check-db-ledger',
    before: {
      'provision-server': 'only on a new server, which boots with the setting',
      'persist-provisioned-server': 'writes .vibecarbon.json',
      'start-dns-update': 'the DNS provider API',
      'setup-server': 'waits for the ready marker and dockerd, reads the boot pull status',
    },
  },
  'compose-ha': {
    carrier: 'check-db-ledger',
    before: {
      'open-state-backend': 'the object storage API',
      'provision-servers': 'a new server boots with the setting; a recorded one gets no up',
      'persist-pending-config': 'writes .vibecarbon.json',
      'start-dns-update': 'the DNS provider API',
      'wait-for-ssh': 'an ssh connect',
      'seed-known-hosts': 'ssh-keyscan',
      'setup-servers': 'waits for the ready marker, reads the boot pull status',
      'wait-docker-ready': 'docker info',
    },
  },
  // deployK3s: the base pull and the pre-pull carry it themselves.
  k8s: { carrier: 'deploy-cluster', before: {} },
  'k8s-ha': {
    carrier: 'provision-clusters',
    before: {
      'open-state-backend': 'the object storage API',
      'generate-ssh-key': 'a local key',
      'upload-ssh-key': 'the provider API',
    },
  },
};

const stepNames = (tier: Tier) => planDeploy(tier).map((s: { name: string }) => s.name);

describe('every deploy tier carries it ahead of its first pull', () => {
  it('names a carrier for every tier', () => {
    expect(Object.keys(CARRIERS).sort()).toEqual([...TIERS].sort());
  });

  it.each(TIERS as Tier[])(
    '%s: only steps that pull nothing run before the carrier, which runs on every deploy',
    (tier) => {
      const { carrier, before } = CARRIERS[tier];
      const plan = planDeploy(tier);
      const at = plan.findIndex((s: { name: string }) => s.name === carrier);
      expect(at, `${tier}: ${carrier} is in the plan`).toBeGreaterThanOrEqual(0);
      expect(plan[at].when, `${tier}: ${carrier} has no when-gate`).toBeFalsy();
      expect(stepNames(tier).slice(0, at)).toEqual(Object.keys(before));
    },
  );
});

/** `sh -s` as a remote command, bare or shell-quoted (lib/ssh.js shJoin). */
const STDIN_SHELL = /^'?sh'? '?-s'?$/;

/** Each ssh the mock saw: the host, and the text its remote shell runs. */
function sent(): Array<{ host: string; text: string }> {
  return runCommandAsync.mock.calls
    .filter(([argv]: [string[]]) => argv[0] === 'ssh')
    .map(([argv, opts]: [string[], { input?: string } | undefined]) => {
      const host = String(argv.find((a) => a.startsWith('root@'))).slice('root@'.length);
      const remote = String(argv.at(-1));
      return { host, text: STDIN_SHELL.test(remote) ? String(opts?.input ?? '') : remote };
    });
}

describe('compose and compose-ha: check-db-ledger sets it first on every server', () => {
  // A first deploy's answer, with Docker versions over their floors.
  const PROBE_OUT =
    'STATE=absent\nVOLUME=\nVC_ENGINE=29.0.0\nVC_COMPOSE=2.40.0\nVC_VERSIONS_MS=1\n';

  beforeEach(() => {
    runCommandAsync.mockReset();
    runCommandAsync.mockResolvedValue(PROBE_OUT);
  });

  it('compose: the server, in the same session as the read (no extra round trip)', async () => {
    await EFFECTS.checkDbLedger({
      serverIp: '192.0.2.10',
      sshKeyPath: '/k',
      projectConfig: { projectName: 'acme' },
    } as never);
    expect(sent()).toEqual([
      { host: '192.0.2.10', text: `${PREFIX}${dbLedgerProbeCommand('acme')}` },
    ]);
  });

  it('compose-ha: the primary and the standby', async () => {
    await EFFECTS.haCheckDbLedger({
      primary: { ip: '192.0.2.10' },
      standby: { ip: '192.0.2.20' },
      sshKeyPath: '/k',
      projectConfig: { projectName: 'acme' },
      onProgress: () => {},
    } as never);
    const calls = sent();
    expect(calls.map((c) => c.host)).toEqual(['192.0.2.10', '192.0.2.20']);
    for (const c of calls) expect(c.text).toBe(`${PREFIX}${dbLedgerProbeCommand('acme')}`);
  });
});

const K3S = read('src/lib/deploy/k8s/k3s.js');

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes from vite's parseAst.
type Node = any;

function walk(node: Node, fn: (n: Node, ancestors: Node[]) => void, ancestors: Node[] = []) {
  fn(node, ancestors);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    for (const child of Array.isArray(v) ? v : [v]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') {
        walk(child, fn, [...ancestors, node]);
      }
    }
  }
}

/** The top-level function declaration `name` in `src`. */
function fnNode(src: string, name: string): Node {
  let found: Node = null;
  walk(parseAst(src), (n) => {
    if (n.type === 'FunctionDeclaration' && n.id?.name === name) found = n;
  });
  expect(found, `${name} not found`).not.toBeNull();
  return found;
}

/** Every call to `callee` inside `fn`, with its ancestors below `fn`. */
function callsIn(fn: Node, callee: string): Array<{ call: Node; ancestors: Node[] }> {
  const out: Array<{ call: Node; ancestors: Node[] }> = [];
  walk(fn.body, (n, ancestors) => {
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === callee)
      out.push({ call: n, ancestors });
  });
  return out;
}

const CONDITIONAL = new Set([
  'IfStatement',
  'ConditionalExpression',
  'LogicalExpression',
  'SwitchStatement',
]);

describe('k8s and k8s-ha: deployK3s sets it first on every node', () => {
  beforeEach(() => {
    runCommandAsync.mockReset();
    runCommandAsync.mockResolvedValue('');
  });

  it('the runtime base pull, the one with no retry, runs it first on the master', async () => {
    await pullK3sRuntimeBase({
      masterIp: '192.0.2.1',
      sshKeyPath: '/k',
      baseRef: 'ghcr.io/hyperformant/node-runtime:24-alpine3.24-r3',
    });
    const calls = sent();
    expect(calls.map((c) => c.host)).toEqual(['192.0.2.1']);
    expect(calls[0].text.startsWith(PREFIX)).toBe(true);
    expect(calls[0].text.slice(PREFIX.length)).toMatch(/^set -eu\n[\s\S]*images pull /);
  });

  it('the pre-pull runs it first on every node it is given, one session each', async () => {
    const nodes = ['192.0.2.1', '192.0.2.2', '192.0.2.3'];
    await prePullImages({ nodeIps: nodes, sshKeyPath: '/k', khPath: '/kh' });
    const calls = sent();
    expect(calls.map((c) => c.host).sort()).toEqual(nodes);
    for (const c of calls) {
      expect(c.text.startsWith(PREFIX)).toBe(true);
      // The host reporter's installer (host-reporter-census.test.ts) sits
      // between the setting and the pulls.
      expect(c.text.slice(PREFIX.length)).toMatch(
        /^\(\n[\s\S]*\) >\/dev\/null 2>&1 \|\| true\nk3s ctr -n k8s\.io images pull /,
      );
    }
  });

  it('deployK3s pre-pulls every node address its infra outputs name, on every deploy', () => {
    const steps = fnNode(K3S, 'deployK3sSteps');
    // The node addresses: every `...Ip`/`...Ips` the infra outputs destructure
    // into, except private ones (the same nodes, on the private network).
    let outputs: string[] = [];
    walk(steps.body, (n) => {
      if (
        n.type === 'VariableDeclarator' &&
        n.init?.type === 'Identifier' &&
        n.init.name === 'infraOutputs' &&
        n.id?.type === 'ObjectPattern'
      ) {
        outputs = n.id.properties.map((p: Node) => p.key?.name).filter(Boolean);
      }
    });
    const nodeAddresses = outputs.filter((k) => /Ips?$/.test(k) && !/Private/.test(k)).sort();
    expect(nodeAddresses).toEqual(['dbIp', 'masterIp', 'workerIps']);

    const prePulls = callsIn(steps, 'prePullImages');
    expect(prePulls).toHaveLength(1);
    const { call, ancestors } = prePulls[0];
    // Unconditional: not behind any gate, so warm deploys run it too.
    expect(ancestors.filter((a) => CONDITIONAL.has(a.type)).map((a) => a.type)).toEqual([]);
    const nodeIps = call.arguments[0].properties.find((p: Node) => p.key?.name === 'nodeIps');
    const targeted = nodeIps.value.elements
      .map((e: Node) =>
        e.type === 'SpreadElement'
          ? (e.argument.left?.name ?? e.argument.name)
          : (e as { name: string }).name,
      )
      .sort();
    expect(targeted).toEqual(nodeAddresses);
  });

  it('k8s-ha runs deployK3s for both clusters', () => {
    const fn = fnNode(read('src/lib/deploy/effects/k8s-ha.js'), 'haK8sProvisionClusters');
    const roles = callsIn(fn, 'deployK3s').map(({ call }) => {
      const role = call.arguments[0].properties.find((p: Node) => p.key?.name === 'role');
      return role?.value?.value;
    });
    expect(roles.sort()).toEqual(['primary', 'standby']);
  });

  it("k8s-ha failover pre-pulls the standby's nodes through the same prePullImages", () => {
    const fn = fnNode(read('src/failover.js'), 'prePullStandbyImages');
    const body = read('src/failover.js').slice(fn.start, fn.end);
    expect(callsIn(fn, 'prePullImages')).toHaveLength(1);
    expect(body).toMatch(
      /nodeIps = \[servers\.standby\.ip, servers\.standby\.dbIp, \.\.\.\(workerIps \?\? \[\]\)\]/,
    );
  });
});

/**
 * Every remote image pull command written in src/, keyed `<file> <function>`,
 * with the step that runs it in each tier. A new one fails here until it is
 * listed: start its remote command with withStableFlowLabel
 * (src/lib/deploy/stable-flowlabel.js) and list it as `self`, or name the
 * step that runs it, which must come after its tier's carrier.
 */
const PULL_SITES: Record<string, { self: true } | { steps: Partial<Record<Tier, string>> }> = {
  // The runtime base on a compose server (scale's new server boots with it).
  'src/lib/deploy/compose/app-image.js deliverComposeAppImage': {
    steps: { compose: 'transfer-image', 'compose-ha': 'transfer-image' },
  },
  // The stack's images (scale's new server boots with it).
  'src/lib/deploy/compose/index.js stackPullCommand': {
    steps: { compose: 'setup-server-files', 'compose-ha': 'pull-images' },
  },
  // reconcile.sh's pull, and the add-on job reconcile.sh starts.
  'src/lib/deploy/bundle.js renderReconcileScript': {
    steps: { compose: 'start-compose-stack', 'compose-ha': 'start-compose-stack' },
  },
  'src/lib/services/addon-start.js renderAddonJobScript': {
    steps: { compose: 'start-compose-stack', 'compose-ha': 'start-compose-stack' },
  },
  'src/lib/deploy/effects/compose-ha.js haWriteReplicationOverlay': {
    steps: { 'compose-ha': 'write-replication-overlay' },
  },
  // k8s: these two carry it themselves (proven above).
  'src/lib/deploy/k8s/k3s.js prePullImages': { self: true },
  'src/lib/deploy/k8s/k3s.js pullK3sRuntimeBase': { self: true },
  // The standby db node, after its cluster's deployK3s pre-pulled it. It reads
  // the primary's registry over wg0, IPv4, which has no flow label.
  'src/lib/deploy/k8s/ha/image-copy.js buildImageCopyScript': {
    steps: { 'k8s-ha': 'copy-standby-image' },
  },
};

const REMOTE_PULL =
  /\bctr\b[^\n]*\b(?:i|images?)\s+pull\b|\bimages\s+pull\b|\b(?:docker|crictl|nerdctl|podman)\s+pull\b|(?:\bcompose|VC_COMPOSE\}|\bdc)\s+pull\b/;

/** `<file> <function>` for every string or template literal (or .sh line) that pulls. */
function pullSitesInSrc(): string[] {
  const found = new Set<string>();
  for (const path of sourceFiles(join(ROOT, 'src'), { exts: ['.js', '.mjs', '.sh'] })) {
    const rel = relative(ROOT, path);
    const src = readFileSync(path, 'utf-8');
    if (path.endsWith('.sh')) {
      const lines = src.split('\n').filter((l) => !l.trimStart().startsWith('#'));
      if (lines.some((l) => REMOTE_PULL.test(l))) found.add(`${rel} <script>`);
      continue;
    }
    walk(parseAst(src), (n, ancestors) => {
      if (n.type !== 'Literal' && n.type !== 'TemplateLiteral') return;
      if (ancestors.some((a) => a.type === 'TemplateLiteral')) return;
      if (!REMOTE_PULL.test(src.slice(n.start, n.end))) return;
      const fn = [...ancestors]
        .reverse()
        .find((a) => a.type === 'FunctionDeclaration' && a.id?.name);
      const top = ancestors.find((a) => a.type === 'VariableDeclarator' && a.id?.name);
      found.add(`${rel} ${fn?.id.name ?? top?.id.name ?? '<module>'}`);
    });
  }
  return [...found].sort();
}

describe('every remote image pull in src/ comes after a carrier', () => {
  it('lists every pull command the CLI writes, and nothing it no longer writes', () => {
    const found = pullSitesInSrc();
    const unlisted = found.filter((k) => !(k in PULL_SITES));
    expect(
      unlisted,
      'a new remote image pull: start its remote command with withStableFlowLabel, or name the step that runs it in PULL_SITES',
    ).toEqual([]);
    expect(found).toEqual(Object.keys(PULL_SITES).sort());
  });

  it.each(Object.entries(PULL_SITES))('%s runs after a carrier, or is one', (site, entry) => {
    if ('self' in entry) {
      // Its own remote command sets it first (the wire tests above prove each).
      const [file, name] = site.split(' ');
      expect(callsIn(fnNode(read(file), name), 'withStableFlowLabel')).toHaveLength(1);
      return;
    }
    for (const [tier, step] of Object.entries(entry.steps) as Array<[Tier, string]>) {
      const plan = stepNames(tier);
      expect(plan.indexOf(step), `${tier}: ${step} is in the plan`).toBeGreaterThanOrEqual(0);
      expect(
        plan.indexOf(step),
        `${tier}: ${step} runs after ${CARRIERS[tier].carrier}`,
      ).toBeGreaterThan(plan.indexOf(CARRIERS[tier].carrier));
    }
  });
});
