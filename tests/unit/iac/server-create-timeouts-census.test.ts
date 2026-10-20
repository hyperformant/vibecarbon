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

async function runProgram(file: string) {
  const { builder, config } = PROGRAMS[file];
  const mod = await import(`../../../src/lib/iac/programs/${file}`);
  created.length = 0;
  await mod[builder](config)();
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
