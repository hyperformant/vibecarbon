/**
 * compose-ha scale: the standby arm never restores (Decision 3).
 *
 * A standby replacement restored from the bucket comes up as an independent
 * primary that nothing streams to: silent split-brain. The standby arm
 * reseeds the replacement from the primary instead (configureStandbyReplication,
 * the staged reseed restore's compose-ha re-seed runs) and proves it streaming
 * with the primary's system identifier. With both arms, it waits for the
 * primary arm and reseeds from the NEW primary. A reseed it cannot prove marks
 * replication degraded.
 */
import { describe, expect, it, vi } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

const LINEAGE = '7699032860122738725';
const PUSHED = 'base_000000010000000000000004';

const h = vi.hoisted(() => ({
  // The nodes a psql runner answers for as the primary (out of recovery).
  primaries: new Set(['9.9.9.1', '1.1.1.1']),
  events: [] as string[],
  reseeds: [] as Array<{ standby: string; primary: string; primaryHost: string }>,
  tunnels: [] as Array<{ primaryIp: string; standbyIp: string }>,
  streaming: { value: true },
  recorded: [] as string[],
  degraded: { value: 0 },
}));

vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    log: { info() {}, warn() {}, error() {}, step() {}, success() {}, message() {} },
    note() {},
    outro() {},
  };
});

vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, loadProjectConfig: () => null, saveProjectConfig: () => {} };
});

vi.mock('../../../src/lib/walg/restore-base.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/lib/walg/restore-base.js')>();
  return {
    ...actual,
    resolveS3Config: async () => ({ bucket: 'b', endpoint: 'e', region: 'r' }),
    readEnvBaseBackups: async () => ({
      s3Config: { bucket: 'b' },
      lineage: LINEAGE,
      backups: [{ name: PUSHED, finishTime: new Date('2026-10-20T00:00:00Z') }],
    }),
  };
});

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    backupCompose: async (ip: string) => {
      h.events.push(`backup:${ip}`);
      return { result: 'pushed', name: PUSHED };
    },
    waitForSSH: async () => true,
    setupServer: async () => {},
    setupServerFiles: async () => {},
    pullComposeImages: async () => {},
    startComposeStack: async (ip: string) => {
      h.events.push(`up:${ip}`);
    },
    restoreCompose: async (ip: string) => {
      h.events.push(`restore:${ip}`);
    },
    dockerLoginOnServer: async () => {},
    isLocalOnlyImageTag: () => false,
    setupComposeBackupCron: async () => {},
    sshRunAsync: async (ip: string, _k: string, cmd: string) => {
      if (cmd.includes('docker-compose.replication.yml <<')) h.events.push(`overlay:${ip}`);
      return cmd.includes('compose-backup.sh') ? 'VC_CRON_REMOVED' : '';
    },
  };
});

vi.mock('../../../src/lib/deploy/compose/ha.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    stopOldPrimaryWriters: async () => ({ ok: true, reached: true, stopped: ['myapp-app'] }),
    startOldPrimaryWriters: async () => true,
    composePsqlRunner: (ip: string) => async (sql: string) =>
      sql === '__ip__'
        ? h.primaries.has(ip)
          ? 'primary'
          : 'standby'
        : sql.includes('pg_switch_wal')
          ? '000000010000000000000003'
          : sql.includes('pg_stat_archiver')
            ? '000000010000000000000003|'
            : '',
    demoteComposeWalgRole: async ({ oldPrimaryIp }: { oldPrimaryIp: string }) => {
      h.events.push(`demote:${oldPrimaryIp}`);
      return true;
    },
    restoreComposeWalgRole: async () => ({ ok: true }),
    openWireguardPortUfw: async () => {},
    openWireguardPortHetznerFirewall: async () => {},
    ensurePrimaryReplicationAccess: async (ip: string) => {
      h.events.push(`primary-access:${ip}`);
    },
    configureStandbyReplication: async (
      standby: string,
      primary: string,
      _k: string,
      _p: string,
      o: { primaryHost: string },
    ) => {
      h.events.push(`reseed:${standby}<-${primary}`);
      h.reseeds.push({ standby, primary, primaryHost: o.primaryHost });
      return true;
    },
  };
});

vi.mock('../../../src/lib/deploy/wireguard.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    exchangeAndBringUpTunnel: async (t: { primaryIp: string; standbyIp: string }) => {
      h.tunnels.push({ primaryIp: t.primaryIp, standbyIp: t.standbyIp });
    },
  };
});

