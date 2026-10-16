/**
 * Browsers PUT uploads straight to the app bucket and GET reads back through
 * presigned URLs, so the bucket needs a CORS rule scoped to the app origin.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyAppBucketCors } from '../../../src/lib/deploy/orchestrator.js';
import { HetznerS3Provider } from '../../../src/lib/providers/hetzner-s3.js';

type Sent = { constructor: { name: string }; input: Record<string, unknown> };

function provider() {
  const p = new HetznerS3Provider('ak', 'sk', 'fsn1') as unknown as {
    _send: (c: Sent) => Promise<unknown>;
    setBucketCors: (b: string, origins: string[]) => Promise<void>;
  };
  const send = vi.fn(async (_c: Sent) => ({}));
  p._send = send;
  return { p, send };
}

describe('setBucketCors', () => {
  it('puts one rule scoped to the given origins with the upload/read surface only', async () => {
    const { p, send } = provider();
    await p.setBucketCors('app-bucket', ['https://example.com']);

    const cmd = send.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('PutBucketCorsCommand');
    expect(cmd.input).toEqual({
      Bucket: 'app-bucket',
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: ['https://example.com'],
            AllowedMethods: ['GET', 'PUT', 'HEAD'],
            AllowedHeaders: ['content-type', 'content-length'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    });
  });

  it('refuses a wildcard origin', async () => {
    const { p, send } = provider();
    await expect(p.setBucketCors('b', ['*'])).rejects.toThrow(/wildcard/i);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('applyAppBucketCors', () => {
  const spin = () => ({ start: vi.fn(), stop: vi.fn() });

  it('allows exactly the https domain origin', async () => {
    const setBucketCors = vi.fn(async () => {});
    await applyAppBucketCors({
      createProvider: async () => ({ setBucketCors }),
      bucket: 'app-b',
      domain: 'example.com',
      spin: spin(),
      log: { warn: vi.fn() },
    });
    expect(setBucketCors).toHaveBeenCalledWith('app-b', ['https://example.com']);
  });

  it('scopes to localhost dev origins and warns without a domain', async () => {
    const setBucketCors = vi.fn(async () => {});
    const warn = vi.fn();
    await applyAppBucketCors({
      createProvider: async () => ({ setBucketCors }),
      bucket: 'app-b',
      spin: spin(),
      log: { warn },
    });
    expect(setBucketCors).toHaveBeenCalledWith('app-b', [
      'http://localhost:3000',
      'http://localhost:5173',
    ]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('warns, never throws, when the provider call fails', async () => {
    const warn = vi.fn();
    await expect(
      applyAppBucketCors({
        createProvider: async () => ({
          setBucketCors: async () => {
            throw new Error('NotImplemented');
          },
        }),
        bucket: 'app-b',
        domain: 'example.com',
        spin: spin(),
        log: { warn },
      }),
    ).resolves.toBeUndefined();
    expect(warn.mock.calls[0][0]).toContain('NotImplemented');
    expect(warn.mock.calls[0][0]).toContain('Re-run');
  });

  it('warns, never throws, when the provider cannot be built', async () => {
    const warn = vi.fn();
    await expect(
      applyAppBucketCors({
        createProvider: async () => {
          throw new Error('bad region');
        },
        bucket: 'b',
        domain: 'example.com',
        spin: spin(),
        log: { warn },
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('orchestrator call site', () => {
  const src = readFileSync(
    join(import.meta.dirname, '../../../src/lib/deploy/orchestrator.js'),
    'utf-8',
  );
  it('applies CORS once, after the skippable s3-setup step has resolved', () => {
    const calls = [...src.matchAll(/await applyAppBucketCors\(/g)];
    expect(calls).toHaveLength(1);
    const at = calls[0].index as number;
    expect(src.indexOf('if (!skipS3Setup) {')).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(src.indexOf("state.getStepResult('s3-setup')"));
    expect(src).not.toContain('setBucketCors(s3Config.bucket');
  });
});
