import { describe, expect, it, vi } from 'vitest';
import { checkAddonsReady, expectedBackgroundAddons } from '../../e2e/checks/addons-ready.js';

/**
 * The deploy no longer waits for the add-ons; the harness still requires each
 * one healthy, within one bounded wait, and quotes its log when it is not.
 */
const ATTEMPT = 'a1b2c3d4e5f6';
const base = {
  mode: 'compose' as const,
  projectName: 'demo',
  features: ['observability', 'n8n', 'redis'],
  ip: '1.1.1.1',
  sshKeyPath: '/k',
  sleep: async () => {},
  attemptId: ATTEMPT,
};

/** Each status body gets the job's start stamp and a live marker, as on a node mid-job. */
function remote(
  statuses: string[],
  log = 'n8n | Error: Mismatching encryption keys',
  { attempt = ATTEMPT, live = true, ps = '' } = {},
) {
  let i = 0;
  return vi.fn(async (_ip: string, cmd: string) => {
    if (cmd.startsWith('tail')) return { ok: true, output: log };
    if (cmd.startsWith('docker ps')) return { ok: true, output: ps };
    const body = statuses[Math.min(i, statuses.length - 1)];
    i++;
    const out = body ? `#attempt ${attempt}\n${body}${live ? '#live\n' : ''}` : '';
    return { ok: true, output: out };
  });
}

describe('addons_ready', () => {
  it('expects the background add-ons only (redis is core)', () => {
    expect(expectedBackgroundAddons(base.features)).toEqual(['observability', 'n8n']);
  });

  it('passes once every background add-on is running', async () => {
    const run = remote([
      'observability\tstarting\t\nn8n\tstarting\t\n',
      'observability\trunning\t\nn8n\tstarting\t\n',
      'observability\trunning\t\nn8n\trunning\t\n',
    ]);
    const r = await checkAddonsReady({ ...base, run });
    expect(r.status).toBe('pass');
    expect(run.mock.calls[0][1]).toContain('/opt/demo/.vc-addons/status');
  });

  it('fails at once on a failed add-on, quoting its reason and log', async () => {
    const run = remote(['observability\trunning\t\nn8n\tfailed\tsetup n8n-setup exited 1\n']);
    const r = await checkAddonsReady({ ...base, run });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(
      /add-on failed to start: n8n: failed \(setup n8n-setup exited 1\)/,
    );
    expect(r.errorMessage).toContain('Mismatching encryption keys');
  });

  it('fails after the bound when an add-on is still starting', async () => {
    let t = 0;
    const run = remote(['observability\trunning\t\nn8n\tstarting\t\n']);
    const r = await checkAddonsReady({
      ...base,
      run,
      budgetMs: 30_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/add-ons not running after 30s: n8n: starting/);
  });

  // I-A1: after a failover the promoted node may have no status file (or a
  // stale one after a failback): the add-ons' own containers decide, so the
  // check neither waits 900 s on nothing nor passes on an old "running".
  it('no status file: passes on the add-on containers being healthy', async () => {
    const ps =
      'demo-grafana\trunning\tUp 1m (healthy)\ndemo-loki\trunning\tUp 1m\n' +
      'demo-prometheus\trunning\tUp 1m\ndemo-alloy\trunning\tUp 1m\n' +
      'demo-postgres-exporter\trunning\tUp 1m\ndemo-n8n\trunning\tUp 1m (healthy)\n';
    const r = await checkAddonsReady({ ...base, run: remote([''], '', { ps }) });
    expect(r.status).toBe('pass');
  });

  it('a stale "running" file does not pass: missing containers fail it', async () => {
    const run = remote(['observability\trunning\t\nn8n\trunning\t\n'], '', {
      attempt: 'f00f00f00f00',
      live: false,
      ps: 'demo-grafana\trunning\tUp 1m (healthy)\n',
    });
    const r = await checkAddonsReady({ ...base, run });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/observability: stopped \(no prometheus container\)/);
  });

  // DigitalOcean compose-ha, GitHub run 43680508383: the file did not name the
  // deploy's attempt, the job was still pulling, and the first read failed the
  // check as "stopped (no prometheus container)".
  it('waits while the job is alive and its containers do not exist yet', async () => {
    const all =
      'demo-grafana\trunning\tUp 1m (healthy)\ndemo-loki\trunning\tUp 1m\n' +
      'demo-prometheus\trunning\tUp 1m\ndemo-alloy\trunning\tUp 1m\n' +
      'demo-postgres-exporter\trunning\tUp 1m\ndemo-n8n\trunning\tUp 1m (healthy)\n';
    let polls = 0;
    const run = vi.fn(async (_ip: string, cmd: string) => {
      if (cmd.startsWith('docker ps')) return { ok: true, output: polls >= 2 ? all : '' };
      polls++;
      return { ok: true, output: '#attempt 0ldattempt000\n#live\n' };
    });
    const r = await checkAddonsReady({ ...base, run });
    expect(r.status).toBe('pass');
    expect(polls).toBe(2);
  });

  it('an unread status file is not a verdict: it keeps waiting', async () => {
    let polls = 0;
    const run = vi.fn(async (_ip: string, cmd: string) => {
      if (cmd.startsWith('docker ps')) return { ok: true, output: '' };
      if (cmd.startsWith('tail')) return { ok: true, output: '' };
      polls++;
      return polls < 3
        ? { ok: false, output: 'ssh: connect to host 1.1.1.1 port 22: Connection timed out' }
        : { ok: true, output: `#attempt ${ATTEMPT}\nobservability\trunning\t\nn8n\trunning\t\n` };
    });
    const r = await checkAddonsReady({ ...base, run });
    expect(r.status).toBe('pass');
    expect(polls).toBe(3);
  });

  it('a failure records what the status file said', async () => {
    const run = remote(['observability\trunning\t\nn8n\trunning\t\n'], '', {
      attempt: 'f00f00f00f00',
      live: false,
    });
    const r = await checkAddonsReady({ ...base, run });
    expect(r.status).toBe('fail');
    expect(r.details?.statusFile).toEqual({
      read: true,
      attempt: 'f00f00f00f00',
      expectedAttempt: ATTEMPT,
      live: false,
    });
  });

  it('M-A5: starting with no live job fails at once as stopped', async () => {
    const run = remote(['observability\trunning\t\nn8n\tstarting\t\n'], 'log', { live: false });
    const r = await checkAddonsReady({ ...base, run });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/n8n: stopped \(the add-on job stopped before n8n came up\)/);
  });

  it('skips with no background add-on or on k8s; fails without an SSH handle', async () => {
    expect((await checkAddonsReady({ ...base, features: ['redis'] })).status).toBe('skip');
    expect((await checkAddonsReady({ ...base, mode: 'k8s' as const })).status).toBe('skip');
    expect((await checkAddonsReady({ ...base, sshKeyPath: null })).status).toBe('fail');
  });
});
