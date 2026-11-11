/**
 * The destroy preview must not claim resources exist when the only evidence is
 * a name in .vibecarbon.json.
 *
 * RCA (excitingai, 2026-10-16): the deploy saved its skeleton env entry (bucket
 * names, deploy mode) BEFORE creating anything, on purpose, so destroy can
 * always find what a failed deploy may have left behind. The deploy then
 * failed at its first S3 call. The preview listed the SSH key (a name it
 * prints unconditionally) and the storage bucket as things that "will be
 * permanently deleted"; neither existed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { destroyPreviewBody, readS3SetupCompleted } from '../../../src/lib/destroy/preview.js';

// The teardown the preview must agree with (handleBackupBucket), over a fake
// object store that records what it was asked to delete.
const store = vi.hoisted(() => ({
  deletedBuckets: [] as string[],
  deletedPrefixes: [] as string[],
}));
vi.mock('../../../src/lib/providers/index.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  providerFor: () => ({
    NAME: 'Hetzner Cloud',
    promptObjectStorageCredentials: async () => ({ accessKey: 'ak', secretKey: 'sk' }),
  }),
  getObjectStorageProvider: async () => ({
    deletePrefix: async (bucket: string, prefix: string) => {
      store.deletedPrefixes.push(`${bucket}/${prefix}`);
      return { objectsRemoved: 1 };
    },
    emptyAndDeleteBucket: async (bucket: string) => {
      store.deletedBuckets.push(bucket);
      return { deleted: true, objectsRemoved: 0, warnings: [] };
    },
  }),
}));
const { DESTROY_EFFECTS, destroyPreviewBucketFacts } = await import('../../../src/destroy.js');

const strip = (s: string) =>
  s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');

const SKELETON = {
  envName: 'prod',
  status: 'deploying',
  deployMode: 'compose',
  provider: 'hetzner',
  region: 'hil',
  s3: { bucket: 'excitingai-88d16c-prod-storage', region: 'fsn1' },
  backupS3: { bucket: 'excitingai-88d16c-backups', region: 'fsn1' },
};

describe('destroyPreviewBody', () => {
  it('labels what a stopped deploy only recorded as "may not exist"', () => {
    const body = strip(
      destroyPreviewBody({
        envConfig: SKELETON,
        projectName: 'excitingai',
        envName: 'prod',
        purgeBackups: false,
        s3SetupCompleted: false,
      }),
    );
    expect(body).toMatch(/excitingai-prod .*may not exist/);
    expect(body).toMatch(
      /excitingai-88d16c-prod-storage \(kept; deleted with -purge\) .*may not exist/,
    );
    expect(body).toMatch(/excitingai-88d16c-backups .*may not exist/);
    expect(body).toContain('Destroy checks each one and skips what is already gone');
  });

  it('lists a finished deploy plainly, with no "may not exist" caveat', () => {
    const body = strip(
      destroyPreviewBody({
        envConfig: {
          ...SKELETON,
          status: 'deployed',
          servers: [{ name: 'excitingai-prod', ip: '203.0.113.7' }],
        },
        projectName: 'excitingai',
        envName: 'prod',
        purgeBackups: false,
        s3SetupCompleted: true,
      }),
    );
    expect(body).not.toContain('may not exist');
    expect(body).toContain('excitingai-prod (203.0.113.7)');
    expect(body).toContain('Bucket: excitingai-88d16c-prod-storage (kept; deleted with -purge)');
    expect(body).not.toContain('all objects will be deleted');
  });

  it('trusts the buckets once the S3 step completed, even if a later step failed', () => {
    const body = strip(
      destroyPreviewBody({
        envConfig: SKELETON,
        projectName: 'excitingai',
        envName: 'prod',
        purgeBackups: false,
        s3SetupCompleted: true,
      }),
    );
    expect(body).not.toMatch(/prod-storage .*may not exist/);
    expect(body).toMatch(/excitingai-prod .*may not exist/);
  });
});

describe('destroyPreviewBody app bucket under -purge', () => {
  it('says the environment’s own bucket will be deleted', () => {
    const body = strip(
      destroyPreviewBody({
        envConfig: { ...SKELETON, status: 'deployed' },
        projectName: 'excitingai',
        envName: 'prod',
        purgeBackups: true,
        s3SetupCompleted: true,
        appBucketOwned: true,
      }),
    );
    expect(body).toContain(
      'Bucket: excitingai-88d16c-prod-storage (WILL BE DELETED, because you passed -purge)',
    );
    expect(body).not.toContain('kept; deleted with -purge');
  });

  it('keeps a bucket that is not the environment’s own (a legacy per-project bucket), as the destroy does', () => {
    const body = strip(
      destroyPreviewBody({
        envConfig: {
          ...SKELETON,
          status: 'deployed',
          s3: { bucket: 'excitingai-88d16c-storage', region: 'fsn1' },
        },
        projectName: 'excitingai',
        envName: 'prod',
        purgeBackups: true,
        s3SetupCompleted: true,
        appBucketOwned: false,
      }),
    );
    expect(body).toContain(
      'Bucket: excitingai-88d16c-storage (kept: legacy shared bucket, delete manually)',
    );
    expect(body).not.toMatch(/excitingai-88d16c-storage \(WILL BE DELETED/);
  });
});

describe('destroyPreviewBody backup bucket under -purge', () => {
  const purge = (backupBucketHolders: string[]) =>
    strip(
      destroyPreviewBody({
        envConfig: { ...SKELETON, status: 'deployed' },
        projectName: 'excitingai',
        envName: 'staging',
        purgeBackups: true,
        s3SetupCompleted: true,
        appBucketOwned: true,
        backupBucketHeld: backupBucketHolders.length > 0,
        backupBucketHolders,
      }),
    );

  it('deletes only this environment’s folder while other environments keep the bucket, and names them', () => {
    const body = purge(['prod', 'qa']);
    expect(body).toContain(
      'Bucket: excitingai-88d16c-backups (backups/excitingai/staging/ WILL BE DELETED, because you passed -purge; the bucket stays for prod, qa)',
    );
    expect(body).not.toMatch(/excitingai-88d16c-backups \(WILL BE DELETED/);
  });

  it('deletes the bucket only when no environment keeps backups in it', () => {
    expect(purge([])).toContain(
      'Bucket: excitingai-88d16c-backups (WILL BE DELETED, because you passed -purge)',
    );
  });

  it('keeps a bucket whose record names no region anywhere, and says why, as the teardown refuses it', () => {
    const body = strip(
      destroyPreviewBody({
        envConfig: {
          ...SKELETON,
          status: 'deployed',
          s3: { bucket: 'excitingai-88d16c-prod-storage' },
          backupS3: { bucket: 'excitingai-88d16c-backups' },
        },
        projectName: 'excitingai',
        envName: 'prod',
        purgeBackups: true,
        s3SetupCompleted: true,
      }),
    );
    expect(body).toContain(
      'Bucket: excitingai-88d16c-backups (kept: no region on record, so destroy cannot tell which store holds it; delete backups/excitingai/prod/ manually)',
    );
    expect(body).not.toMatch(/excitingai-88d16c-backups \([^)]*WILL BE DELETED/);
  });
});

describe('the preview promises exactly what the -purge teardown does', () => {
  const BASE = 'myapp-cd9ecc-backups';
  const FSN1 = 'myapp-cd9ecc-fsn1-backups';
  const live = (name: string, backupS3?: { bucket: string; region?: string }) => ({
    provider: 'hetzner',
    envName: name,
    deployMode: 'compose',
    status: 'deployed',
    deployedAt: '2026-11-01T00:00:00.000Z',
    s3: { bucket: `myapp-cd9ecc-${name}-storage`, region: backupS3?.region ?? 'nbg1' },
    ...(backupS3 && { backupS3 }),
  });
  const layout = (environments: Record<string, unknown>) => ({
    projectName: 'myapp',
    bucketSalt: 'cd9ecc',
    environments: environments as Record<string, ReturnType<typeof live>>,
  });
  const twoRegions = {
    prod: live('prod', { bucket: BASE, region: 'nbg1' }),
    staging: live('staging', { bucket: FSN1, region: 'fsn1' }),
  };

  beforeEach(() => {
    store.deletedBuckets.length = 0;
    store.deletedPrefixes.length = 0;
  });

  /** The preview's backups line and the buckets the teardown deleted. */
  async function both(projectConfig: ReturnType<typeof layout>, envName: string) {
    const envConfig = projectConfig.environments[envName];
    const body = strip(
      destroyPreviewBody({
        envConfig,
        projectName: 'myapp',
        envName,
        purgeBackups: true,
        s3SetupCompleted: true,
        ...destroyPreviewBucketFacts(projectConfig, envName),
      }),
    );
    const bucket = envConfig.backupS3?.bucket ?? '(none)';
    const line = body.split('\n').find((l) => l.includes(bucket)) ?? '';
    const messages: string[] = [];
    const spinner = {
      start: () => {},
      stop: (m?: string) => messages.push(m ?? ''),
      message: () => {},
    };
    await DESTROY_EFFECTS.handleBackupBucket({
      envConfig,
      projectConfig,
      environment: envName,
      args: { purgeBackups: true },
      results: { leaks: createLeakLedger() },
      spinner,
      isK8s: false,
    });
    return {
      line,
      deleted: [...store.deletedBuckets],
      purgedPrefixes: [...store.deletedPrefixes],
      said: messages.join('\n'),
    };
  }

  it("staging -purge while prod lives in nbg1: fsn1's bucket goes, in the preview and the teardown", async () => {
    const { line, deleted } = await both(layout(twoRegions), 'staging');
    expect(line).toContain(`Bucket: ${FSN1} (WILL BE DELETED, because you passed -purge)`);
    expect(deleted).toEqual([FSN1]);
  });

  it('prod -purge while staging lives in fsn1: the base bucket goes, in the preview and the teardown', async () => {
    const { line, deleted } = await both(layout(twoRegions), 'prod');
    expect(line).toContain(`Bucket: ${BASE} (WILL BE DELETED, because you passed -purge)`);
    expect(deleted).toEqual([BASE]);
  });

  it('a record with no region anywhere: the preview keeps the bucket and the teardown deletes nothing', async () => {
    const regionless = {
      ...live('prod', { bucket: BASE }),
      s3: { bucket: 'myapp-cd9ecc-prod-storage' },
    };
    const { line, deleted, purgedPrefixes } = await both(layout({ prod: regionless }), 'prod');
    expect(line).toContain(
      `Bucket: ${BASE} (kept: no region on record, so destroy cannot tell which store holds it; delete backups/myapp/prod/ manually)`,
    );
    expect(deleted).toEqual([]);
    expect(purgedPrefixes).toEqual([]);
  });

  it('a live environment with no record (an older CLI) keeps the base bucket, and both name it', async () => {
    const config = layout({ ...twoRegions, old: live('old') });
    const { line, deleted, said } = await both(config, 'prod');
    expect(line).toContain(
      `Bucket: ${BASE} (backups/myapp/prod/ WILL BE DELETED, because you passed -purge; the bucket stays for old)`,
    );
    expect(deleted).toEqual([]);
    expect(said).toContain('bucket kept for old, which keeps backups there');
  });
});

