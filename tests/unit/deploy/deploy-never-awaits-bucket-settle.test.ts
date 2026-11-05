/**
 * R5/R7: the deploy never waits for a new bucket. On a provider with a settle
 * window it reads the bucket's creation time beside IaC and records it on the
 * env, with nothing printed; on a 0-window provider it does nothing at all.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  it('records the creation time with no note and zero probes', async () => {
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
    expect(log.info).not.toHaveBeenCalled();
    expect(result.bucketCreatedAt).toBe(createdAt.toISOString());
  });

  it('an unreadable creation time is recorded as null, quietly', async () => {
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
    expect(log.info).not.toHaveBeenCalled();
  });

  it('an old bucket is recorded the same way', async () => {
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
    it('reads no creation time and records no bucketCreatedAt', async () => {
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
    expect(src).toMatch(
      /\.\.\.\(Object\.hasOwn\(appBucketFinal, 'bucketCreatedAt'\) && \{\n\s+bucketCreatedAt: appBucketFinal\.bucketCreatedAt,/,
    );
  });

  it('hands the env provider id to the finalize', () => {
    expect(src).toContain('providerId: providerIdFor(envConfig),');
  });
});
