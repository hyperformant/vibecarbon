import { describe, expect, it, vi } from 'vitest';
import { checkAddonsReady, expectedBackgroundAddons } from '../../e2e/checks/addons-ready.js';

/**
 * The deploy no longer waits for the add-ons; the harness still requires each
 * one healthy, within one bounded wait, and quotes its log when it is not.
 */
const base = {
  mode: 'compose' as const,
  projectName: 'demo',
  features: ['observability', 'n8n', 'redis'],
  ip: '1.1.1.1',
  sshKeyPath: '/k',
  sleep: async () => {},
};

function remote(statuses: string[], log = 'n8n | Error: Mismatching encryption keys') {
  let i = 0;
  return vi.fn(async (_ip: string, cmd: string) => {
    if (cmd.startsWith('tail')) return { ok: true, output: log };
    const out = statuses[Math.min(i, statuses.length - 1)];
    i++;
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

  it('skips with no background add-on or on k8s; fails without an SSH handle', async () => {
    expect((await checkAddonsReady({ ...base, features: ['redis'] })).status).toBe('skip');
    expect((await checkAddonsReady({ ...base, mode: 'k8s' as const })).status).toBe('skip');
    expect((await checkAddonsReady({ ...base, sshKeyPath: null })).status).toBe('fail');
  });
});
