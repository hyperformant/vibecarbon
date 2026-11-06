/**
 * Nothing may touch a new bucket until the provider's quiet period has passed.
 *
 * On Hetzner, the HEAD and LIST that createBucket used to send straight after
 * CreateBucket are what made a bucket unreliable: 2026-11-05, 54 new buckets
 * across hel1, fsn1 and nbg1, touched at once, 6 of 18 missed their first
 * probe and exactly those 6 answered NoSuchBucket at random to the end of the
 * test. Silent for 1 s or 2 s, 0 of 36 missed and 6,512 requests were clean.
 * So the order of requests is the property, and that is what these pin.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DigitalOceanSpacesProvider } from '../../../src/lib/providers/digitalocean-spaces.js';
import { HetznerS3Provider } from '../../../src/lib/providers/hetzner-s3.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { S3CompatibleProvider } from '../../../src/lib/providers/s3-base.js';

type Fake = {
  bucketExists: (b: string) => Promise<boolean>;
  _send: (cmd: unknown, opts?: unknown) => Promise<unknown>;
  waitForBucketVisible: (b: string) => Promise<boolean>;
  createBucket: (b: string) => Promise<{ created: boolean; ready: boolean }>;
};

function fake(provider: unknown, { exists = false } = {}) {
  const p = provider as Fake;
  const calls: string[] = [];
  p.bucketExists = vi.fn(async () => {
    calls.push('head');
    return exists;
  });
  p._send = vi.fn(async (cmd: unknown) => {
    calls.push((cmd as { constructor: { name: string } }).constructor.name);
    return {};
  });
  p.waitForBucketVisible = vi.fn(async () => {
    calls.push('visible');
    return true;
  });
  return { p, calls };
}

describe('createBucket quiet period', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a new Hetzner bucket gets no request until the quiet period has passed', async () => {
    const { p, calls } = fake(new HetznerS3Provider('ak', 'sk', 'fsn1'));
    const pending = p.createBucket('b');
    await vi.advanceTimersByTimeAsync(HetznerS3Provider.bucketQuietMs - 1);
    expect(calls).toEqual(['head', 'CreateBucketCommand']);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ created: true, ready: true });
    expect(calls).toEqual(['head', 'CreateBucketCommand', 'visible']);
  });

  it('a bucket that already exists takes no pause', async () => {
    const { p, calls } = fake(new HetznerS3Provider('ak', 'sk', 'fsn1'), { exists: true });
    await expect(p.createBucket('b')).resolves.toMatchObject({ created: false });
    expect(calls).toEqual(['head']);
  });

  it('a provider with no quiet period goes straight to the visibility wait', async () => {
    const { p, calls } = fake(new DigitalOceanSpacesProvider('ak', 'sk', 'nyc3'));
    await expect(p.createBucket('b')).resolves.toMatchObject({ created: true });
    expect(calls).toEqual(['head', 'CreateBucketCommand', 'visible']);
  });
});

const providersDir = join(import.meta.dirname, '../../../src/lib/providers');
type S3Class = { name: string; bucketQuietMs?: unknown };

describe('bucketQuietMs census', () => {
  it('every S3 provider class declares its own, so a new one has to decide', async () => {
    const classes: S3Class[] = [];
    for (const file of readdirSync(providersDir).filter((f) => f.endsWith('.js'))) {
      const src = readFileSync(join(providersDir, file), 'utf-8');
      const names = [...src.matchAll(/class\s+(\w+)\s+extends\s+S3CompatibleProvider\b/g)];
      if (names.length === 0) continue;
      const mod = await import(join(providersDir, file));
      for (const [, name] of names) classes.push(mod[name]);
    }
    expect(classes.length).toBeGreaterThanOrEqual(5);
    const missing = classes.filter(
      (C) =>
        !Object.hasOwn(C, 'bucketQuietMs') ||
        !Number.isInteger(C.bucketQuietMs) ||
        (C.bucketQuietMs as number) < 0,
    );
    expect(missing.map((C) => C.name)).toEqual([]);
  });

  it('the base class declares none, so there is no silent default', () => {
    expect(Object.hasOwn(S3CompatibleProvider, 'bucketQuietMs')).toBe(false);
  });

  it('only Hetzner waits: the others answered 780 of 780 from the first request', async () => {
    const waiting: string[] = [];
    for (const [id, P] of Object.entries(PROVIDERS)) {
      const Class = (await (
        P as unknown as { getObjectStorageProviderClass(): Promise<S3Class> }
      ).getObjectStorageProviderClass()) as S3Class;
      if (Class.bucketQuietMs !== 0) waiting.push(id);
    }
    expect(waiting).toEqual(['hetzner']);
  });
});
