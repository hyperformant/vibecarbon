import { describe, expect, it, vi } from 'vitest';
import { APT_LOCK_OPT, APT_NO_SRV_OPT, aptQuietUpdate } from '../../../src/lib/deploy/apt.js';
import { hostReporterInstaller, hostReporterScript } from '../../../src/lib/host-reporter.js';
import { DOCKER_PACKAGES, DOCKER_SOURCE_ONLY } from '../../../src/lib/iac/docker-install.js';
import {
  cordonArgv,
  drainArgv,
  executeUpdatePlan,
  markArgv,
  releaseLeftoverCordons,
  startOutageMonitor,
  uncordonArgv,
  unmarkArgv,
} from '../../../src/lib/update/execute.js';
import { unexpectedRestartPrompt } from '../../../src/lib/update/text.js';
import { withSshContract } from '../../_shared/ssh-contract.js';

// ---------------------------------------------------------------------------
// A fake clock: `sleep` parks a timer, and `run` drives a promise to the end,
// draining microtasks and then jumping to the earliest timer, so every wait in
// execute.js runs in fake time and a 10 minute budget takes milliseconds.
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);

function fakeClock(start = T0) {
  let t = start;
  let seq = 0;
  type Timer = { at: number; seq: number; resolve: () => void };
  const timers: Timer[] = [];
  const now = () => t;
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = { at: t + Math.max(0, ms), seq: seq++, resolve };
      timers.push(timer);
      signal?.addEventListener(
        'abort',
        () => {
          const i = timers.indexOf(timer);
          if (i >= 0) timers.splice(i, 1);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  const flush = () => new Promise((r) => setImmediate(r));
  async function run<T>(p: Promise<T>): Promise<T> {
    let state: { done: boolean; value?: T; error?: unknown; failed?: boolean } = { done: false };
    p.then(
      (value) => {
        state = { done: true, value };
      },
      (error) => {
        state = { done: true, failed: true, error };
      },
    );
    for (let i = 0; i < 200_000; i++) {
      await flush();
      if (state.done) break;
      if (timers.length === 0) throw new Error('fake clock: stuck with nothing scheduled');
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = timers.shift() as Timer;
      t = Math.max(t, next.at);
      next.resolve();
    }
    if (!state.done) throw new Error('fake clock: too many steps');
    if (state.failed) throw state.error;
    return state.value as T;
  }
  /** Let parked timers fire for `ms` of fake time, with nothing awaited. */
  async function advance(ms: number) {
    const end = t + ms;
    for (;;) {
      await flush();
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (!timers.length || timers[0].at > end) break;
      const next = timers.shift() as Timer;
      t = next.at;
      next.resolve();
    }
    t = end;
  }
  return { now, sleep, run, advance, pending: () => timers.length };
}

// ---------------------------------------------------------------------------
// A fake fleet: servers that reboot in fake time, and a cluster API that, like
// the real one, keeps showing a rebooted node and its pods Ready from before
// the restart until the new kubelet reports in.
// ---------------------------------------------------------------------------

const KEY = '/keys/prod';
const MASTER_IP = '10.1.0.1';
const OLD_READY = new Date(T0 - 3_600_000).toISOString().replace('.000', '');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}/, '');

type Spec = {
  name: string;
  ip: string;
  rebootRequired?: boolean;
  pkgs?: string[];
  downMs?: number; // ssh refused for this long once the reboot fires
  neverBack?: boolean; // the reboot never happens: the old boot id forever
  staysDown?: boolean; // the reboot happens and ssh never answers again
  apiLagMs?: number; // the API shows the node from before, this long after ssh is back
  apiNeverFresh?: boolean;
  podsLagMs?: number; // pods stay Ready from before, this long after ssh is back
  podsNeverFresh?: boolean;
  podsReadyJustBefore?: boolean; // the stale Ready is from 1 s before the reboot fired
  leaseNeverRenews?: boolean;
  appStartMs?: number; // after ssh is back, the app needs this long to be healthy
  upgrade?: { stdout?: string; error?: Error };
  dockerError?: Error;
  reporterError?: Error;
  failKubectl?: string; // a kubectl verb that fails for this node
};

type Server = Spec & { boots: number; rebootAt: number | null; marked: boolean; cordoned: boolean };
type Call = { t: number; via: string; ip: string; argv: string[]; opts: Record<string, unknown> };

function sshRefused(ip: string) {
  return Object.assign(new Error('Command failed: ssh ...'), {
    status: 255,
    stdout: '',
    stderr: `ssh: connect to host ${ip} port 22: Connection refused\n`,
  });
}

