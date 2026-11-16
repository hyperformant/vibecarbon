/**
 * A node's own kubelet credential can annotate its own Node, and only that
 * one: the host reporter relies on it (carbon/cloud-init/k3s/_host-reporter.sh).
 *
 * A master and an agent run on one Docker network with plain k3s defaults
 * (NodeRestriction does not depend on the flannel backend). The agent only
 * has to be registered, not Ready. The reporter runs inside the agent, as it
 * does on a real node, with the agent's kubelet kubeconfig.
 *
 * Every container and network here is named vctest-* and removed in afterAll.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostReporterScript } from '../../../src/lib/host-reporter.js';
import { HOST_STATE_ANNOTATION, parseHostState } from '../../../src/lib/host-state.js';
import { k3sVersion } from '../../../src/lib/images.js';

const SKIPPED =
  process.env.DOCKER_INTEGRATION === 'true'
    ? null
    : 'skipped: needs Docker; run it with DOCKER_INTEGRATION=true (pnpm test:docker)';
if (SKIPPED) console.info(`host-reporter-k3s: ${SKIPPED}`);

const VERSION = process.env.VC_K3S_VERSION || k3sVersion();
const IMAGE = `rancher/k3s:${VERSION.replace('+', '-')}`;
const NET = `vctest-hostrep-net-${process.pid}`;
const MASTER = `vctest-hostrep-master-${process.pid}`;
const AGENT = `vctest-hostrep-agent-${process.pid}`;
const MASTER_IP = '10.0.2.1';
const AGENT_IP = '10.0.2.10';
const K3S_TOKEN = 'vctest-hostrep-token-5c1d';
const KUBELET = '/var/lib/rancher/k3s/agent/kubelet.kubeconfig';
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
const inAgent = (...args: string[]) => run('docker', ['exec', AGENT, ...args]);
const asKubelet = (...args: string[]) => inAgent('kubectl', '--kubeconfig', KUBELET, ...args);
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (what: string, probe: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    sleepSync(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
};
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
// Read the whole Node and index the annotation by its exact key, so the key
// never has to be escaped into a jsonpath expression.
const annotation = (): string => {
  const r = kubectl('get', 'node', AGENT, '-o', 'json');
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout).metadata.annotations?.[HOST_STATE_ANNOTATION] ?? '';
};

describe.skipIf(SKIPPED)(`the host reporter on real k3s (k3s ${VERSION})`, () => {
  let tmp = '';

  beforeAll(() => {
    must('docker', [
      'network',
      'create',
      '--subnet',
      '10.0.2.0/24',
      '--gateway',
      '10.0.2.254',
      NET,
    ]);
    node(
      MASTER,
      MASTER_IP,
      [],
      [
        'server',
        '--token',
        K3S_TOKEN,
        '--disable',
        'coredns,local-storage,metrics-server,traefik,servicelb',
        '--node-name',
        MASTER,
      ],
    );
    waitFor(
      'the master apiserver',
      () => kubectl('get', '--raw', '/readyz').stdout === 'ok',
      120_000,
    );
    node(
      AGENT,
      AGENT_IP,
      [`K3S_URL=https://${MASTER_IP}:6443`, `K3S_TOKEN=${K3S_TOKEN}`],
      ['agent', '--node-name', AGENT],
    );
    waitFor(
      `the ${AGENT} Node to register`,
      () => kubectl('get', 'node', AGENT, '-o', 'name').status === 0,
      120_000,
    );
    waitFor(
      'the agent kubelet kubeconfig',
      () => inAgent('test', '-f', KUBELET).status === 0,
      60_000,
    );
    tmp = mkdtempSync(join(tmpdir(), 'vctest-hostrep-'));
    const file = join(tmp, 'host-reporter.sh');
    writeFileSync(file, hostReporterScript());
    must('docker', ['cp', file, `${AGENT}:/tmp/host-reporter.sh`]);
  }, LONG);

  afterAll(() => {
    run('docker', ['rm', '-f', '-v', MASTER, AGENT]);
    run('docker', ['network', 'rm', NET]);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('reports a pending restart on its own Node', () => {
    inAgent(
      'sh',
      '-c',
      'echo linux-image-e2e-test > /var/run/reboot-required.pkgs && touch /var/run/reboot-required',
    );
    const r = inAgent('sh', '/tmp/host-reporter.sh');
    expect(r.status, r.stderr).toBe(0);
    const state = parseHostState(annotation());
    expect(state).toEqual({
      host: expect.any(String),
      rebootRequired: true,
      since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
      packages: ['linux-image-e2e-test'],
    });
  });

  it('reports no restart once the files are gone', () => {
    inAgent('rm', '-f', '/var/run/reboot-required', '/var/run/reboot-required.pkgs');
    const r = inAgent('sh', '/tmp/host-reporter.sh');
    expect(r.status, r.stderr).toBe(0);
    expect(parseHostState(annotation())).toEqual({
      host: expect.any(String),
      rebootRequired: false,
      since: null,
      packages: [],
    });
  });

  it('is refused annotating another Node (NodeRestriction)', () => {
    const r = asKubelet('annotate', '--overwrite', 'node', MASTER, 'vibecarbon.dev/host-state=x');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/forbidden/i);
    console.info(`forbidden annotate stderr: ${r.stderr.trim()}`);
  });

  it('is the node itself: whoami names system:node:<agent>', () => {
    const r = asKubelet('auth', 'whoami', '-o', 'jsonpath={.status.userInfo.username}');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(`system:node:${AGENT}`);
    console.info(`whoami: ${r.stdout.trim()}`);
  });
});
