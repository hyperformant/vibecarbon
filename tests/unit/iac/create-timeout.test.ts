/**
 * A stalled provider create becomes one readable line, and what it leaves
 * behind is still reachable by destroy.
 *
 * Failure class (2026-10-20, compose-ha restore redeploy, Hetzner hel1):
 * `create_server` and `start_server` sat at progress 0 for 70+ minutes and
 * `pulumi up --stack e2-standby` waited the whole time. With customTimeouts
 * (create-timeout.js) the provider now gives up at 15 minutes; these tests pin
 * what the user sees when it does, and that the full detail still reaches the
 * deploy log.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { sweepEnvironmentServers } from '../../../src/lib/destroy/server-sweep.js';
import {
  createTimeoutError,
  describeCreateTimeout,
  environmentForStack,
  parseCreateTimeouts,
  SERVER_CREATE_TIMEOUT_MINUTES,
} from '../../../src/lib/iac/create-timeout.js';

const selectStackMock = vi.fn();
const progressLogMock = vi.fn();

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...args: unknown[]) => selectStackMock(...args),
    createStack: () => {
      throw new Error('createStack must not be called');
    },
    create: async () => ({ listStacks: async () => [] }),
  },
}));

vi.mock('../../../src/lib/cli/progress.js', () => ({
  progressLog: (...args: unknown[]) => progressLogMock(...args),
}));

const UP_ARGV =
  'pulumi up --yes --skip-preview --color never --client=127.0.0.1:39297 ' +
  '--exec-kind auto.inline --stack e2-standby --non-interactive';

/**
 * The update stream of an hcloud server create that hit its 15m deadline, in
 * the shape the 2026-04-28 e1 log shows for a failed hcloud create (progress
 * lines, then a Diagnostics block with the `* creating urn:` line).
 */
const HCLOUD_TIMEOUT_STREAM = [
  'Updating (e2-standby):',
  '',
  ' +  pulumi:pulumi:Stack vibecarbon-e2-standby creating (0s) ',
  ' +  hcloud:index:Firewall firewall creating (0s) ',
  ' +  hcloud:index:Firewall firewall created (1s) ',
  ' +  hcloud:index:Server server creating (0s) ',
  '@ updating..........',
  ' +  hcloud:index:Server server creating (900s) error:   sdk-v2/provider2.go:572: sdk.helper_schema: context deadline exceeded: provider=hcloud@1.43.1',
  ' +  hcloud:index:Server server creating (900s) error: 1 error occurred:',
  ' +  hcloud:index:Server server **creating failed** error: 1 error occurred:',
  ' +  pulumi:pulumi:Stack vibecarbon-e2-standby creating (902s) error: update failed',
  ' +  pulumi:pulumi:Stack vibecarbon-e2-standby **creating failed** 1 error',
  'Diagnostics:',
  '  pulumi:pulumi:Stack (vibecarbon-e2-standby):',
  '    error: update failed',
  '',
  '  hcloud:index:Server (server):',
  '    error:   sdk-v2/provider2.go:572: sdk.helper_schema: context deadline exceeded: provider=hcloud@1.43.1',
  '    error: 1 error occurred:',
  '    \t* creating urn:pulumi:e2-standby::vibecarbon::hcloud:index/server:Server::server: 1 error occurred:',
  '    \t* context deadline exceeded',
  '',
  'Resources:',
  '    + 2 created',
  '    2 errored',
].join('\n');

/** The automation API's CommandResult envelope around a failed `pulumi up`. */
function commandError(stdout: string) {
  const execaMsg = [`Command failed with exit code 1: ${UP_ARGV}`, stdout].join('\n');
  const err = new Error(`code: -2\n stdout: \n stderr: ${execaMsg}\n err?: Error: ${execaMsg}\n`);
  err.name = 'CommandError';
  return err;
}

/** The checkpoint as it stands after the failure: hcloud SetId's before it waits. */
const STATE_AFTER_TIMEOUT = {
  deployment: {
    resources: [
      {
        urn: 'urn:pulumi:e2-standby::vibecarbon::pulumi:pulumi:Stack::vibecarbon-e2-standby',
        type: 'pulumi:pulumi:Stack',
      },
      {
        urn: 'urn:pulumi:e2-standby::vibecarbon::hcloud:index/server:Server::server',
        type: 'hcloud:index/server:Server',
        id: '118207654',
        inputs: {
          name: 'acme-e2-standby',
          location: 'hel1',
          labels: {
            'managed-by': 'vibecarbon',
            project: 'acme',
            environment: 'e2-standby',
            role: 'compose',
          },
        },
        initErrors: ['context deadline exceeded'],
      },
    ],
  },
};

