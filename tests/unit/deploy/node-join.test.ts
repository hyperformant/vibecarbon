/**
 * A cluster node that never joins stops the command at its join deadline,
 * naming the server, with the provider's view of it (node-join.js).
 *
 * perf run 45922250720 (hetzner/k8s-ha restore-deploy, 2026-11-27): the
 * primary's database server was created and never answered; db-0 sat Pending
 * for awaitDbRollout's 900 s and the failure named only the pod.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awaitNodesJoined,
  clusterNodeExpectations,
  describeServersForLog,
  NODE_JOIN_BUDGET_MS,
  NODE_JOIN_POLL_MS,
  NodesNeverJoinedError,
  nodesNeverJoinedNextStep,
  parseNodeList,
  providerViewLine,
  unjoinedNodes,
} from '../../../src/lib/deploy/k8s/node-join.js';
import {
  DB_LABELS,
  type FakeNode,
  getNodesOutput,
  MASTER_LABELS,
} from '../../_shared/fake-nodes.js';

const MASTER_IP = '167.233.170.10';
const DB_IP = '167.233.172.157';
const WORKER_IP = '167.233.171.20';

const expected = clusterNodeExpectations({
  masterIp: MASTER_IP,
  masterId: 111,
  dbIp: DB_IP,
  workerIps: [WORKER_IP],
});

const master: FakeNode = { name: 'p-master', labels: MASTER_LABELS, ip: MASTER_IP };
const db: FakeNode = { name: 'p-db', labels: DB_LABELS, ip: DB_IP };
const worker: FakeNode = { name: 'p-worker-1', ip: WORKER_IP };

const json = (nodes: FakeNode[]) => getNodesOutput(nodes, ['get', 'nodes', '-o', 'json']);
const list = (nodes: FakeNode[]) => parseNodeList(json(nodes));

/** A clock that only moves when the wait sleeps. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

const DASHES = /[–—]/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('clusterNodeExpectations', () => {
  it('lists the k3s server (with its id), the database node and every worker', () => {
    expect(expected).toEqual([
      { role: 'master', ip: MASTER_IP, id: 111 },
      { role: 'db', ip: DB_IP },
      { role: 'worker', ip: WORKER_IP },
    ]);
    expect(clusterNodeExpectations({ masterIp: MASTER_IP, dbIp: DB_IP })).toEqual([
      { role: 'master', ip: MASTER_IP },
      { role: 'db', ip: DB_IP },
    ]);
  });
});

describe('parseNodeList', () => {
  it('reads names, labels, addresses and the Ready condition', () => {
    expect(list([master, { ...worker, status: 'NotReady' }])).toEqual([
      { name: 'p-master', labels: MASTER_LABELS, addresses: ['p-master', MASTER_IP], ready: true },
      { name: 'p-worker-1', labels: {}, addresses: ['p-worker-1', WORKER_IP], ready: false },
    ]);
  });

  it('refuses an answer that is not a node list', () => {
    expect(() => parseNodeList('')).toThrow();
    expect(() => parseNodeList('{"kind":"Status"}')).toThrow(/no items/);
  });
});

describe('unjoinedNodes', () => {
  it('the incident: the master and a worker joined, the database node never registered', () => {
    expect(unjoinedNodes(list([master, worker]), expected)).toEqual([
      { role: 'db', ip: DB_IP, state: 'unregistered' },
    ]);
  });

  it('nothing is missing when every node is registered and Ready', () => {
    expect(unjoinedNodes(list([master, db, worker]), expected)).toEqual([]);
  });

  it('a registered node that is not Ready is named by its node name', () => {
    expect(unjoinedNodes(list([master, { ...db, status: 'NotReady' }, worker]), expected)).toEqual([
      { role: 'db', ip: DB_IP, name: 'p-db', state: 'notReady' },
    ]);
  });

  it('matches by role when no address does (the master behind a reserved IP)', () => {
    const behindReservedIp = { ...master, ip: '10.0.0.5' };
    expect(unjoinedNodes(list([behindReservedIp, db, worker]), expected)).toEqual([]);
  });

  it('a node counts once: two workers expected, one registered', () => {
    const two = clusterNodeExpectations({
      masterIp: MASTER_IP,
      dbIp: DB_IP,
      workerIps: [WORKER_IP, '167.233.171.21'],
    });
    expect(unjoinedNodes(list([master, db, worker]), two)).toEqual([
      { role: 'worker', ip: '167.233.171.21', state: 'unregistered' },
    ]);
  });

  it('a worker never stands in for the database node', () => {
    const unlabelled = { name: 'p-db', ip: '10.9.9.9' };
    expect(unjoinedNodes(list([master, worker, unlabelled]), expected)).toEqual([
      { role: 'db', ip: DB_IP, state: 'unregistered' },
    ]);
  });
});

describe('awaitNodesJoined', () => {
  it('one read and no wait when every node has joined', async () => {
    const clock = fakeClock();
    const readNodes = vi.fn(async () => json([master, db, worker]));
    await awaitNodesJoined({
      expected,
      readNodes,
      deadline: clock.now() + NODE_JOIN_BUDGET_MS,
      ...clock,
    });
    expect(readNodes).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('waits for a node that joins before the deadline', async () => {
    const clock = fakeClock();
    let reads = 0;
    const readNodes = vi.fn(async () =>
      json(++reads < 4 ? [master, worker] : [master, db, worker]),
    );
    await awaitNodesJoined({
      expected,
      readNodes,
      deadline: clock.now() + NODE_JOIN_BUDGET_MS,
      ...clock,
    });
    expect(readNodes).toHaveBeenCalledTimes(4);
    expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([
      NODE_JOIN_POLL_MS,
      NODE_JOIN_POLL_MS,
      NODE_JOIN_POLL_MS,
    ]);
  });

  it('never sleeps past its deadline: the last wait is what is left', async () => {
    const clock = fakeClock();
    const start = clock.now();
    const readNodes = vi.fn(async () => json([master, worker]));
    await awaitNodesJoined({
      expected,
      readNodes,
      deadline: start + 25_000,
      ...clock,
    }).catch(() => {});
    expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([10_000, 10_000, 5_000]);
    expect(clock.now()).toBe(start + 25_000);
    // A read at the deadline itself: a node that joined in the last poll counts.
    expect(readNodes).toHaveBeenCalledTimes(4);
  });

  it("the incident: stops at its deadline naming the database node, with the provider's view", async () => {
    const clock = fakeClock();
    const start = clock.now();
    const describeServers = vi.fn(async (missing: Parameters<typeof unjoinedNodes>[1]) => {
      return new Map(
        missing.map((n) => [
          n,
          {
            name: 'proj-ci4-db',
            line: 'Hetzner Cloud says it is running, created 2026-11-27 02:32:10 UTC in nbg1-dc3.',
          },
        ]),
      );
    });
    const err = await awaitNodesJoined({
      expected,
      readNodes: async () => json([master, worker]),
      deadline: start + NODE_JOIN_BUDGET_MS,
      describeServers,
      nextStep: nodesNeverJoinedNextStep({ providerName: 'Hetzner Cloud', env: 'ci4' }),
      ...clock,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(NodesNeverJoinedError);
    expect(err.missing).toEqual([{ role: 'db', ip: DB_IP, state: 'unregistered' }]);
    // At the deadline, not before and not a poll past it.
    expect(clock.now()).toBe(start + NODE_JOIN_BUDGET_MS);
    expect(describeServers).toHaveBeenCalledTimes(1);
    const lines = err.message.split('\n');
    expect(lines[0]).toBe(
      `the database node proj-ci4-db (${DB_IP}) never joined the cluster: 600s after the k3s ` +
        'server came up it still had not registered, and the database runs only on that node. ' +
        'Hetzner Cloud says it is running, created 2026-11-27 02:32:10 UTC in nbg1-dc3.',
    );
    expect(err.message).toMatch(/nothing was retried or replaced/);
    // The command ends its line, and the message ends with it.
    expect(lines.at(-1)).toBe('  vibecarbon deploy ci4 -full');
    expect(err.message).not.toMatch(DASHES);
  });

  it('announces once what it is waiting for', async () => {
    const clock = fakeClock();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await awaitNodesJoined({
      expected,
      readNodes: async () => json([master, worker]),
      deadline: clock.now() + 3 * NODE_JOIN_POLL_MS,
      ...clock,
    }).catch(() => {});
    const said = error.mock.calls
      .map(([s]) => String(s))
      .filter((s) => s.includes('[node-join] waiting for'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(`the database node at ${DB_IP}`);
  });

  it('a provider view that fails is a log line, and the join failure is reported as it was', async () => {
    const clock = fakeClock();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await awaitNodesJoined({
      expected,
      readNodes: async () => json([master, worker]),
      deadline: clock.now(),
      describeServers: async () => {
        throw new Error('HTTP 503');
      },
      ...clock,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NodesNeverJoinedError);
    expect(err.message).toMatch(/^the database node at 167\.233\.172\.157 never joined/);
    expect(error.mock.calls.map(([s]) => String(s))).toContain(
      "[node-join] could not record the provider's view: HTTP 503",
    );
  });

  it('a read that fails is no evidence: the last good read decides', async () => {
    const clock = fakeClock();
    let reads = 0;
    const readNodes = vi.fn(async () => {
      if (++reads > 1) throw new Error('Unable to connect to the server: i/o timeout');
      return json([master, worker]);
    });
    const err = await awaitNodesJoined({
      expected,
      readNodes,
      deadline: clock.now() + 2 * NODE_JOIN_POLL_MS,
      ...clock,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NodesNeverJoinedError);
    expect(err.missing).toEqual([{ role: 'db', ip: DB_IP, state: 'unregistered' }]);
  });

  it('says so when no read ever succeeded, instead of guessing', async () => {
    const clock = fakeClock();
    const err = await awaitNodesJoined({
      expected,
      readNodes: async () => {
        throw new Error('Unable to connect to the server: i/o timeout\nmore');
      },
      deadline: clock.now() + NODE_JOIN_POLL_MS,
      ...clock,
    }).catch((e) => e);
    expect(err).not.toBeInstanceOf(NodesNeverJoinedError);
    expect(err.message).toBe(
      "could not read the cluster's nodes for 600s to see whether they joined " +
        '(last error: Unable to connect to the server: i/o timeout).',
    );
  });
});

describe('nodesNeverJoinedNextStep', () => {
  it('a node that registered must be deleted before a new server can take its name', () => {
    const step = nodesNeverJoinedNextStep({ providerName: 'Linode', env: 'prod' })([
      { role: 'db', ip: DB_IP, name: 'p-db', state: 'notReady' },
    ]);
    const lines = step.split('\n');
    expect(lines).toContain('  kubectl delete node p-db');
    expect(lines.at(-1)).toBe('  vibecarbon deploy prod -full');
    expect(step).toMatch(/Linode console/);
    expect(step).not.toMatch(DASHES);
    // Lowercase CLI voice: every line starts lowercase or with a command.
    for (const line of lines) expect(line).toMatch(/^( {2}|[a-z])/);
  });

  it('a node that never registered needs no node delete', () => {
    const step = nodesNeverJoinedNextStep({ providerName: 'Hetzner Cloud', env: 'prod' })([
      { role: 'db', ip: DB_IP, state: 'unregistered' },
    ]);
    expect(step).not.toMatch(/kubectl delete node/);
  });
});

describe('providerViewLine', () => {
  it('status, when, where and the last action with its error', () => {
    expect(
      providerViewLine('Hetzner Cloud', {
        id: 1,
        name: 'p-db',
        status: 'off',
        created: '2026-11-27T02:32:10+00:00',
        location: 'nbg1-dc3',
        events: [
          {
            action: 'start_server',
            status: 'error',
            started: '2026-11-27T02:32:40+00:00',
            finished: null,
            error: 'server_error: boot failed',
          },
        ],
      }),
    ).toBe(
      'Hetzner Cloud says it is off, created 2026-11-27 02:32:10 UTC in nbg1-dc3; its last ' +
        'action, start_server, is error (server_error: boot failed).',
    );
  });

  it('a status detail rides beside the status', () => {
    expect(
      providerViewLine('Vultr', {
        id: 'abc',
        name: null,
        status: 'installingbooting',
        detail: 'power running, subscription active',
        created: null,
        location: 'ewr',
        events: [],
      }),
    ).toBe('Vultr says it is installingbooting, power running, subscription active in ewr.');
  });
});

describe('describeServersForLog', () => {
  const view = (id: number | string, name: string) => ({
    id,
    name,
    status: 'running',
    created: '2026-11-27T02:32:10+00:00',
    location: 'nbg1-dc3',
    events: [
      {
        action: 'create_server',
        status: 'success',
        started: '2026-11-27T02:32:10+00:00',
        finished: '2026-11-27T02:32:40+00:00',
        error: null,
      },
    ],
  });
  const Provider = {
    NAME: 'Hetzner Cloud',
    getPublicIP: (s: { public_net: { ipv4: { ip: string } } }) => s.public_net.ipv4.ip,
  };
  const dbNode = { role: 'db' as const, ip: DB_IP, state: 'unregistered' as const };
  const masterNode = {
    role: 'master' as const,
    ip: MASTER_IP,
    id: 111,
    state: 'unregistered' as const,
  };

  it('finds a server by its address in one listing, or by its id; logs the view and returns its line', async () => {
    const lines: string[] = [];
    const provider = {
      listServersDetailed: vi.fn(async () => ({
        items: [
          { id: 222, public_net: { ipv4: { ip: DB_IP } } },
          { id: 333, public_net: { ipv4: { ip: WORKER_IP } } },
        ],
      })),
      describeServerForDiagnosis: vi.fn(async (id: number) =>
        view(id, id === 222 ? 'proj-ci4-db' : 'proj-ci4-master'),
      ),
    };
    const views = await describeServersForLog({
      provider: provider as never,
      Provider: Provider as never,
      nodes: [dbNode, masterNode],
      log: (l) => lines.push(l),
    });
    expect(provider.listServersDetailed).toHaveBeenCalledTimes(1);
    expect(provider.describeServerForDiagnosis.mock.calls.map(([id]) => id).sort()).toEqual([
      111, 222,
    ]);
    expect(views.get(dbNode)).toEqual({
      name: 'proj-ci4-db',
      line: 'Hetzner Cloud says it is running, created 2026-11-27 02:32:10 UTC in nbg1-dc3; its last action, create_server, is success.',
    });
    expect(lines).toContain(
      `[node-join] Hetzner Cloud's view of proj-ci4-db (${DB_IP}, database node): status running, ` +
        'created 2026-11-27T02:32:10+00:00, at nbg1-dc3, id 222',
    );
    expect(lines).toContain(
      '[node-join]   create_server: success, started 2026-11-27T02:32:10+00:00, finished 2026-11-27T02:32:40+00:00',
    );
  });

  it('never throws: a listing or a read that fails is a log line', async () => {
    const lines: string[] = [];
    const provider = {
      listServersDetailed: vi.fn(async () => {
        throw new Error('HTTP 401: unauthorized');
      }),
      describeServerForDiagnosis: vi.fn(async () => {
        throw new Error('Hetzner Cloud answered HTTP 404 for /servers/111');
      }),
    };
    const views = await describeServersForLog({
      provider: provider as never,
      Provider: Provider as never,
      nodes: [dbNode, masterNode],
      log: (l) => lines.push(l),
    });
    expect(views.size).toBe(0);
    expect(lines).toEqual(
      expect.arrayContaining([
        `[node-join] could not read Hetzner Cloud's view of ${DB_IP}: HTTP 401: unauthorized`,
        `[node-join] could not read Hetzner Cloud's view of ${MASTER_IP}: Hetzner Cloud answered HTTP 404 for /servers/111`,
      ]),
    );
  });

  it('a server the listing does not have is said plainly', async () => {
    const lines: string[] = [];
    await describeServersForLog({
      provider: {
        listServersDetailed: async () => ({ items: [] }),
        describeServerForDiagnosis: vi.fn(),
      } as never,
      Provider: Provider as never,
      nodes: [dbNode],
      log: (l) => lines.push(l),
    });
    expect(lines).toEqual([
      `[node-join] could not read Hetzner Cloud's view of ${DB_IP}: no Hetzner Cloud server has the address ${DB_IP}`,
    ]);
  });

  it('stops at its budget with what it had, and says so', async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const done = describeServersForLog({
        provider: {
          listServersDetailed: async () => ({ items: [] }),
          describeServerForDiagnosis: async (id: number) =>
            id === 111 ? view(111, 'proj-ci4-master') : new Promise(() => {}),
        } as never,
        Provider: Provider as never,
        nodes: [masterNode, { ...dbNode, id: 222 }],
        budgetMs: 30_000,
        log: (l) => lines.push(l),
      });
      await vi.advanceTimersByTimeAsync(30_000);
      const views = await done;
      expect(views.size).toBe(1);
      expect(lines.at(-1)).toBe(
        "[node-join] stopped reading Hetzner Cloud's view after 30s; what it had answered is above",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