vi.mock('../../../src/lib/deploy/failover-guard.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    // The primary reads out of recovery; a standby reads in recovery, streaming
    // (or not), with the same system identifier.
    readReplicaState: async ({ exec }: { exec: (s: string) => Promise<string> }) => {
      const ip = await exec('__ip__');
      const isPrimary = ip === 'primary';
      return {
        inRecovery: !isPrimary,
        systemIdentifier: LINEAGE,
        receiverStatus: isPrimary ? null : h.streaming.value ? 'streaming' : 'startup',
      };
    },
    recordSystemIdentifier: (_c: unknown, sysid: string) => {
      h.recorded.push(sysid);
    },
    markStandbyUnproven: () => {
      h.degraded.value += 1;
    },
  };
});

vi.mock('../../../src/lib/deploy/replication.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fenceDatabaseWrites: async () => ({ terminated: 0 }),
    unfenceDatabaseWrites: async () => true,
    // One read is the whole proof window here.
    verifyStreaming: async ({ readState }: { readState: () => Promise<string> }) => {
      const s = await readState();
      return { streaming: s === 'streaming', lastState: s };
    },
  };
});

vi.mock('../../../src/lib/walg/post-promote-backup.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    pushBaseBackupAfterPromote: async ({ ip }: { ip: string }) => {
      h.events.push(`push:${ip}`);
      return { name: 'base_000000020000000000000005' };
    },
  };
});

vi.mock('../../../src/lib/build.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getGHCRCredentials: async () => ({}) };
});

vi.mock('../../../src/lib/ssh.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, sshRun: async () => '', sshRunScript: async () => '' };
});

const { SCALE_EFFECTS } = await import('../../../src/scale.js');

const NEW_PRIMARY = '9.9.9.1';
const NEW_STANDBY = '9.9.9.2';
const OLD_PRIMARY = '1.1.1.1';
const OLD_STANDBY = '2.2.2.2';

function makeCtx(target: 'both' | 'primary' | 'standby') {
  const primary = { ip: OLD_PRIMARY, id: 'p-old', role: 'primary', name: 'myapp-prod-primary' };
  const standby = { ip: OLD_STANDBY, id: 's-old', role: 'standby', name: 'myapp-prod-standby' };
  let n = 0;
  const provider = {
    createServer: vi.fn(async (args: { name: string }) => {
      n += 1;
      return { id: args.name.includes('standby') ? 's-new' : 'p-new', n };
    }),
    waitForServer: vi.fn(async (id: string) => ({
      public_net: { ipv4: { ip: id === 's-new' ? NEW_STANDBY : NEW_PRIMARY } },
    })),
    deleteServer: vi.fn(async (id: string) => {
      h.events.push(`delete:${id}`);
    }),
    renameServer: vi.fn(async () => {}),
  };
  const targetServers =
    target === 'both' ? [primary, standby] : target === 'primary' ? [primary] : [standby];
  return {
    provider,
    ctx: {
      tier: 'compose-ha',
      provider,
      Provider: HetznerProvider,
      newType: 'cpx31',
      region: 'fsn1',
      sshKeyId: 42,
      envConfig: {
        deployMode: 'compose-ha',
        backup: { lineage: LINEAGE },
        servers: [primary, standby],
      },
      projectConfig: { projectName: 'myapp', environments: {} },
      projectName: 'myapp',
      environment: 'prod',
      sshKeyPath: '/key',
      domain: null,
      services: {},
      dnsChallenge: true,
      dnsProvider: null,
      apiToken: 'tok',
      servers: [primary, standby],
      targetServers,
    } as Record<string, unknown>,
  };
}

function reset() {
  h.events.length = 0;
  h.reseeds.length = 0;
  h.tunnels.length = 0;
  h.recorded.length = 0;
  h.degraded.value = 0;
  h.streaming.value = true;
}

