/**
 * HA integrity checks (HA-correctness Task 11): each one's pass and fail
 * parsing, driven through an injected remote runner so no SSH is involved.
 *
 * These are the assertions that would have caught the HA bugs the branch
 * fixed: a second failover that reseeded the retired node from itself, a DNS
 * flip nobody read back, an old primary left armed, a deploy that bounced the
 * serving primary, and a replication slot with no WAL cap.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDbIncarnationCommand,
  buildDisarmProbeCommand,
  checkAppEndpointsReady,
  checkDnsFlipVerified,
  checkOldPrimaryDisarmed,
  checkPrimaryNotRestarted,
  checkSecondFailoverRefused,
  checkSlotCapped,
  parseDbIncarnation,
  parseDisarmProbe,
  parseReadyEndpointCount,
  type RemoteRun,
  readDbIncarnation,
  readServingIp,
  SLOT_WAL_CAP,
} from '../../e2e/checks/ha-integrity.js';
import { expandSkippedSteps } from '../../e2e/scenarios/step-dependencies.js';

const KEY = '/tmp/key';
const IP = '203.0.113.10';

/** A runner that answers every command with `output`, and records what it ran. */
function runner(output: string, ok = true): RemoteRun & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (_ip: string, remote: string) => {
    calls.push(remote);
    return ok ? { ok: true, output } : { ok: false, output: '', error: '[psql] boom' };
  }) as RemoteRun & { calls: string[] };
  run.calls = calls;
  return run;
}

// ---------------------------------------------------------------------------
// old_primary_disarmed
// ---------------------------------------------------------------------------

const composeProbe = (marker: 0 | 1, role: string) =>
  `HOST_MARKER=${marker}\nWALG_ROLE=${role}\nPROBE_DONE`;

const k8sProbe = (role: string | null, walg: string | null) =>
  JSON.stringify({
    kind: 'List',
    items: [
      {
        kind: 'ConfigMap',
        metadata: { name: 'vibecarbon-config' },
        data: role ? { VIBECARBON_ROLE: role } : {},
      },
      {
        kind: 'StatefulSet',
        metadata: { name: 'db' },
        spec: {
          template: {
            spec: {
              containers: [{ name: 'db', env: walg ? [{ name: 'WALG_ROLE', value: walg }] : [] }],
            },
          },
        },
      },
    ],
  });

describe('parseDisarmProbe', () => {
  it('reads the compose host marker and the running db WALG_ROLE', () => {
    expect(parseDisarmProbe('compose-ha', composeProbe(1, 'standby'))).toEqual({
      walgRole: 'standby',
      retiredMarker: true,
    });
    expect(parseDisarmProbe('compose-ha', composeProbe(0, 'primary'))).toEqual({
      walgRole: 'primary',
      retiredMarker: false,
    });
  });

  it('a compose probe that never finished is unreadable, not "absent"', () => {
    expect(parseDisarmProbe('compose-ha', 'HOST_MARKER=1\n')).toBeNull();
  });

  it('reads the k8s ConfigMap role and the db StatefulSet env', () => {
    expect(parseDisarmProbe('k8s-ha', k8sProbe('retired', 'standby'))).toEqual({
      walgRole: 'standby',
      retiredMarker: true,
    });
    expect(parseDisarmProbe('k8s-ha', k8sProbe(null, 'primary'))).toEqual({
      walgRole: 'primary',
      retiredMarker: false,
    });
  });

  it('unparseable k8s output is unreadable', () => {
    expect(parseDisarmProbe('k8s-ha', 'Error from server')).toBeNull();
  });

  it('the probe commands read the running state, never .env', () => {
    expect(buildDisarmProbeCommand('compose-ha', 'demo')).toContain('docker inspect');
    expect(buildDisarmProbeCommand('compose-ha', 'demo')).toContain('.vibecarbon-retired');
    expect(buildDisarmProbeCommand('k8s-ha', 'demo')).toContain('configmap/vibecarbon-config');
  });
});

describe('checkOldPrimaryDisarmed', () => {
  const base = { mode: 'compose-ha' as const, projectName: 'demo', retiredIp: IP, sshKeyPath: KEY };

  it('passes when the retired side is WALG_ROLE=standby and carries the marker', async () => {
    const r = await checkOldPrimaryDisarmed({ ...base, run: runner(composeProbe(1, 'standby')) });
    expect(r.checkName).toBe('old_primary_disarmed');
    expect(r.status, r.errorMessage).toBe('pass');
  });

  it('fails when the old primary still archives as the primary', async () => {
    const r = await checkOldPrimaryDisarmed({ ...base, run: runner(composeProbe(1, 'primary')) });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/WALG_ROLE=primary/);
  });

  it('fails when the retired marker is missing', async () => {
    const r = await checkOldPrimaryDisarmed({ ...base, run: runner(composeProbe(0, 'standby')) });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/retired marker/);
  });

  it('fails on k8s when the ConfigMap is not marked retired', async () => {
    const r = await checkOldPrimaryDisarmed({
      ...base,
      mode: 'k8s-ha',
      run: runner(k8sProbe(null, 'standby')),
    });
    expect(r.status).toBe('fail');
  });

  it('fails when the probe cannot reach the node', async () => {
    const r = await checkOldPrimaryDisarmed({ ...base, run: runner('', false) });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/boom/);
  });
});

