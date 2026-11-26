/**
 * Census: after any REST write to a k8s-ha cluster's firewall, the next up
 * plans no rule change.
 *
 * Every up refreshes first (src/lib/iac/index.js prepareStackForUp), so the
 * live rule list, REST-written rules included, lands in state, and the up
 * then resets the firewall to the rules its program declares. Hetzner,
 * DigitalOcean and Linode declare their inbound rules inline on one
 * resource. Two REST writers touch those rules: the operator push
 * (applyOperatorCidrs: `vibecarbon access`, the deploy) and the k8s-ha
 * replication opener (buildReplicationFirewallRules: UDP 51821 from the peer
 * cluster's database node). The operator rules survive because both program
 * builders declare them from the saved operatorCidrs. The replication rule
 * had no saved input, so every scale dropped it on both clusters and every
 * failover on the standby, and on Hetzner (`replaceOnChanges: ['*']`) each
 * of those ups replaced the whole firewall. Now the programs declare it from
 * the peer's recorded database address (replicationPeerIpFor).
 *
 * That only holds while the declared rule equals what REST writes, field for
 * field and in order: a rule differing in a description, a port string, a
 * CIDR form or its place keeps the drop alive. So each program is RUN here
 * (Pulumi's mock runtime, no cloud), its declared inbound rules mapped to the
 * provider's REST wire shape, and checked against the provider's own REST
 * writers.
 *
 * A provider whose k8s program leaves the operator rules to REST
 * (K8S_OPERATOR_RULES_AFTER_UP: Vultr) keeps REST as the only writer of all
 * three ports (ruling RV5): its program must declare none of them.
 *
 * Walks the k8s providers of the registry (k8sCensusProviders), not a hand
 * list: a provider that sells k8s, or lands its k8s code ahead of the tier,
 * must have a wire mapping below or be a REST-only writer.
 */
import { join } from 'node:path';
import * as pulumi from '@pulumi/pulumi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgramConfig } from '../../../src/lib/scale-plan.js';
import { k8sCensusProviders } from '../../_shared/k8s-built-ahead.js';
import { REPO_ROOT, readRepoFile, sourceFiles } from '../../_shared/source-files.js';
import { CODE, findCalls, functionRanges, lex, matchBracket } from '../helpers/js-call-scan.js';

let counter = 0;
const registered: { type: string; name: string; inputs: Record<string, unknown> }[] = [];
pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs) {
      counter += 1;
      registered.push({ type: args.type, name: args.name, inputs: args.inputs });
      const ip = `192.0.2.${counter % 250}`;
      return {
        id: String(8_000_000 + counter),
        state: {
          ...args.inputs,
          ipv4Address: ip,
          ipv4AddressPrivate: `10.10.0.${counter % 250}`,
          ipAddress: ip,
          address: ip,
          mainIp: ip,
          internalIp: `10.10.0.${counter % 250}`,
          subnet: ip,
        },
      };
    },
    call(args: pulumi.runtime.MockCallArgs) {
      return args.inputs;
    },
  },
  'vibecarbon',
  'test',
);

type Rule = Record<string, unknown>;
type Registered = (typeof registered)[number];

type K8sProvider = {
  NAME: string;
  REGIONS: Record<string, unknown>;
  DEFAULT_K8S_NODE_TYPE: string;
  K8S_OPERATOR_RULES_AFTER_UP: boolean;
  getK8sProgram: (config: object) => Promise<() => Promise<Record<string, unknown>>>;
  new (
    token: string,
  ): {
    buildReplicationFirewallRules: (firewall: object, peerIp: string) => Rule[] | null;
    applyOperatorCidrs: (args: { firewallName: string; cidrs: string[] }) => Promise<boolean>;
    findFirewallByName: (name: string) => Promise<object | null>;
    setFirewallRules: (id: unknown, rules: Rule[], basis?: object) => Promise<void>;
  };
};

const PEER = '203.0.113.7';
const NEW_PEER = '198.51.100.70';
const OPERATOR = ['203.0.113.5/32', '2001:db8::1/128'];
const REPLICATION_PORT = '51821';
const OPERATOR_PORTS = ['22', '6443'];

/** A defined-values-only copy: the API leaves an unset field out, as these mappings do. */
const present = (o: Rule): Rule =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * Per provider: the Pulumi type of the one resource that holds the inbound
 * rules, how its declared rules read on the provider's REST API (what the
 * refresh and every REST writer see), and the firewall object that
 * provider's findFirewallByName returns around them. Nothing else: the REST
 * rules are always made by the provider's own writers.
 */
const INLINE: Record<
  string,
  {
    type: string;
    toWire: (inputs: Record<string, unknown>) => Rule[];
    wrap: (rules: Rule[]) => object;
  }
