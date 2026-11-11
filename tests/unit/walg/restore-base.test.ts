import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { backupStorageConfig } from '../../../src/lib/backups-bucket.js';
import {
  listBaseBackups,
  NoRestorePointError,
  resolveDeployRestorePoint,
  resolveRestoreBase,
} from '../../../src/lib/walg/restore-base.js';

/**
 * Restore resolves its exact base backup in the CLI, from the wal-g stop
 * sentinels in the backup bucket, before anything on the server is stopped
 * (H3). The server-side fetch then names that backup instead of LATEST.
 */

const A = {
  name: 'base_000000010000000000000002',
  timeline: 1,
  finishTime: new Date('2026-10-20T01:00:00Z'),
};
const B = {
  name: 'base_000000010000000000000004',
  timeline: 1,
  finishTime: new Date('2026-10-20T02:00:00Z'),
};
const C = {
  name: 'base_000000020000000000000006',
  timeline: 2,
  finishTime: new Date('2026-10-20T03:00:00Z'),
};

describe('resolveRestoreBase', () => {
  it('latest is the newest by finish time', () => {
    expect(resolveRestoreBase([A, B, C], 'latest').name).toBe(C.name);
    expect(resolveRestoreBase([C, A, B], 'latest').name).toBe(C.name);
  });

  it('a target instant takes the newest base that finished at or before it', () => {
    expect(resolveRestoreBase([A, B, C], new Date('2026-10-20T02:30:00Z')).name).toBe(B.name);
    expect(resolveRestoreBase([A, B, C], new Date('2026-10-20T02:00:00Z')).name).toBe(B.name);
  });

  it('a target before every base names the window', () => {
    expect(() => resolveRestoreBase([A, B, C], new Date('2026-10-20T00:30:00Z'))).toThrow(
      /oldest .*01:00/,
    );
    expect(() => resolveRestoreBase([A, B, C], new Date('2026-10-20T00:30:00Z'))).toThrow(
      /newest .*03:00/,
    );
    expect(() => resolveRestoreBase([A, B, C], new Date('2026-10-20T00:30:00Z'))).toThrow(
      NoRestorePointError,
    );
  });

  it('no base at all is a NoRestorePointError', () => {
    expect(() => resolveRestoreBase([], 'latest')).toThrow(NoRestorePointError);
  });
});

/** A fake S3 client: records every command it is sent, by class name. */
function fakeS3(objects: Record<string, string>, opts: { missingBucket?: boolean } = {}) {
  const calls: Array<{ command: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      calls.push({ command: cmd.constructor.name, input: cmd.input });
      if (opts.missingBucket) {
        const err = new Error('The specified bucket does not exist');
        err.name = 'NoSuchBucket';
        throw err;
      }
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        const prefix = String(cmd.input.Prefix ?? '');
        const keys = Object.keys(objects).filter((k) => k.startsWith(prefix));
        const contents = keys
          .filter((k) => !k.slice(prefix.length).includes('/'))
          .map((Key) => ({ Key }));
        // A delimited listing (the lineage folders) answers the folders too.
        const folders =
          cmd.input.Delimiter === '/'
            ? [
                ...new Set(
                  keys
                    .map((k) => k.slice(prefix.length))
                    .filter((rest) => rest.includes('/'))
                    .map((rest) => `${prefix}${rest.split('/')[0]}/`),
                ),
              ].map((Prefix) => ({ Prefix }))
            : [];
        return { Contents: contents, CommonPrefixes: folders, IsTruncated: false };
      }
      if (cmd.constructor.name === 'GetObjectCommand') {
        const body = objects[String(cmd.input.Key)];
        if (body === undefined) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        return { Body: { transformToString: async () => body } };
      }
      throw new Error(`unexpected S3 command ${cmd.constructor.name}`);
    },
  };
}

