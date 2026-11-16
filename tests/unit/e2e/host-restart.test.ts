/**
 * The e2e `update` step: mark a restart due on one server, see every surface
 * report it, run `vibecarbon update`, see it clear, and hold the measured
 * downtime to the plan. The checks run here against fakes: a CLI, a fetch, ssh
 * and a clock that only moves when the code sleeps.
 */
import { describe, expect, it } from 'vitest';
import { CookieJar } from '../../e2e/checks/app-functional.js';
import {
  downtimeWithinPlan,
  type HostRestartDeps,
  runHostRestartStep,
  selectRestartTarget,
} from '../../e2e/checks/host-restart.js';
import { NON_PERF_STEPS } from '../../e2e/metrics/reporter.js';
import { expandSkippedSteps } from '../../e2e/scenarios/step-dependencies.js';
import { STEP_NAMES } from '../../e2e/scenarios/types.js';
import { ITER_STEPS } from '../../e2e/utils/iter-step-args.js';

const ENV = 'prod-e2e1';
const DOMAIN = 'app.example.test';

const composeHaConfig = {
  servers: [
    { name: 'prod-e2e1-standby', ip: '10.0.0.2', role: 'standby' },
    { name: 'prod-e2e1-primary', ip: '10.0.0.1', role: 'primary' },
  ],
};
const k8sConfig = { servers: [{ name: 'master', ip: '10.1.0.1', role: 'master' }] };

const node = (name: string, ip: string) => ({
  metadata: { name },
  status: { addresses: [{ type: 'ExternalIP', address: ip }] },
});

const state = (host: string, due: boolean) => ({
  host,
  rebootRequired: due,
  since: due ? '2026-11-15T10:00:00Z' : null,
  packages: due ? ['linux-image-e2e-test'] : [],
});

const annotation = (host: string, due: boolean) =>
  JSON.stringify({ v: 1, ...state(host, due), packages: due ? ['linux-image-e2e-test'] : [] });

type World = {
  due: boolean;
  clock: number;
  downtime: number | null;
  expectedMax: number | null;
  updateExit: number;
  skipped: unknown[];
  planRestart: string;
};

function fakes(mode: 'compose-ha' | 'k8s', world: World, planName: string, hostName: string) {
  const isK8s = mode === 'k8s';
  const calls: string[] = [];
  const deps: HostRestartDeps = {
    now: () => world.clock,
    sleep: async (ms) => {
      world.clock += ms;
    },
    runCli: async (args) => {
      calls.push(args);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          environments: {
            [ENV]: {
              checks: {
                hostState: [
                  { name: 'other', reporting: true, state: state('other', false) },
                  { name: hostName, reporting: true, state: state(hostName, world.due) },
                ],
              },
            },
          },
        }),
        stderr: '',
      };
    },
    runUpdate: async () => {
      calls.push('update');
      world.due = false;
      return {
        exitCode: world.updateExit,
        stderr: '',
        stdout: JSON.stringify({
          env: ENV,
          plan: [{ name: planName, restart: world.planRestart }],
          skipped: world.skipped,
          expectedDowntime: world.expectedMax === null ? null : { min: 60, max: world.expectedMax },
          measuredDowntimeSeconds: world.downtime,
        }),
      };
    },
    signIn: async () => ({ ok: true, jar: new CookieJar() }),
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith('/api/health/ready')) return new Response('ok', { status: 200 });
      return new Response(
        JSON.stringify({
          rebootRequired: world.due,
          servers: [
            { name: 'other', reporting: true, rebootRequired: false },
            { name: hostName, reporting: true, rebootRequired: world.due },
          ],
        }),
        { status: 200 },
      );
    },
    sshRun: async (_ip, _key, argv) => {
      calls.push(`ssh ${argv.join(' ')}`);
      if (argv.join(' ').includes('/var/run/reboot-required')) world.due = true;
      return '';
    },
    sshKubectl: async () => {
      calls.push('kubectl');
      return isK8s
        ? JSON.stringify({
            metadata: {
              name: hostName,
              annotations: { 'vibecarbon.dev/host-state': annotation(hostName, world.due) },
            },
          })
        : '';
    },
  };
  return { deps, calls };
}

const world = (over: Partial<World> = {}): World => ({
  due: false,
  clock: 0,
  downtime: 120,
  expectedMax: 180,
  updateExit: 0,
  skipped: [],
  planRestart: 'due',
  ...over,
});

const run = (
  mode: 'compose-ha' | 'k8s',
  w: World,
  target = { name: 'prod-e2e1-primary', ip: '10.0.0.1', planName: 'prod-e2e1-primary' },
) => {
  const f = fakes(mode, w, target.planName, target.name);
  return {
    ...f,
    result: runHostRestartStep({
      env: ENV,
      mode,
      domain: DOMAIN,
      projectDir: '/tmp/none',
      key: '/tmp/key',
      target,
      adminEmail: 'a@example.test',
      adminPassword: 'x',
      timeouts: { updateMs: 1000 },
      deps: f.deps,
    }),
  };
};