> = {
  // hcloud `rules[]` -> the Hetzner API's firewall `rules[]`. The API reads an
  // unset description back as none: a rule REST wrote has no description key.
  hetzner: {
    type: 'hcloud:index/firewall:Firewall',
    toWire: (inputs) =>
      (inputs.rules as Rule[]).map((r) =>
        present({
          direction: r.direction,
          protocol: r.protocol,
          port: r.port,
          source_ips: r.sourceIps ?? [],
          destination_ips: r.destinationIps ?? [],
          description: r.description,
        }),
      ),
    wrap: (rules) => ({ id: 1, rules }),
  },
  // digitalocean `inboundRules[]` -> the DigitalOcean API's `inbound_rules[]`.
  digitalocean: {
    type: 'digitalocean:index/firewall:Firewall',
    toWire: (inputs) =>
      (inputs.inboundRules as Rule[]).map((r) =>
        present({
          protocol: r.protocol,
          ports: r.portRange,
          sources: present({
            addresses: r.sourceAddresses,
            droplet_ids: r.sourceDropletIds,
            load_balancer_uids: r.sourceLoadBalancerUids,
            kubernetes_ids: r.sourceKubernetesIds,
            tags: r.sourceTags,
          }),
        }),
      ),
    wrap: (rules) => ({ id: 'fw', inbound_rules: rules, outbound_rules: [] }),
  },
  // linode `inbounds[]` (plural ipv4s/ipv6s) -> the Linode API's ordered
  // `rules.inbound[]` (`addresses.{ipv4,ipv6}`).
  linode: {
    type: 'linode:index/firewall:Firewall',
    toWire: (inputs) =>
      (inputs.inbounds as Rule[]).map((r) =>
        present({
          label: r.label,
          description: r.description,
          action: r.action,
          protocol: r.protocol,
          ports: r.ports,
          addresses: present({ ipv4: r.ipv4s, ipv6: r.ipv6s }),
        }),
      ),
    wrap: (rules) => ({
      id: 1,
      rules: { inbound: rules, inbound_policy: 'DROP', outbound: [], outbound_policy: 'ACCEPT' },
    }),
  },
};

const k8sProviders = k8sCensusProviders() as unknown as [string, K8sProvider][];
const inlineProviders = k8sProviders.filter(([, P]) => !P.K8S_OPERATOR_RULES_AFTER_UP);
const restOnlyProviders = k8sProviders.filter(([, P]) => P.K8S_OPERATOR_RULES_AFTER_UP);

