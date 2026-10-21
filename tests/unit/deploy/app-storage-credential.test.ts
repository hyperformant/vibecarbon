/**
 * Each environment's app gets its own object-storage key where the provider
 * can scope one (security plan 2026-10-20, Task 4: R2, R4, R9). Sentinel
 * values only, never a real secret.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appStorageSecretKeys,
  describeAppStorageAccess,
  finishAppKeyRotation,
  localAppStorageSecrets,
  resolveAppStorageCredential,
  revokeAppStorageCredential,
  storageAccessLine,
  storedAppStoragePair,
} from '../../../src/lib/deploy/app-storage-credential.js';
import { renderBundle } from '../../../src/lib/deploy/bundle.js';
import { buildAppSecretData, buildInfraSecretData } from '../../../src/lib/deploy/k8s/k3s.js';
import { startAppBucketFinalize } from '../../../src/lib/deploy/orchestrator.js';
import { envS3Record } from '../../../src/lib/deploy/s3-record.js';
import { parseDotenv } from '../../../src/lib/dotenv.js';
import { buildEnv } from '../../../src/lib/iac/index.js';
import { findEnvDrift } from '../../../src/lib/project.js';
import { DigitalOceanSpacesProvider } from '../../../src/lib/providers/digitalocean-spaces.js';
import { LinodeObjectStorageProvider } from '../../../src/lib/providers/linode-objectstorage.js';

const INFRA = {
  accessKey: 'SENTINEL_INFRA_AK',
  secretKey: 'SENTINEL_INFRA_SK',
  endpoint: 'https://nyc3.digitaloceanspaces.com',
};

/** An in-memory secret store with the same get/set shape as .env.local's. */
function memorySecrets(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    store,
    get: (k: string) => store[k] || undefined,
    set: vi.fn((k: string, v: string) => {
      store[k] = v;
    }),
  };
}

function mintSpies(Class: typeof DigitalOceanSpacesProvider | typeof LinodeObjectStorageProvider) {
  let n = 0;
  return {
    mint: vi.spyOn(Class, 'mintAppKey').mockImplementation(async () => {
      n += 1;
      return {
        id: `SENTINEL_KEY_${n}`,
        accessKey: `SENTINEL_KEY_${n}`,
        secretKey: `SENTINEL_SECRET_${n}`,
      };
    }),
    revoke: vi.spyOn(Class, 'revokeAppKey').mockResolvedValue(undefined),
    exists: vi.spyOn(Class, 'appKeyExists').mockResolvedValue(true),
  };
}

