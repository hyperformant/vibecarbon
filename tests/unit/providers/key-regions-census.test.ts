/**
 * Every S3 provider class declares `keyRegions`: which of its ENDPOINTS the
 * operator's storage keys can address. locateBucket asks only those
 * (addressableRegions), so a cluster these keys cannot reach, which answers
 * 403 for any bucket, never turns a purge of a bucket that does not exist
 * into a leak. Before, a Vultr `-purge` asked ewr1 first with an ams1
 * subscription's keys, got 403, and recorded a leak with exit 2.
 *
 * The values, and the evidence each class cites beside its declaration:
 *   - hetzner 'all': one key pair reaches every bucket of the project, in
 *     every location (Hetzner Object Storage FAQ).
 *   - digitalocean 'all': a Full Access Spaces key covers all buckets, with
 *     no region in the grant (DigitalOcean Spaces, manage access).
 *   - scaleway 'all': the IAM key is bound to a Project, not a region.
 *   - linode 'own': a key holds the regions it was made for, and the
 *     account has one cluster per region while ENDPOINTS lists every one.
 *   - vultr 'own': one key pair per subscription, one cluster per
 *     subscription.
 *
 * A walk, not a hand list, so a new S3 provider is covered for free.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** What each endpoint host answers to HeadBucket, and every host asked. */
const world = vi.hoisted(() => ({
  answer: (_host: string): unknown => 'missing',
  asked: [] as string[],
}));

vi.mock('@aws-sdk/client-s3', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  class S3Client {
    host: string;
    constructor(config: { endpoint: string }) {
      this.host = new URL(config.endpoint).host;
    }
    async send() {
      world.asked.push(this.host);
      const a = world.answer(this.host);
      if (a === 'here') return {};
      if (a === 'missing') {
        throw Object.assign(new Error('NotFound'), {
          name: 'NotFound',
          $metadata: { httpStatusCode: 404 },
        });
      }
      throw a;
    }
    destroy() {}
    middlewareStack = { add() {} };
  }
  return { ...real, S3Client };
});

const { PROVIDERS } = await import('../../../src/lib/providers/index.js');
const { S3CompatibleProvider } = await import('../../../src/lib/providers/s3-base.js');

const SETTLED: Record<string, 'all' | 'own'> = {
  hetzner: 'all',
  digitalocean: 'all',
  scaleway: 'all',
  linode: 'own',
  vultr: 'own',
};

type S3Class = {
  name: string;
  keyRegions?: unknown;
  ENDPOINTS: Record<string, string>;
  new (
    ak: string,
    sk: string,
    region: string,
  ): {
    locateBucket(b: string): Promise<string | null>;
    addressableRegions(): string[];
  };
};

const providersDir = join(import.meta.dirname, '../../../src/lib/providers');

async function classesFromFiles(): Promise<S3Class[]> {
  const out: S3Class[] = [];
  for (const file of readdirSync(providersDir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(providersDir, file), 'utf-8');
    const names = [...src.matchAll(/class\s+(\w+)\s+extends\s+S3CompatibleProvider\b/g)].map(
      (m) => m[1],
    );
    if (names.length === 0) continue;
    const mod = await import(join(providersDir, file));
    for (const name of names) out.push(mod[name]);
  }
  return out;
}

async function classesFromRegistry(): Promise<Array<{ id: string; Class: S3Class }>> {
  return Promise.all(
    Object.entries(PROVIDERS).map(async ([id, P]) => ({
      id,
      Class: (await (
        P as unknown as { getObjectStorageProviderClass(): Promise<S3Class> }
      ).getObjectStorageProviderClass()) as S3Class,
    })),
  );
}

const declared = (C: S3Class) =>
  Object.hasOwn(C, 'keyRegions') && ['all', 'own'].includes(String(C.keyRegions));

const forbidden = () =>
  Object.assign(new Error(''), { name: 'Forbidden', $metadata: { httpStatusCode: 403 } });

