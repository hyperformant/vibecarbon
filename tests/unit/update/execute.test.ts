import { describe, expect, it, vi } from 'vitest';
import {
  APT_LOCK_OPT,
  APT_NO_SRV_OPT,
  aptQuietUpdate,
  aptWaitForDailyUnits,
} from '../../../src/lib/deploy/apt.js';
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
  rebootCall?: { error: Error; scheduled: boolean }; // the reboot's ssh call fails
  apiLagMs?: number; // the API shows the node from before, this long after ssh is back
  apiNeverFresh?: boolean;
  podsLagMs?: number; // pods stay Ready from before, this long after ssh is back
  podsNeverFresh?: boolean;
  podsReadyJustBefore?: boolean; // the stale Ready is from 1 s before the reboot fired
  // A ReplicaSet pod turns Failed once the server is back. Its replacement
  // starts this long after it is back on another node, or, with
  // afterUncordon, on this node this long after the uncordon.
  podFailsAfterBoot?: { replacedAfterMs?: number; afterUncordon?: boolean };
  jobPodFailsAfterBoot?: boolean; // a Job's pod turns Failed once it is back, never retried
  // The StatefulSet's db-0 is deleted at the restart and recreated under the
  // same name: unbound, so off the node's list, until it is Ready this long
  // after the server is back (never without readyAfterMs).
  statefulSet?: { readyAfterMs?: number };
  leaseNeverRenews?: boolean;
  cordonedBefore?: boolean; // cordoned before the run (by the operator, unless markedBefore)
  markedBefore?: boolean; // an earlier update run left its mark
  appStartMs?: number; // after ssh is back (or Docker updated), the app needs this long
  ingressNeverBack?: boolean; // the app is healthy on the server, the domain is not
  upgrade?: { stdout?: string; error?: Error };
  dockerError?: Error;
  checkError?: Error;
  reporterError?: Error;
  failKubectl?: string; // kubectl calls naming this node and starting with this fail
};

type Server = Spec & {
  boots: number;
  rebootAt: number | null;
  dockerAt: number | null;
  uncordonedAt: number | null;
  marked: boolean;
  cordoned: boolean;
};
type Call = { t: number; via: string; ip: string; argv: string[]; opts: Record<string, unknown> };

function sshRefused(ip: string) {
  return Object.assign(new Error('Command failed: ssh ...'), {
    status: 255,
    stdout: '',
    stderr: `ssh: connect to host ${ip} port 22: Connection refused\n`,
  });
}

const controller = (kind: string, name: string, uid: string) => ({
  kind,
  name,
  uid,
  controller: true,
});
const RS_WEB = controller('ReplicaSet', 'web-7f9c', 'rs-web');

