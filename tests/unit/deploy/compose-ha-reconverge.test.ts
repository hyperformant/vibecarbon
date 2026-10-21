/**
 * Role-aware compose-HA reconverge (HA-correctness Task 3b, rulings R11/R12).
 *
 * After `vibecarbon failover` the promoted node is still Pulumi stack
 * `<env>-standby` (WireGuard 10.99.0.2) and the retired node is still
 * `<env>-primary` (10.99.0.1). `vibecarbon deploy` then keeps the promoted node
 * serving as the primary and rebuilds the retired node as the standby:
 *
 *   - the pair is resolved by ROLE, each node keeping its stack and its birth
 *     tunnel address (no WireGuard re-addressing, R11);
 *   - the promoted node's db is never stopped, restarted or recreated;
 *   - the reseed targets the retired node and dials the promoted node's own
 *     tunnel address;
 *   - lastFailover / degraded clear only once streaming is verified and the
 *     standby's system identifier is recorded, so a failed run resumes.
 *
 * SSH is mocked at compose/index.js and answered from a two-node state model,
 * so the real compose/ha.js replication helpers run and every command they
 * would send is recorded (the argv census below).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PROMOTED_IP = '203.0.113.20'; // stack <env>-standby, role primary after the failover
const RETIRED_IP = '203.0.113.10'; // stack <env>-primary, role standby after the failover
const SYSID = '7311111111111111111';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ ip: string; command: string; input?: string }>,
  nodes: {} as Record<string, { inRecovery: boolean | null; receiver: string }>,
  /** The retirement fence on each node (retired-fence.js): markers and running writers. */
  fence: {} as Record<string, { host: boolean; db: boolean; running: boolean; readOnly: boolean }>,
  /** The retired node stops answering the fence clear. */
  clearFails: false,
  reseedFails: false,
  dnsAnswer: [] as string[],
  disk: { config: null as Record<string, unknown> | null },
  started: [] as string[],
  /** One ordered log: ssh writes of interest, stack starts and config saves. */
  events: [] as string[],
  startFails: false,
  envMerges: [] as Array<{ ip: string; vars: Record<string, string> }>,
  upStacks: [] as Array<{ stack: string; location: unknown }>,
}));

// Quiet clack: the effects narrate every step; the assertions read state.
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const quiet = () => {};
  return {
    ...actual,
    log: { info: quiet, warn: quiet, success: quiet, message: quiet, error: quiet, step: quiet },
  };
});

vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    loadProjectConfig: () => structuredClone(h.disk.config),
    saveProjectConfig: (cfg: Record<string, unknown>) => {
      const env = (cfg as { environments?: Record<string, { status?: string }> }).environments
        ?.prod;
      h.events.push(`save:${env?.status}`);
      h.disk.config = structuredClone(cfg);
    },
    registerProject: () => {},
  };
});