/** Run one k8s-ha side's program under the mocks; every resource it registered. */
async function run(Provider: K8sProvider, extra: Record<string, unknown>): Promise<Registered[]> {
  registered.length = 0;
  const node = Provider.DEFAULT_K8S_NODE_TYPE;
  const program = await Provider.getK8sProgram({
    projectName: 'acme',
    environment: 'prod-primary',
    sshPublicKey: 'ssh-ed25519 AAAAtest test@example.com',
    existingSshKeyId: '4242',
    location: Object.keys(Provider.REGIONS)[0],
    masterServerType: node,
    dbServerType: node,
    workerServerType: node,
    minWorkers: 1,
    maxWorkers: 2,
    k3sVersion: 'v1.37.2+k3s1',
    labels: { 'managed-by': 'vibecarbon', 'os-flavor': 'k3s' },
    allowedSshIps: OPERATOR,
    allowedK8sApiIps: OPERATOR,
    k3sToken: 'SENTINEL-k3s-token',
    ...extra,
  });
  const outputs = await program();
  // Registration is asynchronous under the mocks: let every output resolve,
  // then wait until no more resources arrive.
  await new Promise((resolve) => pulumi.all(Object.values(outputs)).apply(resolve));
  for (let seen = -1; seen !== registered.length; ) {
    seen = registered.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [...registered];
}

/** The declared inbound rules in REST wire shape, in declared order. */
async function declared(id: string, Provider: K8sProvider, extra: Record<string, unknown>) {
  const { type, toWire } = INLINE[id];
  const firewalls = (await run(Provider, extra)).filter((r) => r.type === type);
  expect(firewalls, `${Provider.NAME}: one ${type}`).toHaveLength(1);
  return toWire(firewalls[0].inputs);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('k8s firewall round trip census', () => {
  it('every k8s provider either declares its rules inline here or leaves them to REST', () => {
    expect(inlineProviders.map(([id]) => id).sort()).toEqual(Object.keys(INLINE).sort());
    expect(restOnlyProviders.length + inlineProviders.length).toBe(k8sProviders.length);
  });

  describe.each(inlineProviders)('%s: the declared list is what REST leaves', (id, Provider) => {
    const provider = () => new Provider('census-token');

    it('a side with no recorded peer declares no replication rule', async () => {
      const rules = await declared(id, Provider, {});
      expect(JSON.stringify(rules)).not.toContain(REPLICATION_PORT);
    });

    it('the first deploy: REST adds exactly the rule the next up declares, last', async () => {
      const without = await declared(id, Provider, {});
      const withPeer = await declared(id, Provider, { replicationPeerIp: PEER });
      // What the deploy's REST opener writes on the firewall the first up
      // made (no peer recorded yet), compared whole and in order with what
      // the next up declares once the peer is recorded.
      const written = provider().buildReplicationFirewallRules(
        INLINE[id].wrap(structuredClone(without)),
        PEER,
      );
      expect(written).toEqual(withPeer);
    });

    it('once declared, the REST opener has nothing to write', async () => {
      const withPeer = await declared(id, Provider, { replicationPeerIp: PEER });
      expect(provider().buildReplicationFirewallRules(INLINE[id].wrap(withPeer), PEER)).toBeNull();
    });

    it('a replaced peer: REST moves the rule to the new address, which the next up declares', async () => {
      const old = await declared(id, Provider, { replicationPeerIp: PEER });
      const next = await declared(id, Provider, { replicationPeerIp: NEW_PEER });
      expect(
        provider().buildReplicationFirewallRules(INLINE[id].wrap(structuredClone(old)), NEW_PEER),
      ).toEqual(next);
    });

    it('the operator push with the saved CIDRs PUTs the declared list back unchanged', async () => {
      const withPeer = await declared(id, Provider, { replicationPeerIp: PEER });
      const p = provider();
      vi.spyOn(p, 'findFirewallByName').mockResolvedValue(
        INLINE[id].wrap(structuredClone(withPeer)),
      );
      const set = vi.spyOn(p, 'setFirewallRules').mockResolvedValue(undefined);
      expect(
        await p.applyOperatorCidrs({ firewallName: 'acme-prod-primary-firewall', cidrs: OPERATOR }),
      ).toBe(true);
      expect(set).toHaveBeenCalledTimes(1);
      expect(set.mock.calls[0][1]).toEqual(withPeer);
    });
  });

  describe.each(restOnlyProviders)('%s: REST is the only writer (RV5)', (_id, Provider) => {
    it('the program declares none of 22, 6443 or 51821, peer or no peer', async () => {
      const resources = await run(Provider, { replicationPeerIp: PEER });
      const firewallInputs = resources.filter((r) => /firewall/i.test(r.type)).map((r) => r.inputs);
      expect(firewallInputs.length).toBeGreaterThan(0);
      const ports = new Set<string>();
      const walk = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') {
          for (const [k, x] of Object.entries(v)) {
            if (/^(port|ports|portRange|destPortFrom|destPortTo)$/.test(k)) ports.add(String(x));
            walk(x);
          }
        }
      };
      walk(firewallInputs);
      expect(ports.size).toBeGreaterThan(0);
      for (const port of [...OPERATOR_PORTS, REPLICATION_PORT])
        expect([...ports]).not.toContain(port);
      expect(JSON.stringify(firewallInputs)).not.toContain(PEER);
    });
  });
});

// ── Every program build site reads the peer through the one helper ─────────

type Site = { file: string; line: number; args: string; fn: string; fnText: string };

