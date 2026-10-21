import { describe, expect, it, vi } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

// Finding #2 (compose scale): the wal-g base backup of the OLD server must be
// kicked off in the BACKGROUND at the top of the per-server migration and only
// awaited just before the restore that consumes it — NOT awaited up front on the
// critical path. The backup SSHes the OLD server while every provisioning step
// (create / wait / provision / copy / pull / compose-up) touches the NEW server:
// different hosts, zero contention, so its ~11s hides entirely behind
// provisioning. Correctness is preserved: the restore still waits for the backup
// to finish landing in S3, and a backup failure still aborts before restore.
//
// We assert the two orderings that distinguish "overlapped" from "serial":
//   1. createNewServer runs BEFORE the backup resolves  → backup is overlapped
//   2. the backup resolves BEFORE restore is invoked    → correctness preserved

const h = vi.hoisted(() => {
  const events: string[] = [];
  const backupIps: string[] = [];
  // Defer the backup's resolution onto a real timer so that, if the code were
  // (wrongly) awaiting it before provisioning, 'backup:resolved' would land
  // before 'create'. With the overlap, 'create' (a resolved-promise microtask)
  // races ahead of the timer and lands first.
  const backupDeferMs = 25;
  return { events, backupIps, backupDeferMs };
});

// scale resolves the restore's base backup from the backup bucket's stop
// sentinels; here, a bucket holding one base backup.
vi.mock('../../../src/lib/walg/restore-base.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/lib/walg/restore-base.js')>();
  return {
    ...actual,
    // The backup bucket's credentials, as scale's preflight resolves them.
    resolveS3Config: async () => ({
      bucket: 'myapp-backups',
      endpoint: 'e',
      region: 'r',
      accessKey: 'a',
      secretKey: 's',
    }),
    readEnvBaseBackups: async () => ({
      s3Config: { bucket: 'myapp-backups' },
      location: 's3://myapp-backups/backups/myapp/prod/walg/7699032860122738725',
      // The lineage the listing read: the restore pins restore_command to it.
      lineage: '7699032860122738725',
      backups: [
        {
          name: 'base_000000010000000000000002',
          timeline: 1,
          startLsn: '0/2000028',
          finishTime: new Date('2026-10-20T01:00:00Z'),
          sizeBytes: 1024,
          uncompressedBytes: 4096,
        },
      ],
    }),
  };
});

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

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    backupCompose: (ip: string) => {
      h.events.push('backup:call');
      h.backupIps.push(ip);
      return new Promise((res) => {
        setTimeout(() => {
          h.events.push('backup:resolved');
          res({ result: 'pushed', name: 'base_000000010000000000000002' });
        }, h.backupDeferMs);
      });
    },
    waitForSSH: async () => true,
    setupServer: async () => {},
    setupServerFiles: async () => {},
    pullComposeImages: async () => {},
    startComposeStack: async () => {
      h.events.push('composeUp');
    },
    restoreCompose: async () => {
      h.events.push('restore:call');
    },
    dockerLoginOnServer: async () => {},
    isLocalOnlyImageTag: () => false,
    setupComposeBackupCron: async () => {},
    loadCloudInitScript: () => '#!/bin/bash\n',
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

function makeCtx() {
  const provider = {
    createServer: vi.fn(async () => {
      h.events.push('create');
      return { id: 'new-id', server: { public_net: { ipv4: { ip: '9.9.9.9' } } } };
    }),
    waitForServer: vi.fn(async () => ({ public_net: { ipv4: { ip: '9.9.9.9' } } })),
    deleteServer: vi.fn(async (id: string) => {
      h.events.push(`delete:${id}`);
    }),
    apiRequest: vi.fn(async () => ({})),
  };
  return {
    provider,
    ctx: {
      tier: 'compose',
      provider,
      Provider: HetznerProvider,
      newType: 'cpx31',
      region: 'fsn1',
      sshKeyId: 42,
      // Single-server (non-HA), no backup cron; the live lineage on record
      // (scale's preflight refuses without it).
      envConfig: { backup: { lineage: '7699032860122738725' } },
      projectName: 'myapp',
      environment: 'prod',
      sshKeyPath: '/key',
      domain: null, // skip the DNS update path
      services: {},
      dnsChallenge: true, // skip the HTTP-01 ACME reset path
      dnsProvider: null,
      apiToken: 'tok',
      targetServers: [{ ip: '1.1.1.1', id: 'old-id' }],
    },
  };
}

