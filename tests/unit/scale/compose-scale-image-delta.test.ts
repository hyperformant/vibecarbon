/**
 * A compose scale replacement gets the local-only app image the way a deploy
 * does: built once on this machine (amd64) and sent by layer delta, started as
 * soon as the old server's APP_IMAGE is read so it overlaps the bundle upload
 * and the registry logins. It used to build on the new server
 * (buildRemote: 66-114 s cold on DO, 2026-11-02). Only a machine with no
 * docker still builds on the server.
 *
 * The scale itself runs for real through SCALE_EFFECTS.scaleServers; ssh, the
 * build, the delta and the cutover's collaborators are faked (the harness of
 * compose-scale-tls-restore.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

const PUSHED = 'base_000000010000000000000004';
const LINEAGE = '7699032860122738725';
const WIPE = `echo "{}" > /letsencrypt/acme.json`;

const h = vi.hoisted(() => {
  const events: string[] = [];
  const state = {
    // What the new server's acme.json holds: a successful write makes it present.
    live: {} as Record<string, 'present' | 'absent'>,
    snapshot: null as string | null,
    checkTimeouts: [] as number[],
    localDocker: true,
    deltaFails: false,
    buildArgv: [] as string[],
    buildFails: false,
  };
  return { events, state };
});

vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    log: {
      info() {},
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
    updateProjectConfig: (fn: (c: Record<string, unknown>) => unknown) => fn({}),
  };
});

vi.mock('../../../src/lib/deploy/write-fence.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    writeWriteFenceMarker: () => {},
    clearWriteFenceMarker: () => {},
    writeScaleCutoverJournal: () => {},
    markScaleCutoverStep: (_c: unknown, step: string) => {
      h.events.push(`journal:done:${step}`);
    },
    clearScaleCutoverJournal: () => {},
  };
});

vi.mock('../../../src/lib/deploy/compose/server-state-sync.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    recordPendingServerState: () => {},
    syncScaledServerState: async () => {},
  };
});

vi.mock('../../../src/lib/walg/restore-base.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/lib/walg/restore-base.js')>();
  return {
    ...actual,
    resolveS3Config: async () => ({
      bucket: 'b',
      endpoint: 'e',
      region: 'r',
      accessKey: 'AK',
      secretKey: 'SK',
    }),
    readEnvBaseBackups: async () => ({
      s3Config: { bucket: 'b' },
      lineage: LINEAGE,
      backups: [{ name: PUSHED, finishTime: new Date('2026-10-20T00:00:00Z') }],
    }),
  };
});

vi.mock('../../../src/lib/deploy/tls-snapshot.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    readTlsSnapshot: async (_s3: unknown, key: string) => {
      h.events.push(`tls:read:${key}`);
      return h.state.snapshot ? { text: h.state.snapshot } : { text: null, reason: 'no snapshot' };
    },
  };
});

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    backupCompose: async () => ({ result: 'pushed', name: PUSHED }),
    waitForSSH: async () => true,
    setupServer: async () => {},
    setupServerFiles: async () => {
      h.events.push('setup-files');
    },
    pullComposeImages: async (ip: string) => {
      h.events.push(`pull:${ip}`);
    },
    startComposeStack: async (ip: string) => {
      h.events.push(`up:${ip}`);
    },
    restoreCompose: async () => {},
    dockerLoginOnServer: async () => {},
    setupComposeBackupCron: async () => {},
    configureStandbyReplication: async () => {},
    sshRunAsync: async (ip: string, _k: string, cmd: string) => {
      if (cmd.includes('docker pull ')) h.events.push(`basePull:${ip}`);
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
    composePsqlRunner: () => async (sql: string) => {
      if (sql.includes('pg_switch_wal')) return '000000010000000000000003\n';
      if (sql.includes('pg_stat_archiver')) return '000000010000000000000003|';
      return '';
    },
    demoteComposeWalgRole: async () => true,
    restoreComposeWalgRole: async () => ({ ok: true }),
  };
});

vi.mock('../../../src/lib/deploy/replication.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fenceDatabaseWrites: async () => ({ terminated: 0 }),
    unfenceDatabaseWrites: async () => true,
  };
});

vi.mock('../../../src/lib/walg/post-promote-backup.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    pushBaseBackupAfterPromote: async () => ({ name: 'base_000000020000000000000005' }),
  };
});

vi.mock('../../../src/lib/dns-provider.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    hasAutomatedDns: () => true,
    resolveDnsToken: () => 'dns-token',
    getDnsProvider: async () => ({
      upsertApexAndWildcard: async () => {},
      // The resume reads DNS part way moved: it adopts the new server.
      readARecord: async (_t: string, _z: string, name: string) =>
        name.startsWith('*.') ? ['1.1.1.1'] : ['9.9.9.9'],
    }),
  };
});

vi.mock('../../../src/lib/dns-propagation.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, waitForDNSPropagation: async () => true };
});

vi.mock('../../../src/lib/build.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getGHCRCredentials: async () => ({}) };
});

vi.mock('../../../src/lib/ssh.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    sshRun: async (
      ip: string,
      _k: string,
      argv: string[] | string,
      opts: { timeout?: number } = {},
    ) => {
      // The real argv contract (tests/_shared/ssh-contract.ts).
      const { assertSshRunArgv } = await import('../../_shared/ssh-contract.js');
      assertSshRunArgv(argv);
      if (argv[0] === 'cat' && String(argv[1]).endsWith('/.env')) {
        return 'APP_IMAGE=myapp-app:local\n';
      }
      const script = argv[2] ?? '';
      if (script.includes('echo present')) {
        h.events.push(`tls:check:${ip}`);
        h.state.checkTimeouts.push(opts.timeout ?? 0);
        return h.state.live[ip] ?? 'absent';
      }
      if (script.includes('.acme.json.restore')) {
        h.events.push(`tls:write:${ip}`);
        h.state.live[ip] = 'present';
        return '';
      }
      return '';
    },
    sshRunScript: async (ip: string, _k: string, script: string) => {
      if (script.includes(WIPE)) h.events.push(`tls:wipe:${ip}`);
      return '';
    },
  };
});

vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    checkDependency: (cmd: string) => (cmd === 'docker' ? h.state.localDocker : true),
    runCommandAsync: async (argv: string[], opts: unknown) => {
      if (argv[0] === 'docker' && argv[1] === 'build') {
        h.events.push(`localBuild:${argv[argv.indexOf('-t') + 1]}`);
        h.state.buildArgv = argv;
        if (h.state.buildFails) throw Object.assign(new Error('exit 1'), { stderr: 'boom' });
        return '';
      }
      return (actual.runCommandAsync as (a: string[], o: unknown) => Promise<unknown>)(argv, opts);
    },
  };
});

vi.mock('../../../src/lib/deploy/image.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, readRuntimeBaseRef: () => 'ghcr.io/o/node-runtime:1' };
});

vi.mock('../../../src/lib/deploy/layer-delta.js', () => ({
  deliverImage: async (args: { sshTarget: string; tag: string; basePull?: Promise<unknown> }) => {
    h.events.push(`delta:${args.sshTarget}:${args.tag}`);
    await args.basePull;
    if (h.state.deltaFails) throw new Error('image delivery failed: the target exited 1');
    return { bytes: 1, layersSent: 1, layersReused: 9 };
  },
}));

vi.mock('../../../src/lib/deploy/remote-build.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    buildRemote: async (ip: string, _k: string, tag: string) => {
      h.events.push(`remoteBuild:${ip}:${tag}`);
      return true;
    },
  };
});

const { SCALE_EFFECTS } = await import('../../../src/scale.js');

function makeCtx({ tier = 'compose', dnsChallenge = false, ca = 'staging' as string | null } = {}) {
  const provider = {
    createServer: vi.fn(async () => ({ id: 'new-id' })),
    waitForServer: vi.fn(async () => ({ public_net: { ipv4: { ip: '9.9.9.9' } } })),
    deleteServer: vi.fn(async () => {}),
    renameServer: vi.fn(async () => {}),
  };
  const primary = { ip: '1.1.1.1', id: 'old-id', role: 'primary', name: 'primary' };
  const standby = { ip: '2.2.2.2', id: 'sb-id', role: 'standby', name: 'standby' };
  const servers = tier === 'compose' ? [{ ip: '1.1.1.1', id: 'old-id' }] : [primary, standby];
  return {
    tier,
    provider,
    Provider: HetznerProvider,
    newType: 'cpx31',
    region: 'fsn1',
    sshKeyId: 42,
    envConfig: {
      backup: { lineage: LINEAGE, retentionDays: 5 },
      domain: 'app.example.com',
      dnsProvider: 'hetzner',
      dns: { zoneId: 'z' },
      ...(ca ? { tls: { state: 'trusted', ca } } : {}),
      servers,
    },
    projectConfig: { projectName: 'myapp', environments: {} },
    projectName: 'myapp',
    environment: 'prod',
    sshKeyPath: '/key',
    domain: 'app.example.com',
    services: {},
    dnsChallenge,
    dnsProvider: 'hetzner',
    apiToken: 'tok',
    servers,
    targetServers: servers,
  } as Record<string, unknown>;
}

function reset({ localDocker = true, deltaFails = false } = {}) {
  h.events.length = 0;
  h.state.live = {};
  h.state.snapshot = null;
  h.state.checkTimeouts = [];
  h.state.localDocker = localDocker;
  h.state.deltaFails = deltaFails;
  h.state.buildArgv = [];
  h.state.buildFails = false;
}

describe('compose scale: the replacement gets the app image by layer delta', () => {
  it('builds here once, sends the delta, and never builds on the new server', async () => {
    reset();
    await SCALE_EFFECTS.scaleServers(makeCtx({ dnsChallenge: true }));
    expect(h.events).toContain('localBuild:myapp-app:local');
    expect(h.events).toContain('delta:root@9.9.9.9:myapp-app:local');
    expect(h.events).toContain('basePull:9.9.9.9');
    expect(h.events.some((e) => e.startsWith('remoteBuild:'))).toBe(false);
    // amd64 only, whatever this machine is.
    expect(h.state.buildArgv).toContain('--platform=linux/amd64');
  });

  it('starts before the bundle upload and lands before the stack pull and compose up', async () => {
    reset();
    await SCALE_EFFECTS.scaleServers(makeCtx({ dnsChallenge: true }));
    const at = (e: string) => h.events.indexOf(e);
    for (const e of [
      'localBuild:myapp-app:local',
      'basePull:9.9.9.9',
      'delta:root@9.9.9.9:myapp-app:local',
    ]) {
      expect(h.events).toContain(e);
    }
    expect(at('localBuild:myapp-app:local')).toBeLessThan(at('setup-files'));
    expect(at('basePull:9.9.9.9')).toBeLessThan(at('setup-files'));
    expect(at('delta:root@9.9.9.9:myapp-app:local')).toBeLessThan(at('pull:9.9.9.9'));
    expect(at('pull:9.9.9.9')).toBeLessThan(at('up:9.9.9.9'));
  });

  it('a failed delta stops the scale before the new server starts its stack', async () => {
    reset({ deltaFails: true });
    await expect(SCALE_EFFECTS.scaleServers(makeCtx({ dnsChallenge: true }))).rejects.toThrow(
      /image delivery failed: the target exited 1/,
    );
    expect(h.events).not.toContain('up:9.9.9.9');
  });

  it('with no docker on this machine, the new server builds it (the only remote build left)', async () => {
    reset({ localDocker: false });
    await SCALE_EFFECTS.scaleServers(makeCtx({ dnsChallenge: true }));
    expect(h.events).toContain('remoteBuild:9.9.9.9:myapp-app:local');
    expect(h.events.some((e) => e.startsWith('localBuild:') || e.startsWith('delta:'))).toBe(false);
  });
});

describe('compose scale: an operator can keep the server-side build', () => {
  it('a deploy recorded in direct mode keeps building on the server, even with docker here', async () => {
    reset();
    const ctx = makeCtx({ dnsChallenge: true });
    (ctx.envConfig as Record<string, unknown>).imageBuild = 'direct';
    await SCALE_EFFECTS.scaleServers(ctx);
    expect(h.events).toContain('remoteBuild:9.9.9.9:myapp-app:local');
    expect(h.events.some((e) => e.startsWith('localBuild:') || e.startsWith('delta:'))).toBe(false);
  });

  it('-direct forces the server-side build', async () => {
    reset();
    const ctx = makeCtx({ dnsChallenge: true });
    ctx.forceDirectBuild = true;
    await SCALE_EFFECTS.scaleServers(ctx);
    expect(h.events).toContain('remoteBuild:9.9.9.9:myapp-app:local');
    expect(h.events.some((e) => e.startsWith('localBuild:'))).toBe(false);
  });

  it('a failed local build stops the scale; it never falls back to a server-side build', async () => {
    reset();
    h.state.buildFails = true;
    await expect(SCALE_EFFECTS.scaleServers(makeCtx({ dnsChallenge: true }))).rejects.toThrow(
      /docker build failed for myapp-app:local/,
    );
    expect(h.events.some((e) => e.startsWith('remoteBuild:'))).toBe(false);
    expect(h.events).not.toContain('up:9.9.9.9');
  });
});
