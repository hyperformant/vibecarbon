import { describe, expect, it, vi } from 'vitest';
import { assessStatusJson, checkStatusHealth } from '../../e2e/checks/status-health.js';

const row = (container: string, health: string, label = health, detail = '') => ({
  name: container,
  container,
  health,
  label,
  detail,
  latencyMs: 0,
});
const green = {
  environments: {
    prod: {
      config: {},
      checks: {
        remoteHealth: { ok: true, url: 'https://x/api/health/ready' },
        containers: {
          p: {
            kind: 'k8s',
            ip: '1.1.1.1',
            rows: [row('app', 'healthy'), row('job', 'done')],
            platform: { 'flux-system': { healthy: 4, total: 4 } },
            nodes: { ready: 3, total: 3 },
          },
        },
      },
    },
  },
};

describe('assessStatusJson', () => {
  it('passes a fully healthy environment', () => {
    expect(assessStatusJson(green, 'prod')).toEqual({ ok: true });
  });
  it('fails, non-retryable, on an unhealthy row and names it', () => {
    const j = structuredClone(green);
    j.environments.prod.checks.containers.p.rows.push(
      row('supabase-kong', 'unhealthy', 'CrashLoopBackOff', 'restarts 3'),
    );
    expect(assessStatusJson(j, 'prod')).toEqual({
      ok: false,
      retryable: false,
      problems: ['p: supabase-kong CrashLoopBackOff restarts 3'],
    });
  });
  it('is retryable on starting rows only', () => {
    const j = structuredClone(green);
    j.environments.prod.checks.containers.p.rows.push(
      row('app', 'starting', 'starting', 'ready 0/1'),
    );
    expect(assessStatusJson(j, 'prod')).toMatchObject({ ok: false, retryable: true });
  });
  it('fails on platform shortfall, node shortfall, ssh error, probe failure, missing env', () => {
    const j1 = structuredClone(green);
    j1.environments.prod.checks.containers.p.platform['flux-system'].healthy = 3;
    const j2 = structuredClone(green);
    j2.environments.prod.checks.containers.p.nodes.ready = 2;
    const j3 = structuredClone(green);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately shaping an error-only container entry
    (j3.environments.prod.checks.containers as any).p = {
      kind: 'k8s',
      ip: '',
      rows: [],
      error: 'ssh timeout',
    };
    const j4 = structuredClone(green);
    j4.environments.prod.checks.remoteHealth.ok = false;
    for (const j of [j1, j2, j3, j4]) expect(assessStatusJson(j, 'prod').ok).toBe(false);
    expect(assessStatusJson(green, 'nope')).toMatchObject({ ok: false, retryable: false });
    expect(assessStatusJson({ environments: { prod: { checks: {} } } }, 'prod')).toMatchObject({
      ok: false,
      retryable: false,
      problems: ['no containers data for prod'],
    });
  });
});

describe('checkStatusHealth', () => {
  it('polls while retryable, then passes', async () => {
    let n = 0;
    const runCli = vi.fn(async () => {
      n += 1;
      const j = structuredClone(green);
      if (n === 1) j.environments.prod.checks.containers.p.rows.push(row('app', 'starting'));
      return { exitCode: 0, stdout: JSON.stringify(j), stderr: '' };
    });
    const r = await checkStatusHealth({
      projectDir: '/tmp/x',
      envName: 'prod',
      timeoutMs: 1000,
      pollMs: 1,
      runCli: runCli as never,
    });
    expect(r.status).toBe('pass');
    expect(runCli).toHaveBeenCalledTimes(2);
    expect(runCli.mock.calls[0][0]).toBe('status -json');
  });
  it('fails immediately on a non-retryable problem', async () => {
    const j = structuredClone(green);
    j.environments.prod.checks.containers.p.rows.push(
      row('kong', 'unhealthy', 'exited', 'Exited (1)'),
    );
    const runCli = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify(j), stderr: '' }));
    const r = await checkStatusHealth({
      projectDir: '/tmp/x',
      envName: 'prod',
      timeoutMs: 1000,
      pollMs: 1,
      runCli: runCli as never,
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toContain('kong exited Exited (1)');
    expect(runCli).toHaveBeenCalledTimes(1);
  });
  it('fails when the CLI exits non-zero or emits invalid JSON', async () => {
    const bad = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }));
    expect(
      (
        await checkStatusHealth({
          projectDir: '/tmp/x',
          envName: 'prod',
          timeoutMs: 10,
          pollMs: 1,
          runCli: bad as never,
        })
      ).status,
    ).toBe('fail');
    const junk = vi.fn(async () => ({ exitCode: 0, stdout: 'not json', stderr: '' }));
    expect(
      (
        await checkStatusHealth({
          projectDir: '/tmp/x',
          envName: 'prod',
          timeoutMs: 10,
          pollMs: 1,
          runCli: junk as never,
        })
      ).status,
    ).toBe('fail');
  });
});
