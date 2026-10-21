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
    // What the DNS provider reads back for apex and wildcard after a failed
    // update (null: the update succeeds).
    dnsReadBack: null as null | string[][],
    // The DNS update's error (null: it succeeds), and a read-back that fails.
    dnsError: null as null | string,
    dnsUnreadable: false,
    saved: [] as unknown[],
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
  return {
    ...actual,
    loadProjectConfig: () => null,
    saveProjectConfig: (c: unknown) => {
      h.state.saved.push(c);
    },
  };
});

vi.mock('../../../src/lib/deploy/write-fence.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    writeWriteFenceMarker: (_c: unknown, m: { ip: string }) => {
      h.events.push(`marker:write:${m.ip}`);
    },
    clearWriteFenceMarker: () => {
      h.events.push('marker:clear');
    },
    writeScaleCutoverJournal: (_c: unknown, j: { oldIp: string; newIp: string }) => {
      h.events.push(`journal:write:${j.oldIp}->${j.newIp}`);
    },
    markScaleCutoverStep: (_c: unknown, step: string) => {
      h.events.push(`journal:done:${step}`);
    },
    clearScaleCutoverJournal: () => {
      h.events.push('journal:clear');
    },
  };
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
        if (h.state.dnsError) throw new Error(h.state.dnsError);
      },
      readARecord: async (_t: string, _z: string, name: string) => {
        if (h.state.dnsUnreadable) throw new Error('dns read 503');
        return h.state.dnsReadBack?.[name.startsWith('*.') ? 1 : 0] ?? [];
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

const { SCALE_EFFECTS, resumeComposeCutover } = await import('../../../src/scale.js');
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
  h.state.dnsReadBack = null;
  h.state.dnsError = null;
  h.state.dnsUnreadable = false;
  h.state.saved.length = 0;
}