function world(specs: Spec[], opts: { publicUnreachable?: boolean; publicAnswer?: number } = {}) {
  const clock = fakeClock();
  const calls: Call[] = [];
  const fresh = (s: Spec): Server => ({
    ...s,
    boots: 0,
    rebootAt: null,
    dockerAt: null,
    uncordonedAt: null,
    marked: Boolean(s.markedBefore),
    cordoned: Boolean(s.cordonedBefore),
  });
  const servers = specs.map(fresh);
  if (!servers.some((s) => s.ip === MASTER_IP))
    servers.push(fresh({ name: 'master', ip: MASTER_IP }));
  const byIp = (ip: string) => servers.find((s) => s.ip === ip) as Server;
  const byName = (name: string) => servers.find((s) => s.name === name) as Server;
  const record = (via: string, ip: string, argv: string[], o: Record<string, unknown>) =>
    calls.push({ t: clock.now(), via, ip, argv, opts: o });

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
  const failedAt = (s: Server) => backAt(s) + 5000;
  const hasFailed = (s: Server) => isBack(s) && clock.now() >= failedAt(s);
  const replacedAt = (s: Server) => {
    const f = s.podFailsAfterBoot;
    if (!f) return Number.POSITIVE_INFINITY;
    if (f.afterUncordon)
      return s.uncordonedAt === null
        ? Number.POSITIVE_INFINITY
        : s.uncordonedAt + (f.replacedAfterMs ?? 10_000);
    return f.replacedAfterMs === undefined
      ? Number.POSITIVE_INFINITY
      : backAt(s) + f.replacedAfterMs;
  };
  const statefulReadyAt = (s: Server) =>
    s.statefulSet?.readyAfterMs === undefined
      ? Number.POSITIVE_INFINITY
      : backAt(s) + s.statefulSet.readyAfterMs;
  /** When the app went down: the reboot, else the Docker update. */
  const disruptedAt = (s: Server) => s.rebootAt ?? s.dockerAt;
  const healthyAt = (s: Server) =>
    (s.rebootAt !== null ? backAt(s) : (s.dockerAt ?? 0)) + (s.appStartMs ?? 20_000);

  const sshRun = vi.fn(
    async (ip: string, _key: string, argv: string[], o: Record<string, unknown> = {}) => {
      record('ssh', ip, argv, o);
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
        if (s.checkError) throw s.checkError;
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
        if (!s.neverBack && (s.rebootCall?.scheduled ?? true)) {
          s.rebootAt = clock.now() + 2000;
          s.boots += 1;
        }
        if (s.rebootCall) throw s.rebootCall.error;
        return '';
      }
      if (cmd.includes('--only-upgrade')) {
        if (s.dockerError) throw s.dockerError;
        s.dockerAt = clock.now();
        return '';
      }
      throw new Error(`unexpected ssh: ${cmd}`);
    },
  );

  const sshRunScript = vi.fn(
    async (ip: string, _key: string, script: unknown, o: Record<string, unknown> = {}) => {
      if (typeof script !== 'string' || !script)
        throw new Error('sshRunScript takes a script string');
      record('script', ip, [script], o);
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
    spec: s.cordoned ? { unschedulable: true } : {},
    status: {
      nodeInfo: { bootID: apiFresh(s) ? bootId(s, 1) : bootId(s, 0) },
      conditions: [{ type: 'Ready', status: 'True', reason: 'KubeletReady' }],
    },
  });
  const pod = (
    namespace: string,
    name: string,
    nodeName: string,
    phase: string,
    readyStatus: string,
    at: string,
    owner?: ReturnType<typeof controller>,
  ) => ({
    metadata: {
      namespace,
      name,
      uid: `uid-${name}`,
      ...(owner && { ownerReferences: [owner] }),
    },
    spec: { nodeName },
    status: {
      phase,
      conditions: [{ type: 'Ready', status: readyStatus, lastTransitionTime: at }],
    },
  });
  /** The pods bound to one server's node. */
  const serverPods = (s: Server) => {
    const stale = s.podsReadyJustBefore && s.rebootAt !== null ? iso(s.rebootAt - 1000) : OLD_READY;
    const ready = podsFresh(s) ? iso(podsFreshAt(s)) : stale;
    const items = [
      pod(
        'kube-system',
        `hcloud-csi-node-${s.name}`,
        s.name,
        'Running',
        'True',
        ready,
        controller('DaemonSet', 'hcloud-csi-node', 'ds-csi'),
      ),
      pod(
        'vibecarbon',
        `app-${s.name}`,
        s.name,
        'Running',
        'True',
        ready,
        controller('ReplicaSet', `app-${s.name}-5d8f`, `rs-app-${s.name}`),
      ),
      pod(
        'vibecarbon',
        `backup-29001-${s.name}`,
        s.name,
        'Succeeded',
        'False',
        OLD_READY,
        controller('Job', 'backup-29001', 'job-29001'),
      ),
      // Failed long before this run: never waited on, and its controller,
      // whose live pods are elsewhere, is not one this restart must bring back.
      pod(
        'vibecarbon',
        `old-evicted-${s.name}`,
        s.name,
        'Failed',
        'False',
        OLD_READY,
        controller('ReplicaSet', 'web-6c1a', 'rs-old'),
      ),
    ];
    if (s.podFailsAfterBoot) {
      items.push(
        hasFailed(s)
          ? pod('vibecarbon', 'web-7f9c-abcde', s.name, 'Failed', 'False', iso(failedAt(s)), RS_WEB)
          : pod('vibecarbon', 'web-7f9c-abcde', s.name, 'Running', 'True', OLD_READY, RS_WEB),
      );
    }
    if (s.jobPodFailsAfterBoot) {
      const job = controller('Job', 'backup-29002', 'job-29002');
      items.push(
        hasFailed(s)
          ? pod(
              'vibecarbon',
              'backup-29002-abcde',
              s.name,
              'Failed',
              'False',
              iso(failedAt(s)),
              job,
            )
          : pod('vibecarbon', 'backup-29002-abcde', s.name, 'Running', 'True', OLD_READY, job),
      );
    }
    if (s.statefulSet) {
      const sts = controller('StatefulSet', 'db', 'sts-db');
      if (!isBack(s))
        items.push(pod('vibecarbon', 'db-0', s.name, 'Running', 'True', OLD_READY, sts));
      else if (clock.now() >= statefulReadyAt(s))
        items.push(
          pod('vibecarbon', 'db-0', s.name, 'Running', 'True', iso(statefulReadyAt(s)), sts),
        );
    }
    return items;
  };
  /** Every pod in the cluster: each node's, the other web replica, and its replacement. */
  const allPods = () => {
    const items = servers.flatMap(serverPods);
    for (const s of servers.filter((x) => x.podFailsAfterBoot)) {
      // The other replica, Ready since long before: it is not a replacement.
      items.push(
        pod('vibecarbon', 'web-7f9c-other', 'worker-2', 'Running', 'True', OLD_READY, RS_WEB),
      );
      if (clock.now() >= replacedAt(s)) {
        const node = s.podFailsAfterBoot?.afterUncordon ? s.name : 'worker-2';
        items.push(
          pod('vibecarbon', 'web-7f9c-fresh', node, 'Running', 'True', iso(replacedAt(s)), RS_WEB),
        );
      }
    }
    return items;
  };

  const sshKubectl = vi.fn(
    async (ip: string, _key: string, argv: string[], o: Record<string, unknown> = {}) => {
      record('kubectl', ip, argv, o);
      const master = byIp(ip);
      if (isDown(master)) throw sshRefused(ip);
      const [verb, ...rest] = argv;
      const cmd = argv.join(' ');
      const named = servers.find(
        (s) => argv.includes(s.name) || argv.includes(`spec.nodeName=${s.name}`),
      );
      if (named?.failKubectl && cmd.startsWith(named.failKubectl)) {
        throw Object.assign(new Error('Command failed: ssh ...'), {
          status: 1,
          stdout: '',
          stderr: `error: ${verb} failed for ${named.name}\n`,
        });
      }
      if (['cordon', 'uncordon', 'drain', 'annotate'].includes(verb)) {
        const node = byName(verb === 'annotate' ? rest[1] : rest[0]);
        if (verb === 'cordon') node.cordoned = true;
        if (verb === 'uncordon') {
          node.cordoned = false;
          node.uncordonedAt = clock.now();
        }
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
      if (verb === 'get' && rest[0] === 'pods' && rest.includes('--field-selector')) {
        const name = String(rest[rest.indexOf('--field-selector') + 1]).replace(
          'spec.nodeName=',
          '',
        );
        return JSON.stringify({ items: allPods().filter((p) => p.spec.nodeName === name) });
      }
      if (verb === 'get' && rest[0] === 'pods' && rest[1] === '-n') {
        return JSON.stringify({
          items: allPods().filter((p) => p.metadata.namespace === rest[2]),
        });
      }
      throw new Error(`unexpected kubectl: ${cmd}`);
    },
  );

  const verifyAppHealth = vi.fn(
    async (ip: string, _key: string, _project: string, o: Record<string, unknown>) => {
      record('health', ip, [], o);
      const s = byIp(ip);
      const ready = disruptedAt(s) === null ? clock.now() : healthyAt(s);
      const budget = Number(o.budgetMs);
      if (s.staysDown || s.neverBack || ready - clock.now() > budget) {
        await clock.sleep(budget);
        return { healthy: false, status: 'fail', details: 'Health probe failed' };
      }
      if (ready > clock.now()) await clock.sleep(ready - clock.now());
      return { healthy: true, status: '200', details: '' };
    },
  );

  // The public health answers 503 while any primary server is between its
  // reboot (or Docker update) and the moment its app is healthy again.
  const fetchPublicDomain = vi.fn(async (url: string, init: { signal?: AbortSignal } = {}) => {
    record('probe', url, [], init as Record<string, unknown>);
    if (opts.publicUnreachable) throw new TypeError('fetch failed');
    if (opts.publicAnswer) return { status: opts.publicAnswer, ok: false };
    const t = clock.now();
    const down = servers.some((s) => {
      const from = disruptedAt(s);
      return (
        !s.name.startsWith('standby') &&
        from !== null &&
        t >= from &&
        (s.ingressNeverBack || t < healthyAt(s))
      );
    });
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
  return {
    clock,
    calls,
    servers,
    byName,
    backAt,
    apiFreshAt,
    podsFreshAt,
    healthyAt,
    replacedAt,
    statefulReadyAt,
    deps,
  };
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
// --collect and RemainAfterElapse=no unload the transient units even when the
// reboot never happened, so a rerun is not refused with "already loaded".
// RemainAfterElapse is a [Timer] setting (systemd.timer(5)), so it goes to
// the timer unit: `-p` would set it on the service, which refuses it.
const REBOOT = [
  'systemd-run',
  '--on-active=2',
  '--collect',
  '--timer-property=RemainAfterElapse=no',
  '--unit=vibecarbon-update-reboot',
  'systemctl',
  'reboot',
];
const UPGRADE = [
  'env',
  'DEBIAN_FRONTEND=noninteractive',
  'sh',
  '-c',
  `${aptWaitForDailyUnits()}; unattended-upgrade --verbose`,
];
const CORDONED_HINT =
  'it is still cordoned, run vibecarbon update prod again once it is Ready, which uncordons it';
const CONSOLE_HINT = 'check it in your provider console, then run vibecarbon status prod';

// Any other exit is the remote side's: systemd-run refused, nothing was
// scheduled, and ten minutes of polling would only wait out the old boot id.
const refused = () =>
  Object.assign(new Error('Command failed: ssh ...'), {
    status: 1,
    stdout: '',
    stderr:
      'Failed to start transient timer unit: Unit vibecarbon-update-reboot.timer already exists.\n',
  });
const REFUSED_ERROR = (name: string) =>
  `could not restart ${name}: it exited 1\n  Failed to start transient timer unit: Unit vibecarbon-update-reboot.timer already exists.`;

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
    if (cmd.startsWith('get pods -n')) return 'namespace-pods';
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
/** Labels in order, probes left out, runs of the same label collapsed into one. */
const sequence = (calls: Call[]) =>
  calls
    .map(label)
    .filter((l) => l !== 'probe')
    .filter((l, i, all) => l !== all[i - 1]);
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
    // The wait for the daily apt units rides the same ssh call, before the install.
    const upgrade = own[first(own, 'upgrade')];
    expect(upgrade.argv).toEqual(UPGRADE);
    expect(upgrade.opts).toMatchObject({ timeout: 1_200_000, input: '' });
    const check = own[first(own, 'check')];
    expect(check.opts.input).toBe(hostReporterScript());
    // The clock and the boot id come from one ssh call, just before the reboot.
    const before = own[first(own, 'boot')];
    expect(before.argv.join(' ')).toContain('date -u +%s');
    expect(before.argv.join(' ')).toContain('/proc/sys/kernel/random/boot_id');
    const reboot = own[first(own, 'reboot')];
    expect(reboot.argv).toEqual(REBOOT);
    expect(reboot.opts).toMatchObject({ transportRetry: false, timeout: 30_000, input: '' });

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
    // One noninteractive environment for both apt commands: first the wait for
    // the daily apt units, then the refresh from Docker's source alone, then
    // only Docker's packages, only upgraded.
    expect(call.argv).toEqual([
      'env',
      'DEBIAN_FRONTEND=noninteractive',
      'sh',
      '-c',
      `${aptWaitForDailyUnits()}; ${aptQuietUpdate(DOCKER_SOURCE_ONLY)} && apt-get ${APT_LOCK_OPT} ${APT_NO_SRV_OPT} install -y --only-upgrade -o Dpkg::Options::=--force-confold ${DOCKER_PACKAGES.join(' ')}`,
    ]);
    expect(DOCKER_PACKAGES).toEqual([
      'docker-ce',
      'docker-ce-cli',
      'containerd.io',
      'docker-buildx-plugin',
      'docker-compose-plugin',
    ]);
    // 900 s: the daily units' own 300 s, apt's 300 s lock wait, 300 s to work.
    expect(call.opts).toMatchObject({ timeout: 900_000, input: '' });
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
    // The step waited for the domain to answer again after Docker restarted it.
    const s = w.byName('web-1');
    const probes = w.calls.filter((c) => c.via === 'probe');
    expect(probes.some((c) => c.t >= w.healthyAt(s))).toBe(true);
    expect(res.outcomes[0].outageSeconds).toBeGreaterThan(0);
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
      hint: CONSOLE_HINT,
    });
  });

  // Docker just restarted every container: the app wait runs even when the
  // restart check that follows fails.
  it('still waits for the app after a Docker update when the restart check fails', async () => {
    const checkError = Object.assign(new Error('Command failed: ssh ...'), {
      status: 255,
      stdout: '',
      stderr: 'ssh: connect to host 10.0.0.1 port 22: Connection timed out\n',
    });
    const w = world([{ name: 'web-1', ip: '10.0.0.1', checkError }]);
    const docker = { packages: [{ name: 'docker-ce', from: '1', to: '2' }] };
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(compose('web-1', '10.0.0.1'), { install: 0, restart: 'none', docker })),
        makeCtx(),
        w.deps,
      ),
    );
    expect(w.deps.verifyAppHealth).toHaveBeenCalledTimes(1);
    expect(sequence(w.calls.filter((c) => c.ip === '10.0.0.1'))).toEqual([
      'reporter',
      'docker',
      'check',
      'health',
    ]);
    expect(res.stoppedAt).toMatchObject({
      docker: docker.packages,
      error:
        'could not check whether web-1 needs a restart: it exited 255\n  ssh: connect to host 10.0.0.1 port 22: Connection timed out',
      hint: 'run vibecarbon update prod again',
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

  // When ssh itself failed (OpenSSH's own 255) or timed out, the reboot may
  // have been scheduled before the session died: the boot id poll proves which.
  for (const [how, error, why] of [
    [
      'ssh itself failed',
      Object.assign(new Error('Command failed: ssh ...'), {
        status: 255,
        stdout: '',
        stderr: 'Connection to 10.0.0.1 closed by remote host.\n',
      }),
      'Connection to 10.0.0.1 closed by remote host.',
    ],
    [
      'ssh timed out',
      Object.assign(new Error('Command failed: ssh ...'), {
        status: null,
        timedOut: true,
        stdout: '',
        stderr: '',
      }),
      'ssh timeout',
    ],
  ] as const) {
    it(`goes on to the boot id poll when the reboot call fails because ${how}`, async () => {
      const w = world([
        {
          name: 'web-1',
          ip: '10.0.0.1',
          rebootRequired: true,
          pkgs: [PKG],
          rebootCall: { error, scheduled: true },
        },
      ]);
      const ctx = makeCtx();
      const res = await w.clock.run(
        executeUpdatePlan(planOf(step(compose('web-1', '10.0.0.1'))), ctx, w.deps),
      );
      expect(ctx.log.warn).toHaveBeenCalledWith(
        `web-1: the restart command failed (${why}), checking whether it restarts anyway`,
      );
      expect(res.stoppedAt).toBeNull();
      expect(res.outcomes[0]).toMatchObject({ restarted: true, error: null });
      expect(w.deps.verifyAppHealth).toHaveBeenCalledTimes(1);
    });
  }

  it('stops at once when the reboot command itself exits non-zero, and never polls', async () => {
    const w = world([
      {
        name: 'web-1',
        ip: '10.0.0.1',
        rebootRequired: true,
        pkgs: [PKG],
        rebootCall: { error: refused(), scheduled: false },
      },
    ]);
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(compose('web-1', '10.0.0.1'))), makeCtx(), w.deps),
    );
    expect(res.stoppedAt).toMatchObject({
      restarted: false,
      error: REFUSED_ERROR('web-1'),
      hint: 'run vibecarbon update prod again',
    });
    expect(w.calls.slice(first(w.calls, 'reboot')).filter((c) => label(c) === 'boot')).toEqual([]);
    expect(w.deps.verifyAppHealth).not.toHaveBeenCalled();
  });

  // verifyAppHealth asks the container directly: a proxy that did not come
  // back would read as healthy without the public check.
  it('stops when the container is healthy but the domain never answers again', async () => {
    const w = world([
      { name: 'web-1', ip: '10.0.0.1', rebootRequired: true, pkgs: [PKG], ingressNeverBack: true },
    ]);
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(compose('web-1', '10.0.0.1'))), makeCtx(), w.deps),
    );
    expect(res.stoppedAt).toMatchObject({
      restarted: true,
      error: 'web-1 did not become healthy within 5 minutes: app.example.test answered 503',
      hint: CONSOLE_HINT,
    });
    // One 300 s budget for the container and the domain together.
    const reboot = w.calls[first(w.calls, 'reboot')];
    const probes = w.calls.filter((c) => c.via === 'probe' && c.t > reboot.t);
    const health = w.calls[first(w.calls, 'health')];
    expect((probes.at(-1)?.t ?? 0) - health.t).toBeLessThanOrEqual(300_000);
  });

  it('stops when the domain never answers again after a Docker-only update', async () => {
    const w = world([{ name: 'web-1', ip: '10.0.0.1', ingressNeverBack: true }]);
    const docker = { packages: [{ name: 'docker-ce', from: '1', to: '2' }] };
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(compose('web-1', '10.0.0.1'), { install: 0, restart: 'none', docker })),
        makeCtx(),
        w.deps,
      ),
    );
    expect(res.stoppedAt).toMatchObject({
      error: 'web-1 did not become healthy within 5 minutes: app.example.test answered 503',
      hint: CONSOLE_HINT,
    });
  });
});

