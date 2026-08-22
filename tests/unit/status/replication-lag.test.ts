/**
 * Task 12 (pilot-light standby spec) — replication-lag visibility in
 * `vibecarbon status`.
 *
 * Spec rationale: "Insurance you cannot observe is not trustworthy; silent
 * lag growth is the main RPO risk of a minimal standby." Two read-only
 * views feed the single status line:
 *   - buildPrimaryLagQuery(): the PRIMARY's view (pg_stat_replication.state
 *     + replay_lag in seconds) — the normal, healthy signal.
 *   - buildStandbyReplayQuery(): the STANDBY's own self-view
 *     (pg_is_in_recovery + last replay age) — the view that matters
 *     precisely when the primary's view goes missing (a disconnected
 *     standby is invisible to pg_stat_replication).
 *
 * formatReplicationLagLine covers four cases: healthy streaming,
 * standby-side-only data (primary view unavailable), standby NOT in
 * recovery (red DR-not-guaranteed, checked first regardless of the primary
 * view), and both views unavailable.
 *
 * checkReplication (src/status.js) threads both rows through its existing
 * deps-injection pattern — sshKubectl/getPostgresPod/getSSHKeyPath/sshRun —
 * so this stubs those instead of mocking the ssh.js module wholesale.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPrimaryLagQuery,
  buildStandbyReplayQuery,
  formatReplicationLagLine,
} from '../../../src/lib/deploy/replication.js';
import { checkReplication } from '../../../src/status.js';

describe('buildPrimaryLagQuery', () => {
  it('returns the exact SQL (state + replay_lag seconds, COALESCE to 0, single row)', () => {
    expect(buildPrimaryLagQuery()).toBe(
      'SELECT state, COALESCE(EXTRACT(EPOCH FROM replay_lag),0) FROM pg_stat_replication LIMIT 1',
    );
  });
});

describe('buildStandbyReplayQuery', () => {
  it('returns the exact SQL (pg_is_in_recovery + last replay lsn + seconds since last replay)', () => {
    expect(buildStandbyReplayQuery()).toBe(
      'SELECT pg_is_in_recovery(), pg_last_wal_replay_lsn(), ' +
        'COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())),0)',
    );
  });
});

describe('formatReplicationLagLine', () => {
  it('healthy streaming: formats the primary-observed lag in seconds', () => {
    expect(formatReplicationLagLine({ primaryRow: { state: 'streaming', lagSeconds: 0.4 } })).toBe(
      'Replication lag: 0.4s (streaming)',
    );
  });

  it('non-streaming state still reports (echoes the real state, e.g. catchup)', () => {
    expect(formatReplicationLagLine({ primaryRow: { state: 'catchup', lagSeconds: 3 } })).toBe(
      'Replication lag: 3.0s (catchup)',
    );
  });

  it('standby-side-only data: primary view unavailable, standby self-reports last replay age', () => {
    expect(
      formatReplicationLagLine({
        primaryRow: null,
        standbyRow: { inRecovery: true, lastWalReplayLsn: '0/3000060', secondsSinceReplay: 12 },
      }),
    ).toBe('Replication lag: unknown (primary view unavailable; standby last replay 12s ago)');
  });

  it('standby NOT in recovery: red DR-not-guaranteed warning, checked first even if primary looks healthy', () => {
    expect(
      formatReplicationLagLine({
        primaryRow: { state: 'streaming', lagSeconds: 0.1 },
        standbyRow: { inRecovery: false, lastWalReplayLsn: '0/3000060', secondsSinceReplay: 0 },
      }),
    ).toBe('Replication: standby not in recovery; DR NOT GUARANTEED');
  });

  it('standby NOT in recovery takes priority even with no primary view at all', () => {
    expect(
      formatReplicationLagLine({
        standbyRow: { inRecovery: false, lastWalReplayLsn: '', secondsSinceReplay: 0 },
      }),
    ).toBe('Replication: standby not in recovery; DR NOT GUARANTEED');
  });

  it('both unavailable: falls back to a plain unknown line, never throws', () => {
    expect(formatReplicationLagLine({})).toBe('Replication lag: unknown (no data available)');
    expect(formatReplicationLagLine({ primaryRow: null, standbyRow: null })).toBe(
      'Replication lag: unknown (no data available)',
    );
    expect(formatReplicationLagLine(undefined)).toBe(
      'Replication lag: unknown (no data available)',
    );
  });
});

describe('checkReplication — standby-side threading (k8s-HA)', () => {
  // existsSync(sshKeyPath) is a real fs check inside checkReplication (not
  // deps-overridable) — point it at this test file, which always exists.
  const FAKE_KEY_PATH = fileURLToPath(import.meta.url);
  const PRIMARY_IP = '10.1.2.2';
  const STANDBY_IP = '10.1.2.3';

  const k8sHaEnvConfig = () => ({
    deployMode: 'kubernetes',
    secondaryRegion: 'fsn1',
    ha: { enabled: true, standby: { masterIp: STANDBY_IP } },
    servers: [{ name: 'primary', ip: PRIMARY_IP }],
  });

  function makeDeps({ primaryLagOut, standbyOut, byteLagOut = 'streaming|1024' }) {
    const getPostgresPod = vi.fn(async (ip) => (ip === PRIMARY_IP ? 'primary-pod' : 'standby-pod'));
    const sshKubectl = vi.fn(async (ip, _key, argv) => {
      const sql = argv[argv.length - 1];
      if (ip === PRIMARY_IP) {
        return sql === buildPrimaryLagQuery() ? primaryLagOut : byteLagOut;
      }
      if (ip === STANDBY_IP && sql === buildStandbyReplayQuery()) return standbyOut;
      throw new Error(`unexpected sshKubectl call: ip=${ip} sql=${sql}`);
    });
    return {
      getPostgresPod,
      sshKubectl,
      sshRun: vi.fn(),
      getSSHKeyPath: vi.fn(() => FAKE_KEY_PATH),
      timeoutMs: 5000,
    };
  }

  it('threads primaryRow + standbyRow into a healthy lagLine', async () => {
    const deps = makeDeps({ primaryLagOut: 'streaming|0.4', standbyOut: 't|0/3000060|0' });
    const result = await checkReplication('prod', k8sHaEnvConfig(), 'myproj', deps);
    expect(result.lagLine).toBe('Replication lag: 0.4s (streaming)');
    // The pre-existing byte-based streaming/DR path stays intact.
    expect(result.streaming).toBe(true);
    expect(result.lagBytes).toBe(1024);
    // Standby was actually queried (proves the standby-side query ran).
    expect(deps.sshKubectl).toHaveBeenCalledWith(
      STANDBY_IP,
      FAKE_KEY_PATH,
      expect.arrayContaining([buildStandbyReplayQuery()]),
      expect.anything(),
    );
  });

  it('surfaces the standby-not-in-recovery warning even when the primary still looks streaming', async () => {
    const deps = makeDeps({ primaryLagOut: 'streaming|0.1', standbyOut: 'f|0/3000060|999' });
    const result = await checkReplication('prod', k8sHaEnvConfig(), 'myproj', deps);
    expect(result.lagLine).toBe('Replication: standby not in recovery; DR NOT GUARANTEED');
  });

  it('falls back to the standby-only case when the primary query returns nothing', async () => {
    const deps = makeDeps({ primaryLagOut: '', standbyOut: 't|0/3000060|12' });
    const result = await checkReplication('prod', k8sHaEnvConfig(), 'myproj', deps);
    expect(result.lagLine).toBe(
      'Replication lag: unknown (primary view unavailable; standby last replay 12s ago)',
    );
  });

  it('never queries the standby when ha.standby.masterIp is unset (mid-deploy skeleton config)', async () => {
    const envConfig = k8sHaEnvConfig();
    delete envConfig.ha.standby;
    const deps = makeDeps({ primaryLagOut: 'streaming|0.5', standbyOut: 't|0/3000060|0' });
    const result = await checkReplication('prod', envConfig, 'myproj', deps);
    expect(result.lagLine).toBe('Replication lag: 0.5s (streaming)');
    expect(deps.sshKubectl).not.toHaveBeenCalledWith(
      STANDBY_IP,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('compose-ha stays out of scope: never attempts a standby-side query', async () => {
    const envConfig = {
      deployMode: 'compose-ha',
      secondaryRegion: 'fsn1',
      ha: { enabled: true, standby: { masterIp: STANDBY_IP } },
      servers: [{ name: 'primary', ip: PRIMARY_IP }],
    };
    const sshRun = vi.fn(async (_ip, _key, argv) => {
      const cmd = argv[argv.length - 1];
      if (cmd.includes(buildPrimaryLagQuery())) return 'streaming|0.7';
      return 'streaming|2048';
    });
    const sshKubectl = vi.fn();
    const deps = {
      sshRun,
      sshKubectl,
      getPostgresPod: vi.fn(),
      getSSHKeyPath: vi.fn(() => FAKE_KEY_PATH),
      timeoutMs: 5000,
    };
    const result = await checkReplication('prod', envConfig, 'myproj', deps);
    expect(result.lagLine).toBe('Replication lag: 0.7s (streaming)');
    expect(sshKubectl).not.toHaveBeenCalled();
  });
});
