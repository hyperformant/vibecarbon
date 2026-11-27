/**
 * pruneVultrGoneResources, and the three refreshes it runs before: the
 * pre-destroy refresh (destroyStack), the pre-up refresh (upStack's
 * prepareStackForUp) and the one that clears unfinished creates
 * (resolvePendingCreates, in the seal after a deploy's up).
 *
 * Evidence (e2e run 45922250720, vultr k8s, stack civ3): the first destroy
 * failed on the reserved IP, the backstop released it by address, and the
 * destroy that ran once more failed its refresh (`error: update failed`: the
 * provider's Read looks for "Invalid reserved-ip ID", Vultr answers "reserved
 * ip not found") and then its delete, so the environment was kept and
 * reported UNVERIFIED. Here the same stack is pruned before the refresh, the
 * refresh and the destroy succeed, and the destroy counts the pruned IP as
 * the stack's, so it is not read as an empty stack.
 *
 * The real iac layer runs on the fake Pulumi workspace; fetch is stubbed, so
 * nothing reaches Vultr.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePulumi } from '../../_shared/fake-pulumi-workspace.js';
import { createTempDir } from '../../_shared/temp-dir.js';

vi.mock('@pulumi/pulumi/automation/index.js', async () =>
  (await import('../../_shared/fake-pulumi-workspace.js')).fakeAutomationModule(),
);
vi.mock('../../../src/lib/state-passphrase.js', async (orig) =>
  (await import('../../_shared/state-passphrase-stub.js')).fixedStatePassphrase(await orig()),
);
const logged: string[] = [];
vi.mock('../../../src/lib/cli/progress.js', () => ({
  progressLog: (m: string) => logged.push(m),
}));
const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args) };
});

const { __resetStateProbesForTests, destroyStack, pruneVultrGoneResources, upStack } = await import(
  '../../../src/lib/iac/index.js'
);
const { StackHeldError } = await import('../../../src/lib/iac/stack-lock.js');
// @ts-expect-error: JS module without types
const { StateTracker } = await import('../../../src/lib/deploy/state.js');

const STACK = 'civ3';
const P = `urn:pulumi:${STACK}::proj`;
const IP_ID = '9b32862d-ad72-4dd2-bd7d-527dfc4fa4ea';
const RESERVED_IP = {
  urn: `${P}::vultr:index/reservedIp:ReservedIp::ingress`,
  custom: true,
  type: 'vultr:index/reservedIp:ReservedIp',
  id: IP_ID,
  inputs: { region: 'ewr' },
  outputs: { subnet: '209.222.21.107' },
};
const VPC = {
  urn: `${P}::vultr:index/vpc:Vpc::network`,
  custom: true,
  type: 'vultr:index/vpc:Vpc',
  id: 'vpc-uuid',
  inputs: {},
  outputs: {},
};
const MASTER = {
  urn: `${P}::vultr:index/instance:Instance::master`,
  custom: true,
  type: 'vultr:index/instance:Instance',
  id: 'inst-master',
  inputs: {},
  outputs: {},
  dependencies: [VPC.urn, RESERVED_IP.urn],
  propertyDependencies: { reservedIpId: [RESERVED_IP.urn], vpcIds: [VPC.urn] },
};
const STACK_RES = { urn: `${P}::pulumi:pulumi:Stack::proj-${STACK}`, type: 'pulumi:pulumi:Stack' };
const stateOf = (...resources: object[]) => ({
  version: 3,
  deployment: { resources: [STACK_RES, ...structuredClone(resources)] },
});
const typesIn = (state: { deployment: { resources: Array<{ type: string }> } }) =>
  state.deployment.resources.map((r) => r.type);

/** Every GET and every stack verb, in order. */
const events: string[] = [];

/** Vultr answers each id in `gone` with its measured 404, `answers` as given, any other id 200. */
function vultrApi(
  gone: string[],
  answers: Record<string, { status: number; body: string } | 'throw'> = {},
) {
  fetchWithRetryMock.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname.replace(/^\/v2/, '');
    events.push(`GET ${path}`);
    const reply = (status: number, body: string) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    });
    if (path === '/instances') {
      return reply(200, JSON.stringify({ instances: [], meta: { links: { next: '' } } }));
    }
    const answer = answers[path];
    if (answer === 'throw') throw new Error('fetch failed');
    if (answer) return reply(answer.status, answer.body);
    const id = path.split('/').pop() as string;
    if (!gone.includes(id)) return reply(200, '{}');
    if (path.startsWith('/reserved-ips/')) {
      return reply(404, '{"error":"reserved ip not found","status":404}');
    }
    if (path.startsWith('/instances/'))
      return reply(404, '{"error":"instance not found","status":404}');
    if (path.startsWith('/vpcs/')) {
      return reply(404, '{"is_external_error":false,"error":"VPC not found.","status":404}');
    }
    return reply(404, '{"error":"Not Found"}');
  });
}