describe('listBaseBackups', () => {
  const sentinel = readFileSync(
    join(process.cwd(), 'tests/fixtures/walg/sentinel-3.0.9.json'),
    'utf-8',
  );
  const fixture = JSON.parse(sentinel);
  const NAME = fixture.name as string;
  const prefix = 'backups/myapp/prod/walg';

  it('parses a real wal-g 3.0.9 stop sentinel', async () => {
    const s3 = fakeS3({
      [`${prefix}/basebackups_005/${NAME}_backup_stop_sentinel.json`]: JSON.stringify(
        fixture.sentinel,
      ),
      [`${prefix}/basebackups_005/${NAME}/metadata.json`]: '{}',
      [`${prefix}/wal_005/000000010000000000000001.lz4`]: 'x',
    });
    const backups = await listBaseBackups({ s3, bucket: 'myapp-backups', prefix });
    expect(backups).toHaveLength(1);
    const [b] = backups;
    expect(b.name).toBe(NAME);
    expect(b.timeline).toBe(1);
    expect(b.finishTime).toBeInstanceOf(Date);
    expect(b.finishTime.toISOString()).toBe(new Date(fixture.sentinel.FinishTime).toISOString());
    expect(b.sizeBytes).toBe(fixture.sentinel.CompressedSize);
    expect(b.sizeBytes).toBeGreaterThan(0);
    expect(typeof b.startLsn).toBe('string');
    expect(b.startLsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
  });

  it('reads with ListObjectsV2 and GetObject only, never a bucket create or probe', async () => {
    const s3 = fakeS3({
      [`${prefix}/basebackups_005/${NAME}_backup_stop_sentinel.json`]: JSON.stringify(
        fixture.sentinel,
      ),
    });
    await listBaseBackups({ s3, bucket: 'myapp-backups', prefix });
    expect(new Set(s3.calls.map((c) => c.command))).toEqual(
      new Set(['ListObjectsV2Command', 'GetObjectCommand']),
    );
    expect(s3.calls[0].input).toMatchObject({
      Bucket: 'myapp-backups',
      Prefix: `${prefix}/basebackups_005/`,
    });
  });

  it('falls back to UncompressedSize when the compressed size is absent', async () => {
    const { CompressedSize: _drop, ...rest } = fixture.sentinel;
    const s3 = fakeS3({
      [`${prefix}/basebackups_005/${NAME}_backup_stop_sentinel.json`]: JSON.stringify(rest),
    });
    const [b] = await listBaseBackups({ s3, bucket: 'b', prefix });
    expect(b.sizeBytes).toBe(fixture.sentinel.UncompressedSize);
  });

  it('a missing bucket or an empty prefix is an empty list, not an error', async () => {
    expect(await listBaseBackups({ s3: fakeS3({}), bucket: 'b', prefix })).toEqual([]);
    const gone = fakeS3({}, { missingBucket: true });
    expect(await listBaseBackups({ s3: gone, bucket: 'b', prefix })).toEqual([]);
    expect(gone.calls.map((c) => c.command)).toEqual(['ListObjectsV2Command']);
  });

  it('takes the timeline from the first 8 hex digits after base_', async () => {
    const s3 = fakeS3({
      [`${prefix}/basebackups_005/base_0000000A0000000000000006_backup_stop_sentinel.json`]:
        JSON.stringify(fixture.sentinel),
    });
    const [b] = await listBaseBackups({ s3, bucket: 'b', prefix });
    expect(b.timeline).toBe(10);
  });
});

describe('resolveDeployRestorePoint reads the backups bucket at its own endpoint', () => {
  const fixture = JSON.parse(
    readFileSync(join(process.cwd(), 'tests/fixtures/walg/sentinel-3.0.9.json'), 'utf-8'),
  );
  const NAME = fixture.name as string;
  const LINEAGE = '7699032860122738725';
  const prefix = 'backups/myapp/prod/walg';
  // The uploads bucket in fsn1; the backups bucket recorded in nbg1.
  const uploads = {
    accessKey: 'AK',
    secretKey: 'SK',
    walgPrefix: prefix,
    bucket: 'myapp-abc123-prod-storage',
    region: 'fsn1',
    endpoint: 'https://fsn1.your-objectstorage.com',
  };
  const target = {
    bucket: 'myapp-abc123-backups',
    region: 'nbg1',
    endpoint: 'https://nbg1.your-objectstorage.com',
  };
  const objects = {
    [`${prefix}/${LINEAGE}/basebackups_005/${NAME}_backup_stop_sentinel.json`]: JSON.stringify(
      fixture.sentinel,
    ),
  };

  it("lists the backups bucket through a client built for the backups bucket's endpoint", async () => {
    const s3 = fakeS3(objects);
    const makeClient = vi.fn(async () => s3);
    const point = await resolveDeployRestorePoint({
      restore: 'latest',
      k8s: true,
      backup: backupStorageConfig(uploads, target),
      credentialVars: 'HETZNER_S3_ACCESS_KEY and HETZNER_S3_SECRET_KEY',
      makeClient,
    });
    expect(point).toMatchObject({ backup: NAME, lineage: LINEAGE, target: 'latest' });
    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(makeClient).toHaveBeenCalledWith({
      accessKey: 'AK',
      secretKey: 'SK',
      walgPrefix: prefix,
      bucket: 'myapp-abc123-backups',
      region: 'nbg1',
      endpoint: 'https://nbg1.your-objectstorage.com',
    });
    // Every read named the backups bucket, never the uploads bucket.
    expect(new Set(s3.calls.map((c) => c.input.Bucket))).toEqual(new Set(['myapp-abc123-backups']));
  });

  it('with no backups target there is nothing to restore from', async () => {
    const makeClient = vi.fn();
    await expect(
      resolveDeployRestorePoint({
        restore: 'latest',
        k8s: true,
        backup: backupStorageConfig(uploads, null),
        credentialVars: 'HETZNER_S3_ACCESS_KEY and HETZNER_S3_SECRET_KEY',
        makeClient,
      }),
    ).rejects.toThrow(/no backup bucket on record/);
    expect(makeClient).not.toHaveBeenCalled();
  });
});