describe('executeUpdatePlan on k8s', () => {
  const worker = { name: 'worker-1', ip: '10.1.0.2', rebootRequired: true, pkgs: [PKG] };
  const drained = { effect: { kind: 'drained', seconds: null } };
  const runWorker = (w: ReturnType<typeof world>, ctx = makeCtx()) =>
    w.clock.run(
      executeUpdatePlan(planOf(step(k8s('worker-1', 'worker', '10.1.0.2'), drained)), ctx, w.deps),
    );

  it('marks, cordons and drains a worker before its reboot, and releases it once its pods are Ready', async () => {
    const w = world([worker]);
    const res = await runWorker(w);
    const kube = w.calls.filter((c) => c.via === 'kubectl');
    for (const c of kube) expect(c.ip).toBe(MASTER_IP);
    // The node's pods are read once more after the drain, before the reboot:
    // their controllers are what must come back.
    expect(sequence(kube)).toEqual([
      'node',
      'mark',
      'cordon',
      'drain',
      'pods',
      'node',
      'lease',
      'pods',
      'uncordon',
      'unmark',
    ]);
    const owners = w.calls[first(w.calls, 'pods')];
    expect(w.calls.indexOf(owners)).toBeGreaterThan(first(w.calls, 'drain'));
    expect(w.calls.indexOf(owners)).toBeLessThan(first(w.calls, 'reboot'));
    expect(owners.argv).toEqual([
      'get',
      'pods',
      '-A',
      '--field-selector',
      'spec.nodeName=worker-1',
      '-o',
      'json',
    ]);
    expect(kube[first(kube, 'node')].argv).toEqual(['get', 'node', 'worker-1', '-o', 'json']);
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

  it('marks and cordons the master and the db node but never drains them, and waits for the API on the master', async () => {
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
    // Neither is drained, so their pods restart in place: the uncordon comes
    // before the pod wait, or a replacement pinned to the node could not start.
    const dbStart = kube.findIndex((c) => c.argv.join(' ') === 'get node db -o json');
    expect(sequence(kube.slice(0, dbStart))).toEqual([
      'node',
      'mark',
      'cordon',
      'pods',
      'readyz',
      'node',
      'lease',
      'uncordon',
      'unmark',
      'pods',
    ]);
    expect(sequence(kube.slice(dbStart))).toEqual([
      'node',
      'mark',
      'cordon',
      'pods',
      'node',
      'lease',
      'uncordon',
      'unmark',
      'pods',
    ]);
  });

  for (const [role, ip] of [
    ['master', MASTER_IP],
    ['db', '10.1.0.3'],
  ] as const) {
    // Traefik, repl-gateway and the db do not tolerate a cordon: a pod that
    // turned Failed at boot gets a replacement that can only start once the
    // node is uncordoned.
    it(`uncordons the ${role} before its pod wait, so a replacement pinned to it can start`, async () => {
      const w = world([
        {
          name: role,
          ip,
          rebootRequired: true,
          pkgs: [PKG],
          podFailsAfterBoot: { afterUncordon: true },
        },
      ]);
      const res = await w.clock.run(
        executeUpdatePlan(planOf(step(k8s(role, role, ip))), makeCtx(), w.deps),
      );
      expect(res.stoppedAt).toBeNull();
      const s = w.byName(role);
      const reboot = w.calls[first(w.calls, 'reboot')];
      const after = w.calls.filter((c) => c.via === 'kubectl' && c.t > reboot.t);
      expect(first(after, 'uncordon')).toBeGreaterThan(-1);
      expect(first(after, 'uncordon')).toBeLessThan(first(after, 'pods'));
      expect(after[first(after, 'uncordon')].t).toBeLessThan(w.replacedAt(s));
      expect(after.at(-1)?.t).toBeGreaterThanOrEqual(w.replacedAt(s));
      expect(s).toMatchObject({ cordoned: false, marked: false });
    });
  }

  // Traefik runs only on the master and the db serves every request: the next
  // server waits until users can reach the app again, as on compose.
  it('waits for the domain to answer after the master restarts, before the next server', async () => {
    const w = world([
      { name: 'master', ip: MASTER_IP, rebootRequired: true, pkgs: [PKG], appStartMs: 200_000 },
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
    const m = w.byName('master');
    // The pods were back long before the app answered.
    expect(w.podsFreshAt(m)).toBeLessThan(w.healthyAt(m) - 60_000);
    const dbFirst = w.calls.find((c) => c.ip === '10.1.0.3') as Call;
    expect(dbFirst.t).toBeGreaterThanOrEqual(w.healthyAt(m));
  });

  it('stops, already uncordoned, when the domain never answers after the db restarts', async () => {
    const w = world([
      { name: 'db', ip: '10.1.0.3', rebootRequired: true, pkgs: [PKG], ingressNeverBack: true },
    ]);
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(k8s('db', 'db', '10.1.0.3'))), makeCtx(), w.deps),
    );
    expect(res.stoppedAt).toMatchObject({
      restarted: true,
      error: 'db did not become healthy within 5 minutes: app.example.test answered 503',
      hint: CONSOLE_HINT,
    });
    expect(w.byName('db')).toMatchObject({ cordoned: false, marked: false });
    // 300 s from the moment its pods were back.
    const lastPods = w.calls[last(w.calls, 'pods')];
    const probes = w.calls.filter((c) => c.via === 'probe' && c.t > lastPods.t);
    expect((probes.at(-1)?.t ?? 0) - lastPods.t).toBeLessThanOrEqual(300_000);
    expect((probes.at(-1)?.t ?? 0) - lastPods.t).toBeGreaterThan(290_000);
  });

  it('a worker restart does not wait for the domain', async () => {
    const w = world([{ ...worker, ingressNeverBack: true }]);
    const res = await runWorker(w);
    expect(res.stoppedAt).toBeNull();
  });

  it('the master does not wait for the domain when downtime is not measured', async () => {
    const w = world([{ name: 'master', ip: MASTER_IP, rebootRequired: true, pkgs: [PKG] }], {
      publicUnreachable: true,
    });
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(k8s('master', 'master', MASTER_IP))), makeCtx(), w.deps),
    );
    expect(res.stoppedAt).toBeNull();
    expect(w.calls.filter((c) => c.via === 'probe')).toHaveLength(1);
  });

  // The backup CronJob's pod is killed by the reboot and fails: its Job
  // retries it or gives up, and neither is the node's health.
  it('never waits on a Job pod, even one that turned Failed after the reboot', async () => {
    const w = world([
      {
        name: 'master',
        ip: MASTER_IP,
        rebootRequired: true,
        pkgs: [PKG],
        jobPodFailsAfterBoot: true,
      },
    ]);
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(k8s('master', 'master', MASTER_IP))), makeCtx(), w.deps),
    );
    expect(res.stoppedAt).toBeNull();
    const s = w.byName('master');
    const last = w.calls.filter((c) => c.via === 'kubectl').at(-1) as Call;
    expect(last.t).toBeLessThan(w.podsFreshAt(s) + 10_000);
  });

  // A Failed StatefulSet pod is deleted and recreated under the same name, and
  // while it is unbound it is not on the node's list: the node's own pods can
  // all be Ready without the db.
  it('waits until the StatefulSet that ran on the node has a pod Ready since the restart', async () => {
    const w = world([
      {
        name: 'db',
        ip: '10.1.0.3',
        rebootRequired: true,
        pkgs: [PKG],
        statefulSet: { readyAfterMs: 90_000 },
      },
    ]);
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(k8s('db', 'db', '10.1.0.3'))), makeCtx(), w.deps),
    );
    expect(res.stoppedAt).toBeNull();
    const s = w.byName('db');
    const reboot = w.calls[first(w.calls, 'reboot')];
    const polls = w.calls.filter(
      (c) => c.via === 'kubectl' && c.t > reboot.t && /pods/.test(label(c)),
    );
    expect(polls.filter((c) => c.t < w.statefulReadyAt(s)).length).toBeGreaterThan(5);
    expect(polls.at(-1)?.t).toBeGreaterThanOrEqual(w.statefulReadyAt(s));
    expect(polls.find((c) => label(c) === 'namespace-pods')?.argv).toEqual([
      'get',
      'pods',
      '-n',
      'vibecarbon',
      '-o',
      'json',
    ]);
  });

  it('stops, already uncordoned, naming the StatefulSet when none of its pods comes back', async () => {
    const w = world([
      { name: 'db', ip: '10.1.0.3', rebootRequired: true, pkgs: [PKG], statefulSet: {} },
    ]);
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(k8s('db', 'db', '10.1.0.3'))), makeCtx(), w.deps),
    );
    expect(res.stoppedAt).toMatchObject({
      restarted: true,
      error:
        'db did not become healthy within 5 minutes: no pod Ready since the restart for StatefulSet vibecarbon/db',
      hint: CONSOLE_HINT,
    });
    expect(w.byName('db')).toMatchObject({ cordoned: false, marked: false });
  });

  it('stops before the reboot, still cordoned, when the node cannot be read for its pods', async () => {
    const w = world([{ ...worker, failKubectl: 'get pods' }]);
    const res = await runWorker(w);
    expect(res.stoppedAt).toMatchObject({
      restarted: false,
      error: 'could not restart worker-1: it exited 1\n  error: get failed for worker-1',
      hint: CORDONED_HINT,
    });
    expect(first(w.calls, 'reboot')).toBe(-1);
  });

  it('stops at once, still cordoned, when the reboot command itself exits non-zero', async () => {
    const w = world([{ ...worker, rebootCall: { error: refused(), scheduled: false } }]);
    const res = await runWorker(w);
    expect(res.stoppedAt).toMatchObject({ error: REFUSED_ERROR('worker-1'), hint: CORDONED_HINT });
    expect(w.calls.slice(first(w.calls, 'reboot')).filter((c) => label(c) === 'boot')).toEqual([]);
    expect(w.byName('worker-1')).toMatchObject({ cordoned: true, marked: true });
  });

  // An operator's own cordon is theirs: no mark, no uncordon after.
  it('leaves a node the operator already cordoned cordoned, without the mark', async () => {
    const w = world([{ ...worker, cordonedBefore: true }]);
    const ctx = makeCtx();
    const res = await runWorker(w, ctx);
    expect(res.stoppedAt).toBeNull();
    expect(sequence(w.calls.filter((c) => c.via === 'kubectl'))).toEqual([
      'node',
      'drain',
      'pods',
      'node',
      'lease',
      'pods',
    ]);
    expect(w.byName('worker-1')).toMatchObject({ cordoned: true, marked: false });
    expect(ctx.log.info).toHaveBeenCalledWith(
      'worker-1: already cordoned, it stays cordoned after the restart',
    );
  });

  it('does not promise an uncordon for an operator-cordoned node that never comes back', async () => {
    const w = world([{ ...worker, cordonedBefore: true, neverBack: true }]);
    const res = await runWorker(w);
    expect(res.stoppedAt?.error).toMatch(/did not come back within 10 minutes/);
    expect(res.stoppedAt?.hint).toBe(CONSOLE_HINT);
  });

  // The API keeps the node's last status until the new kubelet posts one: the
  // boot id from before the restart, Ready=True. That is not the node back.
  it('keeps waiting while the API still shows the node from before the restart', async () => {
    const w = world([{ ...worker, apiLagMs: 60_000 }]);
    await runWorker(w);
    const s = w.byName('worker-1');
    const reboot = w.calls[first(w.calls, 'reboot')];
    const nodeReads = w.calls.filter((c) => label(c) === 'node' && c.t > reboot.t);
    expect(nodeReads.filter((c) => c.t < w.apiFreshAt(s)).length).toBeGreaterThan(5);
    expect(w.calls[first(w.calls, 'lease')].t).toBeGreaterThanOrEqual(w.apiFreshAt(s));
    expect(w.calls[first(w.calls, 'uncordon')].t).toBeGreaterThanOrEqual(w.apiFreshAt(s));
  });

  it('stops, still cordoned, when the API never shows the node with its new boot id', async () => {
    const w = world([{ ...worker, apiNeverFresh: true }]);
    const res = await runWorker(w);
    expect(res.stoppedAt).toMatchObject({
      name: 'worker-1',
      restarted: true,
      error:
        'worker-1 did not become healthy within 5 minutes: the cluster still showed the node as it was before the restart',
      hint: CORDONED_HINT,
    });
    expect(first(w.calls, 'uncordon')).toBe(-1);
    expect(w.byName('worker-1')).toMatchObject({ cordoned: true, marked: true });
  });

  it('keeps waiting while the pods are Ready only from before the restart', async () => {
    const w = world([{ ...worker, podsLagMs: 90_000 }]);
    await runWorker(w);
    const s = w.byName('worker-1');
    const podReads = w.calls.filter((c) => label(c) === 'pods');
    expect(podReads.filter((c) => c.t < w.podsFreshAt(s)).length).toBeGreaterThan(5);
    expect(w.calls[first(w.calls, 'uncordon')].t).toBeGreaterThanOrEqual(w.podsFreshAt(s));
  });

  // The clock is read just before the reboot command, and the reboot fires 2 s
  // later: a pod that turned Ready in between is still from before the restart.
  it('does not count a pod that turned Ready in the 2 s before the reboot fired', async () => {
    const w = world([{ ...worker, podsLagMs: 90_000, podsReadyJustBefore: true }]);
    await runWorker(w);
    const s = w.byName('worker-1');
    const boot = w.calls.filter((c) => label(c) === 'boot');
    expect(boot[0].t).toBeLessThan((s.rebootAt as number) - 1000);
    expect(w.calls[first(w.calls, 'uncordon')].t).toBeGreaterThanOrEqual(w.podsFreshAt(s));
  });

  it('stops, still cordoned, when the kubelet never renews its lease', async () => {
    const w = world([{ ...worker, leaseNeverRenews: true }]);
    const res = await runWorker(w);
    expect(res.stoppedAt).toMatchObject({
      error:
        'worker-1 did not become healthy within 5 minutes: its kubelet did not renew its node lease',
      hint: CORDONED_HINT,
    });
    // The only pod read is the one before the reboot: the pod wait never ran.
    expect(last(w.calls, 'pods')).toBeLessThan(first(w.calls, 'reboot'));
    expect(first(w.calls, 'uncordon')).toBe(-1);
  });

  it('stops, still cordoned, naming the pods that never became Ready after the restart', async () => {
    const w = world([{ ...worker, podsNeverFresh: true }]);
    const res = await runWorker(w);
    // The Succeeded pod and the pod that failed long before are never waited on.
    expect(res.stoppedAt?.error).toBe(
      'worker-1 did not become healthy within 5 minutes: pods not Ready since the restart: kube-system/hcloud-csi-node-worker-1, vibecarbon/app-worker-1',
    );
    expect(res.stoppedAt?.hint).toContain('still cordoned');
    expect(first(w.calls, 'uncordon')).toBe(-1);
  });

  // A pod that failed after the reboot is a workload the restart broke: wait
  // for the pod its controller made in its place, not the other replica.
  it('waits for the replacement of a pod that turned Failed after the reboot', async () => {
    const w = world([{ ...worker, podFailsAfterBoot: { replacedAfterMs: 120_000 } }]);
    const res = await runWorker(w);
    const s = w.byName('worker-1');
    expect(res.stoppedAt).toBeNull();
    expect(w.calls[first(w.calls, 'uncordon')].t).toBeGreaterThanOrEqual(w.replacedAt(s));
    expect(w.calls[first(w.calls, 'namespace-pods')].argv).toEqual([
      'get',
      'pods',
      '-n',
      'vibecarbon',
      '-o',
      'json',
    ]);
  });

  it('stops, still cordoned, naming a pod that turned Failed and was never replaced', async () => {
    const w = world([{ ...worker, podFailsAfterBoot: {} }]);
    const res = await runWorker(w);
    expect(res.stoppedAt).toMatchObject({
      error:
        'worker-1 did not become healthy within 5 minutes: pods not Ready since the restart: vibecarbon/web-7f9c-abcde',
      hint: CORDONED_HINT,
    });
    expect(first(w.calls, 'uncordon')).toBe(-1);
  });

  it('stops before the reboot, still cordoned, when the drain fails', async () => {
    const w = world([{ ...worker, failKubectl: 'drain' }]);
    const res = await runWorker(w);
    expect(res.stoppedAt).toMatchObject({
      restarted: false,
      error: 'could not drain worker-1: it exited 1\n  error: drain failed for worker-1',
      hint: CORDONED_HINT,
    });
    expect(first(w.calls, 'reboot')).toBe(-1);
  });

  // The mark goes first: a mark without a cordon is released as a no-op, a
  // cordon without a mark would never be released.
  it('stops with nothing cordoned when the mark cannot be written', async () => {
    const w = world([
      { ...worker, failKubectl: 'annotate node worker-1 vibecarbon.dev/cordoned-by-update=true' },
    ]);
    const res = await runWorker(w);
    expect(res.stoppedAt?.error).toMatch(
      /^could not mark worker-1 as cordoned by vibecarbon update: it exited 1/,
    );
    expect(res.stoppedAt?.hint).toBe('run vibecarbon update prod again');
    expect(sequence(w.calls.filter((c) => c.via === 'kubectl'))).toEqual(['node', 'mark']);
    expect(w.byName('worker-1').cordoned).toBe(false);
  });

  it('stops with only the mark left when the cordon fails, which the next run releases', async () => {
    const w = world([{ ...worker, failKubectl: 'cordon' }]);
    const res = await runWorker(w);
    expect(res.stoppedAt).toMatchObject({
      error: 'could not cordon worker-1: it exited 1\n  error: cordon failed for worker-1',
      hint: 'run vibecarbon update prod again',
    });
    expect(w.byName('worker-1')).toMatchObject({ cordoned: false, marked: true });
    // The next run's release reads the node as it was left: marked, schedulable.
    const leftover = {
      metadata: { name: 'worker-1', annotations: { 'vibecarbon.dev/cordoned-by-update': 'true' } },
      spec: {},
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    };
    const kubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) =>
      argv[0] === 'get' ? JSON.stringify({ items: [leftover] }) : '',
    );
    await expect(
      releaseLeftoverCordons([{ name: 'worker-1', masterIp: MASTER_IP }], {
        sshKubectl: withSshContract(kubectl),
        sshKeyPath: KEY,
      }),
    ).resolves.toEqual({ released: ['worker-1'], failed: [] });
  });

  // Cordoned with the mark is a cordon an earlier run left, not the operator's.
  it('releases a node an earlier run left cordoned and marked once it is back', async () => {
    const w = world([{ ...worker, cordonedBefore: true, markedBefore: true }]);
    const res = await runWorker(w);
    expect(res.stoppedAt).toBeNull();
    expect(first(w.calls, 'uncordon')).toBeGreaterThan(-1);
    expect(w.byName('worker-1')).toMatchObject({ cordoned: false, marked: false });
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

  // The install can clear the flag (a package that superseded the one that set
  // it): a due step restarts only while /var/run/reboot-required is there.
  it('does not restart a due step whose restart flag is gone after the install', async () => {
    const w = world([{ name: 'web-1', ip: '10.0.0.1' }]);
    const ctx = makeCtx();
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(compose('web-1', '10.0.0.1'))), ctx, w.deps),
    );
    expect(sequence(w.calls.filter((c) => c.ip === '10.0.0.1'))).toEqual([
      'reporter',
      'upgrade',
      'check',
    ]);
    expect(ctx.log.info).toHaveBeenCalledWith('web-1 no longer needs a restart');
    expect(res.stoppedAt).toBeNull();
    expect(res.outcomes[0]).toMatchObject({ restarted: false, error: null });
  });

  it('k8s: a due node whose flag is gone is never cordoned', async () => {
    const w = world([{ name: 'worker-1', ip: '10.1.0.2' }]);
    const ctx = makeCtx();
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(k8s('worker-1', 'worker', '10.1.0.2'))), ctx, w.deps),
    );
    expect(w.calls.filter((c) => c.via === 'kubectl')).toEqual([]);
    expect(first(w.calls, 'reboot')).toBe(-1);
    expect(ctx.log.info).toHaveBeenCalledWith('worker-1 no longer needs a restart');
    expect(res.outcomes[0]).toMatchObject({ restarted: false, error: null });
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
      hint: CONSOLE_HINT,
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
    expect(res.stoppedAt?.hint).toBe(CORDONED_HINT);
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