describe('fenceComposePrimary', () => {
  it('stops the writers, fences, switches WAL and waits for that file to be archived', async () => {
    const calls: string[] = [];
    const reads = ['000000010000000000000002|', '000000010000000000000003|'];
    const out = await fenceComposePrimary({
      environment: 'prod',
      ip: '1.1.1.1',
      sshKeyPath: '/key',
      projectName: 'myapp',
      services: [],
      deps: {
        writeMarker: () => {
          calls.push('marker');
        },
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
    // The durable marker first: a kill after it leaves a record deploy lifts.
    expect(calls).toEqual([
      'marker',
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
        environment: 'prod',
        ip: '1.1.1.1',
        sshKeyPath: '/key',
        projectName: 'myapp',
        services: [],
        deps: {
          writeMarker: () => {},
          clearMarker: () => {
            calls.push('clear');
          },
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
    expect(calls).toEqual(['fence', 'unfence', 'clear', 'start:myapp-app']);
  });
});

describe('scaleServers: the fenced cutover (single-server compose)', () => {
  it('runs fence, final backup, restore of that name, DNS flip, demote, post-promote push, destroy in order', async () => {
    reset();
    const { ctx } = makeCtx();
    await SCALE_EFFECTS.scaleServers(ctx);
    const order = [
      'create',
      'marker:write:1.1.1.1',
      'writers:stop:app',
      'fence',
      'switch:1.1.1.1',
      'archive-wait:1.1.1.1',
      'backup:1.1.1.1',
      `restore:9.9.9.9:${PUSHED}`,
      'cron:remove',
      // The cutover journal, before the DNS call.
      'journal:write:1.1.1.1->9.9.9.9',
      'dns:9.9.9.9',
      'log:paused',
      // M1: demoted only after the flip, so a rollback never follows a demote.
      'demote:1.1.1.1',
      'push:9.9.9.9:5',
      'delete:old-id',
      'marker:clear',
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

  it('a failure before the DNS flip unfences, restarts writers, reinstalls the cron and deletes the new server (never a demote)', async () => {
    reset('cron');
    const { provider, ctx } = makeCtx();
    await expect(SCALE_EFFECTS.scaleServers(ctx)).rejects.toThrow(/could not remove|cron failed/);
    expect(h.events).not.toContain('demote:1.1.1.1');
    expect(h.events).not.toContain('rearm:1.1.1.1');
    const unfence = h.events.indexOf('unfence');
    expect(unfence).toBeGreaterThan(-1);
    // Unfenced, so the marker goes with it.
    expect(h.events.indexOf('marker:clear')).toBeGreaterThan(unfence);
    expect(h.events.indexOf('writers:start:myapp-app')).toBeGreaterThan(unfence);
    expect(h.events).toContain('cron:install:1.1.1.1');
    expect(h.events.some((e) => e.startsWith('dns:'))).toBe(false);
    expect(provider.deleteServer).toHaveBeenCalledWith('new-id');
    expect(provider.deleteServer).not.toHaveBeenCalledWith('old-id');
  });

  it('a DNS update that fails with every record still on the old server is before the flip: full rollback', async () => {
    reset();
    h.state.dnsError = 'dns api 500';
    h.state.dnsReadBack = [['1.1.1.1'], ['1.1.1.1']];
    const { provider, ctx } = makeCtx();
    await expect(SCALE_EFFECTS.scaleServers(ctx)).rejects.toThrow(/dns api 500/);
    expect(h.events).toContain('unfence');
    expect(h.events).toContain('writers:start:myapp-app');
    expect(h.events).toContain('cron:install:1.1.1.1');
    expect(h.events).not.toContain('demote:1.1.1.1');
    expect(provider.deleteServer).toHaveBeenCalledWith('new-id');
    // The new server is never recorded, and the journal goes.
    expect(h.state.saved).toEqual([]);
    expect(h.events).toContain('journal:clear');
  });

  it.each([
    ['the records cannot be read back', { dnsError: 'dns api 500', dnsUnreadable: true }],
    [
      'the update timed out (the provider may still apply it)',
      { dnsError: 'action timed out', dnsReadBack: [['1.1.1.1'], ['1.1.1.1']] },
    ],
  ])(
    'a DNS update whose outcome is unknown (%s) rolls nothing back and deletes nothing: the journal holds it for the resume',
    async (_why, state) => {
      reset();
      Object.assign(h.state, state);
      const { provider, ctx } = makeCtx();
      await expect(SCALE_EFFECTS.scaleServers(ctx)).rejects.toThrow(
        /where the records point now is unknown: .*The old server 1\.1\.1\.1 stays write-fenced and the new server 9\.9\.9\.9 is kept; rerun vibecarbon scale prod to finish it/,
      );
      expect(h.events).not.toContain('unfence');
      expect(h.events).not.toContain('journal:clear');
      expect(h.events).not.toContain('marker:clear');
      expect(provider.deleteServer).not.toHaveBeenCalled();
      expect(h.state.saved).toEqual([]);
    },
  );

  it('a DNS update that fails part way goes forward: records the new server and names the records still to move', async () => {
    reset();
    h.state.dnsError = 'dns api 500';
    h.state.dnsReadBack = [['9.9.9.9'], ['1.1.1.1']];
    const { provider, ctx } = makeCtx();
    await expect(SCALE_EFFECTS.scaleServers(ctx)).rejects.toThrow(
      /the DNS update failed part way \(dns api 500\); still to point at 9\.9\.9\.9: \*\.example\.com \(now 1\.1\.1\.1\)\. The old server 1\.1\.1\.1 \(id old-id\) is kept, write-fenced\. Still to run: the DNS flip, the old server's demote, the service recreate, the first base backup on the new timeline, the backup cron, the old server's destroy; rerun vibecarbon scale prod to finish it/,
    );
    expect(h.events).not.toContain('unfence');
    expect(provider.deleteServer).not.toHaveBeenCalled();
    // The new server's entry is saved: later commands reach it.
    const saved = h.state.saved.at(-1) as {
      environments: Record<string, { servers: Array<{ ip: string }> }>;
    };
    expect(saved.environments.prod.servers.map((sv) => sv.ip)).toEqual(['9.9.9.9']);
  });

  it('a failed restore rolls back the fence', async () => {
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
      /database to the new server 9\.9\.9\.9, then failed: push failed\. The old server 1\.1\.1\.1 \(id old-id\) is kept, write-fenced\. Still to run: the first base backup on the new timeline, the backup cron, the old server's destroy; rerun vibecarbon scale prod to finish it/,
    );
    expect(h.events).not.toContain('unfence');
    expect(h.events).not.toContain('rearm:1.1.1.1');
    expect(provider.deleteServer).not.toHaveBeenCalled();
  });
});

describe('rollbackComposeCutover', () => {
  it('unfences (clearing the marker), starts the writers and reinstalls the cron', async () => {
    const { rollbackComposeCutover } = await import(
      '../../../src/lib/deploy/compose/scale-cutover.js'
    );
    const calls: string[] = [];
    const out = await rollbackComposeCutover({
      environment: 'prod',
      ip: '1.1.1.1',
      sshKeyPath: '/key',
      projectName: 'myapp',
      stopped: ['myapp-app', 'myapp-n8n'],
      cronRemoved: true,
      backupConfig: { schedule: '0 2 * * *' },
      deps: {
        clearMarker: () => {
          calls.push('clear');
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
    expect(calls).toEqual(['unfence', 'clear', 'start:myapp-app,myapp-n8n', 'cron']);
    expect(out).toEqual({ ok: true, problems: [] });
  });

  it('a fence it cannot lift keeps its marker and is a problem line with the manual SQL, never a throw', async () => {
    const { rollbackComposeCutover } = await import(
      '../../../src/lib/deploy/compose/scale-cutover.js'
    );
    let cleared = false;
    const out = await rollbackComposeCutover({
      environment: 'prod',
      ip: '1.1.1.1',
      sshKeyPath: '/key',
      projectName: 'myapp',
      stopped: ['myapp-app'],
      cronRemoved: false,
      deps: {
        clearMarker: () => {
          cleared = true;
        },
        psql: () => async () => '',
        unfence: async () => false,
        startWriters: async () => true,
      },
    });
    expect(out.ok).toBe(false);
    expect(cleared).toBe(false);
    expect(out.problems).toEqual([
      expect.stringMatching(
        /1\.1\.1\.1 is still write-fenced \(vibecarbon deploy lifts it\); or run this in its db container: .*ALTER SYSTEM RESET default_transaction_read_only/,
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

describe('resumeComposeCutover (a scale stopped mid-cutover)', () => {
  const journal = {
    oldId: 'old-id',
    oldIp: '1.1.1.1',
    newServerId: 'new-id',
    newIp: '9.9.9.9',
    serverType: 'cpx31',
    stopped: ['myapp-app'],
    cronRemoved: true,
    done: [] as string[],
  };
  const resumeCtx = () => {
    const { provider, ctx } = makeCtx();
    const envConfig = {
      ...(ctx.envConfig as Record<string, unknown>),
      domain: 'example.com',
      ha: { writeFence: { ip: '1.1.1.1', source: 'scale', cutover: { ...journal } } },
    };
    return { provider, ctx: { ...ctx, envConfig, servers: undefined } };
  };

  it('DNS still all on the old server: rolls back (unfence, writers, cron), drops the journal, deletes the new server', async () => {
    reset();
    h.state.dnsReadBack = [['1.1.1.1'], ['1.1.1.1']];
    const { provider, ctx } = resumeCtx();
    await expect(resumeComposeCutover(ctx)).resolves.toBe('rolled-back');
    expect(h.events).toContain('unfence');
    expect(h.events).toContain('writers:start:myapp-app');
    expect(h.events).toContain('cron:install:1.1.1.1');
    expect(h.events).toContain('journal:clear');
    expect(provider.deleteServer).toHaveBeenCalledWith('new-id');
    expect(provider.deleteServer).not.toHaveBeenCalledWith('old-id');
    expect(h.events.some((e) => e.startsWith('demote:'))).toBe(false);
  });

  it('DNS part way: adopts the new server, points DNS at it again and runs the remaining post-flip steps', async () => {
    reset();
    h.state.dnsReadBack = [['9.9.9.9'], ['1.1.1.1']];
    const { provider, ctx } = resumeCtx();
    await expect(resumeComposeCutover(ctx)).resolves.toBe('finished');
    const order = [
      'dns:9.9.9.9',
      'demote:1.1.1.1',
      'push:9.9.9.9:5',
      'cron:install:9.9.9.9',
      'delete:old-id',
      'marker:clear',
    ];
    expect(h.events.filter((e) => order.includes(e))).toEqual(order);
    expect(h.events).not.toContain('unfence');
    expect(provider.deleteServer).not.toHaveBeenCalledWith('new-id');
    const saved = h.state.saved.at(-1) as {
      environments: Record<string, { servers: Array<{ ip: string; id: string }> }>;
    };
    expect(saved.environments.prod.servers.map((sv) => sv.id)).toEqual(['new-id']);
  });

  it('skips the post-flip steps the journal says are done', async () => {
    reset();
    const { ctx } = resumeCtx();
    const envConfig = ctx.envConfig as {
      ha: { writeFence: { cutover: { done: string[] } } };
    };
    envConfig.ha.writeFence.cutover.done = ['dns', 'demote', 'recreate', 'push'];
    // The config already names the new server: no DNS read is needed.
    (ctx.envConfig as { servers: unknown[] }).servers = [
      { ip: '9.9.9.9', id: 'new-id', serverType: 'cpx31' },
    ];
    await expect(resumeComposeCutover(ctx)).resolves.toBe('finished');
    expect(h.events.some((e) => e.startsWith('demote:') || e.startsWith('push:'))).toBe(false);
    expect(h.events.some((e) => e.startsWith('dns:'))).toBe(false);
    expect(h.events).toContain('delete:old-id');
  });

  it('DNS unreadable: changes nothing and refuses with the resume command', async () => {
    reset();
    h.state.dnsUnreadable = true;
    const { provider, ctx } = resumeCtx();
    await expect(resumeComposeCutover(ctx)).rejects.toThrow(
      /records point is unknown .*rerun vibecarbon scale prod to finish it/,
    );
    expect(h.events).not.toContain('unfence');
    expect(provider.deleteServer).not.toHaveBeenCalled();
  });
});
