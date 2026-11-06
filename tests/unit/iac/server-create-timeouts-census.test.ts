import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  SERVER_CREATE_TIMEOUT,
  SERVER_RESOURCE_TYPES,
} from '../../../src/lib/iac/create-timeout.js';

/**
 * Census: every server-class resource in every provider IaC program carries
 * `customTimeouts.create`.
 *
 * Without it the bridged provider's own default applies (hcloud 90m,
 * DigitalOcean and Vultr 60m), and on 2026-10-20 a Hetzner create stuck at
 * progress 0 held `vibecarbon deploy` for more than 70 minutes with no output.
 * See src/lib/iac/create-timeout.js for the bound and its evidence.
 *
 * Checked as the programs build their resources, not as source text: each
 * provider SDK is replaced by a recorder (tests/_shared/pulumi-recorder.ts),
 * every program runs, and the options handed to each server-class
 * constructor are read back. A program added to src/lib/iac/programs/ without
 * a row here fails the first test, and a new provider's server class fails
 * the "known server class" check, so neither can slip past.
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

/** Recorder type (`hcloud.Server`, `scaleway.instance.Server`) → Pulumi type token. */
function typeToken(recorded: string): string {
  const parts = recorded.split('.');
  const cls = parts.pop() as string;
  const [pkg, mod = 'index'] = parts;
  return `${pkg}:${mod}/${cls[0].toLowerCase()}${cls.slice(1)}:${cls}`;
}

/** Class names that mean "a VM" in some provider SDK. */
const VM_CLASS = /^(Server|Droplet|Instance|InstanceServer|Vm|VirtualMachine|Linode)$/;

const base = {
  projectName: 'p',
  environment: 'e',
  sshPublicKey: 'ssh-ed25519 AAAA',
  location: 'fsn1',
  serverType: 'cx23',
  labels: {},
  allowedSshIps: ['203.0.113.7/32'],
};
const k8s = {
  ...base,
  allowedK8sApiIps: ['203.0.113.7/32'],
  k3sVersion: 'v1.31.0+k3s1',
  masterServerType: 'cx23',
  dbServerType: 'cx23',
  workerServerType: 'cx23',
  minWorkers: 2,
  apiToken: 'test-token',
  // An existing cluster's token, replayed. A first deploy mints its own.
  k3sToken: 'replayed-token',
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
  'scaleway-compose.js': {
    builder: 'buildScalewayComposeProgram',
    config: { ...base, location: 'fr-par-1' },
  },
};

async function runProgram(file: string, configOverride?: Record<string, unknown>) {
  const { builder, config } = PROGRAMS[file];
  const mod = await import(`../../../src/lib/iac/programs/${file}`);
  created.length = 0;
  await mod[builder](configOverride ?? config)();
  return created.map((r) => ({ ...r, token: typeToken(r.type) }));
}

