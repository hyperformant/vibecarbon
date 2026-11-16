import { describe, expect, it } from 'vitest';
import { buildUpdatePlan, DOWNTIME, isNothingToDo } from '../../../src/lib/update/plan.js';

const host = (over = {}) => ({
  host: 'h',
  rebootRequired: false,
  since: null,
  packages: [] as string[],
  ...over,
});
const state = (over: Record<string, unknown> = {}) => ({
  host: host() as ReturnType<typeof host> | null,
  bootId: 'b',
  ubuntu: [] as string[],
  docker: null as null | { packages: { name: string; from: string; to: string }[] },
  ...over,
});
const t = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  ip: '1.2.3.4',
  side: 'primary',
  role: 'server',
  kind: 'compose',
  ...over,
});
const plan = (inspected: unknown[], skipped: unknown[] = []) =>
  buildUpdatePlan({ envName: 'prod', tier: 'launch', inspected, skipped } as never);

describe('buildUpdatePlan', () => {
  it('puts the standby step before the primary', () => {
    const p = plan([
      { target: t('web'), state: state() },
      { target: t('web-standby', { side: 'standby' }), state: state() },
    ]);
    expect(p.steps.map((s) => s.target.name)).toEqual(['web-standby', 'web']);
    expect(p.envName).toBe('prod');
    expect(p.tier).toBe('launch');
  });

  it('orders k8s nodes worker-1, worker-2, master, db', () => {
    const k = (name: string, role: string) => ({
      target: t(name, { kind: 'k8s', role }),
      state: state(),
    });
    const p = plan([
      k('db', 'db'),
      k('master', 'master'),
      k('worker-2', 'worker'),
      k('worker-1', 'worker'),
    ]);
    expect(p.steps.map((s) => s.target.name)).toEqual(['worker-1', 'worker-2', 'master', 'db']);
  });

  it('decides due, likely and none', () => {
    const p = plan([
      {
        target: t('a'),
        state: state({
          host: host({ rebootRequired: true, packages: ['libc6', 'linux-image-6.8'] }),
        }),
      },
      { target: t('b'), state: state({ ubuntu: ['curl', 'libc6'] }) },
      { target: t('c'), state: state({ ubuntu: ['curl'] }) },
      { target: t('d'), state: state({ host: null, ubuntu: ['dbus'] }) },
    ]);
    const by = Object.fromEntries(p.steps.map((s) => [s.target.name, s]));
    expect([by.a.restart, by.a.restartReason]).toEqual(['due', 'linux-image-6.8']);
    expect([by.b.restart, by.b.restartReason]).toEqual(['likely', 'libc6']);
    expect([by.c.restart, by.c.restartReason]).toEqual(['none', null]);
    expect([by.d.restart, by.d.restartReason]).toEqual(['likely', 'dbus']);
    expect(by.b.install).toBe(2);
  });

  it('names system updates when a due restart lists no package', () => {
    const p = plan([{ target: t('a'), state: state({ host: host({ rebootRequired: true }) }) }]);
    expect(p.steps[0].restartReason).toBe('system updates');
  });

  it('picks the likely reason in sorted order, not inspector order', () => {
    const p = plan([{ target: t('a'), state: state({ ubuntu: ['systemd', 'libc6', 'dbus'] }) }]);
    expect(p.steps[0].restartReason).toBe('dbus');
  });

  it('plans compose primary docker, restart, and both as one outage', () => {
    const docker = { packages: [{ name: 'docker-ce', from: '1', to: '2' }] };
    const p = plan([
      { target: t('a'), state: state({ docker }) },
      {
        target: t('b'),
        state: state({ host: host({ rebootRequired: true, packages: ['libc6'] }) }),
      },
      {
        target: t('c'),
        state: state({ docker, host: host({ rebootRequired: true, packages: ['libc6'] }) }),
      },
    ]);
    expect(p.steps.map((s) => s.effect)).toEqual([
      { kind: 'app-offline', seconds: [30, 60] },
      { kind: 'app-offline', seconds: [60, 180] },
      { kind: 'app-offline', seconds: [60, 240] },
    ]);
    expect(DOWNTIME.dockerThenRestart).toEqual([60, 240]);
  });

  it('drains a restarting worker with no seconds, and no-traffic on standby', () => {
    const due = state({ host: host({ rebootRequired: true, packages: ['libc6'] }) });
    const p = plan([
      { target: t('worker-1', { kind: 'k8s', role: 'worker' }), state: due },
      { target: t('s', { side: 'standby' }), state: due },
    ]);
    const by = Object.fromEntries(p.steps.map((s) => [s.target.name, s.effect]));
    expect(by['worker-1']).toEqual({ kind: 'drained', seconds: null });
    expect(by.s).toEqual({ kind: 'no-traffic', seconds: null });
  });

  it('sums master and db restarts and names them', () => {
    const due = state({ host: host({ rebootRequired: true, packages: ['libc6'] }) });
    const p = plan([
      { target: t('master', { kind: 'k8s', role: 'master' }), state: due },
      { target: t('db', { kind: 'k8s', role: 'db' }), state: due },
      { target: t('worker-1', { kind: 'k8s', role: 'worker' }), state: due },
    ]);
    expect(p.steps.find((s) => s.target.name === 'db')?.effect.kind).toBe('db-offline');
    expect(p.total).toEqual([120, 360]);
    expect(p.outageServers).toEqual(['master', 'db']);
  });

  it('has no total and no effect for ubuntu packages only', () => {
    const p = plan([{ target: t('a'), state: state({ ubuntu: ['curl'] }) }]);
    expect(p.steps[0].effect).toEqual({ kind: 'none', seconds: null });
    expect(p.total).toBeNull();
    expect(p.outageServers).toEqual([]);
  });

  it('plans the reporter where it is missing: compose from the server, k8s from the node', () => {
    const p = plan([
      { target: t('a'), state: state({ reporter: false }) },
      { target: t('b'), state: state({ reporter: true }) },
      { target: t('w1', { kind: 'k8s', role: 'worker', reporting: false }), state: state() },
      { target: t('w2', { kind: 'k8s', role: 'worker', reporting: true }), state: state() },
    ]);
    const by = Object.fromEntries(p.steps.map((s) => [s.target.name, s]));
    expect(by.a.installReporter).toBe(true);
    expect(by.b.installReporter).toBe(false);
    expect(by.w1.installReporter).toBe(true);
    expect(by.w2.installReporter).toBe(false);
    // Installing the reporter restarts nothing.
    expect(by.a.effect).toEqual({ kind: 'none', seconds: null });
    expect(p.total).toBeNull();
  });

  it('a missing reporter alone is something to do', () => {
    expect(isNothingToDo(plan([{ target: t('a'), state: state({ reporter: false }) }]))).toBe(
      false,
    );
    expect(
      isNothingToDo(
        plan([
          { target: t('w', { kind: 'k8s', role: 'worker', reporting: false }), state: state() },
        ]),
      ),
    ).toBe(false);
    expect(isNothingToDo(plan([{ target: t('a'), state: state({ reporter: true }) }]))).toBe(true);
  });

  it('a leftover cordon alone is something to do, and passes through', () => {
    const uncordon = [{ name: 'w1', masterIp: '1.1.1.1' }];
    const p = buildUpdatePlan({
      envName: 'prod',
      tier: 'k8s',
      inspected: [{ target: t('a'), state: state() }],
      skipped: [],
      uncordon,
    } as never);
    expect(p.uncordon).toEqual(uncordon);
    expect(isNothingToDo(p)).toBe(false);
    expect(plan([{ target: t('a'), state: state() }]).uncordon).toEqual([]);
  });

  it('knows nothing to do, and passes skipped through', () => {
    const skipped = [{ name: 'x', ip: null, reason: 'no public address' }];
    const p = plan([{ target: t('a'), state: state() }], skipped);
    expect(isNothingToDo(p)).toBe(true);
    expect(p.skipped).toEqual(skipped);
    expect(isNothingToDo(plan([{ target: t('a'), state: state({ ubuntu: ['curl'] }) }]))).toBe(
      false,
    );
    const docker = { packages: [{ name: 'docker-ce', from: '1', to: '2' }] };
    expect(isNothingToDo(plan([{ target: t('a'), state: state({ docker }) }]))).toBe(false);
    expect(
      isNothingToDo(
        plan([
          {
            target: t('a'),
            state: state({ host: host({ rebootRequired: true, packages: ['x'] }) }),
          },
        ]),
      ),
    ).toBe(false);
  });
});
