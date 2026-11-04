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

// The first base backup on the new timeline has its own tests
// (tests/unit/walg/post-promote-backup-census.test.ts, the step-order census);
// here it lands.
vi.mock('../../../src/lib/walg/post-promote-backup.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  pushBaseBackupAfterPromote: vi.fn(async () => ({ name: 'base_000000020000000000000004' })),
}));

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

/** Each node's wal-g role file, written and read through the real role shells. */
const roleFiles = new Map<string, string>();

/** The role-file surface: a write sets the node's file, a read answers it. */
async function roleSurface(ip: string, command: string): Promise<string | undefined> {
  const { composeRoleWriteOf } = await import('../helpers/compose-role-ssh.js');
  const wrote = composeRoleWriteOf(command);
  if (wrote) {
    roleFiles.set(ip, wrote);
    return `WALG_ROLE_FILE=${wrote}\n`;
  }
  if (command.includes('.vibecarbon-role') && command.includes('WALG_ROLE_FILE')) {
    return `WALG_ROLE_FILE=${roleFiles.get(ip) ?? ''}\n`;
  }
  return undefined;
}

/** What the audit probe reports this run; a test may swap in a failing shape. */
let auditPayload = WALG_AUDIT_PASS;
/** Flipped by the mocked pg_promote, so later replica-state reads see a primary. */
let promoted = false;
const SYSID = '7412345678901234567';

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const rec = async (ip: string, _k: string, command: unknown, options?: { input?: string }) => {
    const c = String(command);
    sshCalls.push({ ip, command: c, input: options?.input });
    const role = await roleSurface(ip, c);
    if (role !== undefined) return role;
    // The failover guard's replica-state read: the standby streams in recovery
    // until pg_promote lands, then reads out of recovery.
    if (c.includes('pg_control_system')) {
      return promoted ? `f|${SYSID}|0/3000060||` : `t|${SYSID}|0/3000060|streaming|1`;
    }
    if (c.includes('pg_promote')) {
      promoted = true;
      return 't';
    }
    if (c.includes('WALG_AUDIT')) return auditPayload; // backup audit verdict
    // new-primary app tier serves — the gate needs every labeled probe up
    if (c.includes('%{http_code}')) return 'app=200';
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

// The role-file writes go through ssh.js's argv sshRun (writeComposeWalgRole):
// recorded in the same call log, as the joined argv.
vi.mock('../../../src/lib/ssh.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const { assertSshRunArgv } = await import('../../_shared/ssh-contract.js');
  return {
    ...actual,
    sshRun: vi.fn(async (ip: string, _k: string, argv: unknown) => {
      assertSshRunArgv(argv);
      const command = argv.join(' ');
      sshCalls.push({ ip, command });
      return (await roleSurface(ip, command)) ?? '';
    }),
  };
});

// mergeRemoteDotenv scp's the remote .env: record the merges instead.
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

// The journal and the role swap write .vibecarbon.json: patch a fresh copy of
// the fixture and record the writes instead.
vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    loadProjectConfig: vi.fn(() => structuredClone(projectConfig)),
    updateProjectConfig: vi.fn((fn: (c: Record<string, unknown>) => unknown) => {
      const current = structuredClone(projectConfig) as Record<string, unknown>;
      return fn(current) ?? current;
    }),
  };
});

// The deploy_key existence gate in failoverComposeHA must pass.
vi.mock('node:fs', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, existsSync: () => true };
});

// The post-flip TLS gate would otherwise open a real socket to the test domain.
// The DNS flip is verified through the provider's own API now (R5); fake a
// provider that holds whatever it was last told.
let dnsHeld: string | null = null;
vi.mock('../../../src/lib/dns-provider.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    resolveDnsToken: () => 'dns-token',
    getDnsProvider: async () => ({
      upsertApexAndWildcard: async (_auth: unknown, _domain: string, ip: string) => {
        dnsHeld = ip;
      },
      readARecord: async () => (dnsHeld ? [dnsHeld] : []),
    }),
  };
});

// The public-DNS wait before the ACME arm (compose-failover-state-matrix pins
// its place): public resolvers already show the promoted node, no network.
vi.mock('../../../src/lib/dns-propagation.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  waitForDNSPropagation: vi.fn(async () => true),
}));

vi.mock('../../../src/lib/deploy/tls-ready.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    waitForTrustedTls: vi.fn(async () => ({ trusted: true, elapsedMs: 1 })),
  };
});

const { failoverComposeHA } = await import('../../../src/lib/deploy/compose/ha.js');
const { TLS_FIRST_LOOK_BUDGET_MS, waitForTrustedTls } = await import(
  '../../../src/lib/deploy/tls-ready.js'
);
const { updateProjectConfig } = await import('../../../src/lib/config.js');