describe('parseCreateTimeouts', () => {
  it('finds the stalled hcloud server create, with its elapsed time', () => {
    expect(parseCreateTimeouts(commandError(HCLOUD_TIMEOUT_STREAM).message)).toEqual([
      {
        urn: 'urn:pulumi:e2-standby::vibecarbon::hcloud:index/server:Server::server',
        stack: 'e2-standby',
        type: 'hcloud:index/server:Server',
        logicalName: 'server',
        elapsedSeconds: 900,
      },
    ]);
  });

  it('reads the SDKv2 waiter spelling (DigitalOcean, Vultr)', () => {
    const msg = [
      '  digitalocean:index/droplet:Droplet (server):',
      '    error: 1 error occurred:',
      '    \t* creating urn:pulumi:d1::vibecarbon::digitalocean:index/droplet:Droplet::server: 1 error occurred:',
      "    \t* Error waiting for droplet (5550123) to become ready: timeout while waiting for state to become 'active' (last state: 'new', timeout: 15m0s)",
    ].join('\n');
    expect(parseCreateTimeouts(msg).map((t) => t.type)).toEqual([
      'digitalocean:index/droplet:Droplet',
    ]);
  });

  it("reads scaleway-sdk-go's waiter spelling", () => {
    const msg =
      '\t* creating urn:pulumi:e1::vibecarbon::scaleway:instance/server:Server::server: 1 error occurred:\n' +
      '\t* scaleway-sdk-go: waiting for server failed: timeout after 15m0s';
    expect(parseCreateTimeouts(msg)).toHaveLength(1);
  });

  it('ignores a create that failed for any other reason', () => {
    const msg = HCLOUD_TIMEOUT_STREAM.replaceAll(
      'context deadline exceeded',
      'resource is currently unavailable (resource_unavailable, 626584196208650)',
    );
    expect(parseCreateTimeouts(msg)).toEqual([]);
  });

  it("ignores one HTTP request's client timeout: that is not the create stalling", () => {
    const msg = HCLOUD_TIMEOUT_STREAM.replaceAll(
      'context deadline exceeded',
      'Get "https://api.hetzner.cloud/v1/actions?id=1": context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
    );
    expect(parseCreateTimeouts(msg)).toEqual([]);
  });

  it('ignores a deadline that is not on a create (a delete, say)', () => {
    const msg =
      '\t* deleting urn:pulumi:e1::vibecarbon::hcloud:index/server:Server::server: 1 error occurred:\n' +
      '\t* context deadline exceeded';
    expect(parseCreateTimeouts(msg)).toEqual([]);
  });
});

describe('createTimeoutError', () => {
  const original = commandError(HCLOUD_TIMEOUT_STREAM);
  const err = createTimeoutError(original, { resources: STATE_AFTER_TIMEOUT.deployment.resources });

  it('names the provider, the resource type and name, and the location', () => {
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('Hetzner');
    expect(msg).toContain('server "acme-e2-standby"');
    expect(msg).toContain('hcloud:index/server:Server');
    expect(msg).toContain('in hel1');
    expect(msg).toContain(`after ${SERVER_CREATE_TIMEOUT_MINUTES} minutes`);
  });

  it('says what to do next: delete and retry, another location, the status page', () => {
    const msg = (err as Error).message;
    expect(msg).toMatch(/Delete that server in the Hetzner console and run the deploy again/);
    expect(msg).toMatch(/usually lands on a healthy host/);
    expect(msg).toMatch(/pick a location other than hel1/);
    expect(msg).toContain('https://status.hetzner.com');
    expect(msg).toContain('deploy log');
  });

  it('is one line in the CLI voice: second person, no em dash', () => {
    const msg = (err as Error).message;
    expect(msg).not.toContain('\n');
    expect(msg).not.toMatch(/—/);
    expect(msg).toMatch(/\byour project\b/);
  });

  it('keeps the original error as its cause and carries the parsed details', () => {
    expect((err as Error & { cause: unknown }).cause).toBe(original);
    expect((err as Error & { createTimeout: Record<string, unknown> }).createTimeout).toMatchObject(
      {
        type: 'hcloud:index/server:Server',
        resourceName: 'acme-e2-standby',
        location: 'hel1',
        environment: 'e2',
      },
    );
  });

  it('falls back to the Pulumi name and no location when state is unreadable', () => {
    const msg = (createTimeoutError(original) as Error).message;
    expect(msg).toContain('server "server"');
    expect(msg).not.toContain(' in hel1');
    expect(msg).toContain('pick a different location');
  });

  it('returns null for every other failure', () => {
    expect(createTimeoutError(new Error('error: update failed'))).toBeNull();
  });
});

describe('describeCreateTimeout', () => {
  it.each([
    [
      'digitalocean:index/droplet:Droplet',
      'DigitalOcean',
      'droplet',
      'https://status.digitalocean.com',
    ],
    ['vultr:index/instance:Instance', 'Vultr', 'instance', 'https://status.vultr.com'],
    ['linode:index/instance:Instance', 'Linode', 'instance', 'https://status.linode.com'],
    ['scaleway:instance/server:Server', 'Scaleway', 'server', 'https://status.scaleway.com'],
  ])('%s reads as %s %s, with its status page', (type, label, noun, url) => {
    const msg = describeCreateTimeout({ type, logicalName: 'server', location: 'x1' });
    expect(msg).toContain(`${label} never finished creating ${noun} "server"`);
    expect(msg).toContain(url);
  });

  it('a non-server resource reports the time it actually waited', () => {
    const msg = describeCreateTimeout({
      type: 'hcloud:index/floatingIp:FloatingIp',
      logicalName: 'ingress-ip',
      elapsedSeconds: 1200,
    });
    expect(msg).toContain('floating ip "ingress-ip"');
    expect(msg).toContain('after 20 minutes');
  });
});

