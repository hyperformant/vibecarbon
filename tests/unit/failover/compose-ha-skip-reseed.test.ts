/**
 * compose-HA failover: skip the pre-promotion re-seed when the standby is
 * already verifiably streaming.
 *
 * Live RCA (compose-ha 2026-07-07): with WireGuard replication finally healthy,
 * the standby was STREAMING at failover time. The pre-promotion re-seed then
 * staged a `pg_basebackup -S vibecarbon_standby_slot` while the standby's own
 * walreceiver still held that persistent slot — pg_basebackup aborted with
 * "replication slot is active for PID …". The fix: read the standby's
 * pg_stat_wal_receiver; if it is streaming, skip the basebackup entirely (parity
 * is already guaranteed, and RTO improves) and go straight to promotion.
 *
 * SSH (compose/index.js sshRun) is mocked; config + fs are stubbed so the flow
 * runs offline without touching disk.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sshCalls: Array<{ ip: string; command: string; input?: string }> = [];

/** A passing wal-g audit payload: storage reachable, one base backup visible. */
const WALG_AUDIT_PASS = [
  'WALG_AUDIT=probed',
  'WALG_AUDIT_PREFIX=s3://bucket/backups/myapp/walg',
  'WALG_AUDIT_RC=0',
  'WALG_AUDIT_ARCHIVER=3|0|000000010000000000000003||2026-07-30 12:00:00+00||f',
  'WALG_AUDIT_LIST_BEGIN',
  '[{"backup_name":"base_000000010000000000000002","time":"2026-07-30T12:00:00Z"}]',
  'WALG_AUDIT_LIST_END',
].join('\n');

/** What the audit probe reports this run; a test may swap in a failing shape. */
let auditPayload = WALG_AUDIT_PASS;

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const rec = (ip: string, _k: string, command: unknown, options?: { input?: string }) => {
    const c = String(command);
    sshCalls.push({ ip, command: c, input: options?.input });
    if (c.includes('pg_stat_wal_receiver')) return 'streaming'; // standby is streaming
    if (c.includes('pg_promote')) return 't'; // promotion succeeds
    if (c.includes('WALG_AUDIT')) return auditPayload; // backup audit verdict
    // new-primary app tier serves — the gate needs every labeled probe up
    if (c.includes('%{http_code}')) return 'rest=200 auth=200 storage=200';
    return '';
  };
  // See compose-ha-wireguard.test.ts: sshRunChecked calls the module-LOCAL
  // sshRun, which the export override does not intercept, so it must be
  // stubbed too or these offline tests attempt real SSH.
  const recChecked = async (
    ip: string,
    k: string,
    command: unknown,
    options?: { input?: string; what?: string },
  ) => {
    const out = await rec(ip, k, command, options);
    if (out === false) throw new Error(`${options?.what || 'remote command'} failed on ${ip}`);
    return out;
  };
  return {
    ...actual,
    sshRun: vi.fn(rec),
    sshRunAsync: vi.fn(rec),
    sshRunChecked: vi.fn(recChecked),
  };
});

// mergeRemoteDotenv scp's the remote .env — record the WALG_ROLE writes instead.
const envMerges: Array<{ ip: string; updates: Record<string, string> }> = [];
vi.mock('../../../src/lib/deploy/utils.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    mergeRemoteDotenv: vi.fn(
      async (ip: string, _o: string, _d: string, updates: Record<string, string>) => {
        envMerges.push({ ip, updates });
      },
    ),
  };
});

// saveProjectConfig writes .vibecarbon.json — stub it.
vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, saveProjectConfig: vi.fn() };
});

// The deploy_key existence gate in failoverComposeHA must pass.
vi.mock('node:fs', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, existsSync: () => true };
});

const { failoverComposeHA } = await import('../../../src/lib/deploy/compose/ha.js');
const { saveProjectConfig } = await import('../../../src/lib/config.js');

const envConfig = {
  deployMode: 'compose-ha',
  domain: 'app.example.com',
  servers: [
    { role: 'primary', ip: '1.1.1.1', region: 'nbg1' },
    { role: 'standby', ip: '2.2.2.2', region: 'ash' },
  ],
};
const projectConfig = { projectName: 'myapp', environments: { prod: envConfig } };
const parsed = { yes: true, dryRun: false };
const tracker = { spinner: () => ({ start() {}, stop() {} }) };

