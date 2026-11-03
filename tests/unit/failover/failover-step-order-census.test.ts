/**
 * Failover step-order census (HA-correctness Task 3, H1), both tiers.
 *
 * A planned failover is zero-data-loss only in this order:
 *   stopWriters (the outward signal; on k8s proven by writersGone, the
 *   quiesced pods actually gone) < fence (ALTER SYSTEM SET
 *   default_transaction_read_only = on) < terminate (no session opened before
 *   the fence survives) < captureLsn (the primary's final WAL position) <
 *   catchUp (the standby replayed up to it) < promote < dns.
 * compose-ha used to promote while the old primary's app kept taking writes,
 * and stopped it 2-6 minutes later: every write in that window was lost. k8s
 * quiesced first. Both tiers now share one catch-up gate, and this census pins
 * the order on each by recording the seams as they are called.
 *
 * fence, terminate, captureLsn and catchUp are recorded at the psql seam (the
 * SQL itself), so the census exercises the real shared fenceDatabaseWrites and
 * waitForStandbyCaughtUp and each tier's default wiring of them, not stubs. A
 * scale that was never confirmed is not the fence: k8s records writersGone only
 * when the real waitForAppTierGone reads the quiesced pods gone.
 *
 * Unplanned (the primary does not answer): promote < dns, and nothing is fenced
 * or read on the unreachable side before the promote.
 *
 * Both tiers arm the promoted side BEFORE pg_promote (D2), while the standby
 * is still in recovery (where archive_command never runs), and nothing
 * restarts the db: k8s applies the vibecarbon-db-role intent, then writes the
 * live role file; compose writes the host role file
 * (/opt/<project>/.vibecarbon-role) over ssh and reads it back. A failed arm
 * aborts before the promote and disarms the standby, unless an earlier run's
 * journaled promote may still land; a k8s standby db pod without the role
 * mount is refused at STEP 1, before anything changes.
 *
 * Both modes, both tiers: the first base backup on the new timeline
 * (pushBaseBackupAfterPromote, H2b) comes after the wal-g role move
 * (restorePromotedWalgRole / auditComposeWalgRole) and after the role-swap save that clears
 * ha.failoverInFlight (swapHaRoles / swapComposeHaRoles), and after the DNS
 * flip. It is anchored on those calls, not on the config save underneath.
 * A wal-g role move that failed skips it (one error names both), and a failed
 * push fails the command once the roles are saved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { argvOver, composeRoleReply, composeRoleWriteOf } from '../helpers/compose-role-ssh.js';
import { k8sRoleReply } from '../helpers/k8s-role-kubectl.js';

vi.mock('../../../src/lib/ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/ssh.js')>()),
  getPostgresPod: vi.fn(async () => 'db-0'),
  sshKubectl: vi.fn(),
}));

const order: string[] = [];

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const rec = (_ip: string, _k: string, command: unknown) => {
    const c = String(command);
    if (c.includes('WALG_AUDIT')) {
      return [
        'WALG_AUDIT=probed',
        'WALG_AUDIT_PREFIX=s3://bucket/backups/myapp/walg',
        'WALG_AUDIT_RC=0',
        'WALG_AUDIT_ARCHIVER=3|0|000000010000000000000003||2026-07-30 12:00:00+00||f',
        'WALG_AUDIT_LIST_BEGIN',
        '[{"backup_name":"base_000000010000000000000002","time":"2026-07-30T12:00:00Z"}]',
        'WALG_AUDIT_LIST_END',
      ].join('\n');
    }
    if (c.includes('%{http_code}')) return 'app=200';
    return '';
  };
  return {
    ...actual,
    sshRun: vi.fn(rec),
    sshRunAsync: vi.fn(rec),
    sshRunChecked: vi.fn(async (ip: string, k: string, c: unknown) => rec(ip, k, c)),
  };
});

vi.mock('../../../src/lib/deploy/utils.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, mergeRemoteDotenv: vi.fn(async () => {}) };
});

let composeFlippedTo: string | null = null;

vi.mock('../../../src/lib/dns-provider.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    resolveDnsToken: () => 'dns-token',
    getDnsProvider: async () => ({
      upsertApexAndWildcard: async (_auth: unknown, _domain: string, ip: string) => {
        order.push('dns');
        composeFlippedTo = ip;
      },
      readARecord: async () => (composeFlippedTo && !dnsFails ? [composeFlippedTo] : []),
    }),
  };
});

vi.mock('../../../src/lib/deploy/tls-ready.js', () => ({
  TLS_FIRST_LOOK_BUDGET_MS: 180_000,
  waitForTrustedTls: async () => ({ trusted: true, elapsedMs: 0 }),
}));

vi.mock('node:fs', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, existsSync: () => true };
});

const ssh = await import('../../../src/lib/ssh.js');
const { failoverHA } = await import('../../../src/failover.js');
const { failoverComposeHA, auditComposeWalgRole } = await import(
  '../../../src/lib/deploy/compose/ha.js'
);

const SYSID = '7412345678901234567';
const PRIMARY_LSN = '0/3000060';
const PRIMARY_IP = '10.0.0.1';
const STANDBY_IP = '10.0.0.9';

const standbyState = (over: Record<string, unknown> = {}) => ({
  inRecovery: true,
  systemIdentifier: SYSID,
  replayLsn: PRIMARY_LSN,
  receiverStatus: 'streaming',
  lastMsgAgeS: 1,
  ...over,
});
const primaryState = () =>
  standbyState({ inRecovery: false, receiverStatus: null, lastMsgAgeS: null });

/**
 * A psql seam that records the two catch-up queries by meaning: the primary's
 * pg_current_wal_lsn() is captureLsn, the standby's replay-lag read is catchUp.
 */
