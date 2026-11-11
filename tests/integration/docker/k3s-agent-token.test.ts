/**
 * The k3s token a master boots with joins agents, and nothing else.
 *
 * Every k8s master installs k3s with `--agent-token "${k3s_token}"` and no
 * `--token`, and every db and worker node joins with K3S_TOKEN set to the
 * same value. The token sits in each node's user data and in the stack's
 * state, so what it can do matters: an agent token joins a node as an agent
 * only, while a server token joins a machine as another server, with the
 * cluster's datastore and its CA keys. With no `--token`, k3s makes the
 * server token itself, at random, on the master, and nothing here ever needs
 * it: no second server joins. Whether k3s really draws that line is k3s's
 * business, so this asks it: the release the CLI installs (or VC_K3S_VERSION,
 * the release the version channel is about to publish).
 *
 * A master runs the flags master-init.sh installs with (k3sServerFlags), an
 * agent the flags worker-init.sh joins with, both on one Docker network at
 * the master's real private address. The agent must go Ready; a server that
 * tries to join with the same token must be turned away; and the master's
 * server token must be its own.
 *
 * Needs Docker and the wireguard module (the flags ask for wireguard-native).
 * Every container and network here is named vctest-* and removed in afterAll.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { k3sVersion } from '../../../src/lib/images.js';
import { k3sServerFlags } from '../../_shared/k3s-server-flags.js';

const SKIPPED =
  process.env.DOCKER_INTEGRATION === 'true'
    ? null
    : 'skipped: needs Docker and the wireguard module; run it with DOCKER_INTEGRATION=true (pnpm test:docker)';
if (SKIPPED) console.info(`k3s-agent-token: ${SKIPPED}`);

const ROOT = process.cwd();
const VERSION = process.env.VC_K3S_VERSION || k3sVersion();
const IMAGE = `rancher/k3s:${VERSION.replace('+', '-')}`;
const NET = `vctest-k3s-join-net-${process.pid}`;
const MASTER = `vctest-k3s-join-master-${process.pid}`;
const AGENT = `vctest-k3s-join-agent-${process.pid}`;
const SERVER = `vctest-k3s-join-server-${process.pid}`;
// master-init.sh's advertise address, which worker-init.sh joins.
const MASTER_IP = '10.0.1.1';
const AGENT_IP = '10.0.1.10';
const SERVER_IP = '10.0.1.20';
const K3S_TOKEN = 'vctest-k3s-join-token-4b7e';
const LONG = 180_000;

const run = (cmd: string, args: string[], timeout = LONG) =>
  spawnSync(cmd, args, { encoding: 'utf-8', timeout });
const must = (cmd: string, args: string[]) => {
  const r = run(cmd, args);
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} exited ${r.status}: ${r.stderr.trim()}`);
  }
  return r.stdout;
};
const kubectl = (...args: string[]) => run('docker', ['exec', MASTER, 'kubectl', ...args]);
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (what: string, probe: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    sleepSync(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const script = (file: string) => readFileSync(join(ROOT, 'carbon/cloud-init/k3s', file), 'utf-8');
/** `docker run` for a k3s node on the test network, at its own address. */
const node = (name: string, ip: string, env: string[], args: string[]) =>
  must('docker', [
    'run',
    '-d',
    '--privileged',
    '--name',
    name,
    '--hostname',
    name,
    '--network',
    NET,
    '--ip',
    ip,
    '--tmpfs',
    '/run',
    '--tmpfs',
    '/var/run',
    '-v',
    '/var/lib/rancher/k3s',
    ...env.flatMap((e) => ['-e', e]),
    IMAGE,
    ...args,
  ]);
const readyStatus = (name: string) =>
  kubectl(
    'get',
    'node',
    name,
    '-o',
    'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
  ).stdout.trim();

