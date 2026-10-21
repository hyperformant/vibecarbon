/**
 * Compose scale fences writes on the old server before the database cutover
 * (backup/restore integrity H6, B6, C8, C19).
 *
 * Before: the old server's base was pushed in the background while the new
 * server was built, and the old server kept taking writes until DNS moved.
 * Every write after that base was lost when the old server was destroyed.
 *
 * Now, in order: stop the writers, fence the database, switch WAL, wait for
 * that file to be archived, push the final base, restore THAT name on the new
 * server, demote the old one (WALG_ROLE) and drop its backup cron, flip DNS,
 * push the first base on the new timeline, destroy the old server. Any failure
 * before the flip rolls the old server back and deletes the new one; after the
 * flip there is no rollback.
 */
import { describe, expect, it, vi } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

const PUSHED = 'base_000000010000000000000004';
const LINEAGE = '7699032860122738725';

const h = vi.hoisted(() => {
  const events: string[] = [];
  const state = {
    archived: '000000010000000000000003',
    failAt: '' as string,
  };
  return { events, state };
});

const fail = (step: string) => {
  if (h.state.failAt === step) throw new Error(`${step} failed`);
};

vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    log: {
      info(msg: string) {
        if (msg.startsWith('writes paused')) h.events.push('log:paused');
      },
      warn() {},
      error() {},
      step() {},
      success() {},
      message() {},
    },
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
      backups: [
        // A newer base than the pushed one: the restore takes the pushed NAME.
        { name: 'base_000000010000000000000009', finishTime: new Date('2026-10-21T00:00:00Z') },
        { name: PUSHED, finishTime: new Date('2026-10-20T00:00:00Z'), uncompressedBytes: 4096 },
      ],
    }),
  };
});

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    backupCompose: async (ip: string) => {
      h.events.push(`backup:${ip}`);
      fail('backup');
      return { result: 'pushed', name: PUSHED };
    },
    waitForSSH: async () => true,
    setupServer: async () => {},
    setupServerFiles: async () => {},
    pullComposeImages: async () => {},
    startComposeStack: async () => {},
    restoreCompose: async (ip: string, _k: string, _p: string, r: { backup: string }) => {
      h.events.push(`restore:${ip}:${r.backup}`);
      fail('restore');
    },
    dockerLoginOnServer: async () => {},
    isLocalOnlyImageTag: () => false,
    setupComposeBackupCron: async (ip: string) => {
      h.events.push(`cron:install:${ip}`);
    },
    sshRunAsync: async (_ip: string, _k: string, cmd: string) => {
      if (cmd.includes('compose-backup.sh')) {
        h.events.push('cron:remove');
        fail('cron');
        return 'VC_CRON_REMOVED';
      }
      return '';
    },
  };
});

vi.mock('../../../src/lib/deploy/compose/ha.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    stopOldPrimaryWriters: async (_ip: string, _k: string, _p: string, services: string[]) => {
      h.events.push(`writers:stop:${services.join(',')}`);
      return { ok: true, reached: true, stopped: ['myapp-app'] };
    },
    startOldPrimaryWriters: async (_ip: string, _k: string, containers: string[]) => {
      h.events.push(`writers:start:${containers.join(',')}`);
      return true;
    },
    composePsqlRunner: (ip: string) => async (sql: string) => {
      if (sql.includes('pg_switch_wal')) {
        h.events.push(`switch:${ip}`);
        return '000000010000000000000003\n';
      }
      if (sql.includes('pg_stat_archiver')) {
        h.events.push(`archive-wait:${ip}`);
        return `${h.state.archived}|`;
      }
      return '';
    },
    demoteComposeWalgRole: async ({ oldPrimaryIp }: { oldPrimaryIp: string }) => {
      h.events.push(`demote:${oldPrimaryIp}`);
      return true;
    },
    restoreComposeWalgRole: async ({ promotedIp }: { promotedIp: string }) => {
      h.events.push(`rearm:${promotedIp}`);
      return { ok: true };
    },
  };
});

