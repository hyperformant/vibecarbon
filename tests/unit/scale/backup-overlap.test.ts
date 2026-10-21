import { describe, expect, it, vi } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

// Compose scale's final base backup of the OLD server (H6, B6). It used to be
// kicked off in the background at the top of the per-server migration, which
// hid its cost behind provisioning but left the old server taking writes after
// the base: every one of them was lost when the old server was destroyed. It
// now runs after the write fence (scale-cutover.js), once the new server is
// provisioned and started, and the restore consumes exactly that base.
//
// We assert:
//   1. the new server is provisioned and started BEFORE the fence;
//   2. the backup runs AFTER the fence and resolves BEFORE the restore;
//   3. a skipped or failed backup aborts before any restore.

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

vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, loadProjectConfig: () => null, updateProjectConfig: () => ({}) };
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

// The fenced cutover's remote steps (compose-scale-fence.test.ts covers them).
vi.mock('../../../src/lib/deploy/compose/scale-cutover.js', async (orig) =>
  (await import('../helpers/scale-cutover-stub.js')).stubScaleCutover(await orig(), () =>
    h.events.push('fence'),
  ),
);
vi.mock('../../../src/lib/deploy/compose/ha.js', async (orig) =>
  (await import('../helpers/scale-cutover-stub.js')).stubDemote(await orig()),
);

vi.mock('../../../src/lib/deploy/write-fence.js', async (orig) =>
  (await import('../helpers/scale-cutover-stub.js')).stubWriteFence(await orig()),
);
vi.mock('../../../src/lib/deploy/compose/server-state-sync.js', async (orig) =>
  (await import('../helpers/scale-cutover-stub.js')).stubServerStateSync(await orig()),
);
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
  const server = { ip: '1.1.1.1', id: 'old-id' };
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
      projectConfig: { projectName: 'myapp', environments: {} },
      servers: [server],
      targetServers: [server],
    },
  };
}

describe('scaleServers — the final backup runs after the write fence (H6)', () => {
  it('provisions and starts the new server, fences, then backs up the old one before the restore', async () => {
    h.events.length = 0;
    const { ctx } = makeCtx();

    await SCALE_EFFECTS.scaleServers(ctx);

    // Sanity: the pipeline actually ran the steps we key on.
    expect(h.events).toContain('backup:call');
    expect(h.events).toContain('create');
    expect(h.events).toContain('backup:resolved');
    expect(h.events).toContain('restore:call');

    // 1. The new server is provisioned and its stack started before the fence:
    //    the write pause never includes provisioning.
    expect(h.events.indexOf('create')).toBeLessThan(h.events.indexOf('composeUp'));
    expect(h.events.indexOf('composeUp')).toBeLessThan(h.events.indexOf('fence'));

    // 2. The backup runs after the fence (it holds every write), and completes
    //    before the restore that consumes it.
    expect(h.events.indexOf('fence')).toBeLessThan(h.events.indexOf('backup:call'));
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

  it('still aborts (and cleans up the new server) if the final backup fails', async () => {
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

  it('a post-restore push that skips fails the scale after the cutover: no rollback, both servers stay (C8)', async () => {
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
      // The new server serves; the old one is kept (demoted) for the operator.
      expect(provider.deleteServer).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