describe.skipIf(SKIPPED)(`the k3s token joins agents only (k3s ${VERSION})`, () => {
  beforeAll(() => {
    must('docker', [
      'network',
      'create',
      '--subnet',
      '10.0.1.0/24',
      '--gateway',
      '10.0.1.254',
      NET,
    ]);
    const masterFlags = k3sServerFlags(script('master-init.sh'), {
      k3s_token: K3S_TOKEN,
      floating_ip: MASTER_IP,
      PUBLIC_IP: MASTER_IP,
      PRIVATE_IFACE: 'eth0',
    });
    node(
      MASTER,
      MASTER_IP,
      [],
      [
        'server',
        ...masterFlags,
        // The join is the subject: no add-on pods, nothing pulled.
        '--disable',
        'coredns,local-storage,metrics-server',
        '--node-name',
        MASTER,
      ],
    );
    waitFor(
      'the master apiserver',
      () => kubectl('get', '--raw', '/readyz').stdout === 'ok',
      120_000,
    );
  }, LONG);

  afterAll(() => {
    run('docker', ['rm', '-f', '-v', MASTER, AGENT, SERVER]);
    run('docker', ['network', 'rm', NET]);
  });

  it('the master makes its own server token, which is not the k3s token', () => {
    const token = run('docker', [
      'exec',
      MASTER,
      'cat',
      '/var/lib/rancher/k3s/server/token',
    ]).stdout.trim();
    // Never printed: `K10<ca hash>::server:<random>`.
    expect(token.includes('::server:'), 'a k3s server token').toBe(true);
    expect(token.includes(K3S_TOKEN), 'the server token is k3s’s own').toBe(false);
  });

  it(
    'an agent joins with it, as worker-init.sh joins, and goes Ready',
    () => {
      const agentFlags = k3sServerFlags(
        script('worker-init.sh'),
        { PUBLIC_IP: AGENT_IP, PRIVATE_IFACE: 'eth0' },
        'agent',
      );
      node(
        AGENT,
        AGENT_IP,
        [`K3S_URL=https://${MASTER_IP}:6443`, `K3S_TOKEN=${K3S_TOKEN}`],
        ['agent', ...agentFlags, '--node-name', AGENT],
      );
      waitFor(`${AGENT} to go Ready`, () => readyStatus(AGENT) === 'True', 120_000);
    },
    LONG,
  );

  it(
    'a server that joins with it is turned away',
    () => {
      // master-init.sh's own flags, so the only thing wrong with this server
      // is the token: k3s compares a joining server's critical settings
      // with the cluster's before it asks for the datastore, and a mismatch
      // would turn it away first.
      const flags = k3sServerFlags(script('master-init.sh'), {
        k3s_token: K3S_TOKEN,
        floating_ip: SERVER_IP,
        PUBLIC_IP: SERVER_IP,
        PRIVATE_IFACE: 'eth0',
      })
        .filter((flag) => flag !== '--cluster-init')
        .map((flag) => (flag === '--agent-token' ? '--token' : flag))
        .map((flag) => (flag === MASTER_IP ? SERVER_IP : flag));
      expect(flags[flags.indexOf('--token') + 1]).toBe(K3S_TOKEN);
      node(
        SERVER,
        SERVER_IP,
        [],
        [
          'server',
          '--server',
          `https://${MASTER_IP}:6443`,
          ...flags,
          '--disable',
          'coredns,local-storage,metrics-server',
          '--node-name',
          SERVER,
        ],
      );
      let outcome = '';
      waitFor(
        `${SERVER} to join or be turned away`,
        () => {
          const state = run('docker', [
            'inspect',
            '-f',
            '{{.State.Status}} {{.State.ExitCode}}',
            SERVER,
          ]).stdout.trim();
          if (state.startsWith('exited')) outcome = state;
          else if (kubectl('get', 'node', SERVER, '-o', 'name').status === 0) outcome = 'joined';
          return outcome !== '';
        },
        120_000,
      );
      expect(outcome).toMatch(/^exited [1-9]/);
      const logs = run('docker', ['logs', SERVER]);
      expect(`${logs.stdout}${logs.stderr}`).toMatch(/not authorized/);
    },
    LONG,
  );
});