// ---------------------------------------------------------------------------
// primary_not_restarted
// ---------------------------------------------------------------------------

const k8sPod = (uid: string, startedAt: string) =>
  JSON.stringify({
    metadata: { uid },
    status: {
      containerStatuses: [
        { name: 'sidecar', state: { running: { startedAt: '2026-01-01T00:00:00Z' } } },
        { name: 'db', state: { running: { startedAt } } },
      ],
    },
  });

describe('parseDbIncarnation', () => {
  it('reads the compose container id and start time', () => {
    expect(parseDbIncarnation('compose-ha', 'abc123 2026-10-21T01:02:03.456Z\n')).toEqual({
      id: 'abc123',
      startedAt: '2026-10-21T01:02:03.456Z',
    });
  });

  it('reads the k8s pod uid and the db container start time', () => {
    expect(parseDbIncarnation('k8s-ha', k8sPod('uid-1', '2026-10-21T01:02:03Z'))).toEqual({
      id: 'uid-1',
      startedAt: '2026-10-21T01:02:03Z',
    });
  });

  it('a db container that is not running has no incarnation', () => {
    expect(parseDbIncarnation('compose-ha', '')).toBeNull();
    expect(
      parseDbIncarnation(
        'k8s-ha',
        JSON.stringify({ metadata: { uid: 'u' }, status: { containerStatuses: [] } }),
      ),
    ).toBeNull();
  });

  it('the commands name the db container and pod', () => {
    expect(buildDbIncarnationCommand('compose-ha', 'demo')).toContain('demo-db');
    expect(buildDbIncarnationCommand('k8s-ha', 'demo')).toContain('pod db-0');
  });
});