describe('a run that throws', () => {
  it('never rejects: a cancelled prompt ends the run with the outcomes so far', async () => {
    const w = world([
      { name: 'web-1', ip: '10.0.0.1', rebootRequired: true, pkgs: [PKG] },
      { name: 'web-2', ip: '10.0.0.2', rebootRequired: true, pkgs: [PKG] },
    ]);
    const ctx = makeCtx({
      yes: false,
      confirm: vi.fn(async () => {
        throw new Error('cancelled');
      }),
    });
    const quiet = { restart: 'none', restartReason: null, effect: { kind: 'none', seconds: null } };
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(
          step(compose('web-1', '10.0.0.1'), { restart: 'due' }),
          step(compose('web-2', '10.0.0.2'), quiet),
          step(compose('web-3', '10.0.0.3'), quiet),
        ),
        ctx,
        w.deps,
      ),
    );
    expect(res.outcomes.map((o) => o.name)).toEqual(['web-1', 'web-2']);
    expect(res.outcomes[0]).toMatchObject({ restarted: true, error: null });
    expect(res.stoppedAt).toBe(res.outcomes[1]);
    expect(res.stoppedAt).toMatchObject({
      name: 'web-2',
      error: 'cancelled',
      hint: 'run vibecarbon update prod again',
    });
    expect(res.becameDue).toEqual([]);
    // The monitor stopped with the run: no probe after it, no timer left behind.
    const count = w.calls.filter((c) => c.via === 'probe').length;
    await w.clock.advance(60_000);
    expect(w.calls.filter((c) => c.via === 'probe')).toHaveLength(count);
    expect(w.clock.pending()).toBe(0);
  });

  it('names the node still cordoned when a log call throws after the cordon', async () => {
    const w = world([{ name: 'worker-1', ip: '10.1.0.2', rebootRequired: true, pkgs: [PKG] }]);
    const ctx = makeCtx();
    ctx.log.step = vi.fn((message: string) => {
      if (message.includes('cordoned')) throw new Error('stdout closed');
    });
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(k8s('worker-1', 'worker', '10.1.0.2'))), ctx, w.deps),
    );
    expect(res.stoppedAt).toMatchObject({ error: 'stdout closed', hint: CORDONED_HINT });
    expect(w.byName('worker-1')).toMatchObject({ cordoned: true, marked: true });
  });
});