describe('compose-ha scale: the standby arm reseeds, never restores', () => {
  it('with both arms, the standby replacement reseeds from the NEW primary, after the primary arm', async () => {
    reset();
    const { provider, ctx } = makeCtx('both');
    await SCALE_EFFECTS.scaleServers(ctx);
    // Exactly one restore, on the new primary; none on the new standby.
    expect(h.events.filter((e) => e.startsWith('restore:'))).toEqual([`restore:${NEW_PRIMARY}`]);
    // No backup and no fence of the old standby.
    expect(h.events).not.toContain(`backup:${OLD_STANDBY}`);
    expect(h.events).not.toContain(`demote:${OLD_STANDBY}`);
    expect(h.reseeds).toEqual([
      { standby: NEW_STANDBY, primary: NEW_PRIMARY, primaryHost: '10.99.0.1' },
    ]);
    // Tunnel between the two new nodes, by birth stack.
    expect(h.tunnels).toEqual([{ primaryIp: NEW_PRIMARY, standbyIp: NEW_STANDBY }]);
    // Reseeded after the primary arm's restore.
    expect(h.events.indexOf(`reseed:${NEW_STANDBY}<-${NEW_PRIMARY}`)).toBeGreaterThan(
      h.events.indexOf(`restore:${NEW_PRIMARY}`),
    );
    // Both new nodes got the replication overlay before their stack came up.
    expect(h.events.indexOf(`overlay:${NEW_STANDBY}`)).toBeLessThan(
      h.events.indexOf(`up:${NEW_STANDBY}`),
    );
    expect(h.events.indexOf(`overlay:${NEW_PRIMARY}`)).toBeLessThan(
      h.events.indexOf(`up:${NEW_PRIMARY}`),
    );
    expect(h.recorded).toEqual([LINEAGE]);
    expect(h.degraded.value).toBe(0);
    expect(provider.deleteServer).toHaveBeenCalledWith('p-old');
    expect(provider.deleteServer).toHaveBeenCalledWith('s-old');
  });

  it('standby only: reseeds from the live primary; nothing is fenced, backed up or restored', async () => {
    reset();
    const { ctx } = makeCtx('standby');
    await SCALE_EFFECTS.scaleServers(ctx);
    expect(h.events.some((e) => e.startsWith('restore:') || e.startsWith('backup:'))).toBe(false);
    expect(h.events.some((e) => e.startsWith('demote:'))).toBe(false);
    expect(h.reseeds).toEqual([
      { standby: NEW_STANDBY, primary: OLD_PRIMARY, primaryHost: '10.99.0.1' },
    ]);
    expect(h.events).toContain(`primary-access:${OLD_PRIMARY}`);
  });

  it('primary only: the existing standby is reseeded from the new primary', async () => {
    reset();
    const { ctx } = makeCtx('primary');
    await SCALE_EFFECTS.scaleServers(ctx);
    expect(h.reseeds).toEqual([
      { standby: OLD_STANDBY, primary: NEW_PRIMARY, primaryHost: '10.99.0.1' },
    ]);
    expect(h.tunnels).toEqual([{ primaryIp: NEW_PRIMARY, standbyIp: OLD_STANDBY }]);
  });

  it('a reseed it cannot prove streaming marks replication degraded and records no identifier', async () => {
    reset();
    h.streaming.value = false;
    const { ctx } = makeCtx('both');
    await SCALE_EFFECTS.scaleServers(ctx);
    expect(h.degraded.value).toBe(1);
    expect(h.recorded).toEqual([]);
  });
});

describe('rejoinComposeStandby on a pair that has failed over', () => {
  it('never reseeds (C2): marks replication degraded and names the deploy', async () => {
    reset();
    const { rejoinComposeStandby } = await import(
      '../../../src/lib/deploy/compose/scale-cutover.js'
    );
    const warnings: string[] = [];
    // Roles inverted against the stacks: the -primary stack's node is the standby.
    const primary = { ip: OLD_STANDBY, role: 'primary', name: 'myapp-prod-standby' };
    const standby = { ip: OLD_PRIMARY, role: 'standby', name: 'myapp-prod-primary' };
    const out = await rejoinComposeStandby({
      environment: 'prod',
      projectName: 'myapp',
      envConfig: { deployMode: 'compose-ha', servers: [standby, primary] },
      primary: { ip: primary.ip, entry: primary },
      standby: { ip: standby.ip, entry: standby },
      sshKeyPath: '/key',
      deps: { warn: (m: string) => warnings.push(m) },
    });
    expect(out).toBe('degraded');
    expect(h.reseeds).toEqual([]);
    expect(h.degraded.value).toBe(1);
    expect(warnings[0]).toMatch(/has failed over at some point.*vibecarbon deploy prod/);
  });
});
