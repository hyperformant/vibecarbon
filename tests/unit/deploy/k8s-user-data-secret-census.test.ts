/**
 * Census: no k8s node's user data carries the provider API token.
 *
 * User data is not a secret store. Pulumi keeps it in the stack's state as
 * plain text, the provider keeps it for the server's life, and its metadata
 * service hands it to anything on the box that asks. The k3s masters used to
 * render the provider API token into theirs, for the kube-system Secrets the
 * cloud controller and CSI driver read; deployK3s now applies those Secrets
 * from the operator's machine on every deploy (applyCloudSecrets,
 * tests/unit/deploy/k8s-cloud-secrets.test.ts), so the boot scripts take no
 * credential but the k3s join token. And that token now joins agents only
 * (`--agent-token`, tests/unit/deploy/k3s-server-flags.test.ts).
 *
 * What this file proves, for every k8s provider:
 *   - templates: every placeholder in carbon/cloud-init/k3s/ that names a
 *     credential is `k3s_token`, and no boot script creates a Secret;
 *   - programs: each k8s program, RUN under Pulumi's mock runtime (no cloud)
 *     with a sentinel apiToken, records no resource input that holds it, user
 *     data included, and renders every node's user data with no placeholder
 *     left.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pulumi from '@pulumi/pulumi';
import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../../../src/lib/providers/index.js';

const K3S_DIR = join(__dirname, '../../../carbon/cloud-init/k3s');
const SENTINEL = 'vc-sentinel-api-token-5e1d';

let counter = 0;
/** Every resource the current program run registered, with its inputs. */
const registered: { type: string; name: string; inputs: Record<string, unknown> }[] = [];
pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs) {
      counter += 1;
      registered.push({ type: args.type, name: args.name, inputs: args.inputs });
      // Every address field any of the programs reads, on every resource.
      const ip = `203.0.113.${counter % 250}`;
      return {
        id: String(8_000_000 + counter),
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
  getK8sProgram: (config: object) => Promise<() => Promise<Record<string, unknown>>>;
};

/**
 * A server's user data as it boots with it: `userData` (Hetzner, DigitalOcean)
 * or Linode's base64 `metadatas[].userData`, decoded. null for a resource
 * that carries none.
 */
function userDataOf(inputs: Record<string, unknown>): string | null {
  if (typeof inputs.userData === 'string') return inputs.userData;
  const metadatas = inputs.metadatas as { userData?: string }[] | undefined;
  const encoded = metadatas?.map((m) => m.userData).filter((u) => typeof u === 'string');
  if (!encoded?.length) return null;
  return encoded.map((u) => Buffer.from(String(u), 'base64').toString('utf-8')).join('\n');
}

const k8sProviders = Object.entries(PROVIDERS as unknown as Record<string, K8sProvider>).filter(
  ([, P]) => P.SUPPORTED_TIERS.includes('k8s'),
);

describe('the k3s boot scripts take no credential but the k3s join token', () => {
  const scripts = readdirSync(K3S_DIR)
    .filter((f) => f.endsWith('.sh'))
    .map((f) => [f, readFileSync(join(K3S_DIR, f), 'utf-8')] as const);

  it('there are master, db and worker scripts for every k8s provider', () => {
    // Hetzner's carry no prefix; the others carry the provider's.
    const names = scripts.map(([f]) => f);
    for (const role of ['master', 'db', 'worker']) {
      expect(names).toContain(`${role}-init.sh`);
      for (const prefix of ['do', 'linode']) expect(names).toContain(`${prefix}-${role}-init.sh`);
    }
  });

  it.each(readdirSync(K3S_DIR).filter((f) => f.endsWith('.sh')))(
    '%s: a credential placeholder is k3s_token or nothing',
    (file) => {
      const script = readFileSync(join(K3S_DIR, file), 'utf-8');
      const placeholders = [...new Set([...script.matchAll(/\$\{(\w+)\}/g)].map(([, v]) => v))];
      const credentials = placeholders.filter((v) =>
        /(^|_)(token|secret|password|passphrase|key|credentials?)$/i.test(v),
      );
      expect(credentials.filter((v) => v !== 'k3s_token')).toEqual([]);
      expect(script).not.toMatch(/\bcreate secret\b/);
    },
  );
});

describe('the k8s programs record no provider API token', () => {
  it('there are k8s providers to check', () => {
    expect(k8sProviders.length).toBeGreaterThan(0);
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
      // Programs no longer take it; one that read it again would put it in
      // its resources.
      apiToken: SENTINEL,
      labels: { 'managed-by': 'vibecarbon', 'os-flavor': 'k3s' },
      allowedSshIps: ['203.0.113.5/32'],
      allowedK8sApiIps: ['203.0.113.5/32'],
    });
    const outputs = await program();
    // Registration is asynchronous under the mocks: let every output resolve,
    // then wait until no more resources arrive.
    await new Promise((resolve) => pulumi.all(Object.values(outputs)).apply(resolve));
    for (let seen = -1; seen !== registered.length; ) {
      seen = registered.length;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const servers = registered
      .map(({ name, inputs }) => ({ name, userData: userDataOf(inputs) }))
      .filter(({ userData }) => userData !== null);
    expect(servers.length, 'master, db and a worker carry user data').toBeGreaterThanOrEqual(3);
    for (const { type, name, inputs } of registered) {
      expect(JSON.stringify(inputs), `${type} ${name}`).not.toContain(SENTINEL);
    }
    expect(JSON.stringify(outputs)).not.toContain(SENTINEL);
    for (const { name, userData } of servers) {
      expect(userData, `${name} user data`).not.toContain(SENTINEL);
      // Rendered all the way: an unfilled ${...} would boot with it empty.
      expect(userData, `${name} user data`).not.toMatch(/\$\{\w+\}/);
    }
  });
});