const resolveDo = (envConfig: object, secrets: ReturnType<typeof memorySecrets>) =>
  resolveAppStorageCredential({
    provider: 'digitalocean',
    environment: 'prod',
    envConfig,
    bucket: 'proj-abc-prod',
    infraCredential: INFRA,
    secrets,
    apiToken: 'SENTINEL_DO_TOKEN',
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('R9 lifecycle on a mint provider', () => {
  it('a first deploy mints once and records the key with no secret', async () => {
    const spies = mintSpies(DigitalOceanSpacesProvider);
    const secrets = memorySecrets();
    const out = await resolveDo({}, secrets);
    expect(spies.mint).toHaveBeenCalledTimes(1);
    expect(spies.mint.mock.calls[0][0]).toBe('proj-abc-prod');
    expect(out).toMatchObject({
      tier: 'isolated',
      accessKey: 'SENTINEL_KEY_1',
      secretKey: 'SENTINEL_SECRET_1',
      record: { id: 'SENTINEL_KEY_1', scoping: 'mint', tier: 'isolated', bucket: 'proj-abc-prod' },
    });
    expect(JSON.stringify(out.record)).not.toContain('SENTINEL_SECRET');
    const names = appStorageSecretKeys('prod');
    expect(secrets.store[names.accessKey]).toBe('SENTINEL_KEY_1');
    expect(secrets.store[names.secretKey]).toBe('SENTINEL_SECRET_1');
  });

  it('a redeploy with the secret present makes zero mint calls', async () => {
    const spies = mintSpies(DigitalOceanSpacesProvider);
    const names = appStorageSecretKeys('prod');
    const secrets = memorySecrets({
      [names.accessKey]: 'SENTINEL_KEY_0',
      [names.secretKey]: 'SENTINEL_SECRET_0',
    });
    const record = {
      id: 'SENTINEL_KEY_0',
      scoping: 'mint',
      tier: 'isolated',
      bucket: 'proj-abc-prod',
    };
    const out = await resolveDo({ s3: { appKey: record } }, secrets);
    expect(spies.mint).not.toHaveBeenCalled();
    expect(spies.revoke).not.toHaveBeenCalled();
    expect(out).toMatchObject({ accessKey: 'SENTINEL_KEY_0', record });
  });

  it('a redeploy with the secret missing locally mints a new key and records the old id as retiring, unrevoked', async () => {
    const spies = mintSpies(DigitalOceanSpacesProvider);
    const record = {
      id: 'SENTINEL_KEY_0',
      scoping: 'mint',
      tier: 'isolated',
      bucket: 'proj-abc-prod',
    };
    const out = await resolveDo({ s3: { appKey: record } }, memorySecrets());
    expect(spies.mint).toHaveBeenCalledTimes(1);
    expect(out.record).toMatchObject({ id: 'SENTINEL_KEY_1', retiring: ['SENTINEL_KEY_0'] });
    // The running app still uses the old key until the deploy succeeds.
    expect(spies.revoke).not.toHaveBeenCalled();
  });

  it('a successful deploy then revokes the retiring key and drops it from the record', async () => {
    const spies = mintSpies(DigitalOceanSpacesProvider);
    const record = {
      id: 'SENTINEL_KEY_1',
      scoping: 'mint',
      tier: 'isolated',
      bucket: 'proj-abc-prod',
      retiring: ['SENTINEL_KEY_0'],
    };
    const after = await finishAppKeyRotation({
      provider: 'digitalocean',
      record,
      apiToken: 'SENTINEL_DO_TOKEN',
    });
    expect(spies.revoke).toHaveBeenCalledWith('SENTINEL_KEY_0', { apiToken: 'SENTINEL_DO_TOKEN' });
    expect(after).toEqual({
      id: 'SENTINEL_KEY_1',
      scoping: 'mint',
      tier: 'isolated',
      bucket: 'proj-abc-prod',
    });
  });

  it('a revoke that fails after the deploy is a warn line, and the id stays retiring for the next try', async () => {
    const spies = mintSpies(DigitalOceanSpacesProvider);
    spies.revoke.mockRejectedValue(new Error('HTTP 500'));
    const log = { warn: vi.fn() };
    const after = await finishAppKeyRotation({
      provider: 'digitalocean',
      record: {
        id: 'SENTINEL_KEY_1',
        scoping: 'mint',
        tier: 'isolated',
        retiring: ['SENTINEL_KEY_0'],
      },
      apiToken: 'SENTINEL_DO_TOKEN',
      log,
    });
    expect(after?.retiring).toEqual(['SENTINEL_KEY_0']);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/SENTINEL_KEY_0 was not revoked \(HTTP 500\)/),
    );
  });

  it('a failed deploy never revokes the old key: rotation runs only after finish() and before the final save', async () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/deploy/orchestrator.js'), 'utf-8');
    const finish = src.indexOf('appBucketFinal = await appBucketFinalize.finish(p.log);');
    const exit = src.indexOf('process.exit(1);', finish);
    const rotate = src.indexOf('await finishAppKeyRotation(', finish);
    const finalSave = src.indexOf('const persistedConfig = loadProjectConfig()', finish);
    expect(finish).toBeGreaterThan(-1);
    expect(exit).toBeGreaterThan(finish);
    expect(rotate).toBeGreaterThan(exit);
    expect(finalSave).toBeGreaterThan(rotate);
    expect([...src.matchAll(/finishAppKeyRotation\(/g)]).toHaveLength(1);
    // And destroy revokes a still-retiring key with the current one.
    const spies = mintSpies(DigitalOceanSpacesProvider);
    await revokeAppStorageCredential({
      provider: 'digitalocean',
      envConfig: {
        s3: {
          appKey: {
            id: 'SENTINEL_KEY_1',
            scoping: 'mint',
            tier: 'isolated',
            retiring: ['SENTINEL_KEY_0'],
          },
        },
      },
      apiToken: 'SENTINEL_DO_TOKEN',
    });
    expect(spies.revoke.mock.calls.map((c) => c[0])).toEqual(['SENTINEL_KEY_1', 'SENTINEL_KEY_0']);
  });

  it('a key the provider no longer lists is replaced the same way', async () => {
    const spies = mintSpies(DigitalOceanSpacesProvider);
    spies.exists.mockResolvedValue(false);
    const names = appStorageSecretKeys('prod');
    const secrets = memorySecrets({
      [names.accessKey]: 'SENTINEL_KEY_0',
      [names.secretKey]: 'SENTINEL_SECRET_0',
    });
    const record = {
      id: 'SENTINEL_KEY_0',
      scoping: 'mint',
      tier: 'isolated',
      bucket: 'proj-abc-prod',
    };
    const out = await resolveDo({ s3: { appKey: record } }, secrets);
    expect(spies.mint).toHaveBeenCalledTimes(1);
    expect(out.record?.id).toBe('SENTINEL_KEY_1');
  });

  it('a refused mint fails with one line naming the scope, and never falls back to the infra key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"id":"forbidden"}', { status: 403 })),
    );
    const err = await resolveDo({}, memorySecrets()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/spaces_key create and delete scopes/);
    expect((err as Error).message.split('\n')).toHaveLength(1);
    expect((err as Error).message).not.toContain('SENTINEL_INFRA');
  });

  it('an env save ahead of the resolve keeps the recorded key; after it, the resolve decides', () => {
    const record = { id: 'SENTINEL_KEY_0', scoping: 'mint', tier: 'isolated', bucket: 'b' };
    const base = { bucket: 'b', region: 'nyc3', endpoint: INFRA.endpoint };
    expect(envS3Record(base, { appKey: record }).appKey).toEqual(record);
    expect(envS3Record({ ...base, appKey: null }, { appKey: record })).not.toHaveProperty('appKey');
    const next = { ...record, id: 'SENTINEL_KEY_1' };
    expect(envS3Record({ ...base, appKey: next }, { appKey: record }).appKey).toEqual(next);
  });

  it('two environments never overwrite each other in the local secret store', () => {
    const prod = appStorageSecretKeys('prod');
    const preview = appStorageSecretKeys('pr-12');
    expect(
      new Set([prod.accessKey, prod.secretKey, preview.accessKey, preview.secretKey]).size,
    ).toBe(4);
  });
});