describe('runHostRestartStep', () => {
  it('passes every check on a due-then-cleared sequence (compose-ha)', async () => {
    const { result } = run('compose-ha', world());
    const results = await result;
    expect(results.map((r) => r.checkName)).toEqual([
      'restart_due_status',
      'restart_due_admin',
      'update_ran',
      'restart_cleared',
      'downtime_within_plan',
    ]);
    expect(results.map((r) => `${r.checkName}:${r.status}`)).toEqual(
      results.map((r) => `${r.checkName}:pass`),
    );
  });

  it('adds the annotation checks on k8s', async () => {
    const target = { name: 'worker-1', ip: '10.1.0.9', planName: 'worker-1' };
    const results = await run('k8s', world(), target).result;
    expect(results.map((r) => r.checkName)).toContain('restart_due_annotation');
    expect(results.every((r) => r.status === 'pass')).toBe(true);
  });

  it('fails downtime_within_plan naming both numbers (400 against a max of 180)', async () => {
    const results = await run('compose-ha', world({ downtime: 400 })).result;
    const d = results.find((r) => r.checkName === 'downtime_within_plan');
    expect(d?.status).toBe('fail');
    expect(d?.errorMessage).toContain('400');
    expect(d?.errorMessage).toContain('180');
  });

  it('fails downtime_within_plan when downtime was not measured', async () => {
    const results = await run('compose-ha', world({ downtime: null })).result;
    const d = results.find((r) => r.checkName === 'downtime_within_plan');
    expect(d?.status).toBe('fail');
    expect(d?.errorMessage).toMatch(/not measured/);
  });

  it('fails update_ran on a skipped server, a non-zero exit, or a target not due', async () => {
    for (const w of [
      world({ skipped: [{ name: 'x', reason: 'no ssh' }] }),
      world({ updateExit: 1 }),
      world({ planRestart: 'likely' }),
    ]) {
      const results = await run('compose-ha', w).result;
      expect(results.find((r) => r.checkName === 'update_ran')?.status).toBe('fail');
    }
  });

  it('fails restart_due_status when the target never shows due within the window', async () => {
    const w = world();
    const f = fakes('compose-ha', w, 'prod-e2e1-primary', 'prod-e2e1-primary');
    f.deps.sshRun = async () => ''; // the marker never lands
    const results = await runHostRestartStep({
      env: ENV,
      mode: 'compose-ha',
      domain: DOMAIN,
      projectDir: '/tmp/none',
      key: '/tmp/key',
      target: { name: 'prod-e2e1-primary', ip: '10.0.0.1', planName: 'prod-e2e1-primary' },
      adminEmail: 'a@example.test',
      adminPassword: 'x',
      deps: f.deps,
    });
    const s = results.find((r) => r.checkName === 'restart_due_status');
    expect(s?.status).toBe('fail');
    expect(s?.errorMessage).toContain('prod-e2e1-primary');
    expect(w.clock).toBeGreaterThanOrEqual(90_000);
  });

  it('fails the admin checks when no admin session is available', async () => {
    const w = world();
    const f = fakes('compose-ha', w, 'prod-e2e1-primary', 'prod-e2e1-primary');
    f.deps.signIn = async () => ({ ok: false, error: 'admin sign-in returned 401' });
    const results = await runHostRestartStep({
      env: ENV,
      mode: 'compose-ha',
      domain: DOMAIN,
      projectDir: '/tmp/none',
      key: '/tmp/key',
      target: { name: 'prod-e2e1-primary', ip: '10.0.0.1', planName: 'prod-e2e1-primary' },
      adminEmail: 'a@example.test',
      adminPassword: 'x',
      deps: f.deps,
    });
    const a = results.find((r) => r.checkName === 'restart_due_admin');
    expect(a?.status).toBe('fail');
    expect(a?.errorMessage).toContain('401');
  });
});

describe('downtimeWithinPlan', () => {
  it('allows the plan max plus 30 s, and no more', () => {
    expect(downtimeWithinPlan(210, { min: 60, max: 180 }).status).toBe('pass');
    expect(downtimeWithinPlan(211, { min: 60, max: 180 }).status).toBe('fail');
    expect(downtimeWithinPlan(31, null).status).toBe('fail');
  });
});

describe('selectRestartTarget', () => {
  it('picks the primary on compose-ha, whatever the array order', async () => {
    const t = await selectRestartTarget({
      mode: 'compose-ha',
      env: ENV,
      envConfig: composeHaConfig,
      key: '/tmp/key',
    });
    expect(t).toEqual({
      name: 'prod-e2e1-primary',
      ip: '10.0.0.1',
      planName: 'prod-e2e1-primary',
    });
  });

  it('picks the first label-matched worker on k8s, by its ExternalIP', async () => {
    const seen: string[][] = [];
    const t = await selectRestartTarget({
      mode: 'k8s',
      env: ENV,
      envConfig: k8sConfig,
      key: '/tmp/key',
      sshKubectl: async (ip, _key, argv) => {
        seen.push([ip, ...argv]);
        return JSON.stringify({ items: [node('w-1', '10.1.0.7'), node('w-2', '10.1.0.8')] });
      },
    });
    expect(t).toEqual({ name: 'w-1', ip: '10.1.0.7', planName: 'w-1' });
    expect(seen[0].slice(0, 3)).toEqual(['10.1.0.1', 'get', 'nodes']);
    expect(seen[0]).toContain('-l');
    expect(seen[0]).toContain('!node-role.kubernetes.io/control-plane,dedicated!=db');
  });

  it('throws when the cluster has no worker with a public address', async () => {
    await expect(
      selectRestartTarget({
        mode: 'k8s',
        env: ENV,
        envConfig: k8sConfig,
        key: '/tmp/key',
        sshKubectl: async () => JSON.stringify({ items: [] }),
      }),
    ).rejects.toThrow(/worker/);
  });
});

describe('step registration', () => {
  it('update follows verify-status, is an iter step, is non-perf and needs deploy', () => {
    expect(STEP_NAMES[STEP_NAMES.indexOf('verify-status') + 1]).toBe('update');
    expect(ITER_STEPS).toContain('update');
    expect(NON_PERF_STEPS.has('update')).toBe(true);
    expect(expandSkippedSteps(new Set(['deploy'])).has('update')).toBe(true);
  });
});
