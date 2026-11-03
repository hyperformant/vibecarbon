/**
 * HA integrity checks (HA-correctness Task 11): each one's pass and fail
 * parsing, driven through an injected remote runner so no SSH is involved.
 *
 * These are the assertions that would have caught the HA bugs the branch
 * fixed: a second failover that reseeded the retired node from itself, a DNS
 * flip nobody read back, an old primary left armed, a deploy that bounced the
 * serving primary, and a replication slot with no WAL cap.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { walgRoleReadShell } from '../../../src/lib/deploy/walg-role.js';
import { shEscape } from '../../../src/lib/shell.js';
import {
  buildDbIncarnationCommand,
  buildDisarmProbeCommand,
  buildHistoryProbe,
  buildHistoryRemoteCommand,
  checkAppEndpointsReady,
  checkDnsFlipVerified,
  checkOldPrimaryDisarmed,
  checkPrimaryDbCreatedOnce,
  checkPrimaryNotRestarted,
  checkPromotedDbNotRecreated,
  checkPromotionHistoryArchived,
  checkSecondFailoverRefused,
  checkSlotCapped,
  historyArchived,
  parseDbIncarnation,
  parseDisarmProbe,
  parseReadyEndpointCount,
  type RemoteRun,
  readDbGeneration,
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
  `HOST_MARKER=${marker}\nWALG_ROLE_FILE=${role}\nPROBE_DONE`;

const k8sProbe = (retired: 0 | 1, intent: string, live: string) =>
  `INTENT=${intent}\nWALG_ROLE_FILE=${live}\nRETIRED=${retired}\nPROBE_DONE`;

describe('parseDisarmProbe', () => {
  it('compose disarm probe: role from the shared reader, not docker inspect', () => {
    const cmd = buildDisarmProbeCommand('compose-ha', 'acme');
    expect(cmd).toContain(walgRoleReadShell('/opt/acme/.vibecarbon-role'));
    expect(cmd).not.toContain('WALG_ROLE=$(docker inspect');
    expect(
      parseDisarmProbe('compose-ha', 'HOST_MARKER=1\nWALG_ROLE_FILE=standby\nPROBE_DONE'),
    ).toEqual({ walgRole: 'standby', walgIntent: null, retiredMarker: true });
  });

  it('k8s disarm probe: intent and live file must both say standby', () => {
    const out = 'INTENT=standby\nWALG_ROLE_FILE=standby\nRETIRED=1\nPROBE_DONE';
    expect(parseDisarmProbe('k8s-ha', out)).toEqual({
      walgRole: 'standby',
      walgIntent: 'standby',
      retiredMarker: true,
    });
  });

  it('k8s disarm probe: the intent ConfigMap plus the live file read in db-0 through the shared reader', () => {
    const cmd = buildDisarmProbeCommand('k8s-ha', 'acme');
    expect(cmd).toContain('configmap vibecarbon-db-role');
    expect(cmd).toContain('VC_WALG_ROLE_INTENT');
    expect(cmd).toContain('configmap vibecarbon-config');
    expect(cmd).toContain(
      `exec db-0 -c db -- sh -c ${shEscape(walgRoleReadShell('/var/lib/vibecarbon/role'))}`,
    );
    expect(cmd).not.toContain('statefulset');
  });

  it('the k8s probe survives the remote shell: the role read reaches sh -c as one word', () => {
    // Run the whole probe in a real shell with kubectl stubbed: the exec call
    // records its argv, and what follows `--` is exactly what db-0 runs.
    const dir = mkdtempSync(join(tmpdir(), 'vc-disarm-argv-'));
    try {
      const argvFile = join(dir, 'argv');
      const stub = `kubectl() { if [ "$3" = exec ]; then printf '%s\\0' "$@" > ${shEscape(argvFile)}; fi; }`;
      spawnSync('sh', ['-c', `${stub}\n${buildDisarmProbeCommand('k8s-ha', 'acme')}`]);
      const argv = readFileSync(argvFile, 'utf-8').split('\0');
      expect(argv.slice(argv.indexOf('--') + 1, -1)).toEqual([
        'sh',
        '-c',
        walgRoleReadShell('/var/lib/vibecarbon/role'),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unreadable or empty role is null, never standby', () => {
    expect(parseDisarmProbe('compose-ha', 'HOST_MARKER=1\nWALG_ROLE_FILE=\nPROBE_DONE')).toEqual({
      walgRole: null,
      walgIntent: null,
      retiredMarker: true,
    });
    // db-0 did not answer: no WALG_ROLE_FILE line at all.
    expect(parseDisarmProbe('k8s-ha', 'INTENT=standby\nRETIRED=1\nPROBE_DONE')).toEqual({
      walgRole: null,
      walgIntent: 'standby',
      retiredMarker: true,
    });
  });

  it('a probe that never finished is unreadable, not "absent"', () => {
    expect(parseDisarmProbe('compose-ha', 'HOST_MARKER=1\n')).toBeNull();
    expect(parseDisarmProbe('k8s-ha', 'INTENT=standby\nWALG_ROLE_FILE=standby\n')).toBeNull();
    expect(parseDisarmProbe('k8s-ha', 'Error from server')).toBeNull();
  });

  it('the compose probe reads the host marker and the role file, never .env', () => {
    const cmd = buildDisarmProbeCommand('compose-ha', 'demo');
    expect(cmd).toContain('.vibecarbon-retired');
    expect(cmd).not.toMatch(/docker inspect|\.env\b/);
  });

  it('the probes run the shared reader for real: a role file reads back through it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-disarm-'));
    try {
      const roleDir = join(dir, '.vibecarbon-role');
      mkdirSync(roleDir);
      const read = () =>
        spawnSync('sh', ['-c', walgRoleReadShell(roleDir)], { encoding: 'utf-8' }).stdout;
      writeFileSync(join(roleDir, 'walg-role'), 'standby\n');
      expect(parseDisarmProbe('compose-ha', `HOST_MARKER=1\n${read()}PROBE_DONE`)?.walgRole).toBe(
        'standby',
      );
      writeFileSync(join(roleDir, 'walg-role'), 'garbage\n');
      expect(
        parseDisarmProbe('compose-ha', `HOST_MARKER=1\n${read()}PROBE_DONE`)?.walgRole,
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkOldPrimaryDisarmed', () => {
  const base = { mode: 'compose-ha' as const, projectName: 'demo', retiredIp: IP, sshKeyPath: KEY };

  it('passes when the retired side role file reads standby and it carries the marker', async () => {
    const r = await checkOldPrimaryDisarmed({ ...base, run: runner(composeProbe(1, 'standby')) });
    expect(r.checkName).toBe('old_primary_disarmed');
    expect(r.status, r.errorMessage).toBe('pass');
  });

  it('fails when the old primary still archives as the primary', async () => {
    const r = await checkOldPrimaryDisarmed({ ...base, run: runner(composeProbe(1, 'primary')) });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/role file reads primary/);
  });

  it('fails when the role file is unreadable: it never passes hollow', async () => {
    const r = await checkOldPrimaryDisarmed({ ...base, run: runner(composeProbe(1, '')) });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/unreadable/);
  });

  it('fails when the retired marker is missing', async () => {
    const r = await checkOldPrimaryDisarmed({ ...base, run: runner(composeProbe(0, 'standby')) });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/retired marker/);
  });

  const k8s = { ...base, mode: 'k8s-ha' as const };

  it('passes on k8s when the intent and the live file both say standby and it is retired', async () => {
    const r = await checkOldPrimaryDisarmed({
      ...k8s,
      run: runner(k8sProbe(1, 'standby', 'standby')),
    });
    expect(r.status, r.errorMessage).toBe('pass');
  });

  it('fails on k8s when the ConfigMap is not marked retired', async () => {
    const r = await checkOldPrimaryDisarmed({
      ...k8s,
      run: runner(k8sProbe(0, 'standby', 'standby')),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/retired marker/);
  });

  it('fails on k8s when the intent still says primary (the next db start re-arms it)', async () => {
    const r = await checkOldPrimaryDisarmed({
      ...k8s,
      run: runner(k8sProbe(1, 'primary', 'standby')),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/vibecarbon-db-role intent reads primary/);
  });

  it('fails on k8s when the live file is unreadable (db-0 did not answer)', async () => {
    const r = await checkOldPrimaryDisarmed({
      ...k8s,
      run: runner('INTENT=standby\nRETIRED=1\nPROBE_DONE'),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/unreadable/);
  });

  it('fails on k8s when the intent is unreadable', async () => {
    const r = await checkOldPrimaryDisarmed({
      ...k8s,
      run: runner(k8sProbe(1, '', 'standby')),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/intent reads \(unreadable/);
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
// primary_db_created_once
// ---------------------------------------------------------------------------

describe('checkPrimaryDbCreatedOnce', () => {
  // The DO e2e of 2026-11-01: a replication-time patch recreated the primary
  // db-0 seconds after its first volume attach, and the re-attach went stale.
  // A cold deploy now creates the primary db once; this guards it.
  const at = (id: string) => ({
    ok: true as const,
    incarnation: { id, startedAt: '2026-11-01T16:05:58Z' },
  });
  const genRunner = (generation: string) => runner(generation);

  it('passes when db-0 is the pod the deploy ended with and its StatefulSet was never changed', async () => {
    const run = genRunner('1');
    const r = await checkPrimaryDbCreatedOnce({
      mode: 'k8s-ha',
      projectName: 'demo',
      ip: IP,
      sshKeyPath: KEY,
      atDeploy: at('uid-1'),
      atVerify: at('uid-1'),
      run,
    });
    expect(r.checkName).toBe('primary_db_created_once');
    expect(r.status, r.errorMessage).toBe('pass');
    expect(run.calls[0]).toContain('get statefulset db');
    expect(run.calls[0]).toContain('.metadata.generation');
  });

  it('fails when the StatefulSet template changed after its creation (a patch rolled db-0)', async () => {
    const r = await checkPrimaryDbCreatedOnce({
      mode: 'k8s-ha',
      projectName: 'demo',
      ip: IP,
      sshKeyPath: KEY,
      atDeploy: at('uid-1'),
      atVerify: at('uid-1'),
      run: genRunner('2'),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/generation 2/);
  });

  it('fails when db-0 was recreated after the deploy', async () => {
    const r = await checkPrimaryDbCreatedOnce({
      mode: 'k8s-ha',
      projectName: 'demo',
      ip: IP,
      sshKeyPath: KEY,
      atDeploy: at('uid-1'),
      atVerify: at('uid-2'),
      run: genRunner('1'),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/uid-1 -> uid-2/);
  });

  it('an unread pod proves nothing', async () => {
    const r = await checkPrimaryDbCreatedOnce({
      mode: 'k8s-ha',
      projectName: 'demo',
      ip: IP,
      sshKeyPath: KEY,
      atDeploy: { ok: false, error: 'db is not running' },
      atVerify: at('uid-1'),
      run: genRunner('1'),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/db is not running/);
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
// promoted_db_not_recreated
// ---------------------------------------------------------------------------

describe('checkPromotedDbNotRecreated', () => {
  const sshArgs = { mode: 'k8s-ha' as const, projectName: 'acme', sshKeyPath: KEY };
  const N = IP;

  it('promoted_db_not_recreated: uid and generation unchanged across the failover', async () => {
    const inc = (id: string) => ({ ok: true as const, incarnation: { id, startedAt: 't' } });
    const run = async () => ({ ok: true, output: '1' });
    expect(
      (
        await checkPromotedDbNotRecreated({
          ...sshArgs,
          run,
          ip: N,
          before: inc('u1'),
          after: inc('u1'),
          generationBefore: '1',
        })
      ).status,
    ).toBe('pass');
    expect(
      (
        await checkPromotedDbNotRecreated({
          ...sshArgs,
          run,
          ip: N,
          before: inc('u1'),
          after: inc('u2'),
          generationBefore: '1',
        })
      ).status,
    ).toBe('fail');
    expect(
      (
        await checkPromotedDbNotRecreated({
          ...sshArgs,
          run: async () => ({ ok: true, output: '2' }),
          ip: N,
          before: inc('u1'),
          after: inc('u1'),
          generationBefore: '1',
        })
      ).status,
    ).toBe('fail');
  });

  const inc = (id: string) => ({ ok: true as const, incarnation: { id, startedAt: 't' } });

  it('k8s reads the db StatefulSet generation on the promoted cluster', async () => {
    const run = runner('3');
    const r = await checkPromotedDbNotRecreated({
      ...sshArgs,
      run,
      ip: N,
      before: inc('u1'),
      after: inc('u1'),
      generationBefore: '3',
    });
    expect(r.checkName).toBe('promoted_db_not_recreated');
    expect(r.status, r.errorMessage).toBe('pass');
    expect(run.calls).toEqual([
      expect.stringContaining("get statefulset db -o jsonpath='{.metadata.generation}'"),
    ]);
  });

  it('k8s: a generation never read before the failover fails, never passes', async () => {
    const r = await checkPromotedDbNotRecreated({
      ...sshArgs,
      run: runner('1'),
      ip: N,
      before: inc('u1'),
      after: inc('u1'),
      generationBefore: null,
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/generation/);
  });

  it('k8s: an unreadable generation now fails', async () => {
    const r = await checkPromotedDbNotRecreated({
      ...sshArgs,
      run: runner('', false),
      ip: N,
      before: inc('u1'),
      after: inc('u1'),
      generationBefore: '1',
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/boom/);
  });

  it('an unread incarnation on either side fails', async () => {
    const bad = { ok: false as const, error: 'db is not running' };
    for (const [before, after] of [
      [bad, inc('u1')],
      [inc('u1'), bad],
    ] as const) {
      const r = await checkPromotedDbNotRecreated({
        ...sshArgs,
        run: runner('1'),
        ip: N,
        before,
        after,
        generationBefore: '1',
      });
      expect(r.status).toBe('fail');
      expect(r.errorMessage).toMatch(/db is not running/);
    }
  });

  it('compose compares the container id only: no generation to read', async () => {
    const run = runner('unused');
    const compose = { ...sshArgs, mode: 'compose-ha' as const, run, ip: N, generationBefore: null };
    expect(
      (await checkPromotedDbNotRecreated({ ...compose, before: inc('c1'), after: inc('c1') }))
        .status,
    ).toBe('pass');
    const r = await checkPromotedDbNotRecreated({
      ...compose,
      before: inc('c1'),
      after: inc('c2'),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toContain('c1 -> c2');
    expect(run.calls).toEqual([]);
  });

  it('readDbGeneration reads the StatefulSet generation; an empty answer is an error', async () => {
    expect(await readDbGeneration({ ...sshArgs, ip: N, run: runner('4\n') })).toEqual({
      ok: true,
      generation: '4',
    });
    expect((await readDbGeneration({ ...sshArgs, ip: N, run: runner('') })).ok).toBe(false);
    expect((await readDbGeneration({ ...sshArgs, ip: N, sshKeyPath: null })).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// promotion_history_archived
// ---------------------------------------------------------------------------

describe('historyArchived', () => {
  it('promotion_history_archived: matches <TL hex>.history as a prefix (wal-g stores it compressed)', () => {
    expect(historyArchived('00000002.history.lz4\n000000020000000000000005.lz4', 2)).toBe(true);
    expect(historyArchived('00000002.history.br', 2)).toBe(true);
    expect(historyArchived('000000020000000000000005.lz4', 2)).toBe(false);
    expect(historyArchived('00000003.history.lz4', 2)).toBe(false);
  });

  it('spells the timeline in upper-case hex', () => {
    expect(historyArchived('0000000A.history.lz4', 10)).toBe(true);
    expect(historyArchived('0000000a.history.lz4', 10)).toBe(false);
  });
});

describe('checkPromotionHistoryArchived', () => {
  const base = {
    mode: 'k8s-ha' as const,
    projectName: 'acme',
    sshKeyPath: KEY,
    ip: IP,
    projectDir: '/nonexistent',
    envPrefix: 'prod',
    budgetMs: 0,
    intervalMs: 0,
  };
  const probe = (walfile: string, lineage = '7300000000000000001') =>
    `HIST=probed\nHIST_LINEAGE=${lineage}\nHIST_WALFILE=${walfile}`;
  const keys = (...names: string[]) =>
    names.map((n) => `backups/acme/prod/walg/7300000000000000001/wal_005/${n}`);

  it('passes when the promoted timeline history is in the archive', async () => {
    const asked: string[] = [];
    const r = await checkPromotionHistoryArchived({
      ...base,
      run: runner(probe('000000020000000000000005')),
      listKeys: async (prefix) => {
        asked.push(prefix);
        return keys('00000002.history.lz4', '000000020000000000000005.lz4');
      },
    });
    expect(r.checkName).toBe('promotion_history_archived');
    expect(r.status, r.errorMessage).toBe('pass');
    expect(asked).toEqual(['backups/acme/prod/walg/7300000000000000001/wal_005/00000002']);
  });

  it('fails when the history file never landed (the promote-then-roll drop)', async () => {
    const r = await checkPromotionHistoryArchived({
      ...base,
      run: runner(probe('000000020000000000000005')),
      listKeys: async () => keys('000000020000000000000005.lz4'),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/00000002\.history/);
  });

  it('fails on timeline 1: nothing was promoted', async () => {
    const r = await checkPromotionHistoryArchived({
      ...base,
      run: runner(probe('000000010000000000000005')),
      listKeys: async () => keys('00000001.history.lz4'),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/timeline 1/);
  });

  it('fails when the probe read no WAL file (still in recovery, psql down)', async () => {
    const r = await checkPromotionHistoryArchived({
      ...base,
      run: runner(probe('')),
      listKeys: async () => {
        throw new Error('listed without a timeline');
      },
    });
    expect(r.status).toBe('fail');
  });

  it('fails when walg-env.sh could not name the lineage', async () => {
    const r = await checkPromotionHistoryArchived({
      ...base,
      run: runner('HIST=fail:no-lineage'),
      listKeys: async () => [],
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/lineage/);
  });

  it('fails on an unparseable probe and on an unreachable node', async () => {
    for (const run of [runner('garbage'), runner('', false)]) {
      const r = await checkPromotionHistoryArchived({ ...base, run, listKeys: async () => [] });
      expect(r.status).toBe('fail');
    }
  });

  it('fails when the listing throws', async () => {
    const r = await checkPromotionHistoryArchived({
      ...base,
      run: runner(probe('000000020000000000000005')),
      listKeys: async () => {
        throw new Error('AccessDenied');
      },
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/AccessDenied/);
  });

  it('skips only when the container says backups are off', async () => {
    const r = await checkPromotionHistoryArchived({
      ...base,
      run: runner('HIST=skip:no-backup-target'),
      listKeys: async () => [],
    });
    expect(r.status).toBe('skip');
  });

  it('with backups on but no backupS3 in the project config, fails (no listing to trust)', async () => {
    const r = await checkPromotionHistoryArchived({
      ...base,
      run: runner(probe('000000020000000000000005')),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/backupS3/);
  });

  it("the history probe has no single quote: it is wrapped in bash -c '...' unescaped", () => {
    expect(buildHistoryProbe()).not.toContain("'");
  });

  it('the probe runs in the db (compose and k8s)', () => {
    const p = buildHistoryProbe();
    expect(p).toContain('pg_walfile_name(pg_current_wal_lsn())');
    expect(buildHistoryRemoteCommand('compose-ha', 'acme')).toContain(
      'cd /opt/acme && docker compose exec -T db bash -c',
    );
    expect(buildHistoryRemoteCommand('k8s-ha', 'acme')).toContain('exec db-0 -c db -- bash -c');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle wiring (source-level: _run-lifecycle.ts runs only on real infra)
// ---------------------------------------------------------------------------

describe('_run-lifecycle.ts wires the HA integrity steps', async () => {
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

  it('the promoted db and its timeline history are checked after every promotion, on both HA modes', () => {
    const calls = src.match(/await checkPromotedDbNotRecreated\(\{/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(src.match(/await checkPromotionHistoryArchived\(\{/g) ?? []).toHaveLength(1);
    // Read right before the promotion on both modes, never only on compose-ha.
    expect(src).not.toMatch(/preFailoverStandbyDb\s*=\s*config\.mode === 'compose-ha'/);
    expect(src).toContain('preFailoverStandbyGeneration =');
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