beforeEach(() => {
  sshCalls.length = 0;
  envMerges.length = 0;
  auditPayload = WALG_AUDIT_PASS;
  vi.mocked(saveProjectConfig).mockClear();
});

describe('failoverComposeHA — standby already streaming', () => {
  it('skips the pg_basebackup re-seed and proceeds straight to promotion', async () => {
    await failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker);

    // The standby-side streaming probe ran against the STANDBY.
    const probe = sshCalls.find((c) => c.command.includes('pg_stat_wal_receiver'));
    expect(probe?.ip).toBe('2.2.2.2');

    // No re-seed: no basebackup staged, no db stop (configureStandbyReplication's
    // host-side `stop db`) — the whole reseed sequence was skipped.
    expect(sshCalls.some((c) => c.input?.includes('pg_basebackup'))).toBe(false);
    expect(sshCalls.some((c) => c.command.includes('stop db'))).toBe(false);

    // Promotion still ran on the standby.
    expect(sshCalls.some((c) => c.command.includes('pg_promote'))).toBe(true);
  });

  // The bug this guards (2026-08-09, round-A d2 verify-failover failure —
  // 3/3 deterministic across e2/d2 runs): the app-tier restart ran as bare
  // `docker compose restart supavisor auth rest ...`, but supavisor is
  // defined ONLY in docker-compose.prod.yml, so bare compose (no -f chain
  // on the remote invocation) failed service-name resolution and exited in
  // ~2s having restarted NOTHING. Two runs got lucky (the step-1c API wait
  // let PostgREST self-recover); the third hit stale supavisor/auth pools
  // and verify-failover failed on app_api_me_authenticated +
  // db_write_roundtrip. Container names (container_name:
  // ${PROJECT_NAME}-<svc>, stamped on all six services) bypass compose
  // file resolution entirely — the hand-rolled-compose-invocation-drifts
  // family (see compose-invocation-service-names census).
  it('restarts the new-primary app tier by CONTAINER name, never bare compose service names', async () => {
    await failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker);

    const restart = sshCalls.find((c) => c.command.includes('docker restart'));
    expect(restart, 'app-tier restart invocation missing').toBeDefined();
    expect(restart?.ip).toBe('2.2.2.2'); // the promoted standby
    for (const svc of ['supavisor', 'auth', 'rest', 'realtime', 'storage', 'app']) {
      expect(restart?.command).toContain(`myapp-${svc}`);
    }
    // The 3/3-failing shape must never come back.
    expect(sshCalls.some((c) => /docker compose restart(?! db)/.test(c.command))).toBe(false);
  });

  // The bug this guards: failover swapped the roles in config but never
  // re-rendered WALG_ROLE, so the PROMOTED node kept the standby write-guard —
  // wal-archive.sh and compose-backup.sh both no-op'd and the new primary
  // archived nothing until some later deploy happened to rewrite the roles.
  it('moves the wal-g write-guard AND the active ACME issuer onto the promoted node, demoting both on the old primary', async () => {
    // The ACME merges are the compose-ha single-active-issuer policy
    // (acme-role.js): the promoted node's disarm key is EMPTIED (falls
    // through to the real CA) and the retired node's is set to the
    // reserved-.invalid sentinel, so the swapped pair never runs two armed
    // solvers against one `_acme-challenge` TXT name (runs
    // 33273372657/33276113128).
    await failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker);

    expect(envMerges).toEqual([
      { ip: '2.2.2.2', updates: { WALG_ROLE: 'primary' } },
      { ip: '2.2.2.2', updates: { ACME_DISARMED_CA_SERVER: '' } },
      { ip: '1.1.1.1', updates: { WALG_ROLE: 'standby' } },
      {
        ip: '1.1.1.1',
        updates: { ACME_DISARMED_CA_SERVER: 'https://acme-disarmed.invalid/directory' },
      },
    ]);
  });

  it('recreates traefik on both nodes so the re-armed/disarmed caserver takes (command env is create-time)', async () => {
    await failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker);

    const traefikRecreates = sshCalls.filter((c) => c.command.includes('up -d --no-deps traefik'));
    expect(traefikRecreates.map((c) => c.ip).sort()).toEqual(['1.1.1.1', '2.2.2.2']);
  });

  it('demotes the old primary only AFTER its app tier is stopped', async () => {
    await failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker);

    // The demote recreates the old primary's db container. compose-HA keeps the
    // old primary SERVING until the promoted node is confirmed (DNS has not
    // flipped yet either), so demoting before the stop would bounce the
    // database out from under live traffic.
    // CONTAINER names, same RCA as the restart test above: the old shape
    // (`docker compose stop app auth … supavisor`) could not resolve the
    // overlay-only supavisor and exited ~2s having stopped NOTHING — the
    // old primary kept serving writes behind the SPLIT-BRAIN warning.
    const stopIdx = sshCalls.findIndex(
      (c) => c.ip === '1.1.1.1' && c.command.includes('docker stop myapp-app'),
    );
    const demoteIdx = sshCalls.findIndex(
      (c) => c.ip === '1.1.1.1' && c.command.includes('up -d --no-deps db'),
    );
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(demoteIdx).toBeGreaterThan(stopIdx);
    for (const svc of ['supavisor', 'auth', 'rest', 'realtime', 'storage', 'app']) {
      expect(sshCalls[stopIdx].command).toContain(`myapp-${svc}`);
    }
    expect(sshCalls.some((c) => /docker compose stop app/.test(c.command))).toBe(false);
  });

  it('recreates the promoted db container so the new WALG_ROLE is actually in its env', async () => {
    await failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker);

    // Writing .env is not enough: container env is fixed at create time, and
    // `docker compose restart` re-runs the SAME container. Only a recreate
    // (`up -d --no-deps db`) re-reads it.
    const recreate = sshCalls.find(
      (c) => c.ip === '2.2.2.2' && c.command.includes('up -d --no-deps db'),
    );
    expect(recreate).toBeDefined();
    // …with the node's real -f set, not a bare `docker compose up` (which would
    // resolve docker-compose.yml only and drop prod.yml + the replication overlay).
    expect(recreate?.command).toContain('-f docker-compose.yml -f docker-compose.prod.yml');
    expect(recreate?.command).toContain('docker-compose.replication.yml');
  });

  it('audits the promoted node in requirePrimary mode (a stale standby role must FAIL, not skip)', async () => {
    await failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker);

    const audit = sshCalls.find((c) => c.command.includes('WALG_AUDIT'));
    expect(audit?.ip).toBe('2.2.2.2');
    expect(audit?.command).toContain('WALG_AUDIT=fail:stale-standby-role');
    expect(audit?.command).not.toContain('WALG_AUDIT=skip:standby-write-guard');
    // The recreate has to precede the audit or the audit reads the OLD container.
    const recreateIdx = sshCalls.findIndex((c) => c.command.includes('up -d --no-deps db'));
    const auditIdx = sshCalls.findIndex((c) => c.command.includes('WALG_AUDIT'));
    expect(recreateIdx).toBeGreaterThanOrEqual(0);
    expect(recreateIdx).toBeLessThan(auditIdx);
  });

  it('fails the command when the promoted node cannot be proven to archive', async () => {
    // The probe reports the exact rot state: role still standby, node NOT in
    // recovery — i.e. it really is the promoted primary, archiving nothing.
    auditPayload = ['WALG_AUDIT=fail:stale-standby-role', 'WALG_AUDIT_RECOVERY=f'].join('\n');

    // The failover still COMPLETES (promote + role swap + DNS) — aborting after
    // a promotion would strand a promoted database behind un-flipped DNS — but
    // the command must not report success.
    await expect(
      failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker),
    ).rejects.toThrow(/FAILOVER COMPLETED, BACKUPS DID NOT/);
    expect(sshCalls.some((c) => c.command.includes('pg_promote'))).toBe(true);
    expect(saveProjectConfig).toHaveBeenCalled();
  });
});