describe('the local secret store (.env.local, through formatDotenvLine)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-app-key-'));
    writeFileSync(join(dir, '.env'), 'BETTER_AUTH_SECRET=SENTINEL_AUTH\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes each env pair to .env.local only, keyed per env, and drift ignores them', () => {
    const secrets = localAppStorageSecrets(dir);
    const prod = appStorageSecretKeys('prod');
    const staging = appStorageSecretKeys('staging');
    secrets.set(prod.accessKey, 'SENTINEL_PROD_AK');
    secrets.set(staging.accessKey, 'SENTINEL STAGING "AK"');
    const local = parseDotenv(readFileSync(join(dir, '.env.local'), 'utf-8'));
    expect(local[prod.accessKey]).toBe('SENTINEL_PROD_AK');
    expect(local[staging.accessKey]).toBe('SENTINEL STAGING "AK"');
    expect(secrets.get(prod.accessKey)).toBe('SENTINEL_PROD_AK');
    expect(readFileSync(join(dir, '.env'), 'utf-8')).not.toContain('SENTINEL_PROD_AK');
    expect(findEnvDrift(dir)).toEqual([]);
  });
});

describe('revoke on destroy', () => {
  const record = {
    id: 'SENTINEL_KEY_0',
    scoping: 'mint',
    tier: 'isolated',
    bucket: 'proj-abc-prod',
  };

  it('revokes the minted key', async () => {
    const spies = mintSpies(LinodeObjectStorageProvider);
    await expect(
      revokeAppStorageCredential({
        provider: 'linode',
        envConfig: { s3: { appKey: record } },
        apiToken: 'SENTINEL_LI_TOKEN',
      }),
    ).resolves.toEqual({ revoked: true });
    expect(spies.revoke).toHaveBeenCalledWith('SENTINEL_KEY_0', { apiToken: 'SENTINEL_LI_TOKEN' });
  });

  it('a revoke failure is a leak, never a throw', async () => {
    const spies = mintSpies(LinodeObjectStorageProvider);
    spies.revoke.mockRejectedValue(new Error('HTTP 500'));
    const out = await revokeAppStorageCredential({
      provider: 'linode',
      envConfig: { s3: { appKey: record } },
      apiToken: 'SENTINEL_LI_TOKEN',
    });
    expect(out.revoked).toBe(false);
    expect(out.leak).toMatch(/SENTINEL_KEY_0.*HTTP 500/);
  });

  it.each([false, true])(
    'the destroy effect revokes with purge=%s, and a failure lands in the leak ledger',
    async (purge) => {
      const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');
      const { createLeakLedger } = await import('../../../src/lib/destroy/leak-ledger.js');
      const { planDestroy } = await import('../../../src/lib/deploy/plan/destroy-plan.js');
      for (const tier of ['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const) {
        const names = planDestroy(tier, {}).map((s: { name: string }) => s.name);
        expect(names.indexOf('revoke-app-storage-key'), tier).toBeGreaterThan(-1);
        expect(names.indexOf('revoke-app-storage-key')).toBeLessThan(
          names.indexOf('delete-app-bucket'),
        );
      }
      const dir = mkdtempSync(join(tmpdir(), 'vc-revoke-'));
      try {
        const spies = mintSpies(LinodeObjectStorageProvider);
        const ctx = (leaks: ReturnType<typeof createLeakLedger>) => ({
          envConfig: { provider: 'linode', s3: { bucket: 'proj-abc-prod', appKey: record } },
          projectConfig: { projectName: 'proj', environments: {} },
          environment: 'prod',
          args: { purgeBackups: purge },
          results: { leaks },
          providerToken: 'SENTINEL_LI_TOKEN',
          cwd: dir,
          spinner: { start: vi.fn(), stop: vi.fn() },
        });
        const ok = createLeakLedger();
        await DESTROY_EFFECTS.revokeAppStorageKey(ctx(ok));
        expect(spies.revoke).toHaveBeenCalledTimes(1);
        expect(ok.entries).toEqual([]);

        spies.revoke.mockRejectedValue(new Error('HTTP 500'));
        const bad = createLeakLedger();
        await DESTROY_EFFECTS.revokeAppStorageKey(ctx(bad));
        expect(bad.entries).toEqual([
          expect.objectContaining({
            severity: 'leak',
            resourceClass: 'storage-key',
            resource: 'SENTINEL_KEY_0',
          }),
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('(a) destroying a fenced env retires its pasted key and says how to forget it', async () => {
    const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');
    const { createLeakLedger } = await import('../../../src/lib/destroy/leak-ledger.js');
    const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');
    const prompts = await import('@clack/prompts');
    vi.spyOn(HetznerProvider, 'promptObjectStorageCredentials').mockResolvedValue(null);
    const warn = vi.spyOn(prompts.log, 'warn').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'vc-retire-'));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const projectConfig = {
        projectName: 'proj',
        environments: {
          staging: {
            provider: 'hetzner',
            s3: {
              bucket: 'proj-abc-staging',
              appKey: { id: 'AK_S', scoping: 'paste-fence', tier: 'fenced' },
            },
          },
        },
      };
      const leaks = createLeakLedger();
      await DESTROY_EFFECTS.revokeAppStorageKey({
        envConfig: projectConfig.environments.staging,
        projectConfig,
        environment: 'staging',
        args: {},
        results: { leaks },
        cwd: dir,
        spinner: { start: vi.fn(), stop: vi.fn() },
      });
      expect(projectConfig).toMatchObject({ retiredAppKeys: ['AK_S'] });
      const saved = JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8'));
      expect(saved.retiredAppKeys).toEqual(['AK_S']);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/configure storage -forget AK_S/));
      expect(leaks.entries).toEqual([]);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the destroy preview names the key it will revoke', async () => {
    const { destroyPreviewBody } = await import('../../../src/lib/destroy/preview.js');
    const body = destroyPreviewBody({
      envConfig: { status: 'deployed', s3: { bucket: 'proj-abc-prod', appKey: record } },
      projectName: 'proj',
      envName: 'prod',
    });
    expect(body).toMatch(/App storage key SENTINEL_KEY_0 \(WILL BE REVOKED\)/);
  });
});

describe('the separation invariant: the app pair is never the WAL-G or Pulumi pair', () => {
  let cwdBackup: string;
  let dir: string;
  let stage: string | undefined;
  beforeEach(() => {
    cwdBackup = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'vc-app-sep-'));
    writeFileSync(join(dir, '.env'), 'BETTER_AUTH_SECRET=SENTINEL_AUTH\n');
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(cwdBackup);
    rmSync(dir, { recursive: true, force: true });
    if (stage) rmSync(stage, { recursive: true, force: true });
    stage = undefined;
  });

  async function appCredential(tier: 'mint' | 'paste-fence') {
    if (tier === 'mint') {
      mintSpies(DigitalOceanSpacesProvider);
      return resolveDo({}, memorySecrets());
    }
    const names = appStorageSecretKeys('prod');
    return resolveAppStorageCredential({
      provider: 'hetzner',
      environment: 'prod',
      envConfig: {},
      bucket: 'proj-abc-prod',
      infraCredential: { ...INFRA, endpoint: 'https://fsn1.your-objectstorage.com' },
      secrets: memorySecrets({
        [names.accessKey]: 'SENTINEL_PASTED_AK',
        [names.secretKey]: 'SENTINEL_PASTED_SK',
      }),
    });
  }

  it.each(['mint', 'paste-fence'] as const)(
    '%s: app.env and the app Secret carry the app pair, WAL-G and Pulumi the infra pair',
    async (tier) => {
      const app = await appCredential(tier);
      expect(app.accessKey).not.toBe(INFRA.accessKey);
      const s3Config = {
        accessKey: INFRA.accessKey,
        secretKey: INFRA.secretKey,
        bucket: 'proj-abc-prod',
        endpoint: INFRA.endpoint,
        region: 'nyc3',
        appCredential: { accessKey: app.accessKey, secretKey: app.secretKey },
      };
      stage = renderBundle('proj', { environment: 'prod', s3: s3Config });
      const appEnv = parseDotenv(readFileSync(join(stage, 'app.env'), 'utf-8'));
      const serverEnv = parseDotenv(readFileSync(join(stage, '.env'), 'utf-8'));
      expect(appEnv.S3_ACCESS_KEY).toBe(app.accessKey);
      expect(appEnv.S3_SECRET_KEY).toBe(app.secretKey);
      // compose's db service (WAL-G) reads the server .env's pair.
      expect(serverEnv.S3_ACCESS_KEY).toBe(INFRA.accessKey);
      expect(serverEnv.S3_SECRET_KEY).toBe(INFRA.secretKey);

      const appSecret = buildAppSecretData({ envLocal: {}, s3Config });
      expect(appSecret.S3_ACCESS_KEY).toBe(app.accessKey);
      const infraSecret = buildInfraSecretData({ envLocal: {}, s3Config, backupBucketName: 'b' });
      expect(infraSecret.S3_CREDENTIALS_INI).toContain(INFRA.accessKey);
      expect(infraSecret.S3_CREDENTIALS_INI).not.toContain(app.accessKey);

      const pulumiEnv = buildEnv({ s3Config });
      expect(pulumiEnv.AWS_ACCESS_KEY_ID).toBe(INFRA.accessKey);
      expect(pulumiEnv.AWS_SECRET_ACCESS_KEY).toBe(INFRA.secretKey);
    },
  );
});