const envConfig = {
  deployMode: 'compose-ha',
  replication: 'streaming',
  deployedAt: '2026-10-01T00:00:00.000Z',
  ha: { enabled: true, systemIdentifier: SYSID },
  domain: 'app.example.com',
  // Managed DNS so the post-flip TLS gate is reachable; no token in the test
  // env, so the DNS flip itself takes its warn branch without touching the
  // network.
  dns: { provider: 'digitalocean', zoneId: 'zone-1' },
  servers: [
    { role: 'primary', ip: '1.1.1.1', region: 'nbg1' },
    { role: 'standby', ip: '2.2.2.2', region: 'ash' },
  ],
};
const projectConfig = { projectName: 'myapp', environments: { prod: envConfig } };
// The primary does not answer pg_isready here while the standby still streams
// from it, which R8 refuses as "alive behind a partition" (classify-failover
// .test.ts); -force-unplanned is the operator saying it is gone anyway.
const parsed = { yes: true, dryRun: false, forceUnplanned: true };
const tracker = { spinner: () => ({ start() {}, stop() {} }) };

beforeEach(() => {
  sshCalls.length = 0;
  // As deployed: the -primary stack primary, the -standby stack standby.
  roleFiles.clear();
  roleFiles.set('1.1.1.1', 'primary');
  roleFiles.set('2.2.2.2', 'standby');
  envMerges.length = 0;
  auditPayload = WALG_AUDIT_PASS;
  promoted = false;
  vi.mocked(updateProjectConfig).mockClear();
});