function respond(ip: string, command: string, input?: string): string | false {
  const node = h.nodes[ip] ?? { inRecovery: null, receiver: '' };
  const tf = node.inRecovery === true ? 't' : node.inRecovery === false ? 'f' : '';
  if (command.includes('pg_ls_waldir')) {
    if (!tf) return false;
    return `${tf}|${h.fence[ip]?.readOnly ? 'on' : 'off'}|16777216`;
  }
  if (command.includes('pg_control_system')) {
    if (!tf) return false;
    return `${tf}|${SYSID}|0/3000060|${node.receiver}|${node.receiver ? '1' : ''}`;
  }
  if (command.includes('pg_is_in_recovery')) return tf;
  if (command.includes('pg_stat_replication')) {
    return h.nodes[RETIRED_IP]?.receiver === 'streaming' && ip === PROMOTED_IP ? 'streaming' : '';
  }
  if (command.includes('SHOW hba_file')) return '/var/lib/postgresql/data/pg_hba.conf';
  if (command.includes('IPAM')) return '172.19.0.0/16 ';
  if (command.includes('.Mounts')) return '/var/lib/docker/volumes/myapp_db_data/_data';
  if (!h.fence[ip]) h.fence[ip] = { host: false, db: false, running: true, readOnly: false };
  const fence = h.fence[ip];
  // The retirement fence's database reads and its read-only write.
  if (command.includes('ALTER SYSTEM SET default_transaction_read_only')) {
    fence.readOnly = true;
    h.events.push(`readOnly:${ip}`);
    return '';
  }
  if (command.includes('pg_reload_conf')) return 't';
  if (command.includes("current_setting('\\''default_transaction_read_only")) {
    return fence.readOnly ? 'on' : 'off';
  }
  if (command.includes('pg_terminate_backend')) return '';
  if (command.includes('pg_file_settings')) return fence.readOnly ? '1' : '0';
  if (command.includes('PROBE_DONE')) {
    return [
      `HOST_MARKER=${fence.host ? 1 : 0}`,
      'WALG_ROLE=primary',
      `DB_MARKER=${fence.db ? 'present' : 'absent'}`,
      ...(fence.running ? ['RUNNING myapp-app'] : []),
      'PROBE_DONE',
    ].join('\n');
  }
  if (command.includes('rm -f') && command.includes('.vibecarbon-retired')) {
    if (h.clearFails) return false;
    fence.host = false;
    fence.db = false;
    h.events.push(`unfence:${ip}`);
    return 'CLEARED';
  }
  if (command.includes('touch') && command.includes('/.vibecarbon-retired')) {
    fence.host = true;
    h.events.push(`fence:${ip}`);
    return 'OK';
  }
  if (command.includes('touch') && command.includes('/vibecarbon-retired')) {
    fence.db = true;
    return 'OK';
  }
  if (command.includes('docker container inspect')) {
    fence.running = false;
    return 'STOPPED myapp-app\nFENCE_DONE';
  }
  if (input?.includes('pg_basebackup'))
    return h.reseedFails ? 'pg_basebackup: error' : 'COMPOSE_RESEED_STAGED';
  if (input?.includes('RESEED_SWAPPED')) {
    h.nodes[ip] = { inRecovery: true, receiver: 'streaming' };
    // The reseed replaces PGDATA, and the PGDATA marker and read-only setting with it.
    fence.db = false;
    fence.readOnly = false;
    return 'RESEED_SWAPPED';
  }
  return '';
}

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const rec = async (ip: string, _k: string, command: unknown, options?: { input?: string }) => {
    const c = Array.isArray(command) ? command.join(' ') : String(command);
    h.calls.push({ ip, command: c, input: options?.input });
    if (options?.input?.includes('pg_basebackup')) h.events.push(`basebackup:${ip}`);
    return respond(ip, c, options?.input);
  };
  return {
    ...actual,
    sshRun: vi.fn(rec),
    sshRunAsync: vi.fn(rec),
    sshRunChecked: vi.fn(async (ip: string, k: string, command: unknown, options?: object) => {
      const out = await rec(ip, k, command, options as { input?: string });
      if (out === false) throw new Error(`remote command failed on ${ip}`);
      return out;
    }),
    startComposeStack: vi.fn(async (ip: string) => {
      h.events.push(`start:${ip}`);
      if (h.startFails && ip === RETIRED_IP) throw new Error('reconcile failed');
      h.started.push(ip);
    }),
  };
});

vi.mock('../../../src/lib/deploy/utils.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    generateSSHKeyPair: () => {},
    mergeRemoteDotenv: vi.fn(
      async (ip: string, _o: string, _d: string, vars: Record<string, string>) => {
        h.envMerges.push({ ip, vars });
      },
    ),
  };
});

vi.mock('../../../src/lib/deploy/wireguard.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    exchangeAndBringUpTunnel: vi.fn().mockResolvedValue({ primaryPubKey: 'A', standbyPubKey: 'B' }),
  };
});

// No real waits between verify-streaming reads.
vi.mock('../../../src/lib/deploy/replication.js', async (orig) => {
  const actual = (await orig()) as Record<string, (o: object) => unknown>;
  return {
    ...actual,
    verifyStreaming: (opts: object) =>
      actual.verifyStreaming({ ...opts, attempts: 1, sleep: async () => {} }),
  };
});

vi.mock('../../../src/lib/deploy/public-dns-lookup.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, resolvePublicA: vi.fn(async () => h.dnsAnswer) };
});

// Spy on the reseed while keeping the real implementation.
vi.mock('../../../src/lib/deploy/compose/ha.js', async (orig) => {
  const actual = (await orig()) as Record<string, (...a: unknown[]) => unknown>;
  return {
    ...actual,
    configureStandbyReplication: vi.fn((...a: unknown[]) =>
      actual.configureStandbyReplication(...a),
    ),
  };
});

