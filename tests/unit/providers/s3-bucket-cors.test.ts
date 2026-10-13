/**
 * Browsers PUT uploads straight to the app bucket and GET reads back through
 * presigned URLs, so the bucket needs a CORS rule scoped to the app origin.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

describe('orchestrator wiring', () => {
  const src = readFileSync(
    join(import.meta.dirname, '../../../src/lib/deploy/orchestrator.js'),
    'utf-8',
  );
  it('calls setBucketCors on the app bucket with the https domain origin', () => {
    expect(src).toContain('s3Provider.setBucketCors(s3Config.bucket, corsOrigins)');
    expect(src).toMatch(/corsOrigins = \[`https:\/\/\$\{domain\}`\]/);
  });
  it('treats a CORS failure as a warning, not a deploy failure', () => {
    const block = src.slice(src.indexOf('Configuring bucket CORS'));
    const catchBody = block.slice(
      block.indexOf('} catch'),
      block.indexOf('Creating backup bucket'),
    );
    expect(catchBody).toContain('p.log.warn');
    expect(catchBody).not.toContain('throw');
  });
});
