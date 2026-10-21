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
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

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
      readARecord: async () => (composeFlippedTo ? [composeFlippedTo] : []),
    }),
  };
});

vi.mock('../../../src/lib/deploy/tls-ready.js', () => ({
  waitForTrustedTls: async () => ({ trusted: true, elapsedMs: 0 }),
}));

vi.mock('node:fs', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, existsSync: () => true };
});

const ssh = await import('../../../src/lib/ssh.js');
const { failoverHA } = await import('../../../src/failover.js');
const { failoverComposeHA } = await import('../../../src/lib/deploy/compose/ha.js');

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
const recordingPsql = (ip: string) => async (sql: string) => {
  const side = ip === PRIMARY_IP ? '' : '@standby';
  if (/^ALTER SYSTEM SET default_transaction_read_only = on$/.test(sql)) {
    order.push(`fence${side}`);
    return '';
  }
  if (sql === 'SELECT pg_reload_conf()') return 't\n';
  if (/current_setting\('default_transaction_read_only'\)/.test(sql)) return 'on\n';
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
  vi.clearAllMocks();
});

async function runK8s(primaryReachable: boolean) {
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
    },
  };
  const deps = {
    identify: () => servers,
    getKeyPath: () => '/fake/key',
    keyExists: () => true,
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
    writeJournal: async () => 'journal-id',
    clearJournal: async () => {},
    promote: async () => {
      order.push('promote');
      return 'promoted';
    },
    restoreWalgRole: async () => ({
      promoted: { ok: true as const },
      demoted: { ok: true as const },
    }),
    gate: async () => {},
    promoteIssuer: async () => ({ patched: [] }),
    swapRoles: () => {},
    reconcileRetired: async () => ({ fenced: [], unreachable: [] }),
  };
  let flippedTo: string | null = null;
  const strategy = {
    getAuth: async () => ({ token: 't', zoneId: 'z' }),
    updateDns: async (_auth: unknown, _domain: string, ip: string) => {
      order.push('dns');
      flippedTo = ip;
    },
    readDns: async () => (flippedTo ? [flippedTo] : []),
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

async function runCompose(primaryReachable: boolean) {
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
    ha: { enabled: true, failoverRegion: 'ash', systemIdentifier: SYSID },
  };
  const deps = {
    isPrimaryReachable: async () => primaryReachable,
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
    writeJournal: async () => 'journal-id',
    clearJournal: async () => {},
    promote: async () => {
      order.push('promote');
      return 'promoted';
    },
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
      return true;
    },
    confirmUnproven: async () => {},
    swapRoles: () => {},
    reconcileRetired: async () => ({ fenced: [], unreachable: [] }),
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

describe('failover step order: k8s-ha (failoverHA)', () => {
  it('planned: stopWriters < writersGone < fence < terminate < captureLsn < catchUp < promote < dns', async () => {
    await runK8s(true);
    expectPlannedOrder();
    expect(order, 'an unconfirmed scale is not the fence').toContain('writersGone');
    expect(at('stopWriters')).toBeLessThan(at('writersGone'));
    expect(at('writersGone')).toBeLessThan(at('fence'));
  });

  it('unplanned: promote < dns, nothing fenced or read on the unreachable primary first', async () => {
    await runK8s(false);
    expectUnplannedOrder();
  });
});

describe('failover step order: compose-ha (failoverComposeHA)', () => {
  it('planned: stopWriters < fence < terminate < captureLsn < catchUp < promote < dns', async () => {
    await runCompose(true);
    expectPlannedOrder();
    // A streaming, caught-up standby needs no reseed, and a proven promote
    // never un-fences the old primary.
    expect(order).not.toContain('reseed');
    expect(order).not.toContain('unfence');
  });

  it('unplanned: promote < dns, nothing fenced or read on the unreachable primary first', async () => {
    await runCompose(false);
    expectUnplannedOrder();
  });
});
