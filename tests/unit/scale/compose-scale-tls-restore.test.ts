/**
 * Compose scale reuses the saved TLS certificate (TLS cert reuse, Task 5).
 *
 * The replacement primary gets the last validated snapshot written into its
 * acme.json after its images are pulled and before its stack starts, so it
 * serves HTTPS the moment DNS moves. A standby-only scale restores nothing
 * (the standby's issuer is disarmed).
 *
 * The HTTP-01 `recreate` step used to wipe acme.json unconditionally; it now
 * asks the new server first and wipes only when the file holds no apex
 * certificate. The decision is made on the server, never from memory, so a
 * cutover resumed from its journal (resumeComposeCutover, a new process)
 * decides the same way.
 *
 * Only ssh, the S3 read and the cutover's collaborators are faked here; the
 * restore itself (compose/tls-restore.js) runs for real.
 */
import { describe, expect, it, vi } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { expectNoKeyLeak } from '../deploy/_no-key-leak.ts';
import { acmeJson } from '../deploy/_tls-fixtures.ts';

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
    setupServerFiles: async () => {},
    pullComposeImages: async (ip: string) => {
      h.events.push(`pull:${ip}`);
    },
    startComposeStack: async (ip: string) => {
      h.events.push(`up:${ip}`);
    },
    restoreCompose: async () => {},
    dockerLoginOnServer: async () => {},
    isLocalOnlyImageTag: () => false,
    setupComposeBackupCron: async () => {},
    configureStandbyReplication: async () => {},
    sshRunAsync: async (_ip: string, _k: string, cmd: string) =>
      cmd.includes('compose-backup.sh') ? 'VC_CRON_REMOVED' : '',
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
      const script = Array.isArray(argv) ? (argv[2] ?? '') : String(argv);
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

const { SCALE_EFFECTS, resumeComposeCutover } = await import('../../../src/scale.js');

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

function reset({ snapshot = acmeJson({}) as string | null } = {}) {
  h.events.length = 0;
  h.state.live = {};
  h.state.snapshot = snapshot;
  h.state.checkTimeouts = [];
}

const tlsAndStack = (events: string[]) =>
  events.filter((e) => /^(pull|up|tls):/.test(e) && !e.startsWith('tls:read'));

describe('scale restores the certificate on the replacement primary', () => {
  it('restores after the image pull and before the stack starts, from the recorded CA', async () => {
    reset();
    await SCALE_EFFECTS.scaleServers(makeCtx({ dnsChallenge: true }));
    expect(tlsAndStack(h.events)).toEqual([
      'pull:9.9.9.9',
      'tls:check:9.9.9.9',
      'tls:write:9.9.9.9',
      'up:9.9.9.9',
    ]);
    expect(h.events).toContain('tls:read:backups/myapp/prod/tls/staging/compose-acme.json');
  });

  it('no recorded CA: nothing is read or written, the scale goes on', async () => {
    reset();
    await SCALE_EFFECTS.scaleServers(makeCtx({ dnsChallenge: true, ca: null }));
    expect(h.events.some((e) => e.startsWith('tls:'))).toBe(false);
    expect(h.events).toContain('up:9.9.9.9');
  });

  it('a standby-only scale never restores', async () => {
    reset();
    const ctx = makeCtx({ tier: 'compose-ha', dnsChallenge: true });
    ctx.targetServers = [(ctx.servers as Array<Record<string, unknown>>)[1]];
    // The streaming proof is not faked here, so the arm fails after its
    // stack is up; what matters is what ran before that.
    await expect(SCALE_EFFECTS.scaleServers(ctx)).rejects.toThrow(
      /the new standby 9\.9\.9\.9 could not be proven streaming/,
    );
    expect(h.events).toContain('up:9.9.9.9');
    expect(h.events.some((e) => e.startsWith('tls:'))).toBe(false);
  });

  it('no key material reaches operator output during a scale restore', async () => {
    reset();
    const snapshot = h.state.snapshot as string;
    const { captured } = await expectNoKeyLeak(snapshot, () =>
      SCALE_EFFECTS.scaleServers(makeCtx({ dnsChallenge: true })),
    );
    expect(h.events).toContain('tls:write:9.9.9.9');
    expect(captured).toContain(
      'TLS certificate for app.example.com restored from its last snapshot.',
    );
  });
});

describe('the HTTP-01 recreate wipes acme.json only when the new server has no apex certificate', () => {
  it('the live check finds the restored apex: no wipe is sent', async () => {
    reset();
    await SCALE_EFFECTS.scaleServers(makeCtx({ dnsChallenge: false }));
    // One check before the stack starts (the restore), one in the recreate.
    expect(h.events.filter((e) => e === 'tls:check:9.9.9.9')).toHaveLength(2);
    expect(h.events).not.toContain('tls:wipe:9.9.9.9');
    // The recreate's check reads a running stack: bounded at 30 s.
    expect(h.state.checkTimeouts.at(-1)).toBe(30_000);
  });

  it('the live check finds nothing (no snapshot to restore): the wipe is sent as before', async () => {
    reset({ snapshot: null });
    await SCALE_EFFECTS.scaleServers(makeCtx({ dnsChallenge: false }));
    expect(h.events).not.toContain('tls:write:9.9.9.9');
    const wipe = h.events.indexOf('tls:wipe:9.9.9.9');
    expect(wipe).toBeGreaterThan(-1);
    // The check that decided it comes first, inside the recreate step.
    expect(h.events.lastIndexOf('tls:check:9.9.9.9')).toBeLessThan(wipe);
    expect(wipe).toBeLessThan(h.events.indexOf('journal:done:recreate'));
  });

  it('DNS-01: no check and no wipe in the recreate, as before', async () => {
    reset({ snapshot: null });
    await SCALE_EFFECTS.scaleServers(makeCtx({ dnsChallenge: true }));
    // No snapshot: the restore never reaches the server, and DNS-01 skips the recreate check.
    expect(h.events.filter((e) => e === 'tls:check:9.9.9.9')).toHaveLength(0);
    expect(h.events).not.toContain('tls:wipe:9.9.9.9');
  });
});

describe('a resumed cutover (resumeComposeCutover) makes the same live-check decision', () => {
  const resumeCtx = () => {
    const ctx = makeCtx({ dnsChallenge: false });
    const envConfig = {
      ...(ctx.envConfig as Record<string, unknown>),
      ha: {
        writeFence: {
          ip: '1.1.1.1',
          source: 'scale',
          cutover: {
            oldId: 'old-id',
            oldIp: '1.1.1.1',
            newServerId: 'new-id',
            newIp: '9.9.9.9',
            serverType: 'cpx31',
            stopped: ['myapp-app'],
            cronRemoved: true,
            done: ['dns', 'demote'],
          },
        },
      },
    };
    return { ...ctx, envConfig, servers: undefined, sleep: async () => {} } as Record<
      string,
      unknown
    >;
  };

  it('the new server already holds the apex (restored before the stop): no wipe', async () => {
    reset();
    h.state.live['9.9.9.9'] = 'present';
    await expect(resumeComposeCutover(resumeCtx())).resolves.toBe('finished');
    expect(h.events).toContain('tls:check:9.9.9.9');
    expect(h.events).not.toContain('tls:wipe:9.9.9.9');
    expect(h.events).toContain('journal:done:recreate');
  });

  it('the new server holds no apex: the wipe is sent', async () => {
    reset();
    await expect(resumeComposeCutover(resumeCtx())).resolves.toBe('finished');
    expect(h.events).toContain('tls:wipe:9.9.9.9');
  });
});
