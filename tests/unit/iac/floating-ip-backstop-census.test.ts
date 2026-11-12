/**
 * Every floating or reserved IP a program makes, destroy can find by its
 * labels.
 *
 * A deploy killed while Pulumi was creating the IP leaves it named nowhere:
 * the pre-destroy refresh drops the pending create, and the address never
 * reached .vibecarbon.json. Destroy then finds it only by the labels the
 * program stamped on it, the project and the stack's environment
 * (deleteReservedIpsByLabels, asked by sweepTaggedReservedIps). So each
 * program is RUN here (Pulumi's mock runtime, no cloud) and every IP it
 * registers is held to that:
 *   - it carries both labels (Hetzner's `labels`, or `project:` and
 *     `environment:` tags), so the sweep scoped to this environment finds it
 *     and no other environment's sweep does;
 *   - its provider has `deleteReservedIpsByLabels`;
 *   - a compose program makes one exactly when its provider says so
 *     (COMPOSE_FLOATING_IP), the flag destroy asks before it looks.
 */
import * as pulumi from '@pulumi/pulumi';
import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../../../src/lib/providers/index.js';

let counter = 0;
const registered: { type: string; name: string; inputs: Record<string, unknown> }[] = [];
pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs) {
      counter += 1;
      registered.push({ type: args.type, name: args.name, inputs: args.inputs });
      const ip = `203.0.113.${counter % 250}`;
      return {
        id: String(7_000_000 + counter),
        state: {
          ...args.inputs,
          ipv4Address: ip,
          ipv4AddressPrivate: `10.10.0.${counter % 250}`,
          ipAddress: ip,
          address: ip,
          mainIp: ip,
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

/** A floating or reserved IP's type token (not its assignment). */
const IP_TYPE = /:(FloatingIp|ReservedIp|Ip)$/;

type AnyProvider = {
  NAME: string;
  SUPPORTED_TIERS: string[];
  REGIONS: Record<string, unknown>;
  DEFAULT_K8S_NODE_TYPE?: string;
  COMPOSE_FLOATING_IP?: boolean;
  prototype: { deleteReservedIpsByLabels?: unknown };
  getK8sProgram: (config: object) => Promise<() => Promise<Record<string, unknown>>>;
  getComposeProgram: (config: object) => Promise<() => Promise<Record<string, unknown>>>;
};
const providers = Object.entries(PROVIDERS as unknown as Record<string, AnyProvider>);

const LABELS = { project: 'acme', environment: 'prod' };
const common = {
  projectName: LABELS.project,
  environment: LABELS.environment,
  sshPublicKey: 'ssh-ed25519 AAAAtest test@example.com',
  apiToken: 'test-token-1234',
  allowedSshIps: ['203.0.113.5/32'],
  allowedK8sApiIps: ['203.0.113.5/32'],
};

/** Run a program to quiescence; the IP resources it registered. */
async function ipsOf(program: () => Promise<Record<string, unknown>>) {
  registered.length = 0;
  const outputs = await program();
  await new Promise((resolve) => pulumi.all(Object.values(outputs)).apply(resolve));
  for (let seen = -1; seen !== registered.length; ) {
    seen = registered.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(registered.length).toBeGreaterThan(0);
  return registered.filter((r) => IP_TYPE.test(r.type));
}

/** Whether a registered IP carries both labels, as labels or as `key:value` tags. */
function carriesBoth(inputs: Record<string, unknown>) {
  const labels = (inputs.labels ?? {}) as Record<string, string>;
  const tags = (inputs.tags ?? []) as string[];
  return Object.entries(LABELS).every(([k, v]) => labels[k] === v || tags.includes(`${k}:${v}`));
}

function holdsToTheSweep(id: string, P: AnyProvider, ips: Awaited<ReturnType<typeof ipsOf>>) {
  for (const ip of ips) {
    expect(carriesBoth(ip.inputs), `${id} ${ip.type} carries the project and environment`).toBe(
      true,
    );
    expect(
      typeof P.prototype.deleteReservedIpsByLabels,
      `${id} makes ${ip.type}: destroy needs deleteReservedIpsByLabels to find one no record names`,
    ).toBe('function');
  }
}

describe('floating and reserved IPs a program makes are found by their labels', () => {
  const k8s = providers.filter(([, P]) => P.SUPPORTED_TIERS.includes('k8s'));
  const compose = providers.filter(([, P]) => P.SUPPORTED_TIERS.includes('compose'));

  it.each(k8s)('k8s: %s', async (id, P) => {
    const node = P.DEFAULT_K8S_NODE_TYPE as string;
    const program = await P.getK8sProgram({
      ...common,
      location: Object.keys(P.REGIONS)[0],
      masterServerType: node,
      dbServerType: node,
      workerServerType: node,
      minWorkers: 1,
      maxWorkers: 2,
      k3sVersion: 'v1.37.2+k3s1',
      // The CLI always passes one (lib/iac/k3s-token.js); a k8s program refuses without it.
      k3sToken: 'SENTINEL-k3s-token',
      labels: { 'managed-by': 'vibecarbon', 'os-flavor': 'k3s' },
    });
    holdsToTheSweep(id, P, await ipsOf(program));
  });

  it.each(compose)('compose: %s', async (id, P) => {
    const program = await P.getComposeProgram({
      ...common,
      location: Object.keys(P.REGIONS)[0],
      serverType: 'test-type',
    });
    const ips = await ipsOf(program);
    holdsToTheSweep(id, P, ips);
    expect(ips.length > 0, `${id}: compose makes an IP exactly when COMPOSE_FLOATING_IP says`).toBe(
      P.COMPOSE_FLOATING_IP === true,
    );
  });

  it('the census sees IPs on both tiers, so a broken type match cannot pass on nothing', async () => {
    const seen = new Set<string>();
    for (const [, P] of providers) {
      if (P.SUPPORTED_TIERS.includes('k8s')) {
        const node = P.DEFAULT_K8S_NODE_TYPE as string;
        const program = await P.getK8sProgram({
          ...common,
          location: Object.keys(P.REGIONS)[0],
          masterServerType: node,
          dbServerType: node,
          workerServerType: node,
          minWorkers: 1,
          maxWorkers: 2,
          k3sVersion: 'v1.37.2+k3s1',
          k3sToken: 'SENTINEL-k3s-token',
          labels: {},
        });
        for (const ip of await ipsOf(program)) seen.add(`k8s ${ip.type}`);
      }
    }
    for (const [, P] of providers) {
      if (P.COMPOSE_FLOATING_IP !== true) continue;
      const program = await P.getComposeProgram({
        ...common,
        location: Object.keys(P.REGIONS)[0],
        serverType: 'test-type',
      });
      for (const ip of await ipsOf(program)) seen.add(`compose ${ip.type}`);
    }
    expect([...seen].sort()).toEqual([
      'compose scaleway:instance/ip:Ip',
      'k8s hcloud:index/floatingIp:FloatingIp',
      'k8s linode:index/reservedIp:ReservedIp',
    ]);
  });
});
