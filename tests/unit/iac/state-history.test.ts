/**
 * removePlainHistory (lib/iac/state-history.js): which of a stack's Pulumi
 * history copies go after the seal, on each backend. Decided by content: a
 * checkpoint that still holds a plain value the seal wraps goes, with its
 * file:// sidecar; a sealed one, every `.history.json` and anything that
 * isn't a checkpoint stay. The real engine's history is
 * tests/integration/iac/state-seal.test.ts.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const store = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  deleted: [] as string[],
  made: [] as unknown[][],
  endpoint: 'https://fsn1.your-objectstorage.com',
}));
vi.mock('../../../src/lib/providers/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/providers/index.js')>()),
  getObjectStorageProvider: async (...args: unknown[]) => {
    store.made.push(args);
    return {
      endpoint: store.endpoint,
      listObjectKeys: async (bucket: string, prefix: string) =>
        [...store.objects.keys()]
          .filter((k) => k.startsWith(`${bucket}/${prefix}`))
          .map((k) => k.slice(bucket.length + 1)),
      getObjectBytes: async (bucket: string, key: string) => {
        const body = store.objects.get(`${bucket}/${key}`);
        if (!body) throw new Error(`NoSuchKey: ${key}`);
        return body;
      },
      deleteObjectKeys: async (bucket: string, keys: string[]) => {
        for (const key of keys) {
          store.deleted.push(key);
          store.objects.delete(`${bucket}/${key}`);
        }
      },
    };
  },
}));

const { removePlainHistory } = await import('../../../src/lib/iac/state-history.js');
const { SECRET_SIG, SECRET_SIG_KEY } = await import('../../../src/lib/iac/state-seal.js');
const { SERVER_RESOURCE_TYPES } = await import('../../../src/lib/iac/create-timeout.js');

// Sentinel only: never a real credential.
const TOKEN = 'SENTINEL-history-token-6a2f';
const CLOUD_INIT = `#cloud-config\n# ${TOKEN}\n`;
const CIPHERTEXT = { [SECRET_SIG_KEY]: SECRET_SIG, ciphertext: 'v1:c2VhbGVk:c2VhbGVk' };

const latestWith = (userData: unknown) => ({
  manifest: { time: '2026-10-01T00:00:00Z', magic: 'x', version: 'v3.259.0' },
  resources: [
    { urn: 'urn:pulumi:e1::proj::pulumi:pulumi:Stack::proj-e1', type: 'pulumi:pulumi:Stack' },
    {
      urn: 'urn:pulumi:e1::proj::hcloud:index/server:Server::master',
      type: 'hcloud:index/server:Server',
      inputs: { userData },
      outputs: { userData },
    },
  ],
});
const checkpoint = (latest: unknown) =>
  Buffer.from(JSON.stringify({ version: 3, checkpoint: { stack: 'e1', latest } }));

const PREFIX = '.pulumi/history/proj/e1/';
const args = (backendUrl: string, extra: Record<string, unknown> = {}) => ({
  backendUrl,
  projectName: 'proj',
  stackName: 'e1',
  types: SERVER_RESOURCE_TYPES,
  ...extra,
});

describe('a file:// backend', () => {
  let root: string;
  let dir: string;
  const put = (name: string, body: Buffer | string) => {
    writeFileSync(join(dir, name), body);
    writeFileSync(join(dir, `${name}.attrs`), '{}');
  };
  beforeEach(() => {
    root = createTempDir('history-file-');
    dir = join(root, PREFIX);
    mkdirSync(dir, { recursive: true });
  });

  it('removes the plain copies and their sidecars, keeps the sealed ones and every list entry', async () => {
    put('e1-1.checkpoint.json', checkpoint(latestWith(CLOUD_INIT)));
    put('e1-1.history.json', '{}');
    put('e1-2.checkpoint.json', checkpoint(latestWith(CIPHERTEXT)));
    put('e1-2.history.json', '{}');
    // Compressed by an operator's PULUMI_DIY_BACKEND_GZIP or _ZSTD.
    put('e1-3.checkpoint.json.gz', gzipSync(checkpoint(latestWith(CLOUD_INIT))));
    put('e1-4.checkpoint.json.zst', zstdCompressSync(checkpoint(latestWith(CLOUD_INIT))));
    // A stack with no deployment yet holds nothing.
    put('e1-0.checkpoint.json', checkpoint(null));

    const result = await removePlainHistory(args(`file://${root}`));

    expect(result).toEqual({ managed: true, checked: 5, removed: 3, unreadable: [] });
    expect(readdirSync(dir).sort()).toEqual(
      [
        'e1-0.checkpoint.json',
        'e1-0.checkpoint.json.attrs',
        'e1-1.history.json',
        'e1-1.history.json.attrs',
        'e1-2.checkpoint.json',
        'e1-2.checkpoint.json.attrs',
        'e1-2.history.json',
        'e1-2.history.json.attrs',
      ].sort(),
    );
  });

  it('a pending operation that carries plain user data counts as plain', async () => {
    const latest = {
      ...latestWith(CIPHERTEXT),
      pending_operations: [
        {
          type: 'creating',
          resource: { type: 'hcloud:index/server:Server', inputs: { userData: CLOUD_INIT } },
        },
      ],
    };
    put('e1-1.checkpoint.json', checkpoint(latest));
    const result = await removePlainHistory(args(`file://${root}`));
    expect(result.removed).toBe(1);
  });

  it('a copy it cannot parse stays, by name only: nothing it holds reaches the result', async () => {
    put('e1-1.checkpoint.json', `not json ${TOKEN}`);
    const result = await removePlainHistory(args(`file://${root}`));
    expect(result).toEqual({
      managed: true,
      checked: 1,
      removed: 0,
      unreadable: ['e1-1.checkpoint.json'],
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(existsSync(join(dir, 'e1-1.checkpoint.json'))).toBe(true);
  });

  it('a stack with no history folder: nothing to do', async () => {
    const result = await removePlainHistory(args(`file://${createTempDir('history-empty-')}`));
    expect(result).toEqual({ managed: true, checked: 0, removed: 0, unreadable: [] });
  });

  it("another stack's history, one whose name starts the same, is never read", async () => {
    const other = join(root, '.pulumi/history/proj/e1-standby');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'x.checkpoint.json'), checkpoint(latestWith(CLOUD_INIT)));
    const result = await removePlainHistory(args(`file://${root}`));
    expect(result.checked).toBe(0);
    expect(existsSync(join(other, 'x.checkpoint.json'))).toBe(true);
  });
});

describe('an s3:// backend', () => {
  const URL =
    's3://proj-state?endpoint=fsn1.your-objectstorage.com&region=fsn1&s3ForcePathStyle=true';
  const S3 = {
    bucket: 'proj-storage',
    stateBucket: 'proj-state',
    accessKey: 'AK',
    secretKey: 'SK',
    region: 'fsn1',
  };
  beforeEach(() => {
    store.objects.clear();
    store.deleted.length = 0;
    store.made.length = 0;
    store.endpoint = 'https://fsn1.your-objectstorage.com';
  });
  const put = (key: string, body: Buffer) => store.objects.set(`proj-state/${PREFIX}${key}`, body);

  it("through the state bucket's own client: only the plain copies go", async () => {
    put('e1-1.checkpoint.json', checkpoint(latestWith(CLOUD_INIT)));
    put('e1-1.history.json', Buffer.from('{}'));
    put('e1-2.checkpoint.json', checkpoint(latestWith(CIPHERTEXT)));

    const result = await removePlainHistory(args(URL, { s3Config: S3, provider: 'hetzner' }));

    expect(result).toEqual({ managed: true, checked: 2, removed: 1, unreadable: [] });
    expect(store.made).toEqual([['hetzner', 'AK', 'SK', 'fsn1']]);
    expect(store.deleted).toEqual([`${PREFIX}e1-1.checkpoint.json`]);
    expect([...store.objects.keys()].sort()).toEqual(
      [`proj-state/${PREFIX}e1-1.history.json`, `proj-state/${PREFIX}e1-2.checkpoint.json`].sort(),
    );
  });

  it("the state bucket's region wins over the app buckets'", async () => {
    await removePlainHistory(
      args(URL, {
        s3Config: { ...S3, stateBucketRegion: 'fsn1', region: 'nbg1' },
        provider: 'hetzner',
      }),
    );
    expect(store.made).toEqual([['hetzner', 'AK', 'SK', 'fsn1']]);
  });

  it('a client that would reach another host than Pulumi does deletes nothing', async () => {
    put('e1-1.checkpoint.json', checkpoint(latestWith(CLOUD_INIT)));
    store.endpoint = 'https://nbg1.your-objectstorage.com';
    await expect(
      removePlainHistory(args(URL, { s3Config: S3, provider: 'hetzner' })),
    ).rejects.toThrow(
      /nbg1\.your-objectstorage\.com, but Pulumi uses fsn1\.your-objectstorage\.com/,
    );
    expect(store.deleted).toEqual([]);
  });

  it('no keys for the state bucket: it fails, so the next deploy tries again', async () => {
    await expect(
      removePlainHistory(args(URL, { s3Config: { ...S3, secretKey: '' }, provider: 'hetzner' })),
    ).rejects.toThrow(/no object storage client for the state bucket proj-state/);
  });

  it("a bucket that isn't this deploy's state bucket, or a backend that isn't S3 or a file: not vibecarbon's to touch", async () => {
    const foreign = await removePlainHistory(
      args('s3://someone-elses?endpoint=x&region=y', { s3Config: S3, provider: 'hetzner' }),
    );
    expect(foreign).toEqual({ managed: false, checked: 0, removed: 0, unreadable: [] });
    const cloud = await removePlainHistory(args('https://api.pulumi.com'));
    expect(cloud.managed).toBe(false);
    expect(store.made).toEqual([]);
  });
});