describe('server-class create timeouts (census)', () => {
  it('every program in src/lib/iac/programs has a row in this census', () => {
    const dir = join(process.cwd(), 'src/lib/iac/programs');
    const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
    expect(files.sort()).toEqual(Object.keys(PROGRAMS).sort());
  });

  it('the bound is a Pulumi duration the bridge parses', () => {
    expect(SERVER_CREATE_TIMEOUT).toMatch(/^\d+m$/);
  });

  it.each(Object.keys(PROGRAMS))(
    '%s: every server-class resource sets customTimeouts.create',
    async (file) => {
      const resources = await runProgram(file);
      const servers = resources.filter((r) => r.token in SERVER_RESOURCE_TYPES);
      // The recorder saw real servers, so an empty pass is impossible.
      expect(servers.length, `${file} registered no server-class resource`).toBeGreaterThan(0);
      for (const server of servers) {
        const opts = (server.opts ?? {}) as { customTimeouts?: { create?: string } };
        expect(
          opts.customTimeouts?.create,
          `${file}: ${server.type} "${server.name}" has no customTimeouts.create`,
        ).toBe(SERVER_CREATE_TIMEOUT);
      }
    },
  );

  // Safety: a cloud-init edit must never replace a live node. Every
  // provider's user-data input forces a replacement on change, and a compose
  // server's (or a k8s master's or db node's) data lives on its disk. k8s
  // WORKERS hold no data, but replacing every static worker because a
  // comment or a timing mark moved in worker-init.sh is churn: they ignore
  // their user data too, and are rebuilt instead through a replacementTrigger
  // carrying only their join target (the master they join, by id and
  // address, and the k3s version), which is what must still rebuild them.
  it.each(Object.keys(PROGRAMS))(
    '%s: every server-class resource ignores changes to its user data',
    async (file) => {
      const resources = await runProgram(file);
      const servers = resources.filter((r) => r.token in SERVER_RESOURCE_TYPES);
      expect(servers.length).toBeGreaterThan(0);
      for (const server of servers) {
        const input =
          SERVER_RESOURCE_TYPES[server.token as keyof typeof SERVER_RESOURCE_TYPES].userDataInput;
        // Non-vacuous: the input really is where this server's user data goes.
        expect(
          Object.keys((server.args ?? {}) as object),
          `${file}: ${server.type} "${server.name}" carries no ${input}`,
        ).toContain(input);
        const opts = (server.opts ?? {}) as { ignoreChanges?: string[] };
        expect(
          opts.ignoreChanges ?? [],
          `${file}: ${server.type} "${server.name}" would be replaced by a user-data change`,
        ).toContain(input);
      }
    },
  );

  // Same guard for the base image. Hetzner compose moved from the `docker-ce`
  // app image to plain Ubuntu (2026-11-04); an image change replaces a server,
  // and a compose server's database lives on its disk.
  it.each(Object.keys(PROGRAMS))(
    '%s: every server-class resource ignores changes to its base image',
    async (file) => {
      const resources = await runProgram(file);
      const servers = resources.filter((r) => r.token in SERVER_RESOURCE_TYPES);
      expect(servers.length).toBeGreaterThan(0);
      for (const server of servers) {
        const input =
          SERVER_RESOURCE_TYPES[server.token as keyof typeof SERVER_RESOURCE_TYPES].imageInput;
        // Non-vacuous: the input really is where this server's image goes.
        expect(
          Object.keys((server.args ?? {}) as object),
          `${file}: ${server.type} "${server.name}" carries no ${input}`,
        ).toContain(input);
        const opts = (server.opts ?? {}) as { ignoreChanges?: string[] };
        expect(
          opts.ignoreChanges ?? [],
          `${file}: ${server.type} "${server.name}" would be replaced by an image change`,
        ).toContain(input);
      }
    },
  );

  // Speed: DO's vendor cloud-init installs the Droplet Console agent, costing
  // 44-68s of first boot on every node. `dropletAgent: false` skips it. The
  // provider treats the field as create-only, so it is ignored on existing
  // droplets: a live droplet is never replaced to apply it.
  it.each(Object.keys(PROGRAMS).filter((f) => f.startsWith('digitalocean-')))(
    '%s: every droplet skips the DO agent and never replaces a live one for it',
    async (file) => {
      const resources = await runProgram(file);
      const droplets = resources.filter((r) => r.token === 'digitalocean:index/droplet:Droplet');
      expect(droplets.length).toBeGreaterThan(0);
      for (const d of droplets) {
        expect((d.args as { dropletAgent?: boolean }).dropletAgent, `${file}: ${d.name}`).toBe(
          false,
        );
        const opts = (d.opts ?? {}) as { ignoreChanges?: string[] };
        expect(opts.ignoreChanges ?? [], `${file}: ${d.name} would be replaced`).toContain(
          'dropletAgent',
        );
      }
    },
  );

  it.each(Object.keys(PROGRAMS))(
    '%s: k8s workers are rebuilt by their join target, not their user data',
    async (file) => {
      const resources = await runProgram(file);
      const workers = resources.filter(
        (r) => r.token in SERVER_RESOURCE_TYPES && /^worker-/.test(r.name),
      );
      if (file.endsWith('-k8s.js'))
        expect(workers.length, `${file} has no worker`).toBeGreaterThan(0);
      for (const w of workers) {
        const opts = (w.opts ?? {}) as {
          replacementTrigger?: { apply: (f: (v: string) => void) => unknown };
        };
        expect(opts.replacementTrigger, `${file}: worker "${w.name}"`).toBeTruthy();
        // The trigger is built from the master's id (the recorder prints a
        // resource output as `<name>.<property>`) and the k3s version.
        const trigger = await new Promise<string>((resolve) => {
          opts.replacementTrigger?.apply((v) => resolve(String(v)));
        });
        expect(trigger, `${file}: worker "${w.name}" trigger`).toContain('master=master.id@');
        expect(trigger, `${file}: worker "${w.name}" trigger`).toContain(`k3s=${k8s.k3sVersion}`);
      }
    },
  );

  // Speed: Hetzner workers have a static master address, so nothing they are
  // built from needs the master to exist. A trigger built from master.id does:
  // the SDK resolves it before it registers the worker, and that alone took
  // Hetzner k8s infra from 72-124 s to 358-788 s (ff9a3a00, 2026-11-04). A
  // first deploy has no worker to protect, and a trigger that arrives on the
  // second deploy replaces nothing but counts from then on (proved on real
  // Pulumi, 2026-11-05: 7 of 7 transitions), so it waits for a token to replay.
  it('hetzner-k8s.js: a first deploy starts its workers with the master, not after it', async () => {
    const { k3sToken: _existing, ...fresh } = k8s;
    const resources = await runProgram('hetzner-k8s.js', fresh);
    const workers = resources.filter(
      (r) => r.token in SERVER_RESOURCE_TYPES && /^worker-/.test(r.name),
    );
    expect(workers).toHaveLength(2);
    for (const w of workers) {
      const opts = (w.opts ?? {}) as { replacementTrigger?: unknown; dependsOn?: unknown };
      expect(opts, `worker "${w.name}"`).not.toHaveProperty('replacementTrigger');
      expect(String(JSON.stringify(opts.dependsOn)), `worker "${w.name}"`).not.toContain('master');
      // The recorder prints a resource output as `<name>.<property>`. User data
      // is a rendered script, whose own text may say "master." in a comment.
      const { userData: _script, ...inputs } = w.args as Record<string, unknown>;
      expect(JSON.stringify(inputs), `worker "${w.name}" inputs`).not.toContain('master.');
    }
  });

  it('digitalocean-k8s.js: a first deploy keeps the trigger, its workers wait on the master anyway', async () => {
    const { k3sToken: _existing, ...fresh } = PROGRAMS['digitalocean-k8s.js'].config;
    const resources = await runProgram('digitalocean-k8s.js', fresh);
    const workers = resources.filter(
      (r) => r.token in SERVER_RESOURCE_TYPES && /^worker-/.test(r.name),
    );
    expect(workers.length).toBeGreaterThan(0);
    for (const w of workers) {
      expect(w.opts, `worker "${w.name}"`).toHaveProperty('replacementTrigger');
    }
  });

  it.each(Object.keys(PROGRAMS))(
    '%s: every VM-shaped class is a known server class',
    async (file) => {
      const resources = await runProgram(file);
      const unknown = resources
        .filter((r) => VM_CLASS.test(r.type.split('.').pop() as string))
        .filter((r) => !(r.token in SERVER_RESOURCE_TYPES))
        .map((r) => r.token);
      expect(unknown, 'add these to SERVER_RESOURCE_TYPES in create-timeout.js').toEqual([]);
    },
  );
});