vi.mock('../../../src/lib/deploy/replication.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fenceDatabaseWrites: async () => {
      h.events.push('fence');
      return { terminated: 0 };
    },
    unfenceDatabaseWrites: async () => {
      h.events.push('unfence');
      return true;
    },
  };
});

vi.mock('../../../src/lib/walg/post-promote-backup.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    pushBaseBackupAfterPromote: async ({ ip, retain }: { ip: string; retain: number }) => {
      h.events.push(`push:${ip}:${retain}`);
      fail('push');
      return { name: 'base_000000020000000000000005' };
    },
  };
});

vi.mock('../../../src/lib/dns-provider.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    hasAutomatedDns: () => true,
    resolveDnsToken: () => 'dns-token',
    getDnsProvider: async () => ({
      upsertApexAndWildcard: async (_t: unknown, _d: string, ip: string) => {
        h.events.push(`dns:${ip}`);
      },
    }),
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
const { fenceComposePrimary } = await import('../../../src/lib/deploy/compose/scale-cutover.js');

function makeCtx() {
  const provider = {
    createServer: vi.fn(async () => {
      h.events.push('create');
      return { id: 'new-id' };
    }),
    waitForServer: vi.fn(async () => ({ public_net: { ipv4: { ip: '9.9.9.9' } } })),
    deleteServer: vi.fn(async (id: string) => {
      h.events.push(`delete:${id}`);
    }),
    renameServer: vi.fn(async () => {}),
  };
  const server = { ip: '1.1.1.1', id: 'old-id' };
  return {
    provider,
    ctx: {
      tier: 'compose',
      provider,
      Provider: HetznerProvider,
      newType: 'cpx31',
      region: 'fsn1',
      sshKeyId: 42,
      envConfig: {
        backup: { lineage: LINEAGE, retentionDays: 5 },
        dnsProvider: 'hetzner',
        dns: { zoneId: 'z' },
        servers: [server],
      },
      projectConfig: { projectName: 'myapp', environments: {} },
      projectName: 'myapp',
      environment: 'prod',
      sshKeyPath: '/key',
      domain: 'example.com',
      services: {},
      dnsChallenge: true,
      dnsProvider: 'hetzner',
      apiToken: 'tok',
      servers: [server],
      targetServers: [server],
    } as Record<string, unknown>,
  };
}

function reset(failAt = '') {
  h.events.length = 0;
  h.state.archived = '000000010000000000000003';
  h.state.failAt = failAt;
}

describe('fenceComposePrimary', () => {
  it('stops the writers, fences, switches WAL and waits for that file to be archived', async () => {
    const calls: string[] = [];
    const reads = ['000000010000000000000002|', '000000010000000000000003|'];
    const out = await fenceComposePrimary({
      ip: '1.1.1.1',
      sshKeyPath: '/key',
      projectName: 'myapp',
      services: [],
      deps: {
        stopWriters: async (_ip: string, _k: string, _p: string, svc: string[]) => {
          calls.push(`stop:${svc.join(',')}`);
          return { ok: true, reached: true, stopped: ['myapp-app'] };
        },
        fence: async () => {
          calls.push('fence');
        },
        psql: () => async (sql: string, o?: { readWrite?: boolean }) => {
          if (sql.includes('pg_switch_wal')) {
            calls.push(`switch:readWrite=${o?.readWrite === true}`);
            return '000000010000000000000003';
          }
          calls.push('archive-wait');
          return reads.shift();
        },
        sleep: async () => {},
      },
    });
    expect(calls).toEqual([
      'stop:app',
      'fence',
      'switch:readWrite=true',
      'archive-wait',
      'archive-wait',
    ]);
    expect(out.switchWal).toBe('000000010000000000000003');
    expect(out.stopped).toEqual(['myapp-app']);
  });

  it('an archive wait past its 120 s deadline fails naming the file, then unfences and starts the writers', async () => {
    const calls: string[] = [];
    let t = 0;
    await expect(
      fenceComposePrimary({
        ip: '1.1.1.1',
        sshKeyPath: '/key',
        projectName: 'myapp',
        services: [],
        deps: {
          stopWriters: async () => ({ ok: true, reached: true, stopped: ['myapp-app'] }),
          fence: async () => {
            calls.push('fence');
          },
          unfence: async () => {
            calls.push('unfence');
            return true;
          },
          startWriters: async (_ip: string, _k: string, c: string[]) => {
            calls.push(`start:${c.join(',')}`);
            return true;
          },
          psql: () => async (sql: string) =>
            sql.includes('pg_switch_wal')
              ? '000000010000000000000003'
              : '000000010000000000000002|000000010000000000000003',
          now: () => t,
          sleep: async (ms: number) => {
            t += ms;
          },
        },
      }),
    ).rejects.toThrow(
      /WAL file 000000010000000000000003 was not archived within 120s \(last archived: 000000010000000000000002, last failed: 000000010000000000000003\); writes resumed there/,
    );
    expect(calls).toEqual(['fence', 'unfence', 'start:myapp-app']);
  });
});

describe('scaleServers: the fenced cutover (single-server compose)', () => {
  it('runs fence, final backup, restore of that name, demote, DNS flip, post-promote push, destroy in order', async () => {
    reset();
    const { ctx } = makeCtx();
    await SCALE_EFFECTS.scaleServers(ctx);
    const order = [
      'create',
      'writers:stop:app',
      'fence',
      'switch:1.1.1.1',
      'archive-wait:1.1.1.1',
      'backup:1.1.1.1',
      `restore:9.9.9.9:${PUSHED}`,
      'demote:1.1.1.1',
      'cron:remove',
      'dns:9.9.9.9',
      'log:paused',
      'push:9.9.9.9:5',
      'delete:old-id',
    ];
    const seen = h.events.filter((e) => order.includes(e));
    expect(seen).toEqual(order);
    // The write pause is measured for the outro.
    expect(typeof ctx.writePauseMs).toBe('number');
  });

  it('an archive wait that never lands aborts before any backup or restore: rollback unfences, then starts the writers', async () => {
    reset();
    h.state.archived = '000000010000000000000002';
    const { provider, ctx } = makeCtx();
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const run = SCALE_EFFECTS.scaleServers(ctx);
      const settled = expect(run).rejects.toThrow(/was not archived within 120s/);
      await vi.advanceTimersByTimeAsync(130_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
    expect(h.events).not.toContain('backup:1.1.1.1');
    expect(h.events.some((e) => e.startsWith('restore:'))).toBe(false);
    const unfence = h.events.indexOf('unfence');
    expect(unfence).toBeGreaterThan(-1);
    expect(h.events.indexOf('writers:start:myapp-app')).toBeGreaterThan(unfence);
    expect(provider.deleteServer).toHaveBeenCalledWith('new-id');
    expect(provider.deleteServer).not.toHaveBeenCalledWith('old-id');
  });

  it('a failure after the demote, before the DNS flip, re-arms WALG_ROLE, unfences, restarts writers and deletes the new server', async () => {
    reset('cron');
    const { provider, ctx } = makeCtx();
    await expect(SCALE_EFFECTS.scaleServers(ctx)).rejects.toThrow(/could not remove|cron failed/);
    const rearm = h.events.indexOf('rearm:1.1.1.1');
    expect(rearm).toBeGreaterThan(h.events.indexOf('demote:1.1.1.1'));
    expect(h.events.indexOf('unfence')).toBeGreaterThan(rearm);
    expect(h.events.indexOf('writers:start:myapp-app')).toBeGreaterThan(
      h.events.indexOf('unfence'),
    );
    expect(h.events).toContain('cron:install:1.1.1.1');
    expect(h.events.some((e) => e.startsWith('dns:'))).toBe(false);
    expect(provider.deleteServer).toHaveBeenCalledWith('new-id');
    expect(provider.deleteServer).not.toHaveBeenCalledWith('old-id');
  });

  it('a failed restore rolls back the fence (no WALG_ROLE re-arm: nothing was demoted)', async () => {
    reset('restore');
    const { provider, ctx } = makeCtx();
    await expect(SCALE_EFFECTS.scaleServers(ctx)).rejects.toThrow(/restore failed/);
    expect(h.events).not.toContain('demote:1.1.1.1');
    expect(h.events).not.toContain('rearm:1.1.1.1');
    expect(h.events).toContain('unfence');
    expect(provider.deleteServer).toHaveBeenCalledWith('new-id');
  });

  it('a failed post-promote push, after the DNS flip, fails the scale with no rollback and keeps both servers', async () => {
    reset('push');
    const { provider, ctx } = makeCtx();
    await expect(SCALE_EFFECTS.scaleServers(ctx)).rejects.toThrow(
      /new server 9\.9\.9\.9, which serves now, then failed: push failed\. The old server 1\.1\.1\.1 \(id old-id\) is kept/,
    );
    expect(h.events).not.toContain('unfence');
    expect(h.events).not.toContain('rearm:1.1.1.1');
    expect(provider.deleteServer).not.toHaveBeenCalled();
  });
});

describe('rollbackComposeCutover', () => {
  it('re-arms WALG_ROLE first (it recreates db), then unfences, starts the writers and reinstalls the cron', async () => {
    const { rollbackComposeCutover } = await import(
      '../../../src/lib/deploy/compose/scale-cutover.js'
    );
    const calls: string[] = [];
    const out = await rollbackComposeCutover({
      ip: '1.1.1.1',
      sshKeyPath: '/key',
      projectName: 'myapp',
      stopped: ['myapp-app', 'myapp-n8n'],
      demoted: true,
      cronRemoved: true,
      backupConfig: { schedule: '0 2 * * *' },
      deps: {
        rearmWalgRole: async () => {
          calls.push('rearm');
          return { ok: true };
        },
        psql: () => async () => '',
        unfence: async () => {
          calls.push('unfence');
          return true;
        },
        startWriters: async (_ip: string, _k: string, c: string[]) => {
          calls.push(`start:${c.join(',')}`);
          return true;
        },
        setupCron: async () => {
          calls.push('cron');
        },
      },
    });
    expect(calls).toEqual(['rearm', 'unfence', 'start:myapp-app,myapp-n8n', 'cron']);
    expect(out).toEqual({ ok: true, problems: [] });
  });

  it('a fence it cannot lift is a problem line with the manual SQL, never a throw', async () => {
    const { rollbackComposeCutover } = await import(
      '../../../src/lib/deploy/compose/scale-cutover.js'
    );
    const out = await rollbackComposeCutover({
      ip: '1.1.1.1',
      sshKeyPath: '/key',
      projectName: 'myapp',
      stopped: ['myapp-app'],
      demoted: false,
      cronRemoved: false,
      deps: {
        psql: () => async () => '',
        unfence: async () => false,
        startWriters: async () => true,
      },
    });
    expect(out.ok).toBe(false);
    expect(out.problems).toEqual([
      expect.stringMatching(
        /1\.1\.1\.1 is still write-fenced; run this in its db container: .*ALTER SYSTEM RESET default_transaction_read_only/,
      ),
    ]);
  });
});

describe('removeComposeBackupCron', () => {
  it('throws when the removal is not confirmed by its marker', async () => {
    const { removeComposeBackupCron } = await import(
      '../../../src/lib/deploy/compose/scale-cutover.js'
    );
    await expect(
      removeComposeBackupCron('1.1.1.1', '/key', { run: async () => false }),
    ).rejects.toThrow('could not remove the backup cron on 1.1.1.1');
    await expect(
      removeComposeBackupCron('1.1.1.1', '/key', { run: async () => 'VC_CRON_REMOVED\n' }),
    ).resolves.toBeUndefined();
  });
});