const fenced = new Set<string>();
const recordingPsql = (ip: string) => async (sql: string) => {
  const side = ip === PRIMARY_IP ? '' : '@standby';
  if (/^ALTER SYSTEM SET default_transaction_read_only = on$/.test(sql)) {
    order.push(`fence${side}`);
    fenced.add(ip);
    return '';
  }
  if (/^ALTER SYSTEM RESET default_transaction_read_only$/.test(sql)) {
    order.push(`unfence${side}`);
    fenced.delete(ip);
    return '';
  }
  if (sql === 'SELECT pg_reload_conf()') return 't\n';
  if (/current_setting\('default_transaction_read_only'\)/.test(sql)) {
    return fenced.has(ip) ? 'on\n' : 'off\n';
  }
  if (/pg_terminate_backend/.test(sql)) {
    order.push(`terminate${side}`);
    return '4242=t\n';
  }
  if (/FROM pg_stat_activity WHERE pid IN \(4242\)/.test(sql)) return '0\n';
  if (/pg_current_wal_lsn\(\)/.test(sql)) {
    order.push(ip === PRIMARY_IP ? 'captureLsn' : 'captureLsn@standby');
    return `${PRIMARY_LSN}\n`;
  }
  if (/pg_last_wal_replay_lsn\(\)/.test(sql)) {
    order.push(ip === STANDBY_IP ? 'catchUp' : 'catchUp@primary');
    return '0\n';
  }
  order.push(`psql:${sql.slice(0, 40)}`);
  return '';
};

let walgArmed = true;
let dnsFails = false;
let pushFails: string | null = null;
const pushArgs: Array<Record<string, unknown>> = [];

const tracker = { spinner: () => ({ start() {}, stop() {}, message() {} }) };

/** Index of the first occurrence; -1 fails every `<` assertion below. */
const at = (step: string) => order.indexOf(step);

const PLANNED = ['stopWriters', 'fence', 'terminate', 'captureLsn', 'catchUp', 'promote', 'dns'];

function expectPlannedOrder() {
  for (const step of PLANNED) {
    expect(order, `planned failover never reached ${step}`).toContain(step);
  }
  expect(at('stopWriters')).toBeLessThan(at('fence'));
  expect(at('marker'), 'the fence is recorded before it is applied').toBeLessThan(at('fence'));
  expect(at('fence'), 'the database fence comes before its sessions are terminated').toBeLessThan(
    at('terminate'),
  );
  expect(
    at('terminate'),
    'every pre-fence session must be gone before the LSN is captured',
  ).toBeLessThan(at('captureLsn'));
  expect(at('captureLsn')).toBeLessThan(at('catchUp'));
  expect(at('catchUp'), 'the standby must be caught up before the promote').toBeLessThan(
    at('promote'),
  );
  expect(at('promote')).toBeLessThan(at('dns'));
}

function expectUnplannedOrder() {
  expect(order).toContain('promote');
  expect(order).toContain('dns');
  expect(at('promote')).toBeLessThan(at('dns'));
  const beforePromote = order.slice(0, at('promote'));
  expect(
    beforePromote,
    'nothing is fenced on the unreachable side before the promote',
  ).not.toContain('fence');
  for (const step of ['stopWriters', 'fence', 'terminate', 'captureLsn', 'catchUp']) {
    expect(order).not.toContain(step);
  }
}