describe('readiness: the app key HeadBucket runs inside the concurrent finalize', () => {
  const provider = {
    getBucketCorsOrigins: vi.fn(async () => ['https://prod.dev']),
    setBucketCors: vi.fn(async () => {}),
  };

  it('two failed HeadBuckets then one success inside the window: the deploy succeeds', async () => {
    const canHeadBucket = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const finalize = startAppBucketFinalize({
      providerId: 'digitalocean',
      createProvider: async () => provider,
      bucket: 'proj-abc-prod',
      domain: 'prod.dev',
      createAppProvider: async () => ({ canHeadBucket }),
      sleep: async () => {},
    });
    await expect(finalize.finish({ warn: vi.fn(), info: vi.fn() })).resolves.toEqual({});
    expect(canHeadBucket).toHaveBeenCalledTimes(3);
  });

  it('a key that never answers fails the deploy naming the bucket', async () => {
    let t = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    const finalize = startAppBucketFinalize({
      providerId: 'digitalocean',
      createProvider: async () => provider,
      bucket: 'proj-abc-prod',
      domain: 'prod.dev',
      createAppProvider: async () => ({ canHeadBucket: async () => false }),
      sleep: async (ms: number) => {
        t += ms;
      },
    });
    await expect(finalize.finish({ warn: vi.fn(), info: vi.fn() })).rejects.toThrow(
      /cannot reach bucket proj-abc-prod/,
    );
  });

  it('the orchestrator never awaits the readiness check serially before IaC', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/deploy/orchestrator.js'), 'utf-8');
    const uses = [...src.matchAll(/waitForAppKeyReady\(/g)];
    // Exactly one call, inside startAppBucketFinalize, and not awaited there.
    expect(uses).toHaveLength(1);
    const fnStart = src.indexOf('export function startAppBucketFinalize(');
    const fnEnd = src.indexOf('\n}\n', fnStart);
    expect(uses[0].index).toBeGreaterThan(fnStart);
    expect(uses[0].index).toBeLessThan(fnEnd);
    expect(src.slice(uses[0].index - 12, uses[0].index)).not.toMatch(/await\s*$/);
  });
});

