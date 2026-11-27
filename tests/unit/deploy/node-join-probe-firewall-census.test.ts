/**
 * Census: the cluster firewall says what the probe from the k3s server says
 * it does (node-join-probe.js).
 *
 * At the join deadline a server that never registered is probed from its k3s
 * server: ping and port 22 on its private and public addresses. Its sentence
 * reads silence on the private address as "the server is not up there", and
 * silence on the public address as "what the firewall would do anyway". Both
 * readings hold only while every provider's k8s firewall:
 *
 *   - lets ping (ICMP) and TCP port 22 in from the private network, or does
 *     not filter the private network at all (PRIVATE_UNFILTERED, each with
 *     its source); and
 *   - lets no ping in from outside the private network, and port 22 only
 *     from the operator CIDRs (`vibecarbon access`). A provider whose program
 *     leaves port 22 to REST (K8S_OPERATOR_RULES_AFTER_UP: Vultr) declares no
 *     port 22 rule, and writeOperatorRulesAfterUp writes it from the operator
 *     CIDRs only.
 *
 * Each k8s program is RUN here under Pulumi's mock runtime (no cloud) and its
 * declared inbound rules read back in one shape. Every provider's firewall
 * drops what no rule admits: Hetzner ("When applying a firewall with no `in`
 * rule all inbound traffic will be dropped", docs.hetzner.cloud), DigitalOcean
 * (a Cloud Firewall denies all inbound traffic no rule allows), Linode and
 * Scaleway (their policies, checked below), Vultr (a group drops what no rule
 * admits once it has one; the program makes every instance wait on the rules).
 */
import * as pulumi from '@pulumi/pulumi';
import { describe, expect, it } from 'vitest';
import { k8sCensusProviders } from '../../_shared/k8s-built-ahead.js';
import { scalewayPrivateIps } from '../../_shared/scaleway-private-ips.js';