/** Every call of `getK8sProgram(` in a source text (a member call included), with its function. */
function buildSitesIn(file: string, text: string): Site[] {
  const { mask, errors } = lex(text);
  if (errors.length > 0) throw new Error(`${file}: cannot scan soundly: ${errors[0]}`);
  const ranges = functionRanges(text, mask);
  const sites: Site[] = [];
  for (const m of text.matchAll(/(?<![\w$])getK8sProgram\s*\(/g)) {
    const at = m.index ?? 0;
    if (mask[at] !== CODE) continue;
    const paren = at + m[0].length - 1;
    const close = matchBracket(text, mask, paren);
    if (close === -1) throw new Error(`${file}: getK8sProgram( never closes`);
    // `static async getK8sProgram(config) {`: a definition, not a call.
    if (/^\s*\{/.test(text.slice(close + 1))) continue;
    const fn = ranges
      .filter((r) => r.start <= at && at <= r.end)
      .sort((a, b) => b.start - a.start)[0];
    if (!fn) throw new Error(`${file}: getK8sProgram( outside any function`);
    sites.push({
      file,
      line: text.slice(0, at).split('\n').length,
      args: text.slice(paren + 1, close).trim(),
      fn: fn.name,
      fnText: text.slice(fn.start, fn.end + 1),
    });
  }
  return sites;
}

/**
 * What is wrong with one build site: the function that builds the program
 * must read the peer with replicationPeerIpFor for the stack its up runs,
 * and hand the result to the program through the config it spreads.
 */
function peerInputProblems(site: Site): string[] {
  const where = `${site.file}:${site.line} (${site.fn})`;
  const problems: string[] = [];
  const reads = findCalls(site.fnText, ['replicationPeerIpFor']);
  const ups = findCalls(site.fnText, ['upStack']);
  if (reads.length !== 1)
    problems.push(`${where}: ${reads.length} replicationPeerIpFor( calls, want 1`);
  if (ups.length !== 1) problems.push(`${where}: ${ups.length} upStack( calls, want 1`);
  if (reads.length === 1 && ups.length === 1 && reads[0].args[1] !== ups[0].args[0]) {
    problems.push(
      `${where}: the peer is read for ${reads[0].args[1]}, the up runs ${ups[0].args[0]}`,
    );
  }
  if (!/^\{\s*\.\.\.programConfig\b/.test(site.args)) {
    problems.push(`${where}: the program is not built from ...programConfig`);
  }
  const { mask } = lex(site.fnText);
  const decl = /\bconst programConfig\s*=\s*/.exec(site.fnText);
  if (!decl || mask[decl.index] !== CODE) {
    problems.push(`${where}: no programConfig is built here`);
  } else {
    const rest = site.fnText.slice(decl.index + decl[0].length);
    const open = decl.index + decl[0].length + rest.search(/[({]/);
    const value = site.fnText.slice(open, matchBracket(site.fnText, mask, open) + 1);
    if (!/\breplicationPeerIp\s*[:,}]/.test(value)) {
      problems.push(`${where}: programConfig carries no replicationPeerIp`);
    }
  }
  return problems;
}

describe('every k8s program build site declares the peer from the one helper', () => {
  const sites = sourceFiles(join(REPO_ROOT, 'src'), {
    exts: ['.js', '.mjs'],
    relativeTo: REPO_ROOT,
  })
    .filter((file) => readRepoFile(file).includes('getK8sProgram'))
    .flatMap((file) => buildSitesIn(file, readRepoFile(file)));

  it('the build sites are the two ups that run a k8s program', () => {
    expect(sites.map((s) => `${s.file} ${s.fn}`).sort()).toEqual([
      'src/lib/deploy/k8s/k3s.js deployK3sSteps',
      'src/lib/iac/converge-cluster.js convergeClusterInfra',
    ]);
  });

  it.each(sites.map((s) => [`${s.file}:${s.line}`, s] as const))(
    '%s reads replicationPeerIpFor for its own stack',
    (_where, site) => {
      expect(peerInputProblems(site)).toEqual([]);
    },
  );

  it('buildProgramConfig hands replicationPeerIp to the program unchanged', () => {
    const config = buildProgramConfig({
      projectName: 'acme',
      environment: 'prod-standby',
      sshPublicKey: 'ssh-ed25519 AAAA',
      allowedCidrs: OPERATOR,
      existingSshKeyId: '4242',
      location: 'hel1',
      newValues: {},
      currentMasterType: 'cx23',
      currentDbType: 'cx23',
      currentWorkerType: 'cx23',
      persistedMinWorkers: 1,
      persistedMaxWorkers: 3,
      k3sVersion: 'v1.37.2+k3s1',
      labels: {},
      replicationPeerIp: PEER,
    });
    expect(config.replicationPeerIp).toBe(PEER);
  });

  // The pin bites: each site fails the moment its read goes or drifts.
  describe('bite', () => {
    const site = (file: string) => {
      const found = sites.find((s) => s.file === file);
      if (!found) throw new Error(`no build site in ${file}`);
      return found;
    };
    const mutate = (file: string, from: RegExp, to: string) => {
      const s = site(file);
      const fnText = s.fnText.replace(from, to);
      expect(fnText, `${file}: the mutation applies`).not.toBe(s.fnText);
      return peerInputProblems({ ...s, fnText });
    };

    it.each(['src/lib/deploy/k8s/k3s.js', 'src/lib/iac/converge-cluster.js'])(
      '%s: no read, a read for another stack, or a config without it all fail',
      (file) => {
        expect(mutate(file, /replicationPeerIpFor\(([^,]+), [^)]+\)/, 'undefined')).not.toEqual([]);
        expect(
          mutate(file, /replicationPeerIpFor\(([^,]+), [^)]+\)/, 'replicationPeerIpFor($1, x)'),
        ).not.toEqual([]);
        expect(mutate(file, /\breplicationPeerIp(\s*[:,])/, 'peerIpUnused$1')).not.toEqual([]);
      },
    );
  });
});
