import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as pulumi from '@pulumi/pulumi';
import { describe, expect, it, vi } from 'vitest';
import { SERVER_RESOURCE_TYPES } from '../../../src/lib/iac/create-timeout.js';

/**
 * Census: everything a provider program hands the Pulumi engine that carries a
 * credential is a secret Output, so Pulumi writes it into the state sealed with
 * the project's state passphrase instead of as plain text. That holds for
 * servers created from then on. A server that already exists keeps the user
 * data its state holds (the next paragraph says why) until the seal after a
 * successful up rewrites it (lib/iac/state-seal.js, upStack).
 *
 * A server's user data is the rendered cloud-init. On the k8s programs it holds
 * the provider token and the k3s join token; the compose cloud-init
 * (carbon/cloud-init/docker-ce-setup.yaml) carries no credential, and a test
 * below holds every compose program to that. A single-server compose deploy
 * never runs an up on the server it already has (deploy/plan/steps.js
 * provisionServerStep), so such a server an older version made keeps its
 * user data plain for good, and that is safe only while it carries no
 * credential. Server user data sits in `ignoreChanges` (create-timeout.js),
 * so wrapping it replaces no existing server; the first test pins that
 * pairing.
 *
 * Same harness as server-create-timeouts-census.test.ts: each provider SDK is a
 * recorder, every program runs, and the arguments of every resource are read
 * back. The programs come from the directory and the server classes from
 * SERVER_RESOURCE_TYPES, so a registered server type without a wrap fails here.
 * A VM type missing from SERVER_RESOURCE_TYPES is skipped here, and caught by
 * server-create-timeouts-census.test.ts ("every VM-shaped class is a known
 * server class").
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

/** `value` resolved through every Output, secret ones included. */
async function revealed(value: unknown): Promise<unknown> {
  if (pulumi.Output.isInstance(value)) {
    const inner = await new Promise((resolve) =>
      (value as pulumi.Output<unknown>).apply((x) => {
        resolve(x);
        return x;
      }),
    );
    return revealed(inner);
  }
  if (Array.isArray(value)) return Promise.all(value.map(revealed));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await revealed(v)])),
    );
  }
  return value;
}

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

  it('every program that exports a k3sToken exports it as a secret Output carrying the token', async () => {
    const exporting: string[] = [];
    for (const file of Object.keys(PROGRAMS)) {
      const { outputs } = await runProgram(file);
      if (!('k3sToken' in outputs)) continue;
      exporting.push(file);
      expect(await isSecret(outputs.k3sToken), `${file}: k3sToken`).toBe(true);
      expect(await revealed(outputs.k3sToken), `${file}: k3sToken`).toBe(K3S_TOKEN);
    }
    // Every program fed a k3s token hands it back, or the scale and failover
    // that replay it would mint a new one.
    const fed = Object.keys(PROGRAMS).filter((f) => 'k3sToken' in PROGRAMS[f].config);
    expect(fed.length).toBeGreaterThan(0);
    expect(exporting.sort()).toEqual(fed.sort());
  });

  it.each(Object.keys(PROGRAMS).filter((f) => 'k3sToken' in PROGRAMS[f].config))(
    '%s: the tokens reach its servers, so the walk below would see a plain copy',
    async (file) => {
      // Positive control for the walk: a config key renamed in a program
      // would leave the sentinels out of every resource, and the walk would
      // pass on nothing. When the tokens leave user data, this changes too.
      const { resources } = await runProgram(file);
      const userData = await Promise.all(
        resources
          .filter((r) => r.token in SERVER_RESOURCE_TYPES)
          .map(async (r) => {
            const input =
              SERVER_RESOURCE_TYPES[r.token as keyof typeof SERVER_RESOURCE_TYPES].userDataInput;
            return JSON.stringify(await revealed((r.args as Record<string, unknown>)[input]));
          }),
      );
      const decoded = userData.map((u) =>
        // Linode carries user data base64-encoded in its metadata.
        u.replace(/"userData":"([A-Za-z0-9+/=]+)"/g, (_m, b64) =>
          Buffer.from(b64, 'base64').toString('utf8'),
        ),
      );
      expect(
        decoded.some((u) => u.includes(K3S_TOKEN)),
        `${file}: k3s token`,
      ).toBe(true);
      expect(
        decoded.some((u) => u.includes(API_TOKEN)),
        `${file}: provider token`,
      ).toBe(true);
    },
  );

  it.each(Object.keys(PROGRAMS).filter((f) => f.endsWith('-compose.js')))(
    '%s: its user data carries no credential, since a single-server compose deploy never seals the server it has',
    async (file) => {
      const { resources } = await runProgram(file);
      const servers = resources.filter((r) => r.token in SERVER_RESOURCE_TYPES);
      expect(servers.length).toBeGreaterThan(0);
      for (const server of servers) {
        const input =
          SERVER_RESOURCE_TYPES[server.token as keyof typeof SERVER_RESOURCE_TYPES].userDataInput;
        // Linode carries user data base64-encoded in its metadata.
        const userData = JSON.stringify(
          await revealed((server.args as Record<string, unknown>)[input]),
        ).replace(/"userData":"([A-Za-z0-9+/=]+)"/g, (_m, b64) =>
          Buffer.from(b64, 'base64').toString('utf8'),
        );
        // Positive control: this is the shared compose cloud-init.
        expect(userData, `${file}: ${server.name}`).toContain('/var/lib/vibecarbon/ready');
        expect(userData, `${file}: the provider token`).not.toContain(API_TOKEN);
      }
    },
  );

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