function world(specs: Spec[]) {
  const clock = fakeClock();
  const calls: Call[] = [];
  const servers = specs.map((s) => ({
    ...s,
    boots: 0,
    rebootAt: null,
    marked: false,
    cordoned: false,
  })) as Server[];
  if (!servers.some((s) => s.ip === MASTER_IP)) {
    servers.push({
      name: 'master',
      ip: MASTER_IP,
      boots: 0,
      rebootAt: null,
      marked: false,
      cordoned: false,
    });
  }
  const byIp = (ip: string) => servers.find((s) => s.ip === ip) as Server;
  const byName = (name: string) => servers.find((s) => s.name === name) as Server;
  const record = (via: string, ip: string, argv: string[], opts: Record<string, unknown>) =>
    calls.push({ t: clock.now(), via, ip, argv, opts });

  const backAt = (s: Server) => (s.rebootAt ?? 0) + (s.downMs ?? 40_000);
  const isBack = (s: Server) =>
    s.rebootAt !== null && !s.staysDown && !s.neverBack && clock.now() >= backAt(s);
  const isDown = (s: Server) =>
    s.rebootAt !== null && !s.neverBack && clock.now() >= s.rebootAt && !isBack(s);
  const bootId = (s: Server, n: number) =>
    `3f1c2a6e-${s.ip.split('.').pop()?.padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
  const currentBoot = (s: Server) => (isBack(s) ? bootId(s, 1) : bootId(s, 0));
  const btime = (s: Server) =>
    isBack(s) ? Math.floor((s.rebootAt as number) / 1000) : Math.floor(T0 / 1000) - 86_400;
  const apiFreshAt = (s: Server) => backAt(s) + (s.apiLagMs ?? 10_000);
  const apiFresh = (s: Server) => isBack(s) && !s.apiNeverFresh && clock.now() >= apiFreshAt(s);
  const podsFreshAt = (s: Server) => backAt(s) + (s.podsLagMs ?? 30_000);
  const podsFresh = (s: Server) => isBack(s) && !s.podsNeverFresh && clock.now() >= podsFreshAt(s);
  const healthyAt = (s: Server) => backAt(s) + (s.appStartMs ?? 20_000);

  const sshRun = vi.fn(
    async (ip: string, _key: string, argv: string[], opts: Record<string, unknown> = {}) => {
      record('ssh', ip, argv, opts);
      const s = byIp(ip);
      const cmd = argv.join(' ');
      if (isDown(s)) throw sshRefused(ip);
      if (cmd.includes('unattended-upgrade')) {
        if (s.upgrade?.error) throw s.upgrade.error;
        return (
          s.upgrade?.stdout ??
          'Packages that will be upgraded: libc6 openssl\nAll upgrades installed'
        );
      }
      if (cmd === 'sh -s -- --print') {
        return JSON.stringify({
          v: 1,
          host: s.name,
          rebootRequired: Boolean(s.rebootRequired) && !isBack(s),
          since: s.rebootRequired ? '2026-11-15T11:00:00Z' : null,
          packages: s.rebootRequired ? (s.pkgs ?? []) : [],
        });
      }
      if (cmd.includes('/proc/sys/kernel/random/boot_id')) {
        return `${currentBoot(s)}\n${Math.floor(clock.now() / 1000)}\n${btime(s)}`;
      }
      if (argv[0] === 'systemd-run') {
        if (!s.neverBack) {
          s.rebootAt = clock.now() + 2000;
          s.boots += 1;
        }
        return '';
      }
      if (cmd.includes('--only-upgrade')) {
        if (s.dockerError) throw s.dockerError;
        return '';
      }
      throw new Error(`unexpected ssh: ${cmd}`);
    },
  );

  const sshRunScript = vi.fn(
    async (ip: string, _key: string, script: unknown, opts: Record<string, unknown> = {}) => {
      if (typeof script !== 'string' || !script)
        throw new Error('sshRunScript takes a script string');
      record('script', ip, [script], opts);
      const s = byIp(ip);
      if (isDown(s)) throw sshRefused(ip);
      if (s.reporterError) throw s.reporterError;
      return '';
    },
  );

  const nodeJson = (s: Server) => ({
    metadata: {
      name: s.name,
      annotations: s.marked ? { 'vibecarbon.dev/cordoned-by-update': 'true' } : {},
    },
    spec: { unschedulable: s.cordoned },
    status: {
      nodeInfo: { bootID: apiFresh(s) ? bootId(s, 1) : bootId(s, 0) },
      conditions: [{ type: 'Ready', status: 'True', reason: 'KubeletReady' }],
    },
  });
  const podsJson = (s: Server) => {
    const stale = s.podsReadyJustBefore && s.rebootAt !== null ? iso(s.rebootAt - 1000) : OLD_READY;
    const ready = podsFresh(s) ? iso(podsFreshAt(s)) : stale;
    const pod = (
      namespace: string,
      name: string,
      phase: string,
      readyStatus: string,
      at: string,
    ) => ({
      metadata: { namespace, name },
      spec: { nodeName: s.name },
      status: {
        phase,
        conditions: [{ type: 'Ready', status: readyStatus, lastTransitionTime: at }],
      },
    });
    return {
      items: [
        pod('kube-system', `svclb-traefik-${s.name}`, 'Running', 'True', ready),
        pod('vibecarbon', `app-${s.name}`, 'Running', 'True', ready),
        pod('vibecarbon', 'backup-29001', 'Succeeded', 'False', OLD_READY),
        pod('vibecarbon', 'old-evicted', 'Failed', 'False', OLD_READY),
      ],
    };
  };

  const sshKubectl = vi.fn(
    async (ip: string, _key: string, argv: string[], opts: Record<string, unknown> = {}) => {
      record('kubectl', ip, argv, opts);
      const master = byIp(ip);
      if (isDown(master)) throw sshRefused(ip);
      const [verb, ...rest] = argv;
      const cmd = argv.join(' ');
      if (['cordon', 'uncordon', 'drain', 'annotate'].includes(verb)) {
        const node = byName(verb === 'annotate' ? rest[1] : rest[0]);
        const failing = node.failKubectl;
        if (failing && (failing === verb || cmd.includes(failing))) {
          throw Object.assign(new Error('Command failed: ssh ...'), {
            status: 1,
            stdout: '',
            stderr: `error: ${failing} failed for ${node.name}\n`,
          });
        }
        if (verb === 'cordon') node.cordoned = true;
        if (verb === 'uncordon') node.cordoned = false;
        if (verb === 'annotate') node.marked = !rest[2].endsWith('-');
        return '';
      }
      if (cmd === 'get --raw /readyz') return 'ok';
      if (verb === 'get' && rest[0] === 'node') return JSON.stringify(nodeJson(byName(rest[1])));
      if (verb === 'get' && rest[0] === 'leases') {
        const name = String(rest[rest.indexOf('--field-selector') + 1]).replace(
          'metadata.name=',
          '',
        );
        const s = byName(name);
        const renewTime =
          apiFresh(s) && !s.leaseNeverRenews
            ? `r${Math.floor((clock.now() - apiFreshAt(s)) / 10_000)}`
            : 'from-before';
        return JSON.stringify({ items: [{ metadata: { name }, spec: { renewTime } }] });
      }
      if (verb === 'get' && rest[0] === 'pods') {
        const name = String(rest[rest.indexOf('--field-selector') + 1]).replace(
          'spec.nodeName=',
          '',
        );
        return JSON.stringify(podsJson(byName(name)));
      }
      throw new Error(`unexpected kubectl: ${cmd}`);
    },
  );

  const verifyAppHealth = vi.fn(
    async (ip: string, _key: string, _project: string, opts: Record<string, unknown>) => {
      record('health', ip, [], opts);
      const s = byIp(ip);
      const ready = s.rebootAt === null ? clock.now() : healthyAt(s);
      const budget = Number(opts.budgetMs);
      if (s.staysDown || s.neverBack || ready - clock.now() > budget) {
        await clock.sleep(budget);
        return { healthy: false, status: 'fail', details: 'Health probe failed' };
      }
      if (ready > clock.now()) await clock.sleep(ready - clock.now());
      return { healthy: true, status: '200', details: '' };
    },
  );

  // The public health answers 503 while any primary server is between its
  // reboot and the moment its app is healthy again.
  const fetchPublicDomain = vi.fn(async (url: string, init: { signal?: AbortSignal } = {}) => {
    record('probe', url, [], init as Record<string, unknown>);
    const t = clock.now();
    const down = servers.some(
      (s) =>
        !s.name.startsWith('standby') && s.rebootAt !== null && t >= s.rebootAt && t < healthyAt(s),
    );
    return { status: down ? 503 : 200, ok: !down };
  });

  const deps = {
    sshRun: withSshContract(sshRun),
    sshRunScript,
    sshKubectl: withSshContract(sshKubectl),
    verifyAppHealth,
    fetchPublicDomain,
    now: clock.now,
    sleep: clock.sleep,
  };
  return { clock, calls, servers, byName, backAt, apiFreshAt, podsFreshAt, healthyAt, deps };
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

const compose = (name: string, ip: string, over = {}) => ({
  name,
  ip,
  side: 'primary',
  role: 'server',
  kind: 'compose',
  ...over,
});
const k8s = (name: string, role: string, ip: string, over = {}) => ({
  name,
  ip,
  side: 'primary',
  role,
  kind: 'k8s',
  masterIp: MASTER_IP,
  nodeName: name,
  ...over,
});
const step = (target: object, over = {}) => ({
  target,
  state: {},
  install: 2,
  docker: null,
  restart: 'due',
  restartReason: 'linux-image-7.0.0-50-generic',
  effect: { kind: 'app-offline', seconds: [60, 180] },
  ...over,
});
const planOf = (...steps: object[]) =>
  ({
    envName: 'prod',
    tier: 'compose',
    steps,
    skipped: [],
    total: null,
    outageServers: [],
  }) as never;

const makeCtx = (over = {}) => ({
  envName: 'prod',
  sshKeyPath: KEY,
  domain: 'app.example.test',
  projectName: 'shop',
  yes: true,
  confirm: vi.fn(async () => true),
  log: { step: vi.fn(), info: vi.fn(), warn: vi.fn() },
  ...over,
});

const PKG = 'linux-image-7.0.0-50-generic';
const REBOOT = [
  'systemd-run',
  '--on-active=2',
  '--unit=vibecarbon-update-reboot',
  'systemctl',
  'reboot',
];
const UPGRADE = ['env', 'DEBIAN_FRONTEND=noninteractive', 'unattended-upgrade', '--verbose'];

/** One label per remote call, so a test can read the order at a glance. */
function label(c: Call): string {
  const cmd = c.argv.join(' ');
  if (c.via === 'script') return 'reporter';
  if (c.via === 'health') return 'health';
  if (c.via === 'probe') return 'probe';
  if (c.via === 'kubectl') {
    if (cmd.startsWith('annotate')) return cmd.endsWith('-') ? 'unmark' : 'mark';
    if (cmd === 'get --raw /readyz') return 'readyz';
    if (cmd.startsWith('get node ')) return 'node';
    if (cmd.startsWith('get leases')) return 'lease';
    if (cmd.startsWith('get pods')) return 'pods';
    return c.argv[0];
  }
  if (cmd.includes('unattended-upgrade')) return 'upgrade';
  if (cmd === 'sh -s -- --print') return 'check';
  if (cmd.includes('boot_id')) return 'boot';
  if (c.argv[0] === 'systemd-run') return 'reboot';
  if (cmd.includes('--only-upgrade')) return 'docker';
  return cmd;
}
/** Labels in order with runs of the same label collapsed into one. */
const sequence = (calls: Call[]) =>
  calls.map(label).filter((l, i, all) => l !== 'probe' && l !== all[i - 1]);
const first = (calls: Call[], l: string) => calls.findIndex((c) => label(c) === l);
const last = (calls: Call[], l: string) => calls.map(label).lastIndexOf(l);

// ---------------------------------------------------------------------------

describe('executeUpdatePlan on compose', () => {
  it('runs the reporter, the upgrade, the check, the reboot, the boot id polls, then the app health', async () => {
    const w = world([{ name: 'web-1', ip: '10.0.0.1', rebootRequired: true, pkgs: [PKG] }]);
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(compose('web-1', '10.0.0.1'))), makeCtx(), w.deps),
    );
    const own = w.calls.filter((c) => c.ip === '10.0.0.1');
    expect(sequence(own)).toEqual([
      'reporter',
      'upgrade',
      'check',
      'boot',
      'reboot',
      'boot',
      'health',
    ]);

    const reporter = own[first(own, 'reporter')];
    expect(reporter.argv).toEqual([hostReporterInstaller()]);
    expect(reporter.opts).toMatchObject({ timeout: 60_000 });
    const upgrade = own[first(own, 'upgrade')];
    expect(upgrade.argv).toEqual(UPGRADE);
    expect(upgrade.opts).toMatchObject({ timeout: 1_200_000, input: '' });
    const check = own[first(own, 'check')];
    expect(check.opts.input).toBe(hostReporterScript());
    // The clock and the boot id come from one ssh call, just before the reboot.
    const before = own[first(own, 'boot')];
    expect(before.argv.join(' ')).toContain('date -u +%s');
    expect(before.argv.join(' ')).toContain('/proc/sys/kernel/random/boot_id');
    expect(own[first(own, 'reboot')].argv).toEqual(REBOOT);

    const polls = own.slice(first(own, 'reboot') + 1).filter((c) => label(c) === 'boot');
    expect(polls.length).toBeGreaterThan(2);
    for (const p of polls) expect(p.opts).toMatchObject({ transportRetry: false, timeout: 10_000 });
    for (let i = 1; i < polls.length; i++) expect(polls[i].t - polls[i - 1].t).toBe(5000);
    expect(polls.at(-1)?.t).toBeGreaterThanOrEqual(w.backAt(w.byName('web-1')));
    expect(polls.at(-2)?.t).toBeLessThan(w.backAt(w.byName('web-1')));

    expect(w.deps.verifyAppHealth).toHaveBeenCalledTimes(1);
    expect(w.deps.verifyAppHealth).toHaveBeenCalledWith('10.0.0.1', KEY, 'shop', {
      domain: 'app.example.test',
      budgetMs: 300_000,
      path: '/api/health/ready',
    });
    expect(res.stoppedAt).toBeNull();
    expect(res.becameDue).toEqual([]);
    expect(res.outcomes).toEqual([
      {
        name: 'web-1',
        installed: 2,
        docker: null,
        restarted: true,
        outageSeconds: expect.any(Number),
        error: null,
        hint: null,
      },
    ]);
  });

  it('counts what unattended-upgrade says it upgraded, not what the plan guessed', async () => {
    const w = world([
      {
        name: 'web-1',
        ip: '10.0.0.1',
        upgrade: { stdout: 'Packages that will be upgraded: openssl\nAll upgrades installed' },
      },
    ]);
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(compose('web-1', '10.0.0.1'), { install: 5, restart: 'none' })),
        makeCtx(),
        w.deps,
      ),
    );
    expect(res.outcomes[0].installed).toBe(1);
  });

  it('updates Docker with apt from its own source, noninteractive, then waits for the app', async () => {
    const w = world([{ name: 'web-1', ip: '10.0.0.1' }]);
    const docker = { packages: [{ name: 'docker-ce', from: '5:28.1.0', to: '5:29.0.1' }] };
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(compose('web-1', '10.0.0.1'), { install: 0, restart: 'none', docker })),
        makeCtx(),
        w.deps,
      ),
    );
    const own = w.calls.filter((c) => c.ip === '10.0.0.1');
    expect(sequence(own)).toEqual(['reporter', 'docker', 'check', 'health']);
    const call = own[first(own, 'docker')];
    // One noninteractive environment for both apt commands, the refresh from
    // Docker's source alone, then only Docker's packages, only upgraded.
    expect(call.argv).toEqual([
      'env',
      'DEBIAN_FRONTEND=noninteractive',
      'sh',
      '-c',
      `${aptQuietUpdate(DOCKER_SOURCE_ONLY)} && apt-get ${APT_LOCK_OPT} ${APT_NO_SRV_OPT} install -y --only-upgrade -o Dpkg::Options::=--force-confold ${DOCKER_PACKAGES.join(' ')}`,
    ]);
    expect(DOCKER_PACKAGES).toEqual([
      'docker-ce',
      'docker-ce-cli',
      'containerd.io',
      'docker-buildx-plugin',
      'docker-compose-plugin',
    ]);
    expect(call.opts).toMatchObject({ timeout: 600_000, input: '' });
    expect(w.deps.verifyAppHealth).toHaveBeenCalledWith('10.0.0.1', KEY, 'shop', {
      domain: 'app.example.test',
      budgetMs: 300_000,
      path: '/api/health/ready',
    });
    expect(res.outcomes[0]).toMatchObject({
      docker: docker.packages,
      restarted: false,
      error: null,
    });
  });

  it('waits for the app once, after the restart, when Docker and a restart share an outage', async () => {
    const w = world([{ name: 'web-1', ip: '10.0.0.1', rebootRequired: true, pkgs: [PKG] }]);
    const docker = { packages: [{ name: 'containerd.io', from: '1.7.1', to: '1.7.2' }] };
    await w.clock.run(
      executeUpdatePlan(planOf(step(compose('web-1', '10.0.0.1'), { docker })), makeCtx(), w.deps),
    );
    const own = w.calls.filter((c) => c.ip === '10.0.0.1');
    expect(sequence(own)).toEqual([
      'reporter',
      'upgrade',
      'docker',
      'check',
      'boot',
      'reboot',
      'boot',
      'health',
    ]);
    expect(w.deps.verifyAppHealth).toHaveBeenCalledTimes(1);
  });

  it('stops when the app never becomes healthy after a Docker update', async () => {
    const w = world([{ name: 'web-1', ip: '10.0.0.1' }]);
    w.deps.verifyAppHealth.mockResolvedValue({ healthy: false, status: 'fail', details: '' });
    const docker = { packages: [{ name: 'docker-ce', from: '1', to: '2' }] };
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(compose('web-1', '10.0.0.1'), { install: 0, restart: 'none', docker })),
        makeCtx(),
        w.deps,
      ),
    );
    expect(res.stoppedAt).toMatchObject({
      error:
        'web-1 did not become healthy within 5 minutes: its health check never passed (last result: fail)',
      hint: 'check it in your provider console, then run vibecarbon status prod',
    });
  });

  it('warns and goes on when the reporter cannot be installed', async () => {
    const w = world([
      {
        name: 'web-1',
        ip: '10.0.0.1',
        reporterError: Object.assign(new Error('x'), { status: 1, stderr: 'boom\n' }),
      },
    ]);
    const ctx = makeCtx();
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(compose('web-1', '10.0.0.1'), { restart: 'none' })),
        ctx,
        w.deps,
      ),
    );
    expect(ctx.log.warn).toHaveBeenCalledWith(
      'could not install the restart reporter on web-1 (boom), so vibecarbon status may not show when it needs a restart',
    );
    expect(res.stoppedAt).toBeNull();
    expect(sequence(w.calls.filter((c) => c.ip === '10.0.0.1'))).toEqual([
      'reporter',
      'upgrade',
      'check',
    ]);
  });
});

describe('executeUpdatePlan on k8s', () => {
  const worker = { name: 'worker-1', ip: '10.1.0.2', rebootRequired: true, pkgs: [PKG] };
  const drained = { effect: { kind: 'drained', seconds: null } };

  it('cordons, marks and drains a worker before its reboot, and releases it once its pods are Ready', async () => {
    const w = world([worker]);
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(k8s('worker-1', 'worker', '10.1.0.2'), drained)),
        makeCtx(),
        w.deps,
      ),
    );
    const kube = w.calls.filter((c) => c.via === 'kubectl');
    for (const c of kube) expect(c.ip).toBe(MASTER_IP);
    expect(sequence(kube)).toEqual([
      'cordon',
      'mark',
      'drain',
      'node',
      'lease',
      'pods',
      'uncordon',
      'unmark',
    ]);
    expect(kube[first(kube, 'cordon')].argv).toEqual(['cordon', 'worker-1']);
    expect(kube[first(kube, 'mark')].argv).toEqual([
      'annotate',
      'node',
      'worker-1',
      'vibecarbon.dev/cordoned-by-update=true',
      '--overwrite',
    ]);
    const drain = kube[first(kube, 'drain')];
    expect(drain.argv).toEqual([
      'drain',
      'worker-1',
      '--ignore-daemonsets',
      '--delete-emptydir-data',
      '--timeout=300s',
    ]);
    expect(Number(drain.opts.timeout)).toBeGreaterThan(300_000);
    expect(kube[first(kube, 'lease')].argv).toEqual([
      'get',
      'leases',
      '-n',
      'kube-node-lease',
      '--field-selector',
      'metadata.name=worker-1',
      '-o',
      'json',
    ]);
    expect(kube[first(kube, 'pods')].argv).toEqual([
      'get',
      'pods',
      '-A',
      '--field-selector',
      'spec.nodeName=worker-1',
      '-o',
      'json',
    ]);
    expect(kube[first(kube, 'uncordon')].argv).toEqual(['uncordon', 'worker-1']);
    expect(kube[first(kube, 'unmark')].argv).toEqual([
      'annotate',
      'node',
      'worker-1',
      'vibecarbon.dev/cordoned-by-update-',
    ]);

    const all = w.calls;
    const reboot = all.findIndex((c) => label(c) === 'reboot');
    expect(all.findIndex((c) => label(c) === 'drain')).toBeLessThan(reboot);
    expect(first(all, 'uncordon')).toBeGreaterThan(last(all, 'pods'));
    expect(all[first(all, 'uncordon')].t).toBeGreaterThanOrEqual(
      w.podsFreshAt(w.byName('worker-1')),
    );
    expect(w.byName('worker-1')).toMatchObject({ cordoned: false, marked: false });
    expect(w.deps.verifyAppHealth).not.toHaveBeenCalled();
    expect(res.outcomes[0]).toMatchObject({ name: 'worker-1', restarted: true, error: null });
  });

  it('cordons the master and the db node but never drains them, and waits for the API on the master', async () => {
    const w = world([
      { name: 'master', ip: MASTER_IP, rebootRequired: true, pkgs: [PKG] },
      { name: 'db', ip: '10.1.0.3', rebootRequired: true, pkgs: [PKG] },
    ]);
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(k8s('master', 'master', MASTER_IP)), step(k8s('db', 'db', '10.1.0.3'))),
        makeCtx(),
        w.deps,
      ),
    );
    expect(res.stoppedAt).toBeNull();
    const kube = w.calls.filter((c) => c.via === 'kubectl');
    expect(kube.some((c) => c.argv[0] === 'drain')).toBe(false);
    expect(kube.filter((c) => c.argv[0] === 'cordon').map((c) => c.argv[1])).toEqual([
      'master',
      'db',
    ]);
    const master = w.calls.slice(0, first(w.calls, 'unmark') + 1);
    expect(sequence(master.filter((c) => c.via === 'kubectl'))).toEqual([
      'cordon',
      'mark',
      'readyz',
      'node',
      'lease',
      'pods',
      'uncordon',
      'unmark',
    ]);
    const db = w.calls.slice(first(w.calls, 'unmark') + 1).filter((c) => c.via === 'kubectl');
    expect(db.some((c) => label(c) === 'readyz')).toBe(false);
  });

  // The API keeps the node's last status until the new kubelet posts one: the
  // boot id from before the restart, Ready=True. That is not the node back.
  it('keeps waiting while the API still shows the node from before the restart', async () => {
    const w = world([{ ...worker, apiLagMs: 60_000 }]);
    await w.clock.run(
      executeUpdatePlan(
        planOf(step(k8s('worker-1', 'worker', '10.1.0.2'), drained)),
        makeCtx(),
        w.deps,
      ),
    );
    const s = w.byName('worker-1');
    const nodeReads = w.calls.filter((c) => label(c) === 'node');
    expect(nodeReads.filter((c) => c.t < w.apiFreshAt(s)).length).toBeGreaterThan(5);
    expect(w.calls[first(w.calls, 'lease')].t).toBeGreaterThanOrEqual(w.apiFreshAt(s));
    expect(w.calls[first(w.calls, 'uncordon')].t).toBeGreaterThanOrEqual(w.apiFreshAt(s));
  });

  it('stops, still cordoned, when the API never shows the node with its new boot id', async () => {
    const w = world([{ ...worker, apiNeverFresh: true }]);
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(k8s('worker-1', 'worker', '10.1.0.2'), drained)),
        makeCtx(),
        w.deps,
      ),
    );
    expect(res.stoppedAt).toMatchObject({
      name: 'worker-1',
      restarted: true,
      error:
        'worker-1 did not become healthy within 5 minutes: the cluster still showed the node as it was before the restart',
      hint: 'it is still cordoned, run vibecarbon update prod again once it is Ready, which uncordons it',
    });
    expect(first(w.calls, 'uncordon')).toBe(-1);
    expect(w.byName('worker-1')).toMatchObject({ cordoned: true, marked: true });
  });

  it('keeps waiting while the pods are Ready only from before the restart', async () => {
    const w = world([{ ...worker, podsLagMs: 90_000 }]);
    await w.clock.run(
      executeUpdatePlan(
        planOf(step(k8s('worker-1', 'worker', '10.1.0.2'), drained)),
        makeCtx(),
        w.deps,
      ),
    );
    const s = w.byName('worker-1');
    const podReads = w.calls.filter((c) => label(c) === 'pods');
    expect(podReads.filter((c) => c.t < w.podsFreshAt(s)).length).toBeGreaterThan(5);
    expect(w.calls[first(w.calls, 'uncordon')].t).toBeGreaterThanOrEqual(w.podsFreshAt(s));
  });

  // The clock is read just before the reboot command, and the reboot fires 2 s
  // later: a pod that turned Ready in between is still from before the restart.
  it('does not count a pod that turned Ready in the 2 s before the reboot fired', async () => {
    const w = world([{ ...worker, podsLagMs: 90_000, podsReadyJustBefore: true }]);
    await w.clock.run(
      executeUpdatePlan(
        planOf(step(k8s('worker-1', 'worker', '10.1.0.2'), drained)),
        makeCtx(),
        w.deps,
      ),
    );
    const s = w.byName('worker-1');
    const boot = w.calls.filter((c) => label(c) === 'boot');
    expect(boot[0].t).toBeLessThan((s.rebootAt as number) - 1000);
    expect(w.calls[first(w.calls, 'uncordon')].t).toBeGreaterThanOrEqual(w.podsFreshAt(s));
  });

  it('stops, still cordoned, when the kubelet never renews its lease', async () => {
    const w = world([{ ...worker, leaseNeverRenews: true }]);
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(k8s('worker-1', 'worker', '10.1.0.2'), drained)),
        makeCtx(),
        w.deps,
      ),
    );
    expect(res.stoppedAt).toMatchObject({
      error:
        'worker-1 did not become healthy within 5 minutes: its kubelet did not renew its node lease',
      hint: 'it is still cordoned, run vibecarbon update prod again once it is Ready, which uncordons it',
    });
    expect(first(w.calls, 'pods')).toBe(-1);
    expect(first(w.calls, 'uncordon')).toBe(-1);
  });

  it('stops, still cordoned, naming the pods that never became Ready after the restart', async () => {
    const w = world([{ ...worker, podsNeverFresh: true }]);
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(k8s('worker-1', 'worker', '10.1.0.2'), drained)),
        makeCtx(),
        w.deps,
      ),
    );
    // The Succeeded and Failed pods are finished, so they are never waited on.
    expect(res.stoppedAt?.error).toBe(
      'worker-1 did not become healthy within 5 minutes: pods not Ready since the restart: kube-system/svclb-traefik-worker-1, vibecarbon/app-worker-1',
    );
    expect(res.stoppedAt?.hint).toContain('still cordoned');
    expect(first(w.calls, 'uncordon')).toBe(-1);
  });

  it('stops before the reboot, still cordoned, when the drain fails', async () => {
    const w = world([{ ...worker, failKubectl: 'drain' }]);
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(k8s('worker-1', 'worker', '10.1.0.2'), drained)),
        makeCtx(),
        w.deps,
      ),
    );
    expect(res.stoppedAt).toMatchObject({
      restarted: false,
      error: 'could not drain worker-1: it exited 1\n  error: drain failed for worker-1',
      hint: 'it is still cordoned, run vibecarbon update prod again once it is Ready, which uncordons it',
    });
    expect(first(w.calls, 'reboot')).toBe(-1);
  });

  it('uncordons again when the mark cannot be written, so nothing is left cordoned unmarked', async () => {
    const w = world([{ ...worker, failKubectl: 'cordoned-by-update=true' }]);
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(k8s('worker-1', 'worker', '10.1.0.2'), drained)),
        makeCtx(),
        w.deps,
      ),
    );
    expect(res.stoppedAt?.error).toMatch(
      /^could not mark worker-1 as cordoned by vibecarbon update/,
    );
    expect(res.stoppedAt?.hint).toBe('run vibecarbon update prod again');
    expect(sequence(w.calls.filter((c) => c.via === 'kubectl'))).toEqual([
      'cordon',
      'mark',
      'uncordon',
    ]);
    expect(w.byName('worker-1').cordoned).toBe(false);
  });
});

describe('restarts the plan did not predict', () => {
  const web = { name: 'web-1', ip: '10.0.0.1', rebootRequired: true, pkgs: [PKG] };
  const quiet = { restart: 'none', restartReason: null, effect: { kind: 'none', seconds: null } };

  it('-y leaves it for the next run and names the server and package', async () => {
    const w = world([web]);
    const ctx = makeCtx({ yes: true });
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(compose('web-1', '10.0.0.1'), quiet)), ctx, w.deps),
    );
    expect(first(w.calls, 'reboot')).toBe(-1);
    expect(ctx.confirm).not.toHaveBeenCalled();
    expect(res.becameDue).toEqual([{ name: 'web-1', package: PKG }]);
    expect(res.outcomes[0]).toMatchObject({ restarted: false, error: null });
  });

  it('asks with the exact prompt and does not restart on no', async () => {
    const w = world([web]);
    const ctx = makeCtx({ yes: false, confirm: vi.fn(async () => false) });
    const target = compose('web-1', '10.0.0.1');
    const res = await w.clock.run(executeUpdatePlan(planOf(step(target, quiet)), ctx, w.deps));
    expect(ctx.confirm).toHaveBeenCalledTimes(1);
    expect(ctx.confirm).toHaveBeenCalledWith(
      unexpectedRestartPrompt({ target: target as never, pkg: PKG }),
    );
    expect(ctx.confirm).toHaveBeenCalledWith(
      `web-1 now needs a restart for ${PKG}, which the plan did not show. The app is offline for about 1 to 3 minutes while it restarts. Restart it now?`,
    );
    expect(first(w.calls, 'reboot')).toBe(-1);
    expect(res.becameDue).toEqual([{ name: 'web-1', package: PKG }]);
  });

  it('restarts on yes', async () => {
    const w = world([web]);
    const ctx = makeCtx({ yes: false, confirm: vi.fn(async () => true) });
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(compose('web-1', '10.0.0.1'), quiet)), ctx, w.deps),
    );
    expect(first(w.calls, 'reboot')).toBeGreaterThan(-1);
    expect(res.becameDue).toEqual([]);
    expect(res.outcomes[0].restarted).toBe(true);
  });

  it('does not restart a likely step when no restart became due', async () => {
    const w = world([{ name: 'web-1', ip: '10.0.0.1' }]);
    const ctx = makeCtx();
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(compose('web-1', '10.0.0.1'), { restart: 'likely', restartReason: 'libc6' })),
        ctx,
        w.deps,
      ),
    );
    expect(first(w.calls, 'reboot')).toBe(-1);
    expect(ctx.log.info).toHaveBeenCalledWith('web-1: no restart needed after all');
    expect(res.outcomes[0].restarted).toBe(false);
  });

  it('restarts a likely step when the restart became due', async () => {
    const w = world([web]);
    await w.clock.run(
      executeUpdatePlan(
        planOf(step(compose('web-1', '10.0.0.1'), { restart: 'likely', restartReason: 'libc6' })),
        makeCtx(),
        w.deps,
      ),
    );
    expect(first(w.calls, 'reboot')).toBeGreaterThan(-1);
  });
});

describe('stopping at the first failure', () => {
  // Review Focus 2: the daily job holds the dpkg lock past apt's wait.
  it('stops at a failed install with its last output lines and touches no later server', async () => {
    const lockErr = Object.assign(new Error('Command failed: ssh ...'), {
      status: 100,
      stdout: [
        'Checking: libc6',
        'Checking: openssl',
        '',
        'Packages that will be upgraded: libc6 openssl',
        'Writing dpkg log to /var/log/unattended-upgrades/unattended-upgrades-dpkg.log',
        'Reading package lists...',
        'E: Could not get lock /var/lib/dpkg/lock-frontend',
      ].join('\n'),
      stderr: '',
    });
    const w = world([
      { name: 'web-standby', ip: '10.0.0.2', upgrade: { error: lockErr } },
      { name: 'web-primary', ip: '10.0.0.1', rebootRequired: true, pkgs: [PKG] },
    ]);
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(
          step(compose('web-standby', '10.0.0.2', { side: 'standby' })),
          step(compose('web-primary', '10.0.0.1')),
        ),
        makeCtx(),
        w.deps,
      ),
    );
    expect(res.outcomes).toHaveLength(1);
    expect(res.stoppedAt).toBe(res.outcomes[0]);
    expect(res.stoppedAt).toMatchObject({ name: 'web-standby', installed: 0, restarted: false });
    expect(res.stoppedAt?.error).toBe(
      [
        'could not install the security updates on web-standby: it exited 100',
        '  Checking: openssl',
        '  Packages that will be upgraded: libc6 openssl',
        '  Writing dpkg log to /var/log/unattended-upgrades/unattended-upgrades-dpkg.log',
        '  Reading package lists...',
        '  E: Could not get lock /var/lib/dpkg/lock-frontend',
      ].join('\n'),
    );
    expect(res.stoppedAt?.hint).toBe(
      'run vibecarbon update prod again once web-standby is reachable and apt is free',
    );
    expect(w.calls.some((c) => c.ip === '10.0.0.1')).toBe(false);
    expect(first(w.calls, 'reboot')).toBe(-1);
  });

  it('stops when the install runs past its budget', async () => {
    const timeout = Object.assign(new Error('Command failed: ssh ...'), {
      status: null,
      timedOut: true,
      stdout: 'Checking: libc6\n',
      stderr: '',
    });
    const w = world([{ name: 'web-1', ip: '10.0.0.1', upgrade: { error: timeout } }]);
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(compose('web-1', '10.0.0.1'))), makeCtx(), w.deps),
    );
    expect(res.stoppedAt?.error).toBe(
      'could not install the security updates on web-1: it did not finish within 20 minutes\n  Checking: libc6',
    );
  });

  // Review Focus 3: the server never comes back.
  it('compose: stops after 10 minutes when the boot id never changes', async () => {
    const w = world([
      { name: 'web-1', ip: '10.0.0.1', rebootRequired: true, pkgs: [PKG], neverBack: true },
      { name: 'web-2', ip: '10.0.0.2' },
    ]);
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(compose('web-1', '10.0.0.1')), step(compose('web-2', '10.0.0.2'))),
        makeCtx(),
        w.deps,
      ),
    );
    const reboot = w.calls[first(w.calls, 'reboot')];
    const polls = w.calls.filter((c) => label(c) === 'boot' && c.t > reboot.t);
    expect((polls.at(-1)?.t ?? 0) - reboot.t).toBe(600_000);
    expect(res.stoppedAt?.error).toMatch(/did not come back within 10 minutes/);
    expect(res.stoppedAt).toMatchObject({
      name: 'web-1',
      restarted: false,
      error:
        'web-1 did not come back within 10 minutes: it still had the boot id from before the restart',
      hint: 'check it in your provider console, then run vibecarbon status prod',
    });
    expect(w.calls.some((c) => c.ip === '10.0.0.2')).toBe(false);
    expect(w.deps.verifyAppHealth).not.toHaveBeenCalled();
  });

  it('k8s: stops after 10 minutes, still cordoned, when the node never comes back', async () => {
    const w = world([
      { name: 'worker-1', ip: '10.1.0.2', rebootRequired: true, pkgs: [PKG], neverBack: true },
    ]);
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(k8s('worker-1', 'worker', '10.1.0.2'))), makeCtx(), w.deps),
    );
    expect(res.stoppedAt?.error).toMatch(/did not come back within 10 minutes/);
    expect(res.stoppedAt?.hint).toContain('still cordoned');
    expect(res.stoppedAt?.hint).toBe(
      'it is still cordoned, run vibecarbon update prod again once it is Ready, which uncordons it',
    );
    expect(first(w.calls, 'uncordon')).toBe(-1);
  });

  it('says what ssh said when the server stays down', async () => {
    const w = world([
      { name: 'web-1', ip: '10.0.0.1', rebootRequired: true, pkgs: [PKG], staysDown: true },
    ]);
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(compose('web-1', '10.0.0.1'))), makeCtx(), w.deps),
    );
    expect(res.stoppedAt?.error).toBe(
      'web-1 did not come back within 10 minutes: ssh said: ssh: connect to host 10.0.0.1 port 22: Connection refused',
    );
  });
});

describe('every remote command', () => {
  it('has a timeout and a stdin that ends (input), on compose and on k8s', async () => {
    const docker = { packages: [{ name: 'docker-ce', from: '1', to: '2' }] };
    const w = world([
      { name: 'web-1', ip: '10.0.0.1', rebootRequired: true, pkgs: [PKG] },
      { name: 'worker-1', ip: '10.1.0.2', rebootRequired: true, pkgs: [PKG] },
      { name: 'master', ip: MASTER_IP, rebootRequired: true, pkgs: [PKG] },
    ]);
    await w.clock.run(
      executeUpdatePlan(
        planOf(
          step(compose('web-1', '10.0.0.1'), { docker }),
          step(k8s('worker-1', 'worker', '10.1.0.2')),
          step(k8s('master', 'master', MASTER_IP)),
        ),
        makeCtx(),
        w.deps,
      ),
    );
    const remote = w.calls.filter((c) => ['ssh', 'script', 'kubectl'].includes(c.via));
    expect(remote.length).toBeGreaterThan(30);
    for (const c of remote) {
      expect(typeof c.opts.timeout, label(c)).toBe('number');
      expect(typeof c.opts.input, label(c)).toBe('string');
    }
  });
});

// Review Focus 4: a run stopped mid-way left a node cordoned.
describe('releaseLeftoverCordons', () => {
  const node = (name: string, ready: string, marked: boolean) => ({
    metadata: {
      name,
      annotations: marked ? { 'vibecarbon.dev/cordoned-by-update': 'true' } : {},
    },
    spec: { unschedulable: true },
    status: { conditions: [{ type: 'Ready', status: ready }] },
  });

  it('uncordons only the marked nodes that are Ready, and removes their mark', async () => {
    const kubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) =>
      argv[0] === 'get'
        ? JSON.stringify({
            items: [
              node('worker-1', 'True', true),
              node('worker-2', 'False', true),
              node('worker-3', 'True', false),
            ],
          })
        : '',
    );
    const released = await releaseLeftoverCordons([MASTER_IP, MASTER_IP], {
      sshKubectl: withSshContract(kubectl),
      sshKeyPath: KEY,
    });
    expect(released).toEqual(['worker-1']);
    expect(kubectl.mock.calls.map((c) => c[2])).toEqual([
      ['get', 'nodes', '-o', 'json'],
      ['uncordon', 'worker-1'],
      ['annotate', 'node', 'worker-1', 'vibecarbon.dev/cordoned-by-update-'],
    ]);
    for (const c of kubectl.mock.calls) {
      expect(c[0]).toBe(MASTER_IP);
      expect(c[1]).toBe(KEY);
      expect(c[3]).toMatchObject({ timeout: expect.any(Number), input: '' });
    }
  });

  it('leaves a cluster it cannot read for the plan to report', async () => {
    const kubectl = vi.fn(async () => {
      throw new Error('ssh: connect to host 10.1.0.1 port 22: Connection refused');
    });
    await expect(
      releaseLeftoverCordons([MASTER_IP], {
        sshKubectl: withSshContract(kubectl),
        sshKeyPath: KEY,
      }),
    ).resolves.toEqual([]);
  });

  it('builds the argv the brief names', () => {
    expect(cordonArgv('n')).toEqual(['cordon', 'n']);
    expect(markArgv('n')).toEqual([
      'annotate',
      'node',
      'n',
      'vibecarbon.dev/cordoned-by-update=true',
      '--overwrite',
    ]);
    expect(drainArgv('n')).toEqual([
      'drain',
      'n',
      '--ignore-daemonsets',
      '--delete-emptydir-data',
      '--timeout=300s',
    ]);
    expect(uncordonArgv('n')).toEqual(['uncordon', 'n']);
    expect(unmarkArgv('n')).toEqual([
      'annotate',
      'node',
      'n',
      'vibecarbon.dev/cordoned-by-update-',
    ]);
  });
});

describe('startOutageMonitor', () => {
  it('turns probes ok, fail, fail, ok at 5 s into one window of 10 s', async () => {
    const clock = fakeClock();
    const answers = [{ status: 200 }, new Error('fetch failed'), { status: 503 }, { status: 200 }];
    const probe = vi.fn(async () => {
      const a = answers[Math.min(probe.mock.calls.length - 1, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a;
    });
    const monitor = startOutageMonitor({
      url: 'https://app.example.test/api/health/ready',
      probe,
      now: clock.now,
      sleep: clock.sleep,
    });
    await clock.advance(17_000);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(probe.mock.calls[0][0]).toBe('https://app.example.test/api/health/ready');
    const result = monitor.stop();
    expect(result).toEqual({ windows: [{ start: T0 + 5000, end: T0 + 15_000 }], totalSeconds: 10 });
    await clock.advance(60_000);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(clock.pending()).toBe(0);
  });

  it('closes a window still open when it stops', async () => {
    const clock = fakeClock();
    const probe = vi.fn(async () => ({ status: 502 }));
    const monitor = startOutageMonitor({ url: 'u', probe, now: clock.now, sleep: clock.sleep });
    await clock.advance(12_000);
    expect(monitor.stop()).toEqual({
      windows: [{ start: T0, end: T0 + 12_000 }],
      totalSeconds: 12,
    });
  });
});

describe('the outage each step caused', () => {
  it('is the overlap of the measured windows with that step', async () => {
    const w = world([
      { name: 'standby-1', ip: '10.0.0.2', rebootRequired: true, pkgs: [PKG] },
      { name: 'web-1', ip: '10.0.0.1', rebootRequired: true, pkgs: [PKG] },
    ]);
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(
          step(compose('standby-1', '10.0.0.2', { side: 'standby' }), {
            effect: { kind: 'no-traffic', seconds: null },
          }),
          step(compose('web-1', '10.0.0.1')),
        ),
        makeCtx(),
        w.deps,
      ),
    );
    const probes = w.calls.filter((c) => c.via === 'probe');
    expect(probes[0].ip).toBe('https://app.example.test/api/health/ready');
    expect((probes[0].opts as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
    const s = w.byName('web-1');
    const firstDown = probes.find((c) => c.t >= (s.rebootAt as number)) as Call;
    // web-1 is the last step: its step ends when its app is healthy, and the
    // monitor stops with the run, closing a window the next probe would have.
    const firstUp = probes.find((c) => c.t >= w.healthyAt(s));
    const end = Math.min(firstUp?.t ?? Number.POSITIVE_INFINITY, w.healthyAt(s));
    expect(res.outcomes[0].outageSeconds).toBe(0);
    expect(res.outcomes[1].outageSeconds).toBe((end - firstDown.t) / 1000);
    expect(res.outcomes[1].outageSeconds).toBeGreaterThan(40);
    // Stopped with the run: no probe after it, no timer left behind.
    const count = probes.length;
    await w.clock.advance(60_000);
    expect(w.calls.filter((c) => c.via === 'probe')).toHaveLength(count);
    expect(w.clock.pending()).toBe(0);
  });

  it('is not measured without a domain', async () => {
    const w = world([{ name: 'web-1', ip: '10.0.0.1', rebootRequired: true, pkgs: [PKG] }]);
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(compose('web-1', '10.0.0.1'))),
        makeCtx({ domain: null }),
        w.deps,
      ),
    );
    expect(w.deps.fetchPublicDomain).not.toHaveBeenCalled();
    expect(res.outcomes[0].outageSeconds).toBe(0);
  });

  it('stops the monitor when the run throws', async () => {
    const w = world([{ name: 'web-1', ip: '10.0.0.1', rebootRequired: true, pkgs: [PKG] }]);
    const ctx = makeCtx({
      yes: false,
      confirm: vi.fn(async () => {
        throw new Error('cancelled');
      }),
    });
    const quiet = { restart: 'none', restartReason: null, effect: { kind: 'none', seconds: null } };
    await expect(
      w.clock.run(
        executeUpdatePlan(planOf(step(compose('web-1', '10.0.0.1'), quiet)), ctx, w.deps),
      ),
    ).rejects.toThrow('cancelled');
    const count = w.calls.filter((c) => c.via === 'probe').length;
    await w.clock.advance(60_000);
    expect(w.calls.filter((c) => c.via === 'probe')).toHaveLength(count);
    expect(w.clock.pending()).toBe(0);
  });
});