describe('scaleServers — background backup overlap (finding #2)', () => {
  it('kicks the OLD-server backup off in the background and only awaits it before restore', async () => {
    h.events.length = 0;
    const { ctx } = makeCtx();

    await SCALE_EFFECTS.scaleServers(ctx);

    // Sanity: the pipeline actually ran the steps we key on.
    expect(h.events).toContain('backup:call');
    expect(h.events).toContain('create');
    expect(h.events).toContain('backup:resolved');
    expect(h.events).toContain('restore:call');

    // 1. Overlap: the new server is created before the backup finishes — i.e.
    //    provisioning did NOT block on the backup. (Serial code resolves the
    //    backup before it ever calls createServer, failing this.)
    expect(h.events.indexOf('create')).toBeLessThan(h.events.indexOf('backup:resolved'));

    // 2. Correctness: the backup completes before the restore that consumes it.
    expect(h.events.indexOf('backup:resolved')).toBeLessThan(h.events.indexOf('restore:call'));
  });

  it('a skipped backup of the primary aborts before the restore (a skip is not a backup)', async () => {
    h.events.length = 0;
    const { provider, ctx } = makeCtx();
    const compose = await import('../../../src/lib/deploy/compose/index.js');
    const spy = vi
      .spyOn(compose, 'backupCompose')
      .mockResolvedValueOnce({ result: 'skipped', reason: 'already-running' });
    try {
      await expect(SCALE_EFFECTS.scaleServers(ctx)).rejects.toThrow(
        /backup of .* was skipped \(already-running\)/,
      );
      expect(provider.deleteServer).toHaveBeenCalledWith('new-id');
      expect(h.events).not.toContain('restore:call');
    } finally {
      spy.mockRestore();
    }
  });

  it('still aborts (and cleans up the new server) if the background backup fails', async () => {
    h.events.length = 0;
    const { provider, ctx } = makeCtx();
    const compose = await import('../../../src/lib/deploy/compose/index.js');
    const spy = vi
      .spyOn(compose, 'backupCompose')
      .mockRejectedValueOnce(new Error('wal-g push failed'));
    try {
      await expect(SCALE_EFFECTS.scaleServers(ctx)).rejects.toThrow(/wal-g push failed/);
      // The new server was provisioned, then deleted on the abort so it is not
      // left orphaned; the restore never ran against an un-backed-up source.
      expect(provider.createServer).toHaveBeenCalled();
      expect(provider.deleteServer).toHaveBeenCalledWith('new-id');
      expect(h.events).not.toContain('restore:call');
    } finally {
      spy.mockRestore();
    }
  });

  it('pushes the first base on the NEW server after its restore, before the old server goes (H2b)', async () => {
    h.events.length = 0;
    h.backupIps.length = 0;
    const { ctx } = makeCtx();
    await SCALE_EFFECTS.scaleServers(ctx);
    // The old server's backup, then the post-restore push on the new one.
    expect(h.backupIps).toEqual(['1.1.1.1', '9.9.9.9']);
    const push = h.events.lastIndexOf('backup:call');
    expect(h.events.indexOf('restore:call')).toBeLessThan(push);
    expect(push).toBeLessThan(h.events.indexOf('delete:old-id'));
  });

  it('a post-restore push that skips fails the scale: the new server goes, the old one stays', async () => {
    h.events.length = 0;
    h.backupIps.length = 0;
    const { provider, ctx } = makeCtx();
    const compose = await import('../../../src/lib/deploy/compose/index.js');
    const real = compose.backupCompose;
    const spy = vi.spyOn(compose, 'backupCompose').mockImplementation(async (ip, ...rest) =>
      ip === '9.9.9.9'
        ? { result: 'skipped', reason: 'in-recovery' }
        : // biome-ignore lint/suspicious/noExplicitAny: the factory mock's own signature.
          (real as any)(ip, ...rest),
    );
    try {
      await expect(SCALE_EFFECTS.scaleServers(ctx)).rejects.toThrow(
        'promoted, but the first base backup on the new timeline failed: the backup was skipped (in-recovery); run vibecarbon backup prod now',
      );
      expect(provider.deleteServer).toHaveBeenCalledWith('new-id');
      expect(provider.deleteServer).not.toHaveBeenCalledWith('old-id');
    } finally {
      spy.mockRestore();
    }
  });
});