// haProvisionServers seams: a fake provider and Pulumi up keyed by stack name.
vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  class FakeProvider {
    static DEFAULT_COMPOSE_TYPE = 'cpx22';
    static getDefaultStandbyRegion = () => 'should-not-be-used';
    static resolveServerTypeForRegion = (t: string) => t;
    static getComposeProgram = async (args: { environment: string; location: string }) => ({
      stack: args.environment,
      location: args.location,
    });
    async createSSHKey() {
      return 'key-1';
    }
  }
  return { ...actual, providerFor: () => FakeProvider, providerIdFor: () => 'hetzner' };
});
vi.mock('../../../src/lib/iac/index.js', () => ({
  upStack: vi.fn(async (stack: string, program: { location: unknown }) => {
    h.upStacks.push({ stack, location: program.location });
    const ip = stack.endsWith('-primary') ? RETIRED_IP : PROMOTED_IP;
    return { outputs: { serverIp: ip, serverId: stack.endsWith('-primary') ? '1' : '2' } };
  }),
}));

const roleSwap = await import('../../../src/lib/deploy/compose/ha-role-swap.js');
const { planComposeHaReconverge, assertComposeHaReconvergeReady } = roleSwap;
const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');
const composeHa = await import('../../../src/lib/deploy/compose/ha.js');
const wireguard = await import('../../../src/lib/deploy/wireguard.js');

const servers = (primaryStackRole: string, standbyStackRole: string) => [
  {
    name: 'myapp-prod-primary',
    id: '1',
    ip: RETIRED_IP,
    region: 'nbg1',
    serverType: 'cpx22',
    role: primaryStackRole,
  },
  {
    name: 'myapp-prod-standby',
    id: '2',
    ip: PROMOTED_IP,
    region: 'ash',
    serverType: 'cpx22',
    role: standbyStackRole,
  },
];

/** What swapComposeHaRoles persists after one completed failover. */
const swappedEnv = (extra: Record<string, unknown> = {}) => ({
  deployMode: 'compose-ha',
  provider: 'hetzner',
  status: 'deployed',
  region: 'ash',
  secondaryRegion: 'nbg1',
  serverType: 'cpx22',
  ha: { enabled: true, failoverRegion: 'nbg1', systemIdentifier: SYSID },
  replication: 'degraded',
  degraded: true,
  lastFailover: '2026-10-20T12:00:00.000Z',
  deployedAt: '2026-10-19T12:00:00.000Z',
  servers: servers('standby', 'primary'),
  ...extra,
});

const plan = () =>
  planComposeHaReconverge({ projectName: 'myapp', environment: 'prod', envConfig: swappedEnv() });

function baseCtx(extra: Record<string, unknown> = {}) {
  const reconverge = plan();
  return {
    projectConfig: { projectName: 'myapp' },
    environment: 'prod',
    envConfig: swappedEnv(),
    region: 'ash',
    secondaryRegion: 'nbg1',
    standbyRegion: 'nbg1',
    serverType: 'cpx22',
    standbyServerType: 'cpx22',
    reconverge,
    primary: {
      ip: PROMOTED_IP,
      serverId: '2',
      stack: 'standby',
      region: 'ash',
      serverType: 'cpx22',
    },
    standby: {
      ip: RETIRED_IP,
      serverId: '1',
      stack: 'primary',
      region: 'nbg1',
      serverType: 'cpx22',
    },
    sshKeyPath: '/tmp/never-used-key',
    domain: 'prod.example.com',
    dnsProvider: 'hetzner',
    services: {},
    onProgress: () => {},
    ...extra,
  } as Record<string, unknown>;
}

/** The reconverge-relevant effects, in deploy-plan order. */
async function runReconverge(ctx: Record<string, unknown>) {
  const E = COMPOSE_HA_EFFECTS as Record<string, (c: Record<string, unknown>) => Promise<void>>;
  await E.haPersistPendingConfig(ctx);
  await E.haMergeWalgRole(ctx);
  await E.haStartComposeStack(ctx);
  await E.haWriteReplicationOverlay(ctx);
  await E.haConfigureReplication(ctx);
  await E.haVerifyStreaming(ctx);
  await E.haFinalizeConfig(ctx);
}