describe('failoverComposeHA — standby already streaming', () => {
  it('skips the pg_basebackup re-seed and proceeds straight to promotion', async () => {
    await failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker);

    // The guard's replica-state read (which carries the walreceiver status) ran
    // against the STANDBY.
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
  // `docker compose restart <svc> ...`, and a service defined ONLY in
  // docker-compose.prod.yml failed service-name resolution (no -f chain on
  // the remote invocation), so it exited in ~2s having restarted NOTHING and
  // verify-failover failed on app_api_me_authenticated + db_write_roundtrip.
  // Container names (container_name: ${PROJECT_NAME}-<svc>, stamped on every
  // service) bypass compose file resolution entirely — the
  // hand-rolled-compose-invocation-drifts family (see
  // server-compose-command-census: a bare `docker compose` is banned).
  it('restarts the new-primary app tier by CONTAINER name, never bare compose service names', async () => {
    await failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker);

    const restart = sshCalls.find((c) => c.command.includes('docker restart'));
    expect(restart, 'app-tier restart invocation missing').toBeDefined();
    expect(restart?.ip).toBe('2.2.2.2'); // the promoted standby
    // Exactly the app: every other container the old stack restarted has been
    // removed, and naming one that does not exist makes `docker restart` exit
    // non-zero for the whole list.
    expect(restart?.command).toBe('docker restart myapp-app');
    // The 3/3-failing shape must never come back.
    expect(
      sshCalls.some((c) => /(?:docker compose|sh vc-compose) restart(?! db)/.test(c.command)),
    ).toBe(false);
  });

  // The bug this guards: failover swapped the roles in config but never moved
  // the wal-g role, so the PROMOTED node kept the standby write-guard:
  // wal-archive.sh and compose-backup.sh both no-op'd and the new primary
  // archived nothing until some later deploy happened to rewrite the roles.
  it('moves the wal-g role FILE and the active ACME issuer onto the promoted node, demoting both on the old primary', async () => {
    // The ACME merges are the compose-ha single-active-issuer policy
    // (acme-role.js): the retired node's disarm key is set to the
    // reserved-.invalid sentinel BEFORE the DNS flip, and the promoted node's
    // is EMPTIED (falls through to the real CA) after it, so only the node
    // DNS points at ever places an HTTP-01 order. The wal-g role is no longer
    // in .env at all.
    await failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker);

    expect(envMerges).toEqual([
      {
        ip: '1.1.1.1',
        updates: { ACME_DISARMED_CA_SERVER: 'https://acme-disarmed.invalid/directory' },
      },
      { ip: '2.2.2.2', updates: { ACME_DISARMED_CA_SERVER: '' } },
    ]);
    expect(roleFiles.get('2.2.2.2')).toBe('primary');
    expect(roleFiles.get('1.1.1.1')).toBe('standby');
  });

  // The role-gated container reconcile is gone with the service it held off
  // the standby, and the wal-g role moves with a host write: no `up -d
  // --no-deps <svc>` other than the traefik recreates may run on either node.
  it('recreates nothing but traefik during the role swap (never the db)', async () => {
    await failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker);

    const recreated = sshCalls
      .map((c) => /up -d --no-deps ([\w-]+)/.exec(c.command)?.[1])
      .filter((svc): svc is string => Boolean(svc));
    expect(recreated.length).toBeGreaterThan(0);
    expect(new Set(recreated)).toEqual(new Set(['traefik']));
  });

  it('gates failover completion on the domain serving trusted TLS (post-DNS-flip)', async () => {
    // Run 33279912405 attempt 2: the arm/disarm both landed (traefik
    // recreated on both nodes) but verify-failover's 180s ssl_valid budget
    // expired while the promoted node's fresh issuance was still in flight. Same rule as deploy: a failover is not done until the domain
    // serves trusted TLS — the failover CLI waits (warn-don't-abort: DR
    // completion beats cert perfection) so downstream checks start AFTER
    // issuance in the normal case.
    await failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker);

    // The deploy's first-look budget: past it the promoted node's tls-retry
    // cron takes over, so failover never holds the outage report open longer.
    expect(waitForTrustedTls).toHaveBeenCalledWith(
      'app.example.com',
      expect.objectContaining({ budgetMs: TLS_FIRST_LOOK_BUDGET_MS }),
    );
  });

  it('recreates traefik on both nodes so the re-armed/disarmed caserver takes (command env is create-time)', async () => {
    await failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker);

    const traefikRecreates = sshCalls.filter((c) => c.command.includes('up -d --no-deps traefik'));
    expect(traefikRecreates.map((c) => c.ip).sort()).toEqual(['1.1.1.1', '2.2.2.2']);
  });

  it('demotes the old primary only AFTER its app tier is stopped', async () => {
    await failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker);

    // compose-HA keeps the old primary SERVING until the promoted node is
    // confirmed (DNS has not flipped yet either), and a node whose role file
    // reads standby drops every WAL segment it completes, so the demote
    // waits for the stop.
    // CONTAINER names, same RCA as the restart test above: the old shape
    // (`docker compose stop app …`) could not resolve an overlay-only service
    // and exited ~2s having stopped NOTHING — the old primary kept serving
    // writes behind the SPLIT-BRAIN warning.
    const { composeRoleWriteOf } = await import('../helpers/compose-role-ssh.js');
    const stopIdx = sshCalls.findIndex(
      (c) => c.ip === '1.1.1.1' && c.command.includes('for c in myapp-app;'),
    );
    const demoteIdx = sshCalls.findIndex(
      (c) => c.ip === '1.1.1.1' && composeRoleWriteOf(c.command) === 'standby',
    );
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(demoteIdx).toBeGreaterThan(stopIdx);
    // Exactly the app, and by inspect-then-stop: a missing container makes a
    // plain `docker stop` exit non-zero, which reads as the split-brain warning.
    expect(sshCalls[stopIdx].command).toContain('docker container inspect');
    expect(sshCalls[stopIdx].command).toContain('docker stop "$c"');
    expect(sshCalls.some((c) => /(?:docker compose|sh vc-compose) stop app/.test(c.command))).toBe(
      false,
    );
  });

  it('arms the promoted node by a host role-file write BEFORE pg_promote, with no db recreate', async () => {
    await failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker);

    const { composeRoleWriteOf } = await import('../helpers/compose-role-ssh.js');
    const arm = sshCalls.findIndex(
      (c) => c.ip === '2.2.2.2' && composeRoleWriteOf(c.command) === 'primary',
    );
    const promote = sshCalls.findIndex((c) => c.command.includes('pg_promote'));
    expect(arm).toBeGreaterThanOrEqual(0);
    expect(arm).toBeLessThan(promote);
    // On the host, through the one writer: /opt/<project>/.vibecarbon-role.
    expect(sshCalls[arm].command).toContain('/opt/myapp/.vibecarbon-role');
    // No db recreate, whatever spelling: the old one ran through compose's `up`.
    expect(sshCalls.some((c) => c.command.includes('up -d --no-deps db'))).toBe(false);
  });

  it('audits the promoted node in requirePrimary mode (a stale standby role must FAIL, not skip)', async () => {
    await failoverComposeHA('prod', envConfig, projectConfig, parsed, tracker);

    const audit = sshCalls.find((c) => c.command.includes('WALG_AUDIT'));
    expect(audit?.ip).toBe('2.2.2.2');
    expect(audit?.command).toContain('WALG_AUDIT=fail:stale-standby-role');
    expect(audit?.command).not.toContain('WALG_AUDIT=skip:standby-write-guard');
    // The audit runs after the promote, on the role the arm wrote before it.
    const promoteIdx = sshCalls.findIndex((c) => c.command.includes('pg_promote'));
    const auditIdx = sshCalls.findIndex((c) => c.command.includes('WALG_AUDIT'));
    expect(promoteIdx).toBeGreaterThanOrEqual(0);
    expect(promoteIdx).toBeLessThan(auditIdx);
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
    expect(updateProjectConfig).toHaveBeenCalled();
  });
});