describe('none providers share the infra key, with no mint or policy call', () => {
  it.each([
    ['scaleway', /scaleway: a one-bucket key needs org-wide IAM write/],
    ['vultr', /vultr: one key pair per subscription/],
  ])('%s', async (provider, reason) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const sendSpy = vi.spyOn(S3Client.prototype, 'send');
    const secrets = memorySecrets();
    const out = await resolveAppStorageCredential({
      provider,
      environment: 'prod',
      envConfig: {},
      bucket: 'proj-abc-prod',
      infraCredential: INFRA,
      secrets,
    });
    expect(out).toMatchObject({ tier: 'shared', record: null, accessKey: INFRA.accessKey });
    expect(out.reason).toMatch(reason);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(secrets.set).not.toHaveBeenCalled();
  });
});

describe('status: storage access row', () => {
  it('prints the tier and reason for each of the three tiers', async () => {
    const isolated = {
      s3: {
        bucket: 'proj-abc-prod',
        appKey: { id: 'SENTINEL_K', scoping: 'mint', tier: 'isolated', bucket: 'proj-abc-prod' },
      },
    };
    const fenced = {
      s3: {
        bucket: 'proj-abc-prod',
        appKey: { id: 'SENTINEL_K', scoping: 'paste-fence', tier: 'fenced' },
      },
    };
    const plain = { s3: { bucket: 'proj-abc-prod' } };
    await expect(storageAccessLine(isolated, 'linode')).resolves.toBe(
      'storage access: isolated (linode: key limited to bucket proj-abc-prod)',
    );
    await expect(storageAccessLine(fenced, 'hetzner')).resolves.toBe(
      'storage access: fenced (hetzner: pasted key denied on every other vibecarbon bucket)',
    );
    await expect(storageAccessLine(plain, 'hetzner')).resolves.toBe(
      'storage access: shared (hetzner: no app key pasted)',
    );
    await expect(storageAccessLine(plain, 'vultr')).resolves.toMatch(
      /^storage access: shared \(vultr: /,
    );
    await expect(storageAccessLine({}, 'vultr')).resolves.toBeNull();
    expect(
      describeAppStorageAccess({ provider: 'digitalocean', scoping: 'mint', envConfig: plain })
        .tier,
    ).toBe('shared');
  });

  it('status renders the row under the bucket', async () => {
    const { storageAccessRow } = await import('../../../src/status.js');
    await expect(
      storageAccessRow({ provider: 'scaleway', s3: { bucket: 'proj-abc-prod' } }),
    ).resolves.toMatch(/^storage access: shared \(scaleway: /);
  });
});

describe('GitOps gets the app pair, never the infra pair on a scoping provider', () => {
  const names = appStorageSecretKeys('prod');
  const record = {
    id: 'SENTINEL_KEY_0',
    scoping: 'mint',
    tier: 'isolated',
    bucket: 'proj-abc-prod',
  };

  it('a mint env hands GitOps its stored app pair', async () => {
    const pair = await storedAppStoragePair({
      provider: 'digitalocean',
      environment: 'prod',
      envConfig: { s3: { appKey: record } },
      infraCredential: INFRA,
      secrets: memorySecrets({
        [names.accessKey]: 'SENTINEL_KEY_0',
        [names.secretKey]: 'SENTINEL_S_0',
      }),
    });
    expect(pair).toEqual({ accessKey: 'SENTINEL_KEY_0', secretKey: 'SENTINEL_S_0' });
  });

  it('a mint env without its secret here refuses rather than hand over the infra pair', async () => {
    await expect(
      storedAppStoragePair({
        provider: 'digitalocean',
        environment: 'prod',
        envConfig: { s3: { appKey: record } },
        infraCredential: INFRA,
        secrets: memorySecrets(),
      }),
    ).rejects.toThrow(/not stored on this machine/);
  });

  it('seedOrgSecrets no longer seeds a repo-level S3 pair; the per-env secrets carry the app pair', async () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/github-environments.js'), 'utf-8');
    expect(src).not.toMatch(/setSecretFromBodyFile\('S3_(ACCESS|SECRET)_KEY'/);
    const { buildPerEnvSecrets } = await import('../../../src/lib/deploy/k8s/gitops-deploy.js');
    const perEnv = buildPerEnvSecrets(
      { S3_ACCESS_KEY: 'SENTINEL_INFRA_AK' },
      { appStorage: { accessKey: 'SENTINEL_APP_AK', secretKey: 'SENTINEL_APP_SK' } },
    );
    expect(perEnv.S3_ACCESS_KEY).toBe('SENTINEL_APP_AK');
    expect(perEnv.S3_SECRET_KEY).toBe('SENTINEL_APP_SK');
  });
});