const envOnDisk = () =>
  (h.disk.config as { environments: Record<string, Record<string, unknown>> }).environments.prod;

/** A command that stops, restarts, recreates or starts the db service. */
const DB_LIFECYCLE =
  /docker compose\b[^;&|]*\b(stop|restart|up|rm|kill|create|start)\b[^;&|]*\sdb(\s|$)|--force-recreate/;

beforeEach(() => {
  h.calls.length = 0;
  h.started.length = 0;
  h.events.length = 0;
  h.startFails = false;
  h.envMerges.length = 0;
  h.upStacks.length = 0;
  h.reseedFails = false;
  h.dnsAnswer = [PROMOTED_IP];
  h.fence = {};
  h.clearFails = false;
  h.nodes = {
    [PROMOTED_IP]: { inRecovery: false, receiver: '' },
    [RETIRED_IP]: { inRecovery: false, receiver: '' },
  };
  h.disk.config = { projectName: 'myapp', environments: { prod: swappedEnv() } };
  process.env.REPL_PASSWORD = 'unit-test-repl-pw';
  vi.mocked(composeHa.configureStandbyReplication).mockClear();
  vi.mocked(wireguard.exchangeAndBringUpTunnel).mockClear();
});

describe('planComposeHaReconverge', () => {
  it('names the promoted node primary and the retired node standby, each keeping its stack', () => {
    const p = plan();
    expect(p?.promoted).toMatchObject({ ip: PROMOTED_IP, stack: 'standby', region: 'ash' });
    expect(p?.retired).toMatchObject({ ip: RETIRED_IP, stack: 'primary', region: 'nbg1' });
  });

  it('is null for a pair whose roles match their stacks and that has not failed over', () => {
    const envConfig = swappedEnv({
      servers: servers('primary', 'standby'),
      lastFailover: undefined,
    });
    expect(
      planComposeHaReconverge({ projectName: 'myapp', environment: 'prod', envConfig }),
    ).toBeNull();
  });

  it('is null for every other tier', () => {
    const envConfig = { ...swappedEnv(), deployMode: 'kubernetes' };
    expect(
      planComposeHaReconverge({ projectName: 'myapp', environment: 'prod', envConfig }),
    ).toBeNull();
  });

  it('refuses while a failover journal is set, naming vibecarbon failover', () => {
    const envConfig = swappedEnv({
      ha: { enabled: true, failoverInFlight: { id: 'j', target: 'standby' } },
    });
    expect(() =>
      planComposeHaReconverge({ projectName: 'myapp', environment: 'prod', envConfig }),
    ).toThrow(/vibecarbon failover prod/);
  });
});

describe('assertComposeHaReconvergeReady (refusals before any ssh write)', () => {
  const state = (inRecovery: boolean | null) => ({
    inRecovery,
    systemIdentifier: inRecovery === null ? null : SYSID,
    replayLsn: null,
    receiverStatus: null,
    lastMsgAgeS: null,
  });
  const ready = (o: { promoted?: boolean | null; retired?: boolean | null; dns?: string[] }) =>
    assertComposeHaReconvergeReady({
      plan: plan(),
      environment: 'prod',
      domain: 'prod.example.com',
      readState: async (ip: string) =>
        state(
          ip === PROMOTED_IP
            ? 'promoted' in o
              ? (o.promoted ?? null)
              : false
            : 'retired' in o
              ? (o.retired ?? null)
              : false,
        ),
      resolveA: async () => o.dns ?? [PROMOTED_IP],
    });

  it('passes a finished failover: promoted out of recovery and serving DNS', async () => {
    await expect(ready({})).resolves.toBeUndefined();
  });

  it('refuses when the promoted node is still in recovery', async () => {
    await expect(ready({ promoted: true })).rejects.toThrow(
      /still in recovery.*vibecarbon failover prod/,
    );
  });

  it('refuses when the promoted node cannot be read', async () => {
    await expect(ready({ promoted: null })).rejects.toThrow(/could not read/);
  });

  it('refuses when DNS does not point at the promoted node yet', async () => {
    await expect(ready({ dns: [RETIRED_IP] })).rejects.toThrow(
      new RegExp(`prod\\.example\\.com.*${PROMOTED_IP}`),
    );
  });

  it('refuses when the reseed target is out of recovery and serving DNS', async () => {
    await expect(ready({ dns: [PROMOTED_IP, RETIRED_IP] })).rejects.toThrow(/serving/);
  });

  it('messages are one line with no em dash', async () => {
    for (const o of [{ promoted: true }, { dns: [RETIRED_IP] }]) {
      const err = await ready(o).catch((e: Error) => e);
      expect(String((err as Error).message)).not.toMatch(/\n|—/);
    }
  });
});

