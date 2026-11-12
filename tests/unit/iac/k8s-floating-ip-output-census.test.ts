/**
 * Every k8s program exports a `floatingIp` output exactly when its provider
 * says its clusters have one (`K8S_FLOATING_IP`).
 *
 * The flag is what the rest of the CLI trusts: deployK3s requires the output
 * only where it is set, and a deploy releases a recorded reserved IP only
 * where it is not (k8s/retired-reserved-ip.js). A program that mints a
 * floating IP its provider says it lacks would have the deploy release the
 * cluster's live ingress address; a program that drops the output on a
 * provider that says it has one fails every deploy at "Pulumi outputs
 * missing floatingIp". So each program is RUN here (Pulumi's mock runtime,
 * no cloud) and its real output keys compared with the flag.
 */
import * as pulumi from '@pulumi/pulumi';
import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../../../src/lib/providers/index.js';

let counter = 0;
/** Every resource the current program run registered: type token and logical name. */
const registered: { type: string; name: string }[] = [];
pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs) {
      counter += 1;
      registered.push({ type: args.type, name: args.name });
      // Every address field any of the programs reads, on every resource.
      const ip = `203.0.113.${counter % 250}`;
      return {
        id: String(7_000_000 + counter),
        state: {
          ...args.inputs,
          ipv4Address: ip,
          ipv4AddressPrivate: `10.10.0.${counter % 250}`,
          ipAddress: ip,
          address: ip,
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

type K8sProvider = {
  NAME: string;
  SUPPORTED_TIERS: string[];
  REGIONS: Record<string, unknown>;
  DEFAULT_K8S_NODE_TYPE: string;
  K8S_FLOATING_IP: boolean;
  RETIRED_STACK_RESOURCES: readonly { type: string; name: string }[];
  getK8sProgram: (config: object) => Promise<() => Promise<Record<string, unknown>>>;
};

const k8sProviders = Object.entries(PROVIDERS as unknown as Record<string, K8sProvider>).filter(
  ([, P]) => P.SUPPORTED_TIERS.includes('k8s'),
);

describe('k8s program outputs match K8S_FLOATING_IP', () => {
  it('there are k8s providers on both sides of the flag', () => {
    const flags = new Set(k8sProviders.map(([, P]) => P.K8S_FLOATING_IP));
    expect(flags).toEqual(new Set([true, false]));
  });

  it.each(k8sProviders)('%s', async (_id, Provider) => {
    registered.length = 0;
    const node = Provider.DEFAULT_K8S_NODE_TYPE;
    const program = await Provider.getK8sProgram({
      projectName: 'acme',
      environment: 'prod',
      sshPublicKey: 'ssh-ed25519 AAAAtest test@example.com',
      location: Object.keys(Provider.REGIONS)[0],
      masterServerType: node,
      dbServerType: node,
      workerServerType: node,
      minWorkers: 1,
      maxWorkers: 2,
      k3sVersion: 'v1.37.2+k3s1',
      apiToken: 'test-token-1234',
      labels: { 'managed-by': 'vibecarbon', 'os-flavor': 'k3s' },
      allowedSshIps: ['203.0.113.5/32'],
      allowedK8sApiIps: ['203.0.113.5/32'],
      k3sToken: 'SENTINEL-k3s-token',
    });
    const outputs = await program();
    expect(Object.keys(outputs)).toContain('masterIp');
    expect(
      Object.keys(outputs).includes('floatingIp'),
      `${Provider.NAME}: floatingIp output vs K8S_FLOATING_IP`,
    ).toBe(Provider.K8S_FLOATING_IP);
    // Every up takes RETIRED_STACK_RESOURCES out of the stack's state before
    // it runs (lib/iac/retired-resources.js). A program that declared one
    // again would have it dropped from state and created anew on every up.
    // Registration is asynchronous under the mocks: let every output resolve,
    // then wait until no more resources arrive.
    await new Promise((resolve) => pulumi.all(Object.values(outputs)).apply(resolve));
    for (let seen = -1; seen !== registered.length; ) {
      seen = registered.length;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(registered.length).toBeGreaterThan(0);
    const declared = registered.filter((r) =>
      Provider.RETIRED_STACK_RESOURCES.some((x) => x.type === r.type && x.name === r.name),
    );
    expect(declared, `${Provider.NAME} declares a retired resource`).toEqual([]);
  });
});
