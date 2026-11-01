import { describe, expect, it, vi } from 'vitest';
import { checkAddonsReady, expectedBackgroundAddons } from '../../e2e/checks/addons-ready.js';

/**
 * The deploy no longer waits for the add-ons; the harness still requires each
 * one healthy, within one bounded wait, and quotes its log when it is not.
 */
const STARTED = 1_800_000_000;
const base = {
  mode: 'compose' as const,
  projectName: 'demo',
  features: ['observability', 'n8n', 'redis'],
  ip: '1.1.1.1',
  sshKeyPath: '/k',
  sleep: async () => {},
  notBeforeMs: (STARTED - 60) * 1000,
};

/** Each status body gets the job's start stamp and a live marker, as on a node mid-job. */
function remote(
  statuses: string[],
  log = 'n8n | Error: Mismatching encryption keys',
  { stamp = STARTED, live = true, ps = '' } = {},
) {
  let i = 0;
  return vi.fn(async (_ip: string, cmd: string) => {
    if (cmd.startsWith('tail')) return { ok: true, output: log };
    if (cmd.startsWith('docker ps')) return { ok: true, output: ps };
    const body = statuses[Math.min(i, statuses.length - 1)];
    i++;
    const out = body ? `#started ${stamp}\n${body}${live ? '#live\n' : ''}` : '';
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
      'demo-prometheus\trunning\tUp 1m\ndemo-promtail\trunning\tUp 1m\n' +
      'demo-postgres-exporter\trunning\tUp 1m\ndemo-n8n\trunning\tUp 1m (healthy)\n';
    const r = await checkAddonsReady({ ...base, run: remote([''], '', { ps }) });
    expect(r.status).toBe('pass');
  });

  it('a stale "running" file does not pass: missing containers fail it', async () => {
    const run = remote(['observability\trunning\t\nn8n\trunning\t\n'], '', {
      stamp: STARTED - 3600,
      live: false,
      ps: 'demo-grafana\trunning\tUp 1m (healthy)\n',
    });
    const r = await checkAddonsReady({ ...base, run });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/observability: stopped \(no prometheus container\)/);
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