describe('wgIpOf (R11: tunnel addresses follow birth identity)', () => {
  it('maps each stack to its birth tunnel address and refuses anything else', () => {
    expect(wireguard.wgIpOf({ stackIdentity: 'primary' })).toBe('10.99.0.1');
    expect(wireguard.wgIpOf({ stackIdentity: 'standby' })).toBe('10.99.0.2');
    expect(() => wireguard.wgIpOf({ stackIdentity: 'retired' as never })).toThrow();
  });
});

describe('configureStandbyReplication takes the primary tunnel address explicitly', () => {
  it('refuses without primaryHost (no default)', async () => {
    await expect(
      composeHa.configureStandbyReplication(RETIRED_IP, PROMOTED_IP, '/k', 'myapp'),
    ).rejects.toThrow(/primaryHost/);
    expect(h.calls).toEqual([]);
  });
});

describe('haProvisionServers on a swapped env', () => {
  it('keeps each stack at its birth region and resolves the pair by role', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reconverge-'));
    const sshKeyPath = join(dir, 'key');
    writeFileSync(`${sshKeyPath}.pub`, 'ssh-ed25519 AAAA test');
    const ctx = baseCtx({
      sshKeyPath,
      apiToken: 't',
      imageRef: 'ghcr.io/o/r:tag',
      projectConfig: { projectName: 'myapp', operatorCidrs: [] },
      primary: undefined,
      standby: undefined,
    });
    await COMPOSE_HA_EFFECTS.haProvisionServers(ctx);
    // Pulumi stacks keep their birth names AND their birth locations, so an up
    // never replaces a server (envConfig.region was swapped by the failover).
    expect(h.upStacks).toEqual(
      expect.arrayContaining([
        { stack: 'prod-primary', location: 'nbg1' },
        { stack: 'prod-standby', location: 'ash' },
      ]),
    );
    expect(ctx.primary).toMatchObject({ ip: PROMOTED_IP, stack: 'standby', region: 'ash' });
    expect(ctx.standby).toMatchObject({ ip: RETIRED_IP, stack: 'primary', region: 'nbg1' });
  });
});