/** The stack's state lives here: each export reads it, each import writes it. */
let current: ReturnType<typeof stateOf>;
function statefulStack(initial: ReturnType<typeof stateOf>) {
  current = structuredClone(initial);
  fakePulumi.behaviour.exportStack = () => structuredClone(current);
  fakePulumi.behaviour.importStack = (_name, deployment) => {
    events.push('import');
    current = structuredClone(deployment) as ReturnType<typeof stateOf>;
  };
  fakePulumi.behaviour.refresh = () => {
    events.push('refresh');
  };
}

const VULTR = { projectName: 'proj', provider: 'vultr', providerToken: 'tok' };

beforeEach(() => {
  fakePulumi.reset();
  __resetStateProbesForTests();
  fetchWithRetryMock.mockReset();
  events.length = 0;
  logged.length = 0;
  process.env.PULUMI_BACKEND_URL = `file://${createTempDir('vultr-prune-backend-')}`;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('destroyStack on a Vultr stack (the civ3 re-run)', () => {
  it('takes the released reserved IP out before the refresh, then destroys, and counts it', async () => {
    statefulStack(stateOf(RESERVED_IP));
    vultrApi([IP_ID]);
    fakePulumi.behaviour.destroy = () => {
      events.push('destroy');
      return { summary: { result: 'succeeded', resourceChanges: {} } };
    };

    const result = await destroyStack(STACK, () => {}, VULTR);

    expect(events).toEqual([`GET /reserved-ips/${IP_ID}`, 'import', 'refresh', 'destroy']);
    expect(typesIn(fakePulumi.imports[0].deployment as never)).toEqual(['pulumi:pulumi:Stack']);
    expect(logged).toContain(
      `[pulumi] took the reserved IP ingress (id ${IP_ID}) out of ${STACK}'s state: Vultr says it's gone ("reserved ip not found"), and the refresh would fail on it instead of dropping it`,
    );
    // Nothing was left to delete, yet the stack held something: not the
    // empty stack recordPulumiDestroyOutcome reports UNVERIFIED.
    expect(result).toEqual({ destroyed: true, resourceCount: 1 });
  });

  it('takes out only what Vultr says is gone, with every reference to it', async () => {
    statefulStack(stateOf(VPC, RESERVED_IP, MASTER));
    vultrApi([IP_ID]);

    const result = await destroyStack(STACK, () => {}, VULTR);

    expect(fakePulumi.imports).toHaveLength(1);
    const left = (fakePulumi.imports[0].deployment as ReturnType<typeof stateOf>).deployment
      .resources as Array<Record<string, unknown>>;
    expect(left.map((r) => r.urn)).toEqual([STACK_RES.urn, VPC.urn, MASTER.urn]);
    const master = left[2];
    expect(master.dependencies).toEqual([VPC.urn]);
    expect(master.propertyDependencies).toEqual({ reservedIpId: [], vpcIds: [VPC.urn] });
    expect(logged.filter((l) => l.includes('out of civ3'))).toHaveLength(1);
    // Two left and one taken out: the count is the stack's own.
    expect(result).toEqual({ destroyed: true, resourceCount: 3 });
  });

  it.each([
    ['a 500', { status: 500, body: '{"error":"Internal server error"}' }],
    ['a 403', { status: 403, body: '{"error":"Unauthorized IP address"}' }],
    ['a 404 that is not its not-found', { status: 404, body: '{"error":"Not Found"}' }],
    ['a network error', 'throw' as const],
  ])('%s leaves the state untouched, and the refresh runs as before', async (_, answer) => {
    statefulStack(stateOf(RESERVED_IP));
    vultrApi([], { [`/reserved-ips/${IP_ID}`]: answer });

    await destroyStack(STACK, () => {}, VULTR);

    expect(fakePulumi.imports).toEqual([]);
    expect(events).toContain('refresh');
    expect(logged.filter((l) => l.includes('out of civ3'))).toEqual([]);
  });

  it('asks Vultr nothing on another provider, or without a token', async () => {
    statefulStack(stateOf(RESERVED_IP));
    vultrApi([IP_ID]);
    await destroyStack(STACK, () => {}, { ...VULTR, provider: 'digitalocean' });
    __resetStateProbesForTests();
    await destroyStack(STACK, () => {}, { projectName: 'proj', provider: 'vultr' });
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(fakePulumi.imports).toEqual([]);
  });
});

describe('pruneVultrGoneResources', () => {
  const open = async () => {
    const { getOrCreateStack } = await import('../../../src/lib/iac/index.js');
    return getOrCreateStack(STACK, () => {}, VULTR);
  };

  it('a stack held by a live run stops the caller, unchanged', async () => {
    statefulStack(stateOf(RESERVED_IP));
    vultrApi([IP_ID]);
    const held = new StackHeldError(STACK, [
      { user: 'ci', host: 'runner', pid: 1, at: new Date().toISOString() },
    ]);
    fakePulumi.behaviour.importStack = () => {
      throw held;
    };
    const stack = await open();
    await expect(pruneVultrGoneResources(stack, VULTR)).rejects.toBe(held);
  });

  it('any other failed import leaves the state as it was, says so, and lets the refresh run', async () => {
    statefulStack(stateOf(RESERVED_IP));
    vultrApi([IP_ID]);
    fakePulumi.behaviour.importStack = () => {
      throw new Error(
        'code: -2\n stdout: \n stderr: Command failed with exit code 255: pulumi stack import\n' +
          'error: state file contains errors\n',
      );
    };
    const stack = await open();
    const given = stateOf(RESERVED_IP);
    const out = await pruneVultrGoneResources(stack, VULTR, given);
    expect(out).toEqual({ removed: [], deployment: given });
    expect(logged.join('\n')).toContain(
      `[pulumi] vultr gone-resource check skipped for ${STACK}: error: state file contains errors`,
    );
    expect(logged.join('\n')).not.toContain('out of civ3');
  });

  it('nothing gone: no import', async () => {
    statefulStack(stateOf(VPC, RESERVED_IP));
    vultrApi([]);
    const stack = await open();
    const out = await pruneVultrGoneResources(stack, VULTR);
    expect(out.removed).toEqual([]);
    expect(fakePulumi.imports).toEqual([]);
  });
});

describe('upStack on a Vultr stack: the pre-up refresh', () => {
  it('runs after what Vultr says is gone is taken out, on the state as it then stands', async () => {
    statefulStack(stateOf(VPC, MASTER));
    vultrApi(['inst-master']);

    await upStack(STACK, async () => ({}), VULTR);

    const before = events.slice(0, events.indexOf('refresh') + 1);
    expect(before.sort()).toEqual(
      ['GET /instances/inst-master', 'GET /vpcs/vpc-uuid', 'import', 'refresh'].sort(),
    );
    expect(events.indexOf('import')).toBeLessThan(events.indexOf('refresh'));
    expect(typesIn(fakePulumi.imports[0].deployment as never)).toEqual([
      'pulumi:pulumi:Stack',
      'vultr:index/vpc:Vpc',
    ]);
  });

  it('a stack left with nothing but its own record skips the refresh, as a new one does', async () => {
    statefulStack(stateOf(MASTER));
    vultrApi(['inst-master']);
    await upStack(STACK, async () => ({}), VULTR);
    expect(events).toEqual(['GET /instances/inst-master', 'import']);
  });
});

describe('the seal after a deploy: the refresh that clears unfinished creates', () => {
  it('runs after what Vultr says is gone is taken out', async () => {
    const OWN = ['project:proj', `environment:${STACK}`, 'managed-by:vibecarbon', 'role:worker'];
    // A server whose user data is still plain: only then does the seal clear
    // the unfinished creates (sealCurrentState).
    const plainMaster = {
      ...MASTER,
      dependencies: [VPC.urn],
      propertyDependencies: {},
      inputs: { userData: '#cloud-config\n' },
      outputs: { userData: '#cloud-config\n' },
    };
    const pending = stateOf(VPC, plainMaster);
    (pending.deployment as Record<string, unknown>).pending_operations = [
      {
        type: 'creating',
        resource: {
          urn: `${P}::vultr:index/instance:Instance::worker-1`,
          custom: true,
          type: 'vultr:index/instance:Instance',
          inputs: { label: `proj-${STACK}-worker-1`, tags: OWN },
        },
      },
    ];
    statefulStack(pending);
    let cleared = false;
    fakePulumi.behaviour.refresh = (_name, options) => {
      if ((options as { clearPendingCreates?: boolean })?.clearPendingCreates) {
        events.push('clear');
        cleared = true;
        (current.deployment as Record<string, unknown>).pending_operations = [];
      } else {
        events.push('refresh');
      }
    };
    // Gone from Vultr only once the up has run: the pre-up check finds it live.
    let upDone = false;
    fakePulumi.behaviour.up = () => {
      events.push('up');
      upDone = true;
      return { outputs: {}, summary: { result: 'succeeded' } };
    };
    vultrApi([]);
    const base = fetchWithRetryMock.getMockImplementation() as (u: string) => Promise<unknown>;
    fetchWithRetryMock.mockImplementation(async (url: string) => {
      if (!upDone || !url.endsWith('/vpcs/vpc-uuid')) return base(url);
      events.push('GET /vpcs/vpc-uuid');
      return {
        ok: false,
        status: 404,
        text: async () => '{"is_external_error":false,"error":"VPC not found.","status":404}',
      };
    });
    const ledgerDir = createTempDir('vultr-prune-ledger-');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(ledgerDir);
    const ledger = new StateTracker('proj', STACK);
    cwd.mockRestore();

    await upStack(STACK, async () => ({}), { ...VULTR, ledger });

    expect(cleared).toBe(true);
    const afterUp = events.slice(events.indexOf('up') + 1);
    const clearAt = afterUp.indexOf('clear');
    expect(afterUp.slice(0, clearAt)).toContain('GET /vpcs/vpc-uuid');
    expect(afterUp.slice(0, clearAt)).toContain('import');
    expect(logged).toContain(
      `[pulumi] took the VPC network (id vpc-uuid) out of ${STACK}'s state: Vultr says it's gone ("VPC not found."), and the refresh would fail on it instead of dropping it`,
    );
  });
});