beforeEach(() => {
  world.asked = [];
  world.answer = () => 'missing';
});

describe('keyRegions census', () => {
  it('(a) every S3 provider class declares its own keyRegions', async () => {
    const fromFiles = await classesFromFiles();
    expect(fromFiles.length).toBeGreaterThanOrEqual(5);
    const missing = [
      ...fromFiles.filter((C) => !declared(C)).map((C) => C.name),
      ...(await classesFromRegistry()).filter(({ Class }) => !declared(Class)).map(({ id }) => id),
    ];
    expect(missing, 'missing or invalid static keyRegions').toEqual([]);
  });

  it('(b) the base declares none, and a class without one cannot search', async () => {
    expect(Object.hasOwn(S3CompatibleProvider, 'keyRegions')).toBe(false);
    class Undeclared extends (S3CompatibleProvider as unknown as S3Class) {
      static ENDPOINTS = { a1: 'https://a1.example.test' };
    }
    const store = new Undeclared('A'.repeat(20), 'x'.repeat(40), 'a1');
    await expect(store.locateBucket('b')).rejects.toThrow(/declares no keyRegions/);
    expect(world.asked).toEqual([]);
  });

  it('(c) each provider declares the settled scope', async () => {
    const got = Object.fromEntries(
      (await classesFromRegistry()).map(({ id, Class }) => [id, Class.keyRegions]),
    );
    expect(got).toEqual(SETTLED);
  });
});

/** A store of `id` at a region that is not the first of its ENDPOINTS. */
async function storeOf(id: string) {
  const { Class } = (await classesFromRegistry()).find((r) => r.id === id) as {
    Class: S3Class;
  };
  const regions = Object.keys(Class.ENDPOINTS);
  const region = regions[regions.length - 1];
  const host = (r: string) => new URL(Class.ENDPOINTS[r]).host;
  return {
    store: new Class('A'.repeat(20), 'x'.repeat(40), region),
    region,
    own: host(region),
    hosts: regions.map(host),
  };
}

describe.each(
  Object.entries(SETTLED)
    .filter(([, s]) => s === 'own')
    .map(([id]) => id),
)('locateBucket on %s (keys for one cluster)', (id) => {
  it('asks only its own cluster, so other clusters answering 403 never stop a purge', async () => {
    const { store, own } = await storeOf(id);
    world.answer = (host) => (host === own ? 'missing' : forbidden());
    await expect(store.locateBucket('proj-abc-staging-storage')).resolves.toBeNull();
    expect(world.asked).toEqual([own]);
  });

  it('finds a bucket there', async () => {
    const { store, own, region } = await storeOf(id);
    world.answer = (host) => (host === own ? 'here' : forbidden());
    await expect(store.locateBucket('proj-abc-staging-storage')).resolves.toBe(region);
  });

  it('still fails closed when its own cluster answers anything but not found', async () => {
    const { store, region } = await storeOf(id);
    world.answer = () => forbidden();
    await expect(store.locateBucket('proj-abc-staging-storage')).rejects.toMatchObject({
      name: 'BucketLocateError',
      region,
    });
  });
});

describe.each(
  Object.entries(SETTLED)
    .filter(([, s]) => s === 'all')
    .map(([id]) => id),
)('locateBucket on %s (keys for every region)', (id) => {
  it('asks every region before it says not found', async () => {
    const { store, hosts } = await storeOf(id);
    await expect(store.locateBucket('proj-abc-staging-storage')).resolves.toBeNull();
    expect(world.asked).toEqual(hosts);
  });

  it('a 403 in another region still fails closed', async () => {
    const { store, own, hosts } = await storeOf(id);
    const other = hosts.find((h) => h !== own) as string;
    world.answer = (host) => (host === other ? forbidden() : 'missing');
    await expect(store.locateBucket('proj-abc-staging-storage')).rejects.toMatchObject({
      name: 'BucketLocateError',
    });
  });
});