describe('a run that throws before its first step', () => {
  it('never rejects: the first step stops with the thrown message and nothing runs', async () => {
    const w = world([{ name: 'web-1', ip: '10.0.0.1', rebootRequired: true, pkgs: [PKG] }], {
      publicUnreachable: true,
    });
    const ctx = makeCtx();
    ctx.log.warn = vi.fn(() => {
      throw new Error('stdout closed');
    });
    const res = await w.clock.run(
      executeUpdatePlan(
        planOf(step(compose('web-1', '10.0.0.1')), step(compose('web-2', '10.0.0.2'))),
        ctx,
        w.deps,
      ),
    );
    expect(res.outcomes).toEqual([
      {
        name: 'web-1',
        installed: 0,
        docker: null,
        restarted: false,
        outageSeconds: null,
        error: 'stdout closed',
        hint: 'run vibecarbon update prod again',
      },
    ]);
    expect(res.stoppedAt).toBe(res.outcomes[0]);
    expect(res.becameDue).toEqual([]);
    expect(w.calls.filter((c) => c.via !== 'probe')).toEqual([]);
    expect(w.clock.pending()).toBe(0);
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

  const planned = (...names: string[]) => names.map((name) => ({ name, masterIp: MASTER_IP }));

  // worker-2 turned not Ready since the plan: it stays cordoned, and the run
  // says so. worker-3 lost its mark since the plan: someone else owns it now.
  it('uncordons only the planned nodes still marked and Ready, and removes their mark', async () => {
    const kubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) =>
      argv[0] === 'get'
        ? JSON.stringify({
            items: [
              node('worker-1', 'True', true),
              node('worker-2', 'False', true),
              node('worker-3', 'True', false),
              // Marked since the plan was shown: not in the plan, so left alone.
              node('worker-4', 'True', true),
            ],
          })
        : '',
    );
    const result = await releaseLeftoverCordons(planned('worker-1', 'worker-2', 'worker-3'), {
      sshKubectl: withSshContract(kubectl),
      sshKeyPath: KEY,
    });
    expect(result).toEqual({
      released: ['worker-1'],
      failed: [{ name: 'worker-2', reason: 'it is not Ready' }],
    });
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

  it('reports a cluster it cannot read, and a node it cannot release', async () => {
    const down = vi.fn(async () => {
      throw Object.assign(new Error('Command failed: ssh ...'), {
        status: 255,
        stderr: 'ssh: connect to host 10.1.0.1 port 22: Connection refused\n',
      });
    });
    await expect(
      releaseLeftoverCordons(planned('worker-1'), {
        sshKubectl: withSshContract(down),
        sshKeyPath: KEY,
      }),
    ).resolves.toEqual({
      released: [],
      failed: [
        {
          name: 'worker-1',
          reason: 'kubectl said: ssh: connect to host 10.1.0.1 port 22: Connection refused',
        },
      ],
    });
    const refuses = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      if (argv[0] === 'get') return JSON.stringify({ items: [node('worker-1', 'True', true)] });
      throw Object.assign(new Error('Command failed: ssh ...'), { status: 1, stderr: 'nope\n' });
    });
    await expect(
      releaseLeftoverCordons(planned('worker-1'), {
        sshKubectl: withSshContract(refuses),
        sshKeyPath: KEY,
      }),
    ).resolves.toEqual({
      released: [],
      failed: [{ name: 'worker-1', reason: 'kubectl said: nope' }],
    });
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
    await expect(monitor.ready).resolves.toBe(true);
    await clock.advance(17_000);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(probe.mock.calls[0][0]).toBe('https://app.example.test/api/health/ready');
    expect(monitor.upSince(T0 + 15_000)).toBe(true);
    expect(monitor.upSince(T0 + 15_001)).toBe(false);
    const result = monitor.stop();
    expect(result).toEqual({
      windows: [{ start: T0 + 5000, end: T0 + 15_000 }],
      totalSeconds: 10,
    });
    await clock.advance(60_000);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(clock.pending()).toBe(0);
  });

  it('closes a window still open when it stops, and says what the last probe saw', async () => {
    const clock = fakeClock();
    const probe = vi.fn(async () =>
      probe.mock.calls.length === 1 ? { status: 200 } : { status: 502 },
    );
    const monitor = startOutageMonitor({ url: 'u', probe, now: clock.now, sleep: clock.sleep });
    await clock.advance(12_000);
    expect(monitor.last()).toEqual({ at: T0 + 10_000, up: false, status: 502, detail: null });
    expect(monitor.stop()).toEqual({
      windows: [{ start: T0 + 5000, end: T0 + 12_000 }],
      totalSeconds: 7,
    });
  });

  it('reports a first probe that fails as not ready', async () => {
    const clock = fakeClock();
    const probe = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    });
    const monitor = startOutageMonitor({ url: 'u', probe, now: clock.now, sleep: clock.sleep });
    await expect(monitor.ready).resolves.toBe(false);
    expect(monitor.last()).toEqual({ at: T0, up: false, status: null, detail: 'ENOTFOUND' });
    monitor.stop();
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
    // The step waits for the domain itself, so a probe closes the window
    // inside the step, before the run ends.
    const firstUp = probes.find((c) => c.t >= w.healthyAt(s)) as Call;
    expect(res.outcomes[0].outageSeconds).toBe(0);
    expect(res.outcomes[1].outageSeconds).toBe((firstUp.t - firstDown.t) / 1000);
    expect(res.outcomes[1].outageSeconds).toBeGreaterThan(40);
    // Stopped with the run: no probe after it, no timer left behind.
    const count = probes.length;
    await w.clock.advance(60_000);
    expect(w.calls.filter((c) => c.via === 'probe')).toHaveLength(count);
    expect(w.clock.pending()).toBe(0);
  });

  it('is not measured when this machine cannot reach the domain at the start', async () => {
    const w = world([{ name: 'web-1', ip: '10.0.0.1', rebootRequired: true, pkgs: [PKG] }], {
      publicUnreachable: true,
    });
    const ctx = makeCtx();
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(compose('web-1', '10.0.0.1'))), ctx, w.deps),
    );
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn).toHaveBeenCalledWith(
      'could not reach app.example.test from this machine, so downtime is not measured',
    );
    // One baseline probe, then nothing: no monitor and no wait on the domain.
    expect(w.calls.filter((c) => c.via === 'probe')).toHaveLength(1);
    expect(res.stoppedAt).toBeNull();
    expect(res.outcomes[0]).toMatchObject({ restarted: true, outageSeconds: null });
  });

  it('is not measured when the domain answers non-2xx at the start, and says what it answered', async () => {
    const w = world([{ name: 'web-1', ip: '10.0.0.1', rebootRequired: true, pkgs: [PKG] }], {
      publicAnswer: 503,
    });
    const ctx = makeCtx();
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(compose('web-1', '10.0.0.1'))), ctx, w.deps),
    );
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn).toHaveBeenCalledWith(
      'app.example.test answered 503 before the update, so downtime is not measured',
    );
    expect(w.calls.filter((c) => c.via === 'probe')).toHaveLength(1);
    expect(res.stoppedAt).toBeNull();
    expect(res.outcomes[0]).toMatchObject({ restarted: true, outageSeconds: null });
  });

  it('is not measured without a domain', async () => {
    const w = world([{ name: 'web-1', ip: '10.0.0.1', rebootRequired: true, pkgs: [PKG] }]);
    const ctx = makeCtx({ domain: null });
    const res = await w.clock.run(
      executeUpdatePlan(planOf(step(compose('web-1', '10.0.0.1'))), ctx, w.deps),
    );
    expect(w.deps.fetchPublicDomain).not.toHaveBeenCalled();
    expect(ctx.log.warn).not.toHaveBeenCalled();
    expect(res.outcomes[0].outageSeconds).toBeNull();
  });
});