describe('destroyPreviewBody pinned app bucket', () => {
  it('says a pinned bucket is kept, even under -purge, as the destroy does', () => {
    for (const purgeBackups of [false, true]) {
      const body = strip(
        destroyPreviewBody({
          envConfig: {
            ...SKELETON,
            status: 'deployed',
            s3: { bucket: 'legacy-uploads', bucketPin: 'legacy-uploads', region: 'fsn1' },
          },
          projectName: 'excitingai',
          envName: 'prod',
          purgeBackups,
          s3SetupCompleted: true,
        }),
      );
      expect(body).toContain('Bucket: legacy-uploads (kept: pinned, delete manually)');
      expect(body).not.toMatch(/legacy-uploads \(WILL BE DELETED/);
    }
  });
});

describe('readS3SetupCompleted', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the deploy-state record of the S3 step', () => {
    dir = mkdtempSync(join(tmpdir(), 'vc-preview-'));
    expect(readS3SetupCompleted(dir, 'prod')).toBe(false);
    mkdirSync(join(dir, '.vibecarbon'));
    writeFileSync(
      join(dir, '.vibecarbon', 'deploy-state-prod.json'),
      JSON.stringify({ version: 2, steps: { 's3-setup': { status: 'started' } } }),
    );
    expect(readS3SetupCompleted(dir, 'prod')).toBe(false);
    writeFileSync(
      join(dir, '.vibecarbon', 'deploy-state-prod.json'),
      JSON.stringify({ version: 2, steps: { 's3-setup': { status: 'completed' } } }),
    );
    expect(readS3SetupCompleted(dir, 'prod')).toBe(true);
  });
});