afterEach(() => {
  order.length = 0;
  fenced.clear();
  pushArgs.length = 0;
  walgArmed = true;
  dnsFails = false;
  pushFails = null;
  vi.clearAllMocks();
});

type KubectlSeam = (ip: string, argv: string[], o?: { input?: string }) => Promise<string>;

/** The census's k8s cluster: the role surface, recording the arm's live write. */
const censusKubectl: KubectlSeam = async (ip, argv) => {
  const reply = k8sRoleReply(argv);
  if (argv.includes('exec') && reply?.includes('WALG_ROLE_FILE=primary')) {
    order.push(ip === STANDBY_IP ? 'arm' : 'arm@primary');
  }
  return reply ?? '';
};

async function runK8s(
  primaryReachable: boolean,
  over: {
    kubectl?: KubectlSeam;
    promote?: () => unknown;
    /** An earlier run's failover journal, present at entry. */
    journal?: boolean;
    writeJournal?: () => Promise<unknown>;
  } = {},
) {
  const servers = {
    primary: { ip: PRIMARY_IP, floatingIp: PRIMARY_IP, region: 'nbg1' },
    standby: { ip: STANDBY_IP, floatingIp: '10.0.0.99', region: 'ash' },
  };
  const envConfig = {
    domain: 'app.example.com',
    region: 'nbg1',
    secondaryRegion: 'ash',
    replication: 'streaming',
    deployedAt: '2026-10-01T00:00:00.000Z',
    ha: {
      primary: { masterIp: PRIMARY_IP },
      standby: { masterIp: STANDBY_IP },
      systemIdentifier: SYSID,
      ...(over.journal && {
        failoverInFlight: { target: 'standby', systemIdentifier: SYSID, primaryLsn: null },
      }),
    },
  };
  const deps = {
    identify: () => servers,
    getKeyPath: () => '/fake/key',
    keyExists: () => true,
    // The live standby image check (standby-image-precheck.test.ts): present.
    assertStandbyImage: async () => 'sha256:aa',
    preflight: async () => ({
      workerSpec: { count: 2, serverType: 'cx23' },
      scaleUpList: [{ name: 'app', namespace: 'vibecarbon', replicas: 2 }],
      creds: {},
    }),
    provision: async () => ({ provisioned: true as const }),
    isPrimaryReady: async () => primaryReachable,
    readStandbyState: async () =>
      primaryReachable ? standbyState() : standbyState({ receiverStatus: null, lastMsgAgeS: null }),
    readPrimaryState: async () => primaryState(),
    psql: (ip: string) => recordingPsql(ip),
    isStreaming: async () => true,
    scale: async (ip: string, _k: string, _l: unknown, _r: unknown, label: string) => {
      if (/^quiesce primary/.test(label)) {
        order.push(ip === PRIMARY_IP ? 'stopWriters' : 'stopWriters@standby');
      }
    },
    reseed: async () => {},
    writeMarker: () => {
      order.push('marker');
    },
    clearMarker: () => {},
    writeJournal: over.writeJournal ?? (async () => 'journal-id'),
    clearJournal: async () => {},
    promote:
      over.promote ??
      (async () => {
        order.push('promote');
        return 'promoted';
      }),
    kubectl: over.kubectl ?? censusKubectl,
    restoreWalgRole: async () => {
      order.push('walgRole');
      return {
        promoted: walgArmed
          ? { ok: true as const }
          : { ok: false as const, error: new Error('no') },
        demoted: { ok: true as const },
      };
    },
    gate: async () => {},
    promoteIssuer: async () => ({ patched: [] }),
    swapRoles: () => {
      order.push('swap');
    },
    pushBaseBackup: async (a: Record<string, unknown>) => {
      order.push('basePush');
      pushArgs.push(a);
      if (pushFails) throw new Error(pushFails);
      return { name: 'base_000000020000000000000004' };
    },
    reconcileRetired: async () => ({ fenced: [], unreachable: [] }),
    writeFence: async () => ({ ok: true }),
    recordFence: () => {},
  };
  let flippedTo: string | null = null;
  const strategy = {
    getAuth: async () => ({ token: 't', zoneId: 'z' }),
    updateDns: async (_auth: unknown, _domain: string, ip: string) => {
      order.push('dns');
      flippedTo = ip;
    },
    readDns: async () => (flippedTo && !dnsFails ? [flippedTo] : []),
  };
  // The real waitForAppTierGone reads the quiesced Deployment's selector, then
  // its pods: none left is the proof (writersGone).
  vi.mocked(ssh.sshKubectl).mockImplementation(async (_ip, _k, argv: string[]) => {
    if (argv[0] === 'get' && argv[1] === 'deployment') return '{"app":"app"}';
    if (argv[0] === 'get' && argv[1] === 'pods') {
      order.push('writersGone');
      return '';
    }
    return '';
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  try {
    await failoverHA(
      'prod',
      envConfig,
      {},
      { dryRun: false, yes: true, serverType: null },
      tracker,
      strategy,
      // biome-ignore lint/suspicious/noExplicitAny: injected test deps bag.
      deps as any,
    );
  } finally {
    exitSpy.mockRestore();
  }
}

type ComposeRun = (ip: string, k: string, command: string) => Promise<string | false>;

/** A passing wal-g audit payload: storage reachable, one base backup visible. */
const COMPOSE_AUDIT_PASS = [
  'WALG_AUDIT=probed',
  'WALG_AUDIT_PREFIX=s3://bucket/backups/myapp/walg',
  'WALG_AUDIT_RC=0',
  'WALG_AUDIT_ARCHIVER=3|0|000000010000000000000003||2026-07-30 12:00:00+00||f',
  'WALG_AUDIT_LIST_BEGIN',
  '[{"backup_name":"base_000000010000000000000002","time":"2026-07-30T12:00:00Z"}]',
  'WALG_AUDIT_LIST_END',
].join('\n');

/** A compose node over ssh: the role-file surface and the audit; '' for the rest. */
const composeReply = (cmd: string) =>
  composeRoleReply(cmd) ?? (cmd.includes('WALG_AUDIT') ? COMPOSE_AUDIT_PASS : '');

/** The census's compose ssh seam: records the arm (the primary role written on the standby). */
const censusComposeRun: ComposeRun = async (ip, _k, cmd) => {
  if (composeRoleWriteOf(cmd) === 'primary') {
    order.push(ip === STANDBY_IP ? 'arm' : 'arm@primary');
  }
  return composeReply(cmd);
};

async function runCompose(
  primaryReachable: boolean,
  over: {
    run?: ComposeRun;
    promote?: () => unknown;
    /** An earlier run's failover journal, present at entry. */
    journal?: boolean;
    writeJournal?: () => Promise<unknown>;
  } = {},
) {
  const run = over.run ?? censusComposeRun;
  const envConfig = {
    deployMode: 'compose-ha',
    domain: 'app.example.com',
    region: 'nbg1',
    secondaryRegion: 'ash',
    replication: 'streaming',
    deployedAt: '2026-10-01T00:00:00.000Z',
    dns: { provider: 'cloudflare', zoneId: 'zone-1' },
    servers: [
      { name: 'myapp-prod-primary', role: 'primary', ip: PRIMARY_IP, region: 'nbg1' },
      { name: 'myapp-prod-standby', role: 'standby', ip: STANDBY_IP, region: 'ash' },
    ],
    ha: {
      enabled: true,
      failoverRegion: 'ash',
      systemIdentifier: SYSID,
      ...(over.journal && {
        failoverInFlight: { target: 'standby', systemIdentifier: SYSID, primaryLsn: null },
      }),
    },
    backup: { retentionDays: 14 },
  };
  const deps = {
    isPrimaryReachable: async () => primaryReachable,
    // The real role writer (writeComposeWalgRole) over the census's ssh seam.
    roleRun: argvOver(run),
    // The db containers bind the role directory (compose-ha-failover-role-bind).
    probeRoleBind: async () => true,
    readState: async (ip: string) =>
      ip === PRIMARY_IP
        ? primaryState()
        : primaryReachable
          ? standbyState()
          : standbyState({ receiverStatus: null, lastMsgAgeS: null }),
    psql: (ip: string) => recordingPsql(ip),
    reseed: async () => {
      order.push('reseed');
    },
    recordSeeded: () => {},
    writeMarker: () => {
      order.push('marker');
    },
    clearMarker: () => {},
    writeJournal: over.writeJournal ?? (async () => 'journal-id'),
    clearJournal: async () => {},
    promote:
      over.promote ??
      (async () => {
        order.push('promote');
        return 'promoted';
      }),
    stopWriters: async (ip: string) => {
      order.push(ip === PRIMARY_IP ? 'stopWriters' : 'stopWriters@standby');
      return { ok: true, stopped: ['myapp-app'] };
    },
    startWriters: async () => {
      order.push('unfence');
      return true;
    },
    fenceOldPrimary: async (ip: string) => {
      order.push(ip === PRIMARY_IP ? 'stopApp' : 'stopApp@standby');
      return { ok: true, reached: true };
    },
    confirmUnproven: async () => {},
    restoreWalgRole: async (a: Parameters<typeof auditComposeWalgRole>[0]) => {
      const health = walgArmed
        ? await auditComposeWalgRole({ ...a, deps: { run, log: () => {} } })
        : { ok: false, error: new Error('no') };
      order.push('walgRole');
      return health;
    },
    swapRoles: () => {
      order.push('swap');
    },
    pushBaseBackup: async (a: Record<string, unknown>) => {
      order.push('basePush');
      pushArgs.push(a);
      if (pushFails) throw new Error(pushFails);
      return { name: 'base_000000020000000000000004' };
    },
    reconcileRetired: async () => ({ fenced: [], unreachable: [] }),
    writeFence: async () => ({ ok: true }),
    recordFence: () => {},
  };
  await failoverComposeHA(
    'prod',
    envConfig,
    { projectName: 'myapp', environments: { prod: envConfig } },
    { yes: true, dryRun: false },
    tracker,
    // biome-ignore lint/suspicious/noExplicitAny: injected test deps bag.
    deps as any,
  );
}

/** A kubectl reply for runFailoverK8s: the role surface, '' for the rest. */
const k8sReply = (argv: string[], o: { roleMount?: boolean; markerGrep?: string } = {}) =>
  k8sRoleReply(argv, o) ?? '';

/** The real failoverHA (planned), with the census's seams and the given kubectl and promote. */
const runFailoverK8s = (stubs: { kubectl: KubectlSeam; promote: () => unknown }) =>
  runK8s(true, stubs);

describe('k8s-ha: the wal-g role moves before the promote, with no db restart (D2)', () => {
  it('k8s: the promoted side is armed BEFORE pg_promote, by apply + live write, and nothing rolls the db', async () => {
    const log: string[] = [];
    await runFailoverK8s({
      kubectl: async (_ip, argv, o) => {
        log.push(`${argv.join(' ')} ${o?.input ?? ''}`);
        return k8sReply(argv);
      },
      promote: async () => {
        log.push('PROMOTE');
        return 'promoted';
      },
    });
    const intent = log.findIndex(
      (l) => l.includes('apply -f -') && l.includes('VC_WALG_ROLE_INTENT: primary'),
    );
    const live = log.findIndex(
      (l) => l.includes('exec') && l.includes('/var/lib/vibecarbon/role') && l.includes('primary'),
    );
    const promote = log.indexOf('PROMOTE');
    expect(intent).toBeGreaterThanOrEqual(0);
    expect(live).toBeGreaterThan(intent);
    expect(promote).toBeGreaterThan(live);
    expect(log.some((l) => /set env statefulset\/db|rollout status statefulset\/db/.test(l))).toBe(
      false,
    );
  });

  it('k8s: a failed live role write aborts BEFORE promotion', async () => {
    const promote = vi.fn();
    await expect(
      runFailoverK8s({
        kubectl: async (_ip, argv) => {
          if (argv.includes('exec') && argv.join(' ').includes('walg-role'))
            throw new Error('exec failed');
          return k8sReply(argv);
        },
        promote,
      }),
    ).rejects.toThrow(/before promotion/i);
    expect(promote).not.toHaveBeenCalled();
  });

  it('k8s: a failed arm disarms the standby before the abort (never a half-armed node)', async () => {
    const inputs: string[] = [];
    const promote = vi.fn();
    const err = await runFailoverK8s({
      kubectl: async (_ip, argv, o) => {
        if (o?.input) inputs.push(o.input);
        // The primary write lands but reads back wrong; the standby write lands.
        if (argv.includes('exec') && argv.join(' ').includes("'%s\\n' primary")) {
          return 'WALG_ROLE_FILE=\n';
        }
        return k8sReply(argv);
      },
      promote,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/before promotion/i);
    expect(err.message).toMatch(/read-back-mismatch/);
    expect(err.message).toMatch(/disarmed/);
    expect(promote).not.toHaveBeenCalled();
    expect(inputs.map((i) => /VC_WALG_ROLE_INTENT: (\w+)/.exec(i)?.[1])).toEqual([
      'primary',
      'standby',
    ]);
    // The planned run lifts the fence it put on the primary.
    expect(at('fence')).toBeLessThan(at('unfence'));
  });

  /** A kubectl seam recording each role intent applied, whose primary live write reads back wrong. */
  const failingArm =
    (inputs: string[]): KubectlSeam =>
    async (_ip, argv, o) => {
      if (o?.input) inputs.push(/VC_WALG_ROLE_INTENT: (\w+)/.exec(o.input)?.[1] ?? '?');
      if (argv.includes('exec') && argv.join(' ').includes("'%s\\n' primary")) {
        return 'WALG_ROLE_FILE=\n';
      }
      return k8sReply(argv);
    };

  it('k8s: a failed arm on a rerun with a journal leaves the standby armed: an earlier promote may still land', async () => {
    const inputs: string[] = [];
    const promote = vi.fn();
    const err = await runK8s(false, {
      journal: true,
      kubectl: failingArm(inputs),
      promote,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/may still land/);
    expect(err.message).not.toMatch(/Nothing was promoted/);
    expect(err.message).toMatch(/vibecarbon failover prod/);
    expect(promote).not.toHaveBeenCalled();
    // No disarm: `standby` on a node whose promote is landing would drop its
    // .history and .partial files.
    expect(inputs).toEqual(['primary']);
  });

  it('k8s: a failed journal write after a clean arm disarms the standby (no journal at entry)', async () => {
    const inputs: string[] = [];
    const promote = vi.fn();
    const err = await runK8s(true, {
      kubectl: async (_ip, argv, o) => {
        if (o?.input) inputs.push(/VC_WALG_ROLE_INTENT: (\w+)/.exec(o.input)?.[1] ?? '?');
        return k8sReply(argv);
      },
      writeJournal: async () => {
        throw new Error('could not save .vibecarbon.json: EACCES');
      },
      promote,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/EACCES/);
    expect(err.message).toMatch(/disarmed/);
    expect(promote).not.toHaveBeenCalled();
    expect(inputs).toEqual(['primary', 'standby']);
    expect(at('fence')).toBeLessThan(at('unfence'));
  });

  it('k8s: a standby db pod without the role mount (a pre-release cluster) is refused at STEP 1, before anything changes (C18)', async () => {
    const calls: string[] = [];
    const promote = vi.fn();
    await expect(
      runFailoverK8s({
        kubectl: async (_ip, argv) => {
          calls.push(argv.join(' '));
          return k8sReply(argv, { roleMount: false });
        },
        promote,
      }),
    ).rejects.toThrow(/predates[\s\S]*vibecarbon deploy/);
    expect(promote).not.toHaveBeenCalled();
    expect(calls.some((c) => /scale |apply -f -|exec .*walg-role/.test(c))).toBe(false);
    expect(order).not.toContain('stopWriters');
  });
});

describe('k8s-ha: D1, the in-place reseed guard at STEP 1', () => {
  it('k8s: the in-place guard runs at STEP 1, before the replica proof, provisioning or quiesce', async () => {
    const log: string[] = [];
    const promote = vi.fn();
    await expect(
      runFailoverK8s({
        kubectl: async (_ip, argv) => {
          log.push(argv.join(' '));
          return k8sReply(argv, { markerGrep: '0' });
        },
        promote,
      }),
    ).rejects.toThrow(/predates in-place reseeds[\s\S]*vibecarbon deploy prod/);
    // The guard's own exec greps the mounted wrapper (and reads recovery in
    // the same exec); nothing else ran.
    const rest = log.filter((l) => !l.includes('db-guard.sh'));
    expect(rest.some((l) => /scale |pg_stat_wal_receiver|exec .*psql|apply -f -/.test(l))).toBe(
      false,
    );
    expect(order).toEqual([]);
    expect(promote).not.toHaveBeenCalled();
  });

  it('k8s: a guard that fails for another reason (unreadable, not D1) is left to the replica proof', async () => {
    await runFailoverK8s({
      kubectl: async (_ip, argv) => {
        if (argv.includes('configmap')) throw new Error('ssh: connection reset');
        return k8sReply(argv);
      },
      promote: async () => {
        order.push('promote');
        return 'promoted';
      },
    }).catch(() => {});
    expect(order).toContain('stopWriters');
  });
});

/** The real failoverComposeHA (planned), with the census's seams and the given ssh run and promote. */
const runFailoverCompose = (stubs: { run: ComposeRun; promote: () => unknown }) =>
  runCompose(true, stubs);

describe('compose-ha: the wal-g role moves before the promote, with no db recreate (D2)', () => {
  it('compose: the promoted host role file is written BEFORE pg_promote; no db recreate', async () => {
    const cmds: string[] = [];
    await runFailoverCompose({
      run: async (_ip, _k, cmd) => {
        cmds.push(cmd);
        return composeReply(cmd);
      },
      promote: async () => {
        cmds.push('PROMOTE');
        return 'promoted';
      },
    });
    const write = cmds.findIndex(
      (c) => c.includes('.vibecarbon-role') && c.includes("'%s\\n' primary"),
    );
    expect(write).toBeGreaterThanOrEqual(0);
    expect(write).toBeLessThan(cmds.indexOf('PROMOTE'));
    expect(cmds.some((c) => c.includes('up -d --no-deps db'))).toBe(false);
  });

  it('compose: a role file that does not read back primary aborts BEFORE promotion', async () => {
    const promote = vi.fn();
    await expect(
      runFailoverCompose({
        run: async (_ip, _k, cmd) =>
          composeRoleWriteOf(cmd) === 'primary' ? 'WALG_ROLE_FILE=\n' : composeReply(cmd),
        promote,
      }),
    ).rejects.toThrow(/before promotion/i);
    expect(promote).not.toHaveBeenCalled();
  });

  /** A compose ssh seam recording each role written, whose primary write reads back wrong. */
  const failingComposeArm =
    (roles: string[]): ComposeRun =>
    async (_ip, _k, cmd) => {
      const role = composeRoleWriteOf(cmd);
      if (role) roles.push(role);
      return role === 'primary' ? 'WALG_ROLE_FILE=\n' : composeReply(cmd);
    };

  it('compose: a failed arm disarms the standby before the abort (never a half-armed node)', async () => {
    const roles: string[] = [];
    const promote = vi.fn();
    const err = await runFailoverCompose({ run: failingComposeArm(roles), promote }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/before promotion/i);
    expect(err.message).toMatch(/disarmed/);
    expect(err.message).toMatch(/Nothing was promoted/);
    expect(promote).not.toHaveBeenCalled();
    expect(roles).toEqual(['primary', 'standby']);
    // The planned run lifts the fence it put on the primary.
    expect(at('fence')).toBeLessThan(at('unfence'));
  });

  it('compose: a failed arm on a rerun with a journal leaves the standby armed: an earlier promote may still land', async () => {
    const roles: string[] = [];
    const promote = vi.fn();
    const err = await runCompose(false, {
      journal: true,
      run: failingComposeArm(roles),
      promote,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/may still land/);
    expect(err.message).not.toMatch(/Nothing was promoted/);
    expect(err.message).toMatch(/vibecarbon failover prod/);
    expect(promote).not.toHaveBeenCalled();
    expect(roles).toEqual(['primary']);
  });

  it('compose: a failed journal write after a clean arm disarms the standby (no journal at entry)', async () => {
    const roles: string[] = [];
    const promote = vi.fn();
    const err = await runCompose(true, {
      run: async (_ip, _k, cmd) => {
        const role = composeRoleWriteOf(cmd);
        if (role) roles.push(role);
        return composeReply(cmd);
      },
      writeJournal: async () => {
        throw new Error('could not save .vibecarbon.json: EACCES');
      },
      promote,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/EACCES/);
    expect(err.message).toMatch(/disarmed/);
    expect(promote).not.toHaveBeenCalled();
    expect(roles).toEqual(['primary', 'standby']);
    expect(at('fence')).toBeLessThan(at('unfence'));
  });

  it('compose: a failed journal write on a rerun with a journal keeps the arm: an earlier promote may still land', async () => {
    const roles: string[] = [];
    const promote = vi.fn();
    const err = await runCompose(false, {
      journal: true,
      run: async (_ip, _k, cmd) => {
        const role = composeRoleWriteOf(cmd);
        if (role) roles.push(role);
        return composeReply(cmd);
      },
      writeJournal: async () => {
        throw new Error('could not save .vibecarbon.json: EACCES');
      },
      promote,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/EACCES/);
    expect(err.message).toMatch(/may still land/);
    expect(err.message).not.toMatch(/disarmed/);
    expect(promote).not.toHaveBeenCalled();
    // No disarm: `standby` on a node whose earlier promote is landing would
    // drop its .history and .partial files.
    expect(roles).toEqual(['primary']);
  });
});

describe('failover step order: k8s-ha (failoverHA)', () => {
  it('planned: stopWriters < writersGone < fence < terminate < captureLsn < catchUp < arm < promote < dns', async () => {
    await runK8s(true);
    expectPlannedOrder();
    expect(at('catchUp')).toBeLessThan(at('arm'));
    expect(at('arm'), 'the promoted side is armed before the promote (D2)').toBeLessThan(
      at('promote'),
    );
    expect(order, 'an unconfirmed scale is not the fence').toContain('writersGone');
    expect(at('stopWriters')).toBeLessThan(at('writersGone'));
    expect(at('writersGone')).toBeLessThan(at('fence'));
  });

  it('unplanned: promote < dns, nothing fenced or read on the unreachable primary first', async () => {
    await runK8s(false);
    expectUnplannedOrder();
    expect(at('arm')).toBeGreaterThan(-1);
    expect(at('arm')).toBeLessThan(at('promote'));
    expect(order).not.toContain('arm@primary');
  });
});

describe('failover step order: compose-ha (failoverComposeHA)', () => {
  it('planned: stopWriters < fence < terminate < captureLsn < catchUp < arm < promote < dns', async () => {
    await runCompose(true);
    expectPlannedOrder();
    expect(at('catchUp')).toBeLessThan(at('arm'));
    expect(at('arm'), 'the promoted side is armed before the promote (D2)').toBeLessThan(
      at('promote'),
    );
    // A streaming, caught-up standby needs no reseed, and a proven promote
    // never un-fences the old primary.
    expect(order).not.toContain('reseed');
    expect(order).not.toContain('unfence');
  });

  it('unplanned: promote < dns, nothing fenced or read on the unreachable primary first', async () => {
    await runCompose(false);
    expectUnplannedOrder();
    expect(at('arm')).toBeGreaterThan(-1);
    expect(at('arm')).toBeLessThan(at('promote'));
    expect(order).not.toContain('arm@primary');
  });
});

function expectBasePushLast() {
  for (const step of ['walgRole', 'swap', 'dns', 'basePush']) {
    expect(order, `failover never reached ${step}`).toContain(step);
  }
  expect(at('promote')).toBeLessThan(at('walgRole'));
  expect(at('walgRole'), 'the base is pushed once the wal-g role reads primary').toBeLessThan(
    at('basePush'),
  );
  expect(at('swap'), 'the base is pushed after the swap save').toBeLessThan(at('basePush'));
  expect(at('dns'), 'the base push stays out of the RTO path').toBeLessThan(at('basePush'));
  expect(order.filter((x) => x === 'basePush')).toHaveLength(1);
  expect(pushArgs[0]).toMatchObject({ ip: STANDBY_IP, envName: 'prod' });
}

describe.each([
  ['k8s-ha', 'k8s', runK8s],
  ['compose-ha', 'compose', runCompose],
] as const)('failover %s: a base backup on the new timeline', (_label, tier, run) => {
  it.each([true, false])(
    'planned=%s: walgRole < swap < basePush, after the DNS flip',
    async (planned) => {
      await run(planned);
      expectBasePushLast();
      expect(pushArgs[0]).toMatchObject({ tier });
      // compose prunes with the env's own retention; k8s retention is the CronJob's.
      if (tier === 'compose') expect(pushArgs[0]).toMatchObject({ retain: 14 });
      else expect(pushArgs[0]).not.toHaveProperty('retain');
    },
  );

  it('a DNS flip that is not confirmed skips the push; the DNS error names the missing base', async () => {
    dnsFails = true;
    const err = await run(true).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('FAILOVER COMPLETED, DNS DID NOT');
    expect(err.message).toContain('no base backup was pushed on the new timeline');
    expect(err.message).toContain('run vibecarbon backup prod');
    expect(order).toContain('swap');
    expect(order).not.toContain('basePush');
  });

  it('a failed wal-g role move skips the push; the one error names the missing base', async () => {
    walgArmed = false;
    const err = await run(true).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('FAILOVER COMPLETED, BACKUPS DID NOT');
    expect(err.message).toContain('no base backup on the new timeline');
    expect(err.message).toContain('vibecarbon backup prod');
    expect(order).not.toContain('basePush');
  });

  it('a failed push fails the command after the roles are saved', async () => {
    pushFails =
      'promoted, but the first base backup on the new timeline failed: boom; run vibecarbon backup prod now';
    const err = await run(true).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(pushFails);
    expect(at('swap')).toBeLessThan(at('basePush'));
  });
});
