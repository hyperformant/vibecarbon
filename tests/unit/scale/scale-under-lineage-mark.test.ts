/**
 * Fix round 2 (Task 3): compose scale restores the LIVE database onto the new
 * server, never a chosen lineage. While backup.unrestoredPrior is set (a DR
 * redeploy left the replaced database's backups beside the new one's), a
 * resolved listing refuses, which failed scale after provisioning the new
 * server. Scale reads the recorded lineage's folder (C7) and proceeds.
 *
 * The listing here is the real readEnvBaseBackups over a fake S3 holding both
 * lineages; the server-side steps are stubs.
 */
import { describe, expect, it, vi } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

const OLD = '7612000000000000001';
const NEW = '7699032860122738725';

const h = vi.hoisted(() => {
  const PREFIX = 'backups/myapp/prod/walg';
  const sentinel = (finish: string) =>
    JSON.stringify({ FinishTime: finish, LSN: 1, CompressedSize: 10, UncompressedSize: 20 });
  const objects: Record<string, string> = {
    [`${PREFIX}/7612000000000000001/basebackups_005/base_000000010000000000000008_backup_stop_sentinel.json`]:
      sentinel('2026-10-19T02:00:00Z'),
    [`${PREFIX}/7699032860122738725/basebackups_005/base_00000001000000000000000C_backup_stop_sentinel.json`]:
      sentinel('2026-10-21T02:00:00Z'),
  };
  const fakeS3 = () => ({
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const prefix = String(cmd.input.Prefix ?? '');
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        const under = Object.keys(objects).filter((k) => k.startsWith(prefix));
        return {
          Contents: under
            .filter((k) => !k.slice(prefix.length).includes('/'))
            .map((Key) => ({ Key })),
          CommonPrefixes: [
            ...new Set(
              under
                .filter((k) => k.slice(prefix.length).includes('/'))
                .map((k) => `${prefix}${k.slice(prefix.length).split('/')[0]}/`),
            ),
          ].map((Prefix) => ({ Prefix })),
        };
      }
      const body = objects[String(cmd.input.Key)];
      return { Body: { transformToString: async () => body } };
    },
  });
  const creds = {
    bucket: 'myapp-backups',
    endpoint: 'e',
    region: 'r',
    accessKey: 'a',
    secretKey: 's',
  };
  return {
    restores: [] as Array<Record<string, unknown>>,
    fakeS3,
    creds,
    // What the backup bucket's credential lookup answers (null: none set).
    s3: { value: creds as typeof creds | null },
  };
});

vi.mock('../../../src/lib/walg/restore-base.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/lib/walg/restore-base.js')>();
  return {
    ...actual,
    // The real listing, over the fake bucket.
    resolveS3Config: async () => h.s3.value,
    readEnvBaseBackups: (args: Parameters<typeof actual.readEnvBaseBackups>[0]) =>
      actual.readEnvBaseBackups({
        ...args,
        s3Config: {
          bucket: 'myapp-backups',
          endpoint: 'e',
          region: 'r',
          accessKey: 'a',
          secretKey: 's',
        },
        makeClient: () => h.fakeS3(),
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
    backupCompose: async () => ({ result: 'pushed', name: 'base_00000001000000000000000C' }),
    waitForSSH: async () => true,
    setupServer: async () => {},
    setupServerFiles: async () => {},
    pullComposeImages: async () => {},
    startComposeStack: async () => {},
    restoreCompose: async (...args: unknown[]) => {
      h.restores.push(args[3] as Record<string, unknown>);
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
      // Single-server compose after a DR redeploy whose first base landed: the
      // replaced database's lineage is still marked unrestored.
      envConfig: {
        deployMode: 'compose',
        backup: { lineage: NEW, priorLineages: [OLD], unrestoredPrior: OLD },
      },
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

describe('compose scale under an unrestored prior lineage', () => {
  it('restores the live lineage onto the new server and proceeds', async () => {
    h.restores.length = 0;
    h.s3.value = h.creds;
    const { ctx } = makeCtx();
    await SCALE_EFFECTS.scaleServers(ctx);
    expect(h.restores).toHaveLength(1);
    expect(h.restores[0]).toMatchObject({ backup: 'base_00000001000000000000000C', lineage: NEW });
    expect(String(h.restores[0].recoveryConf)).toContain(`export RESTORE_LINEAGE=${NEW};`);
  });
});

// Fix round 3: scale's restore needs a recorded lineage and the backup
// bucket's credentials. Both are local facts, so both refuse before any
// server is built (the late refusals deleted a server just provisioned).
describe('compose scale preflight, before any provisioning', () => {
  it('no recorded lineage: refuses naming vibecarbon deploy, and no server is created', async () => {
    h.s3.value = h.creds;
    const { ctx, provider } = makeCtx();
    ctx.envConfig = { deployMode: 'compose', backup: {} };
    await expect(SCALE_EFFECTS.scaleServers(ctx)).rejects.toThrow(/vibecarbon deploy prod/);
    expect(provider.createServer).not.toHaveBeenCalled();
  });

  it('no backup credentials: refuses naming the variables, and no server is created', async () => {
    h.s3.value = null;
    const { ctx, provider } = makeCtx();
    await expect(SCALE_EFFECTS.scaleServers(ctx)).rejects.toThrow(
      /HETZNER_ACCESS_KEY and HETZNER_SECRET_KEY/,
    );
    expect(provider.createServer).not.toHaveBeenCalled();
    h.s3.value = h.creds;
  });
});
