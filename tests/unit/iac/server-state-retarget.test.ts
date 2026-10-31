/**
 * Pulumi state follows a compose scale (Task 7b).
 *
 * Compose scale builds the replacement server with provider.createServer and
 * deletes the old one outside Pulumi. Left alone, the stack still names the
 * deleted server: the next compose-ha deploy's refresh drops it and `up`
 * creates a fresh server (a Hetzner name collision, or on other providers an
 * empty server the deploy then targets).
 *
 * The sync re-points the program's own `server` resource at the replacement:
 * same URN, the new provider id, the new size. `pulumi import` cannot do this
 * cleanly: a fresh import has no prior state, so the inputs a provider never
 * reads back (user data, SSH keys) come in empty and the next `up` replaces
 * the server. A re-pointed resource keeps them, and the deploy's refresh
 * (Read with the last known inputs) fills every readable field from the new
 * server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectStackMock = vi.fn();
vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...args: unknown[]) => selectStackMock(...args),
    createStack: () => {
      throw new Error('createStack must not be called: the sync never conjures a stack');
    },
    create: async () => ({ listStacks: async () => [] }),
  },
}));

const { COMPOSE_SERVER_STATE, composeServerStateSpec, retargetServerResource, syncServerState } =
  await import('../../../src/lib/iac/server-state.js');

const STACK_URN = 'urn:pulumi:prod-primary::myapp::pulumi:pulumi:Stack::myapp-prod-primary';

function deploymentFor(provider: string) {
  const spec = COMPOSE_SERVER_STATE[provider];
  return {
    version: 3,
    deployment: {
      manifest: {},
      resources: [
        {
          urn: STACK_URN,
          type: 'pulumi:pulumi:Stack',
          outputs: { serverIp: '1.1.1.1', serverId: 'old-id', firewallId: 'fw' },
        },
        {
          urn: `urn:pulumi:prod-primary::myapp::${spec.type}::server`,
          type: spec.type,
          id: 'old-id',
          inputs: { [spec.sizeKey]: 'small', userData: 'kept', name: 'myapp-prod-primary' },
          outputs: {
            id: 'old-id',
            [spec.sizeKey]: 'small',
            [spec.ipKey]: '1.1.1.1',
            userData: 'kept',
          },
          parent: STACK_URN,
        },
        {
          urn: 'urn:pulumi:prod-primary::myapp::x:index/firewall:Firewall::firewall',
          type: 'x:index/firewall:Firewall',
          id: 'fw',
          inputs: {},
          outputs: { id: 'fw' },
        },
      ],
    },
  };
}

const TARGET = { serverId: 'new-id', serverType: 'big', ip: '9.9.9.9' };

describe('COMPOSE_SERVER_STATE: every provider compose scale supports', () => {
  it('names the server resource type, its size input and its IP output per provider', () => {
    expect(COMPOSE_SERVER_STATE).toEqual({
      hetzner: { type: 'hcloud:index/server:Server', sizeKey: 'serverType', ipKey: 'ipv4Address' },
      digitalocean: {
        type: 'digitalocean:index/droplet:Droplet',
        sizeKey: 'size',
        ipKey: 'ipv4Address',
      },
      vultr: { type: 'vultr:index/instance:Instance', sizeKey: 'plan', ipKey: 'mainIp' },
      linode: { type: 'linode:index/instance:Instance', sizeKey: 'type', ipKey: 'ipAddress' },
    });
  });

  it('matches the resource class each compose program declares as `server`', async () => {
    const classes = {
      hetzner: (await import('@pulumi/hcloud')).Server,
      digitalocean: (await import('@pulumi/digitalocean')).Droplet,
      vultr: (await import('@ediri/vultr')).Instance,
      linode: (await import('@pulumi/linode')).Instance,
    } as Record<string, { __pulumiType: string }>;
    for (const [provider, spec] of Object.entries(COMPOSE_SERVER_STATE)) {
      expect(classes[provider].__pulumiType).toBe(spec.type);
    }
  });

  it('scaleway has no spec: its server holds a flexible IP and volumes the replacement does not', () => {
    expect(composeServerStateSpec('scaleway')).toBeNull();
    expect(composeServerStateSpec('hetzner')).toBe(COMPOSE_SERVER_STATE.hetzner);
  });
});

describe('retargetServerResource', () => {
  for (const provider of Object.keys(COMPOSE_SERVER_STATE)) {
    it(`${provider}: re-points the server resource at the replacement, same URN, inputs kept`, () => {
      const spec = COMPOSE_SERVER_STATE[provider];
      const before = deploymentFor(provider);
      const { deployment, changed } = retargetServerResource(before, spec, TARGET);
      expect(changed).toBe(true);
      const [stackRes, server, firewall] = deployment.deployment.resources;
      expect(server.urn).toBe(before.deployment.resources[1].urn);
      expect(server.id).toBe('new-id');
      expect(server.outputs.id).toBe('new-id');
      expect(server.inputs[spec.sizeKey]).toBe('big');
      expect(server.outputs[spec.sizeKey]).toBe('big');
      expect(server.outputs[spec.ipKey]).toBe('9.9.9.9');
      // What the provider never reads back stays as the deploy wrote it.
      expect(server.inputs.userData).toBe('kept');
      expect(server.outputs.userData).toBe('kept');
      // The stack outputs other commands read name the replacement too.
      expect(stackRes.outputs).toEqual({
        serverIp: '9.9.9.9',
        serverId: 'new-id',
        firewallId: 'fw',
      });
      // Nothing else moves.
      expect(firewall).toEqual(before.deployment.resources[2]);
      // Pure: the input is not mutated.
      expect(before.deployment.resources[1].id).toBe('old-id');
    });
  }

  it('is idempotent: a second run over its own result changes nothing', () => {
    const spec = COMPOSE_SERVER_STATE.hetzner;
    const once = retargetServerResource(deploymentFor('hetzner'), spec, TARGET).deployment;
    const twice = retargetServerResource(once, spec, TARGET);
    expect(twice.changed).toBe(false);
    expect(twice.deployment).toEqual(once);
  });

  it('refuses a stack with no server resource, naming the stack', () => {
    const spec = COMPOSE_SERVER_STATE.hetzner;
    const empty = {
      version: 3,
      deployment: { resources: [{ urn: STACK_URN, type: 'pulumi:pulumi:Stack' }] },
    };
    expect(() => retargetServerResource(empty, spec, TARGET, 'prod-primary')).toThrow(
      /stack prod-primary holds no hcloud:index\/server:Server named "server"/,
    );
  });

  it('refuses two server resources rather than guess', () => {
    const spec = COMPOSE_SERVER_STATE.hetzner;
    const d = deploymentFor('hetzner');
    d.deployment.resources.push({ ...d.deployment.resources[1] });
    expect(() => retargetServerResource(d, spec, TARGET, 'prod')).toThrow(/2 hcloud/);
  });
});

describe('syncServerState', () => {
  let imported: unknown[];
  let exported: ReturnType<typeof deploymentFor>;
  beforeEach(() => {
    imported = [];
    exported = deploymentFor('vultr');
    selectStackMock.mockReset();
    selectStackMock.mockImplementation(async () => ({
      name: 'prod-primary',
      exportStack: async () => structuredClone(exported),
      importStack: async (state: unknown) => {
        imported.push(state);
      },
    }));
  });

  it('selects the existing stack (never creates), and imports the re-pointed state', async () => {
    const out = await syncServerState('prod-primary', TARGET, {
      provider: 'vultr',
      providerToken: 'tok',
      projectName: 'myapp',
    });
    expect(out).toEqual({ changed: true });
    expect(selectStackMock).toHaveBeenCalledTimes(1);
    expect(selectStackMock.mock.calls[0][0]).toMatchObject({
      stackName: 'prod-primary',
      projectName: 'myapp',
    });
    expect(imported).toHaveLength(1);
    const server = (imported[0] as typeof exported).deployment.resources[1];
    expect(server.id).toBe('new-id');
    expect(server.inputs.plan).toBe('big');
  });

  it('writes nothing when state already names the replacement', async () => {
    exported = retargetServerResource(exported, COMPOSE_SERVER_STATE.vultr, TARGET).deployment;
    const out = await syncServerState('prod-primary', TARGET, {
      provider: 'vultr',
      providerToken: 'tok',
      projectName: 'myapp',
    });
    expect(out).toEqual({ changed: false });
    expect(imported).toHaveLength(0);
  });

  it('refuses a provider with no spec before touching state', async () => {
    await expect(
      syncServerState('prod', TARGET, {
        provider: 'scaleway',
        providerToken: 't',
        projectName: 'myapp',
      }),
    ).rejects.toThrow(/scaleway/);
    expect(selectStackMock).not.toHaveBeenCalled();
  });
});
