/**
 * R5/R7: the deploy never waits for a new bucket to settle. On a provider
 * with a settle window it reads the bucket's creation time beside IaC,
 * records it on the env and prints one note; on a 0-window provider it does
 * nothing at all. Only the e2e verification runs the gate.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAppBucketFinalize } from '../../../src/lib/deploy/orchestrator.js';

const MIN = 60_000;

function fakeProvider(createdAt: Date | null) {
  return {
    getBucketCorsOrigins: vi.fn(async () => ['https://prod.dev']),
    setBucketCors: vi.fn(async () => {}),
    listBuckets: vi.fn(async () => [{ name: 'app-b', creationDate: createdAt }]),
    bucketCreatedAt: vi.fn(async () => createdAt),
  };
}

function spyProbes() {
  const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  const sendSpy = vi.spyOn(S3Client.prototype, 'send');
  return { fetchSpy, sendSpy };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a Hetzner-shaped deploy (20 minute window) against a new bucket', () => {
  it('records the creation time and prints one note, with zero probes', async () => {
    const { fetchSpy, sendSpy } = spyProbes();
    const createdAt = new Date(Date.now() - MIN);
    const provider = fakeProvider(createdAt);
    const finalize = startAppBucketFinalize({
      providerId: 'hetzner',
      createProvider: async () => provider,
      bucket: 'app-b',
      domain: 'prod.dev',
    });
    const log = { warn: vi.fn(), info: vi.fn() };
    const result = await finalize.finish(log);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(provider.bucketCreatedAt).toHaveBeenCalledOnce();
    const notes = log.info.mock.calls.filter(([m]) => /new storage bucket/.test(m));
    expect(notes).toHaveLength(1);
    expect(notes[0][0]).toMatch(/about 19 more minutes/);
    expect(result.bucketCreatedAt).toBe(createdAt.toISOString());
    expect(result.corsOrigins).toEqual(['https://prod.dev']);
  });

  it('an unreadable creation time is recorded as null and still gets the note', async () => {
    spyProbes();
    const finalize = startAppBucketFinalize({
      providerId: 'hetzner',
      createProvider: async () => fakeProvider(null),
      bucket: 'app-b',
      domain: 'prod.dev',
    });
    const log = { warn: vi.fn(), info: vi.fn() };
    const result = await finalize.finish(log);
    expect(result).toHaveProperty('bucketCreatedAt', null);
    expect(log.info).toHaveBeenCalledOnce();
  });

  it('an old bucket is recorded with no note', async () => {
    spyProbes();
    const createdAt = new Date(Date.now() - 30 * MIN);
    const finalize = startAppBucketFinalize({
      providerId: 'hetzner',
      createProvider: async () => fakeProvider(createdAt),
      bucket: 'app-b',
      domain: 'prod.dev',
    });
    const log = { warn: vi.fn(), info: vi.fn() };
    const result = await finalize.finish(log);
    expect(result.bucketCreatedAt).toBe(createdAt.toISOString());
    expect(log.info).not.toHaveBeenCalled();
  });
});

describe.each(['digitalocean', 'linode', 'scaleway', 'vultr'])(
  'a 0-window provider (%s)',
  (providerId) => {
    it('reads no creation time, prints no note and records no bucketCreatedAt', async () => {
      const { fetchSpy, sendSpy } = spyProbes();
      const provider = fakeProvider(new Date(Date.now() - MIN));
      const finalize = startAppBucketFinalize({
        providerId,
        createProvider: async () => provider,
        bucket: 'app-b',
        domain: 'prod.dev',
      });
      const log = { warn: vi.fn(), info: vi.fn() };
      const result = await finalize.finish(log);

      expect(provider.bucketCreatedAt).not.toHaveBeenCalled();
      expect(provider.listBuckets).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
      expect(log.info).not.toHaveBeenCalled();
      expect(Object.hasOwn(result, 'bucketCreatedAt')).toBe(false);
    });
  },
);

describe('orchestrator wiring', () => {
  const src = readFileSync(
    join(import.meta.dirname, '../../../src/lib/deploy/orchestrator.js'),
    'utf-8',
  );

  it('persists bucketCreatedAt only when finish produced one', () => {
    expect(src).toContain(
      "...(Object.hasOwn(appBucketFinal, 'bucketCreatedAt') && {\n            bucketCreatedAt: appBucketFinal.bucketCreatedAt,",
    );
  });

  it('hands the env provider id to the finalize', () => {
    expect(src).toContain('providerId: providerIdFor(envConfig),');
  });
});

describe('census: only the gate module references the gate', () => {
  const srcRoot = join(import.meta.dirname, '../../../src');

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  }

  it('no src file other than bucket-settle.js names waitForBucketSettled or makeAppBucketProbeRound', () => {
    const offenders = walk(srcRoot)
      .filter((f) => /\.(js|mjs|ts)$/.test(f))
      .filter((f) => relative(srcRoot, f) !== join('lib', 'deploy', 'bucket-settle.js'))
      .filter((f) =>
        /\b(waitForBucketSettled|makeAppBucketProbeRound)\b/.test(readFileSync(f, 'utf-8')),
      )
      .map((f) => relative(srcRoot, f));
    expect(offenders).toEqual([]);
  });
});
