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
  // Defer the backup's resolution onto a real timer so that, if the code were
  // (wrongly) awaiting it before provisioning, 'backup:resolved' would land
  // before 'create'. With the overlap, 'create' (a resolved-promise microtask)
  // races ahead of the timer and lands first.
  const backupDeferMs = 25;
  return { events, backupDeferMs };
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
    backupCompose: () => {
      h.events.push('backup:call');
      return new Promise<void>((res) => {
        setTimeout(() => {
          h.events.push('backup:resolved');
          res();
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
    waitForServer: vi.fn(async () => ({})),
    deleteServer: vi.fn(async () => {}),
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
      envConfig: {}, // no backup cron, single-server (non-HA)
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
});