describe('environmentForStack', () => {
  it('maps the HA stacks back to their environment', () => {
    expect(environmentForStack('e2-standby')).toBe('e2');
    expect(environmentForStack('e4-primary')).toBe('e4');
    expect(environmentForStack('prod')).toBe('prod');
  });
});

describe('upStack: a stalled create fails with the one-line error', () => {
  beforeEach(() => {
    selectStackMock.mockReset();
    progressLogMock.mockReset();
  });

  it('throws the classified error and still logs the full Pulumi failure', async () => {
    const stack = {
      name: 'e2-standby',
      cancel: vi.fn().mockResolvedValue(undefined),
      exportStack: vi.fn().mockResolvedValue(STATE_AFTER_TIMEOUT),
      refresh: vi.fn().mockResolvedValue(undefined),
      up: vi.fn().mockRejectedValue(commandError(HCLOUD_TIMEOUT_STREAM)),
      outputs: vi.fn().mockResolvedValue({}),
    };
    selectStackMock.mockResolvedValue(stack);
    const { upStack, summarizePulumiError } = await import('../../../src/lib/iac/index.js');

    const caught = await upStack('e2-standby', () => ({}), { projectName: 'acme' }).catch(
      (e: unknown) => e,
    );

    expect((caught as Error).name).toBe('CreateTimeoutError');
    // What every caller prints (k8s-ha, converge-cluster, the deploy outro).
    const line = summarizePulumiError(caught);
    expect(line).toMatch(/^Hetzner never finished creating server "acme-e2-standby"/);
    expect(line).toContain('in hel1');
    // The full detail went to the deploy log first.
    const logged = progressLogMock.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('[pulumi:error]');
    expect(logged).toContain('* context deadline exceeded');
    expect(stack.up).toHaveBeenCalledTimes(1);
  });

  it('leaves every other up failure as it was', async () => {
    const other = commandError(
      HCLOUD_TIMEOUT_STREAM.replaceAll('context deadline exceeded', 'server limit reached'),
    );
    const stack = {
      name: 'e2-standby',
      cancel: vi.fn().mockResolvedValue(undefined),
      exportStack: vi.fn().mockResolvedValue(STATE_AFTER_TIMEOUT),
      refresh: vi.fn().mockResolvedValue(undefined),
      up: vi.fn().mockRejectedValue(other),
      outputs: vi.fn().mockResolvedValue({}),
    };
    selectStackMock.mockResolvedValue(stack);
    const { upStack } = await import('../../../src/lib/iac/index.js');
    await expect(upStack('e2-standby', () => ({}), { projectName: 'acme' })).rejects.toBe(other);
  });
});

describe('destroy after a stalled create', () => {
  it("sweeps the half-created server the error names (compose-ha's standby)", async () => {
    // The stalled server exists in the provider with the name and labels the
    // program gave it at create time; it is just never `running`.
    const err = createTimeoutError(commandError(HCLOUD_TIMEOUT_STREAM), {
      resources: STATE_AFTER_TIMEOUT.deployment.resources,
    }) as Error & { createTimeout: { resourceName: string; environment: string } };
    const { resourceName, environment } = err.createTimeout;
    const stalled = {
      id: 118207654,
      name: resourceName,
      status: 'initializing',
      labels: STATE_AFTER_TIMEOUT.deployment.resources[1].inputs?.labels,
    };
    const deleteServer = vi.fn().mockResolvedValue(true);
    const provider = {
      listServersDetailed: vi.fn().mockResolvedValue({ items: [stalled], complete: true }),
      deleteServer,
      serverLabels: (s: { labels?: Record<string, string> }) => s.labels ?? {},
      serverRegion: () => 'hel1',
    };
    const leaks = createLeakLedger();

    const result = await sweepEnvironmentServers({
      provider,
      leaks,
      projectName: 'acme',
      environment,
      deployMode: 'compose-ha',
    });

    expect(deleteServer).toHaveBeenCalledWith(118207654, { waitUntilGone: true });
    expect(result.deleted).toEqual(['acme-e2-standby']);
    expect(leaks.isClean()).toBe(true);
  });

  it('a delete the provider refuses is reported as a leak, never silence', async () => {
    const provider = {
      listServersDetailed: vi.fn().mockResolvedValue({
        items: [{ id: 1, name: 'acme-e2-standby', labels: {} }],
        complete: true,
      }),
      deleteServer: vi
        .fn()
        .mockRejectedValue(new Error('Failed to delete server: server is locked')),
      serverLabels: () => ({}),
      serverRegion: () => 'hel1',
    };
    const leaks = createLeakLedger();
    await sweepEnvironmentServers({
      provider,
      leaks,
      projectName: 'acme',
      environment: environmentForStack('e2-standby'),
      deployMode: 'compose-ha',
    });
    expect(leaks.isClean()).toBe(false);
  });
});