let counter = 0;
const registered: { type: string; name: string; inputs: Record<string, unknown> }[] = [];
const privateIps = scalewayPrivateIps();
pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs) {
      counter += 1;
      registered.push({ type: args.type, name: args.name, inputs: args.inputs });
      const ip = `192.0.2.${counter % 250}`;
      const id = String(8_100_000 + counter);
      return {
        id,
        state: {
          ...privateIps(args, id),
          ...args.inputs,
          ipv4Address: ip,
          ipv4AddressPrivate: `10.10.0.${counter % 250}`,
          ipAddress: ip,
          address: ip,
          mainIp: ip,
          internalIp: `10.10.0.${counter % 250}`,
          subnet: args.inputs.subnet ?? ip,
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

const OPERATOR = ['203.0.113.5/32', '2001:db8::1/128'];

type K8sProvider = {
  NAME: string;
  REGIONS: Record<string, unknown>;
  DEFAULT_K8S_NODE_TYPE: string;
  K8S_OPERATOR_RULES_AFTER_UP: boolean;
  getK8sProgram: (config: object) => Promise<() => Promise<Record<string, unknown>>>;
};

/** One inbound accept rule: protocol, port or range, and its sources. */
type Rule = { protocol: string; port: string; sources: string[] };

/**
 * Providers whose firewall never sees traffic on the cluster's private
 * network, with the source: the probe's private checks pass there whatever
 * the rules say.
 */
const PRIVATE_UNFILTERED: Record<string, string> = {
  hetzner:
    'Hetzner Cloud Firewalls do not filter private networks ("Not yet, because we consider ' +
    'the private networks to be secure", docs.hetzner.com/cloud/firewalls/faq)',
  scaleway:
    "an instance's security group never filters its Private Network NIC; only a group applied " +
    'to that NIC would, and none is (src/lib/iac/programs/scaleway-k8s.js)',
};

/**
 * Per provider: the Pulumi type that holds its inbound rules, and how one
 * resource's inputs read as Rules. Vultr's rules are one resource each.
 */
const READERS: Record<
  string,
  { type: string; rules: (inputs: Record<string, unknown>) => Rule[] }
> = {
  hetzner: {
    type: 'hcloud:index/firewall:Firewall',
    rules: (inputs) =>
      (inputs.rules as Record<string, unknown>[])
        .filter((r) => r.direction === 'in')
        .map((r) => ({
          protocol: String(r.protocol),
          port: String(r.port ?? 'any'),
          sources: (r.sourceIps as string[]) ?? [],
        })),
  },
  digitalocean: {
    type: 'digitalocean:index/firewall:Firewall',
    rules: (inputs) =>
      (inputs.inboundRules as Record<string, unknown>[]).map((r) => ({
        protocol: String(r.protocol),
        port: String(r.portRange ?? 'any'),
        sources: (r.sourceAddresses as string[]) ?? [],
      })),
  },
  linode: {
    type: 'linode:index/firewall:Firewall',
    rules: (inputs) => {
      expect(inputs.inboundPolicy, 'Linode drops what no rule admits').toBe('DROP');
      return (inputs.inbounds as Record<string, unknown>[])
        .filter((r) => r.action === 'ACCEPT')
        .map((r) => ({
          protocol: String(r.protocol).toLowerCase(),
          port: String(r.ports ?? 'any'),
          sources: [...((r.ipv4s as string[]) ?? []), ...((r.ipv6s as string[]) ?? [])],
        }));
    },
  },
  vultr: {
    type: 'vultr:index/firewallRule:FirewallRule',
    rules: (inputs) => [
      {
        protocol: String(inputs.protocol),
        port: String(inputs.port ?? 'any'),
        sources: [`${inputs.subnet}/${inputs.subnetSize}`],
      },
    ],
  },
  scaleway: {
    type: 'scaleway:instance/securityGroup:SecurityGroup',
    rules: (inputs) => {
      expect(inputs.inboundDefaultPolicy, 'Scaleway drops what no rule admits').toBe('drop');
      return (inputs.inboundRules as Record<string, unknown>[])
        .filter((r) => r.action === 'accept')
        .map((r) => ({
          protocol: String(r.protocol).toLowerCase(),
          port: String(r.port ?? 'any'),
          sources: [String(r.ipRange)],
        }));
    },
  },
};

/** Does a rule's port field (`22`, `1-65535`, `1:65535`, `any`) cover port 22? */
function covers22(port: string): boolean {
  if (port === 'any' || port === '' || port === 'undefined') return true;
  const [from, to = from] = port.split(/[-:]/).map(Number);
  return from <= 22 && 22 <= to;
}

/** An RFC 1918 IPv4 range: the cluster's private network, never the internet. */
function isPrivateRange(cidr: string): boolean {
  const [a, b] = cidr.split('/')[0].split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** What in `rules` breaks what the probe's sentences say of this firewall. */
function firewallFindings(
  rules: Rule[],
  { privateFiltered, operator }: { privateFiltered: boolean; operator: string[] },
): string[] {
  const out: string[] = [];
  if (privateFiltered) {
    if (!rules.some((r) => r.protocol === 'icmp' && r.sources.some(isPrivateRange))) {
      out.push('no rule lets ping in from the private network');
    }
    if (
      !rules.some((r) => r.protocol === 'tcp' && covers22(r.port) && r.sources.some(isPrivateRange))
    ) {
      out.push('no rule lets port 22 in from the private network');
    }
  }
  for (const r of rules) {
    const outside = r.sources.filter((s) => !isPrivateRange(s));
    if (r.protocol === 'icmp' && outside.length > 0) {
      out.push(`a rule lets ping in from ${outside.join(', ')}`);
    }
    if (r.protocol === 'tcp' && covers22(r.port)) {
      const strangers = outside.filter((s) => !operator.includes(s));
      if (strangers.length > 0) out.push(`a rule lets port 22 in from ${strangers.join(', ')}`);
    }
  }
  return out;
}

/** Run one cluster's program under the mocks; every resource it registered. */
async function run(Provider: K8sProvider) {
  registered.length = 0;
  const node = Provider.DEFAULT_K8S_NODE_TYPE;
  const program = await Provider.getK8sProgram({
    projectName: 'acme',
    environment: 'prod',
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
    replicationPeerIp: '198.51.100.70',
  });
  const outputs = await program();
  await new Promise((resolve) => pulumi.all(Object.values(outputs)).apply(resolve));
  for (let seen = -1; seen !== registered.length; ) {
    seen = registered.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [...registered];
}

const k8sProviders = k8sCensusProviders('program') as unknown as [string, K8sProvider][];

describe('the cluster firewall says what the probe from the k3s server says it does', () => {
  it('walks every k8s provider, each with a rule reader', () => {
    expect(k8sProviders.length).toBeGreaterThan(0);
    expect(k8sProviders.map(([id]) => id).filter((id) => !(id in READERS))).toEqual([]);
    for (const [id, why] of Object.entries(PRIVATE_UNFILTERED)) {
      expect(id in READERS, `${id} is no k8s provider`).toBe(true);
      expect(why.length).toBeGreaterThan(40);
    }
  });

  for (const [id, Provider] of k8sProviders) {
    it(`${id}: ping and port 22 from the private network pass; from outside, no ping and port 22 only from the operator`, async () => {
      const { type, rules } = READERS[id];
      const found = (await run(Provider)).filter((r) => r.type === type);
      expect(found.length, `${Provider.NAME}: its ${type}`).toBeGreaterThan(0);
      const all = found.flatMap((r) => rules(r.inputs));
      if (Provider.K8S_OPERATOR_RULES_AFTER_UP) {
        // REST writes port 22 from the operator CIDRs after the up: the
        // program itself must declare none from outside the private network.
        expect(
          all.filter(
            (r) => r.protocol === 'tcp' && covers22(r.port) && !r.sources.every(isPrivateRange),
          ),
        ).toEqual([]);
      }
      expect(
        firewallFindings(all, {
          privateFiltered: !(id in PRIVATE_UNFILTERED),
          operator: OPERATOR,
        }),
      ).toEqual([]);
    });
  }

  describe('the checks bite', () => {
    const tcp = (port: string, ...sources: string[]) => ({ protocol: 'tcp', port, sources });
    const icmp = (...sources: string[]) => ({ protocol: 'icmp', port: 'any', sources });

    it('ports cover 22 by value, range or any', () => {
      expect(['22', '1-65535', '1:65535', 'any'].map(covers22)).toEqual([true, true, true, true]);
      expect(['80', '23-100', '6443'].map(covers22)).toEqual([false, false, false]);
    });

    it('a filtered private network without ping or port 22 is flagged', () => {
      expect(
        firewallFindings([tcp('6443', '10.0.1.0/24')], {
          privateFiltered: true,
          operator: OPERATOR,
        }),
      ).toEqual([
        'no rule lets ping in from the private network',
        'no rule lets port 22 in from the private network',
      ]);
      expect(
        firewallFindings([tcp('1-65535', '10.0.1.0/24'), icmp('10.0.1.0/24')], {
          privateFiltered: true,
          operator: OPERATOR,
        }),
      ).toEqual([]);
    });

    it('ping from outside, or port 22 from anyone but the operator, is flagged', () => {
      expect(
        firewallFindings([icmp('0.0.0.0/0'), tcp('22', '0.0.0.0/0', OPERATOR[0])], {
          privateFiltered: false,
          operator: OPERATOR,
        }),
      ).toEqual(['a rule lets ping in from 0.0.0.0/0', 'a rule lets port 22 in from 0.0.0.0/0']);
    });
  });
});
