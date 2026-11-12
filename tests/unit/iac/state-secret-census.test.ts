import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as pulumi from '@pulumi/pulumi';
import { describe, expect, it, vi } from 'vitest';
import { SERVER_RESOURCE_TYPES } from '../../../src/lib/iac/create-timeout.js';

/**
 * Census: everything a provider program hands the Pulumi engine that carries a
 * credential is a secret Output, so the state file seals it with the project's
 * state passphrase instead of keeping it as plain text.
 *
 * A server's user data is the rendered cloud-init, which holds the provider
 * token, the S3 keys and (k8s) the k3s join token. Server user data sits in
 * `ignoreChanges` (create-timeout.js), so wrapping it replaces no existing
 * server; the first test pins that pairing.
 *
 * Same harness as server-create-timeouts-census.test.ts: each provider SDK is a
 * recorder, every program runs, and the arguments of every resource are read
 * back. The server classes come from SERVER_RESOURCE_TYPES and the programs
 * from the directory, so a new server type or program without a wrap fails
 * here rather than being skipped.
 */

const { created } = vi.hoisted(() => ({
  created: [] as Array<{ type: string; name: string; args: unknown; opts?: unknown }>,
}));

vi.mock('@pulumi/hcloud', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('hcloud', created),
);
vi.mock('@pulumi/digitalocean', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('digitalocean', created),
);
vi.mock('@ediri/vultr', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('vultr', created),
);
vi.mock('@pulumi/linode', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('linode', created),
);
vi.mock('@pulumiverse/scaleway', async () =>
  (await import('../../_shared/pulumi-recorder.js')).recorderModule('scaleway', created),
);

function typeToken(recorded: string): string {
  const parts = recorded.split('.');
  const cls = parts.pop() as string;
  const [pkg, mod = 'index'] = parts;
  return `${pkg}:${mod}/${cls[0].toLowerCase()}${cls.slice(1)}:${cls}`;
}

// Sentinels only: never a real credential.
const API_TOKEN = 'SENTINEL-api-token-4f1c';
const K3S_TOKEN = 'SENTINEL-k3s-token-9b7e';

const base = {
  projectName: 'p',
  environment: 'e',
  sshPublicKey: 'ssh-ed25519 AAAA',
  location: 'fsn1',
  serverType: 'cx23',
  labels: {},
  allowedSshIps: ['203.0.113.7/32'],
  apiToken: API_TOKEN,
};
const k8s = {
  ...base,
  allowedK8sApiIps: ['203.0.113.7/32'],
  k3sVersion: 'v1.31.0+k3s1',
  masterServerType: 'cx23',
  dbServerType: 'cx23',
  workerServerType: 'cx23',
  minWorkers: 2,
  k3sToken: K3S_TOKEN,
};

const PROGRAMS: Record<string, { builder: string; config: Record<string, unknown> }> = {
  'hetzner-compose.js': { builder: 'buildHetznerComposeProgram', config: base },
  'hetzner-k8s.js': { builder: 'buildHetznerK8sProgram', config: k8s },
  'digitalocean-compose.js': {
    builder: 'buildDigitalOceanComposeProgram',
    config: { ...base, location: 'nyc3' },
  },
  'digitalocean-k8s.js': {
    builder: 'buildDigitalOceanK8sProgram',
    config: { ...k8s, location: 'nyc3' },
  },
  'vultr-compose.js': { builder: 'buildVultrComposeProgram', config: { ...base, location: 'ewr' } },
  'linode-compose.js': {
    builder: 'buildLinodeComposeProgram',
    config: { ...base, location: 'us-east' },
  },
  'linode-k8s.js': { builder: 'buildLinodeK8sProgram', config: { ...k8s, location: 'us-east' } },
  'scaleway-compose.js': {
    builder: 'buildScalewayComposeProgram',
    config: { ...base, location: 'fr-par-1' },
  },
};

async function runProgram(file: string) {
  const { builder, config } = PROGRAMS[file];
  const mod = await import(`../../../src/lib/iac/programs/${file}`);
  created.length = 0;
  const outputs = await mod[builder](config)();
  return { resources: created.map((r) => ({ ...r, token: typeToken(r.type) })), outputs };
}

const isSecret = async (v: unknown): Promise<boolean> =>
  pulumi.Output.isInstance(v) && (await (v as pulumi.Output<unknown>).isSecret);

/**
 * Every plain string reachable from `value`. A secret Output is sealed in
 * state and so is not walked; any other Output is resolved and walked.
 */
async function plainStrings(value: unknown, out: string[] = []): Promise<string[]> {
  if (pulumi.Output.isInstance(value)) {
    if (await isSecret(value)) return out;
    const inner = await new Promise((resolve) =>
      (value as pulumi.Output<unknown>).apply((x) => {
        resolve(x);
        return x;
      }),
    );
    return plainStrings(inner, out);
  }
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const x of value) await plainStrings(x, out);
  else if (value && typeof value === 'object')
    for (const x of Object.values(value)) await plainStrings(x, out);
  return out;
}

const K8S = Object.keys(PROGRAMS).filter((f) => f.endsWith('-k8s.js'));

describe('secrets in Pulumi state (census)', () => {
  it('every program in src/lib/iac/programs has a row in this census', () => {
    const dir = join(process.cwd(), 'src/lib/iac/programs');
    const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
    expect(files.sort()).toEqual(Object.keys(PROGRAMS).sort());
  });

  it.each(Object.keys(PROGRAMS))(
    '%s: every server user data is a secret Output, and still ignored on an existing server',
    async (file) => {
      const { resources } = await runProgram(file);
      const servers = resources.filter((r) => r.token in SERVER_RESOURCE_TYPES);
      expect(servers.length, `${file} registered no server-class resource`).toBeGreaterThan(0);
      for (const server of servers) {
        const input =
          SERVER_RESOURCE_TYPES[server.token as keyof typeof SERVER_RESOURCE_TYPES].userDataInput;
        const value = (server.args as Record<string, unknown>)[input];
        expect(
          await isSecret(value),
          `${file}: ${server.type} "${server.name}" ${input} is not a secret Output`,
        ).toBe(true);
        // Wrapping adds no diff for a live server: the input is ignored.
        const opts = (server.opts ?? {}) as { ignoreChanges?: string[] };
        expect(opts.ignoreChanges ?? [], `${file}: ${server.name}`).toContain(input);
      }
    },
  );

  it.each(K8S)('%s: the k3sToken export is a secret Output carrying the token', async (file) => {
    const { outputs } = await runProgram(file);
    expect(await isSecret(outputs.k3sToken)).toBe(true);
    const plain = await new Promise((resolve) =>
      (outputs.k3sToken as pulumi.Output<string>).apply((x) => {
        resolve(x);
        return x;
      }),
    );
    expect(plain).toBe(K3S_TOKEN);
  });

  it.each(Object.keys(PROGRAMS))(
    '%s: no plain string anywhere in a resource carries the provider token or the k3s token',
    async (file) => {
      const { resources, outputs } = await runProgram(file);
      expect(resources.length).toBeGreaterThan(0);
      const seen = await plainStrings([
        resources.map((r) => [r.args, r.opts]),
        // Stack outputs are sealed per output: only the secret ones are skipped.
        outputs,
      ]);
      for (const s of seen) {
        expect(s, `${file}: a plain string carries the provider token`).not.toContain(API_TOKEN);
        expect(s, `${file}: a plain string carries the k3s token`).not.toContain(K3S_TOKEN);
      }
    },
  );
});