describe('reconverge effects', () => {
  it('(a) never stops, restarts or recreates the promoted node db', async () => {
    await runReconverge(baseCtx());
    const promoted = h.calls.filter((c) => c.ip === PROMOTED_IP).map((c) => c.command);
    expect(promoted.length).toBeGreaterThan(0);
    expect(promoted.filter((c) => DB_LIFECYCLE.test(c))).toEqual([]);
    // The census bites: the retired node's db IS recreated / stopped for its reseed.
    const retired = h.calls.filter((c) => c.ip === RETIRED_IP).map((c) => c.command);
    expect(retired.some((c) => DB_LIFECYCLE.test(c))).toBe(true);
  });

  it('(b) ensures the replication slot on the promoted node', async () => {
    await runReconverge(baseCtx());
    const slotOnPromoted = h.calls.some(
      (c) =>
        c.ip === PROMOTED_IP &&
        (`${c.input ?? ''}`.includes('vibecarbon_standby_slot') ||
          (/echo (\S+) \| base64 -d/.test(c.command) &&
            Buffer.from(c.command.match(/echo (\S+) \| base64 -d/)?.[1] ?? '', 'base64')
              .toString()
              .includes('vibecarbon_standby_slot'))),
    );
    expect(slotOnPromoted).toBe(true);
  });

  it('(c) reseeds the retired node from the promoted node over 10.99.0.2', async () => {
    await runReconverge(baseCtx());
    expect(composeHa.configureStandbyReplication).toHaveBeenCalledTimes(1);
    const [target, source, , , opts] = vi.mocked(composeHa.configureStandbyReplication).mock
      .calls[0] as unknown[];
    expect(target).toBe(RETIRED_IP);
    expect(source).toBe(PROMOTED_IP);
    expect(opts).toEqual({ primaryHost: '10.99.0.2' });
    // The basebackup ran on the retired node, never on the promoted one.
    expect(h.calls.filter((c) => c.input?.includes('pg_basebackup')).map((c) => c.ip)).toEqual([
      RETIRED_IP,
    ]);
    // The tunnel keeps its birth mapping: 10.99.0.1 stays on the retired node.
    expect(wireguard.exchangeAndBringUpTunnel).toHaveBeenCalledWith(
      expect.objectContaining({ primaryIp: RETIRED_IP, standbyIp: PROMOTED_IP }),
    );
  });

  it('(d) writes each replication overlay with the node birth tunnel address', async () => {
    await runReconverge(baseCtx());
    const overlay = (ip: string) =>
      h.calls.find((c) => c.ip === ip && c.command.includes('docker-compose.replication.yml <<'))
        ?.command ?? '';
    expect(overlay(RETIRED_IP)).toContain('bind=10.99.0.1');
    expect(overlay(PROMOTED_IP)).toContain('bind=10.99.0.2');
  });

  it('(e) app tier up on the promoted node, held at zero on the retired one until its reseed, then up as a standby', async () => {
    await runReconverge(baseCtx());
    // Held at zero for the pre-reseed window...
    const stopIdx = h.calls.findIndex(
      (c) =>
        c.ip === RETIRED_IP && /docker stop/.test(c.command) && c.command.includes('myapp-app'),
    );
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    // ...then reconciled as a normal standby in the SAME run: after the
    // basebackup made it a replica, before finalize persists 'deployed'.
    const ev = h.events;
    expect(ev.indexOf(`start:${PROMOTED_IP}`)).toBeGreaterThanOrEqual(0);
    const retiredStart = ev.indexOf(`start:${RETIRED_IP}`);
    expect(retiredStart).toBeGreaterThan(ev.indexOf(`basebackup:${RETIRED_IP}`));
    expect(ev.indexOf(`basebackup:${RETIRED_IP}`)).toBeGreaterThanOrEqual(0);
    expect(retiredStart).toBeLessThan(ev.indexOf('save:deployed'));
    expect(h.started).toEqual([PROMOTED_IP, RETIRED_IP]);
    // WALG_ROLE follows the roles, not the stacks.
    const role = (ip: string) => h.envMerges.find((m) => m.ip === ip)?.vars.WALG_ROLE;
    expect(role(PROMOTED_IP)).toBe('primary');
    expect(role(RETIRED_IP)).toBe('standby');
  });

  it('(f) clears lastFailover and degraded only after verified streaming and a recorded identifier', async () => {
    await runReconverge(baseCtx());
    const env = envOnDisk();
    expect(env.lastFailover).toBeUndefined();
    expect(env.replication).toBe('streaming');
    expect(env.degraded).toBe(false);
    expect((env.ha as Record<string, unknown>).systemIdentifier).toBe(SYSID);
    // Roles stay correct; stack identity (names) unchanged.
    const sv = env.servers as Array<{ name: string; role: string; ip: string }>;
    expect(sv.find((s) => s.role === 'primary')).toMatchObject({
      name: 'myapp-prod-standby',
      ip: PROMOTED_IP,
    });
    expect(sv.find((s) => s.role === 'standby')).toMatchObject({
      name: 'myapp-prod-primary',
      ip: RETIRED_IP,
    });
  });

  it('(g) the retired node is fenced before its reseed, and the fence comes off only in finalize', async () => {
    await runReconverge(baseCtx());
    const ev = h.events;
    const fenced = ev.indexOf(`fence:${RETIRED_IP}`);
    const unfenced = ev.indexOf(`unfence:${RETIRED_IP}`);
    expect(fenced).toBeGreaterThanOrEqual(0);
    expect(fenced).toBeLessThan(ev.indexOf(`basebackup:${RETIRED_IP}`));
    // Off once it streams (verify-streaming ran) and right before the save that
    // records the reconverge complete.
    expect(unfenced).toBeGreaterThan(ev.indexOf(`basebackup:${RETIRED_IP}`));
    expect(unfenced).toBeLessThan(ev.indexOf('save:deployed'));
    expect(h.fence[RETIRED_IP]).toMatchObject({ host: false, db: false });
    // Its database is read-only for the window too (nothing in the reconverge
    // writes to it before the reseed replaces it).
    expect(ev.indexOf(`readOnly:${RETIRED_IP}`)).toBeGreaterThanOrEqual(0);
    expect(ev.indexOf(`readOnly:${RETIRED_IP}`)).toBeLessThan(
      ev.indexOf(`basebackup:${RETIRED_IP}`),
    );
    // The promoted node is never fenced.
    expect(ev).not.toContain(`readOnly:${PROMOTED_IP}`);
    expect(ev).not.toContain(`fence:${PROMOTED_IP}`);
    expect(ev).not.toContain(`unfence:${PROMOTED_IP}`);
  });

  it('(g) a run that fails before streaming leaves the retired node fenced', async () => {
    h.reseedFails = true;
    await expect(runReconverge(baseCtx())).rejects.toThrow();
    expect(h.events).toContain(`fence:${RETIRED_IP}`);
    expect(h.events).not.toContain(`unfence:${RETIRED_IP}`);
    expect(h.fence[RETIRED_IP].host).toBe(true);
  });

  it('(g) a marker that cannot be cleared keeps the reconverge incomplete', async () => {
    h.clearFails = true;
    const ctx = baseCtx();
    await runReconverge(ctx);
    expect(ctx.reconvergeComplete).toBe(false);
    expect(envOnDisk().lastFailover).toBe('2026-10-20T12:00:00.000Z');
  });

  it('refuses the reseed when its target reads out of recovery while serving DNS, before any write', async () => {
    h.dnsAnswer = [RETIRED_IP];
    const ctx = baseCtx();
    await expect(COMPOSE_HA_EFFECTS.haConfigureReplication(ctx)).rejects.toThrow(/serving/);
    expect(composeHa.configureStandbyReplication).not.toHaveBeenCalled();
    expect(h.calls.every((c) => /pg_control_system/.test(c.command))).toBe(true);
  });

  it('is idempotent: a standby already streaming from the promoted node is not reseeded', async () => {
    h.nodes[RETIRED_IP] = { inRecovery: true, receiver: 'streaming' };
    await runReconverge(baseCtx());
    expect(composeHa.configureStandbyReplication).not.toHaveBeenCalled();
    expect(h.calls.some((c) => c.input?.includes('pg_basebackup'))).toBe(false);
    // A streaming standby proves the tunnel: it is not torn down and rebuilt.
    expect(wireguard.exchangeAndBringUpTunnel).not.toHaveBeenCalled();
    // A replica standby gets its stack like any standby.
    expect(h.started.sort()).toEqual([PROMOTED_IP, RETIRED_IP].sort());
    expect(envOnDisk().lastFailover).toBeUndefined();
  });

  it('a failed reconcile of the rebuilt standby leaves the reconverge incomplete', async () => {
    h.startFails = true;
    const ctx = baseCtx();
    await runReconverge(ctx);
    const env = envOnDisk();
    expect(ctx.reconvergeComplete).toBe(false);
    expect(env.lastFailover).toBe('2026-10-20T12:00:00.000Z');
    expect(env.replication).toBe('degraded');
    expect(env.deployedAt).toBe('2026-10-19T12:00:00.000Z');
  });

  it('resumes: a failed reseed leaves the env swapped and degraded, and a rerun reseeds and clears', async () => {
    h.reseedFails = true;
    await expect(runReconverge(baseCtx())).rejects.toThrow();
    let env = envOnDisk();
    expect(env.lastFailover).toBe('2026-10-20T12:00:00.000Z');
    expect(env.replication).toBe('degraded');
    const sv = () => env.servers as Array<{ name: string; role: string }>;
    expect(sv().find((s) => s.role === 'primary')?.name).toBe('myapp-prod-standby');

    h.reseedFails = false;
    await runReconverge(baseCtx({ envConfig: envOnDisk() }));
    env = envOnDisk();
    expect(composeHa.configureStandbyReplication).toHaveBeenCalledTimes(2);
    expect(env.lastFailover).toBeUndefined();
    expect(env.replication).toBe('streaming');
    expect(sv().find((s) => s.role === 'primary')?.name).toBe('myapp-prod-standby');
  });
});
