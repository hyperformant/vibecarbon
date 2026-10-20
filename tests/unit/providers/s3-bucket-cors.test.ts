/**
 * Browsers PUT uploads straight to the app bucket and GET reads back through
 * presigned URLs, so the bucket needs a CORS rule scoped to the app origin.
 */
import { describe, expect, it, vi } from 'vitest';
import { applyAppBucketCors } from '../../../src/lib/deploy/orchestrator.js';
import { HetznerS3Provider } from '../../../src/lib/providers/hetzner-s3.js';

type Sent = { constructor: { name: string }; input: Record<string, unknown> };

function provider() {
  const p = new HetznerS3Provider('ak', 'sk', 'fsn1') as unknown as {
    _send: (c: Sent) => Promise<unknown>;
    setBucketCors: (b: string, origins: string[]) => Promise<void>;
    getBucketCorsOrigins: (b: string) => Promise<string[]>;
    deleteBucketCors: (b: string) => Promise<void>;
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

describe('getBucketCorsOrigins', () => {
  it('returns every origin across the rules on the bucket', async () => {
    const { p, send } = provider();
    send.mockResolvedValueOnce({
      CORSRules: [
        { AllowedOrigins: ['https://prod.dev'] },
        { AllowedOrigins: ['https://staging.dev'] },
      ],
    });
    await expect(p.getBucketCorsOrigins('app-bucket')).resolves.toEqual([
      'https://prod.dev',
      'https://staging.dev',
    ]);
    const cmd = send.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('GetBucketCorsCommand');
    expect(cmd.input).toEqual({ Bucket: 'app-bucket' });
  });

  it('returns [] when the bucket has no CORS rule yet', async () => {
    const { p, send } = provider();
    send.mockRejectedValueOnce(
      Object.assign(new Error('The CORS configuration does not exist'), {
        name: 'NoSuchCORSConfiguration',
      }),
    );
    await expect(p.getBucketCorsOrigins('b')).resolves.toEqual([]);
  });

  it('returns [] on a bare 404', async () => {
    const { p, send } = provider();
    send.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      }),
    );
    await expect(p.getBucketCorsOrigins('b')).resolves.toEqual([]);
  });

  it('throws on NoSuchBucket, even as a 404 (a young Hetzner bucket answers it transiently)', async () => {
    // An empty list here makes the deploy PUT only its own origins and wipe
    // every other environment's; throwing sends it down the warn-and-skip path.
    const { p, send } = provider();
    send.mockRejectedValueOnce(
      Object.assign(new Error('The specified bucket does not exist'), {
        name: 'NoSuchBucket',
        $metadata: { httpStatusCode: 404 },
      }),
    );
    await expect(p.getBucketCorsOrigins('b')).rejects.toThrow('bucket does not exist');
  });

  it('throws on any other error', async () => {
    const { p, send } = provider();
    send.mockRejectedValueOnce(
      Object.assign(new Error('Access Denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      }),
    );
    await expect(p.getBucketCorsOrigins('b')).rejects.toThrow('Access Denied');
  });
});

describe('deleteBucketCors', () => {
  it('sends DeleteBucketCors for the bucket', async () => {
    const { p, send } = provider();
    await p.deleteBucketCors('app-bucket');
    const cmd = send.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('DeleteBucketCorsCommand');
    expect(cmd.input).toEqual({ Bucket: 'app-bucket' });
  });
});

describe('applyAppBucketCors', () => {
  const spin = () => ({ start: vi.fn(), stop: vi.fn() });

  it('allows exactly the https domain origin', async () => {
    const setBucketCors = vi.fn(async () => {});
    await applyAppBucketCors({
      createProvider: async () => ({ setBucketCors, getBucketCorsOrigins: async () => [] }),
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
      createProvider: async () => ({ setBucketCors, getBucketCorsOrigins: async () => [] }),
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
          getBucketCorsOrigins: async () => [],
          setBucketCors: async () => {
            throw new Error('NotImplemented');
          },
        }),
        bucket: 'app-b',
        domain: 'example.com',
        spin: spin(),
        log: { warn },
      }),
    ).resolves.toEqual(['https://example.com']);
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
    ).resolves.toEqual(['https://example.com']);
    expect(warn).toHaveBeenCalledOnce();
  });
});