describe('checkPrimaryNotRestarted', () => {
  const at = (id: string, startedAt: string) => ({
    ok: true as const,
    incarnation: { id, startedAt },
  });

  it('passes when the db kept its container and start time across the deploy', () => {
    const r = checkPrimaryNotRestarted({
      ip: IP,
      before: at('a', '2026-10-21T01:00:00Z'),
      after: at('a', '2026-10-21T01:00:00Z'),
    });
    expect(r.checkName).toBe('primary_not_restarted');
    expect(r.status, r.errorMessage).toBe('pass');
  });

  it('fails when the db restarted in place', () => {
    const r = checkPrimaryNotRestarted({
      ip: IP,
      before: at('a', '2026-10-21T01:00:00Z'),
      after: at('a', '2026-10-21T01:09:00Z'),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/restarted/);
  });

  it('fails when the db was recreated', () => {
    const r = checkPrimaryNotRestarted({
      ip: IP,
      before: at('a', '2026-10-21T01:00:00Z'),
      after: at('b', '2026-10-21T01:00:00Z'),
    });
    expect(r.status).toBe('fail');
  });

  it('fails when either read failed: an unread start time proves nothing', () => {
    const r = checkPrimaryNotRestarted({
      ip: IP,
      before: { ok: false, error: 'no sshKeyPath' },
      after: at('a', '2026-10-21T01:00:00Z'),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/no sshKeyPath/);
  });

  it('readDbIncarnation turns a runner answer into an incarnation', async () => {
    const r = await readDbIncarnation({
      mode: 'compose-ha',
      projectName: 'demo',
      ip: IP,
      sshKeyPath: KEY,
      run: runner('abc 2026-10-21T01:00:00Z'),
    });
    expect(r).toEqual({ ok: true, incarnation: { id: 'abc', startedAt: '2026-10-21T01:00:00Z' } });
  });
});

// ---------------------------------------------------------------------------
// slot_capped
// ---------------------------------------------------------------------------

describe('checkSlotCapped', () => {
  const base = { mode: 'compose-ha' as const, projectName: 'demo', primaryIp: IP, sshKeyPath: KEY };

  it('the cap is the value the db argv carries', () => {
    expect(SLOT_WAL_CAP).toBe('4GB');
  });

  it('passes on 4GB', async () => {
    const run = runner('4GB\n');
    const r = await checkSlotCapped({ ...base, run });
    expect(r.checkName).toBe('slot_capped');
    expect(r.status, r.errorMessage).toBe('pass');
    expect(run.calls[0]).toContain('SHOW max_slot_wal_keep_size');
  });

  it('fails on the uncapped default (-1)', async () => {
    const r = await checkSlotCapped({ ...base, run: runner('-1') });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/-1/);
  });

  it('fails when psql failed', async () => {
    const r = await checkSlotCapped({ ...base, run: runner('', false) });
    expect(r.status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// app_endpoints_ready
// ---------------------------------------------------------------------------

const slices = (...ready: boolean[]) =>
  JSON.stringify({
    items: [
      { endpoints: ready.map((r) => ({ addresses: ['10.42.0.9'], conditions: { ready: r } })) },
    ],
  });

describe('app_endpoints_ready', () => {
  it('counts only ready endpoints', () => {
    expect(parseReadyEndpointCount(slices(true, false, true))).toBe(2);
    expect(parseReadyEndpointCount(JSON.stringify({ items: [] }))).toBe(0);
    expect(parseReadyEndpointCount('nope')).toBeNull();
  });

  it('passes with at least one ready app endpoint', async () => {
    const r = await checkAppEndpointsReady({
      primaryIp: IP,
      sshKeyPath: KEY,
      run: runner(slices(true)),
    });
    expect(r.checkName).toBe('app_endpoints_ready');
    expect(r.status, r.errorMessage).toBe('pass');
  });

  it('fails when the app Service has no ready endpoint (stale pool after the db-0 recreate)', async () => {
    const r = await checkAppEndpointsReady({
      primaryIp: IP,
      sshKeyPath: KEY,
      run: runner(slices(false)),
    });
    expect(r.status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// dns_flip_verified
// ---------------------------------------------------------------------------

describe('checkDnsFlipVerified', () => {
  const D = 'e2.example.dev';

  it('passes when apex and wildcard both read back as the promoted IP', async () => {
    const seen: string[] = [];
    const r = await checkDnsFlipVerified({
      domain: D,
      expectedIp: IP,
      readA: async (name) => {
        seen.push(name);
        return [IP];
      },
    });
    expect(r.checkName).toBe('dns_flip_verified');
    expect(r.status, r.errorMessage).toBe('pass');
    expect(seen).toEqual([D, `*.${D}`]);
  });

  it('fails when the wildcard still names the old primary', async () => {
    const r = await checkDnsFlipVerified({
      domain: D,
      expectedIp: IP,
      readA: async (name) => (name.startsWith('*') ? ['198.51.100.1'] : [IP]),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/198\.51\.100\.1/);
  });

  it('fails when a name has no A record at all, reported as nothing', async () => {
    const r = await checkDnsFlipVerified({
      domain: D,
      expectedIp: IP,
      readA: async (name) => (name.startsWith('*') ? [] : [IP]),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/nothing/);
  });

  it('fails when a stale second A record still sends traffic to the old primary', async () => {
    const r = await checkDnsFlipVerified({
      domain: D,
      expectedIp: IP,
      readA: async () => [IP, '198.51.100.1'],
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/198\.51\.100\.1/);
  });

  it('fails when the provider API cannot be read', async () => {
    const r = await checkDnsFlipVerified({
      domain: D,
      expectedIp: IP,
      readA: async () => {
        throw new Error('401');
      },
    });
    expect(r.status).toBe('fail');
  });

  it('fails when there is no promoted IP to compare against', async () => {
    const r = await checkDnsFlipVerified({ domain: D, expectedIp: null, readA: async () => [IP] });
    expect(r.status).toBe('fail');
  });

  it('fails when there is no provider reader (no token or zone)', async () => {
    const r = await checkDnsFlipVerified({
      domain: D,
      expectedIp: IP,
      readA: null,
      readerError: 'HCLOUD_TOKEN is not set',
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/HCLOUD_TOKEN/);
  });

  it('skips with the reason on manual DNS, where failover flips nothing', async () => {
    const r = await checkDnsFlipVerified({
      domain: D,
      expectedIp: IP,
      readA: null,
      skipReason: 'manual DNS',
    });
    expect(r.status).toBe('skip');
  });
});

describe('readServingIp', () => {
  it('is the k8s-ha primary floating IP, else its master, else the compose role primary', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const write = (env: object) => {
      const dir = mkdtempSync(join(tmpdir(), 'ha-integrity-'));
      writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify({ environments: { e: env } }));
      return dir;
    };
    expect(
      readServingIp(
        write({
          ha: {
            primary: { masterIp: '1.1.1.1', floatingIp: '2.2.2.2' },
            standby: { masterIp: '3.3.3.3' },
          },
        }),
        'e',
      ),
    ).toBe('2.2.2.2');
    expect(
      readServingIp(
        write({ ha: { primary: { masterIp: '1.1.1.1' }, standby: { masterIp: '3.3.3.3' } } }),
        'e',
      ),
    ).toBe('1.1.1.1');
    expect(
      readServingIp(
        write({
          servers: [
            { ip: '4.4.4.4', role: 'standby' },
            { ip: '5.5.5.5', role: 'primary' },
          ],
        }),
        'e',
      ),
    ).toBe('5.5.5.5');
  });
});

// ---------------------------------------------------------------------------
// second_failover_refused
// ---------------------------------------------------------------------------

describe('checkSecondFailoverRefused', () => {
  const roles = { primaryIp: '5.5.5.5', standbyIp: '4.4.4.4' };

  it('passes when the failover exits non-zero naming vibecarbon deploy and roles hold', () => {
    const r = checkSecondFailoverRefused({
      exitCode: 1,
      output: 'Run vibecarbon deploy e2 to get back to two nodes',
      rolesBefore: roles,
      rolesAfter: { ...roles },
    });
    expect(r.checkName).toBe('second_failover_refused');
    expect(r.status, r.errorMessage).toBe('pass');
  });

  it('fails when the second failover succeeded', () => {
    const r = checkSecondFailoverRefused({
      exitCode: 0,
      output: 'Failover complete',
      rolesBefore: roles,
      rolesAfter: { primaryIp: '4.4.4.4', standbyIp: '5.5.5.5' },
    });
    expect(r.status).toBe('fail');
  });

  it('fails when it exits non-zero for some other reason', () => {
    const r = checkSecondFailoverRefused({
      exitCode: 1,
      output: 'ssh: connect to host timed out',
      rolesBefore: roles,
      rolesAfter: roles,
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/vibecarbon deploy/);
  });

  it('fails when the refusal still moved the roles', () => {
    const r = checkSecondFailoverRefused({
      exitCode: 1,
      output: 'run vibecarbon deploy e2 first, then fail over',
      rolesBefore: roles,
      rolesAfter: { primaryIp: '4.4.4.4', standbyIp: '5.5.5.5' },
    });
    expect(r.status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle wiring (source-level: _run-lifecycle.ts runs only on real infra)
// ---------------------------------------------------------------------------

describe('_run-lifecycle.ts wires the HA integrity steps', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(
    fileURLToPath(new URL('../../e2e/scenarios/_run-lifecycle.ts', import.meta.url)),
    'utf8',
  );
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    expect(i, `${needle} not found`).toBeGreaterThan(-1);
    return i;
  };

  it('orders failover, verify-failover, second-failover, reconverge-deploy, failback, verify-failback', () => {
    const order = [
      "stepDefs.push(promotionStep('failover'))",
      "name: 'verify-failover'",
      "name: 'second-failover'",
      "name: 'reconverge-deploy'",
      "stepDefs.push(promotionStep('failback'))",
      "name: 'verify-failback'",
    ].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('runs reconverge-deploy on both HA modes and the failback on compose-ha only', () => {
    const reconverge = at("name: 'reconverge-deploy'");
    expect(src.slice(reconverge - 200, reconverge)).not.toMatch(/config\.mode === 'k8s-ha'/);
    const failback = at("stepDefs.push(promotionStep('failback'))");
    expect(src.slice(failback - 120, failback)).toContain("if (config.mode === 'compose-ha') {");
  });

  it('warm-deploy and reconverge-deploy deploy inside the primary-restart assertion', () => {
    expect(src.match(/await assertPrimaryNotRestartedAcross\(stepId, /g)).toHaveLength(2);
  });

  it('--skip-steps drops dependents through expandSkippedSteps', () => {
    expect(src).toContain('const dropped = expandSkippedSteps(options.skipSteps);');
  });

  it('a reconverge that cannot write its survival marker fails instead of skipping the proof', () => {
    expect(src).not.toContain('reconvergeMarkerWritten');
    expect(src).toContain('reconverge-deploy: could not write survival marker');
    expect(src).toContain("if (survival.status !== 'pass') {");
  });
});

describe('expandSkippedSteps', () => {
  const expand = (...s: string[]) => [...expandSkippedSteps(new Set(s))].sort();

  it('skipping failover drops everything that needs a failed-over env', () => {
    expect(expand('failover')).toEqual(
      ['failback', 'failover', 'reconverge-deploy', 'second-failover', 'verify-failback'].sort(),
    );
  });

  it('skipping reconverge-deploy drops the failback and its verify', () => {
    expect(expand('reconverge-deploy')).toEqual([
      'failback',
      'reconverge-deploy',
      'verify-failback',
    ]);
  });

  it('skipping failback drops verify-failback', () => {
    expect(expand('failback')).toEqual(['failback', 'verify-failback']);
  });

  it('a step with no dependents is dropped alone', () => {
    expect(expand('scale', 'verify-scale')).toEqual(['scale', 'verify-scale']);
  });
});
