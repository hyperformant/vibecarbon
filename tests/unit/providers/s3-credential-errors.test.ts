/**
 * Wrong object-storage keys must be named as wrong keys, in plain words, the
 * moment they are used.
 *
 * RCA (excitingai, 2026-10-16): pasted S3 keys were wrong. Nothing checked
 * them at the prompt, and the first use was the HEAD probe in createBucket.
 * S3 answers a HEAD with bad keys as a bare 403 (a HEAD response has no body,
 * so no error code), which bucketExists reported as "exists but is owned by
 * another account. Try a different project name": the wrong cause and the
 * wrong fix. The deploy then exited before the log flushed that line.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HetznerS3Provider } from '../../../src/lib/providers/hetzner-s3.js';
import { describeS3Error } from '../../../src/lib/providers/s3-base.js';

vi.mock('@aws-sdk/client-s3', () => {
  const named = (n: string) =>
    class {
      kind = n;
    };
  return {
    S3Client: class {
      send = vi.fn();
    },
    CreateBucketCommand: named('CreateBucket'),
    DeleteBucketCommand: named('DeleteBucket'),
    HeadBucketCommand: named('HeadBucket'),
    ListBucketsCommand: named('ListBuckets'),
    PutBucketCorsCommand: named('PutBucketCors'),
    ListObjectsV2Command: named('ListObjectsV2'),
    ListObjectVersionsCommand: named('ListObjectVersions'),
    DeleteObjectsCommand: named('DeleteObjects'),
    PutObjectCommand: named('PutObject'),
    GetObjectCommand: named('GetObject'),
    DeleteObjectCommand: named('DeleteObject'),
    CopyObjectCommand: named('CopyObject'),
    ListMultipartUploadsCommand: named('ListMultipartUploads'),
    AbortMultipartUploadCommand: named('AbortMultipartUpload'),
  };
});

const err = (name: string, status?: number) =>
  Object.assign(new Error(name), {
    name,
    ...(status ? { $metadata: { httpStatusCode: status } } : {}),
  });

describe('describeS3Error', () => {
  it('names a wrong access key in plain words, with the S3 code', () => {
    const line = describeS3Error(err('InvalidAccessKeyId', 403));
    expect(line).toContain('access key');
    expect(line).toContain('InvalidAccessKeyId');
    expect(line).not.toContain('\n');
  });

  it('names a wrong secret key in plain words, with the S3 code', () => {
    const line = describeS3Error(err('SignatureDoesNotMatch', 403));
    expect(line).toContain('secret key');
    expect(line).toContain('SignatureDoesNotMatch');
  });

  it('names missing permissions for AccessDenied', () => {
    expect(describeS3Error(err('AccessDenied', 403))).toContain('AccessDenied');
  });

  it('names a connection timeout as no answer from the endpoint', () => {
    const line = describeS3Error(err('TimeoutError'), {
      endpoint: 'https://fsn1.your-objectstorage.com',
    });
    expect(line).toContain('https://fsn1.your-objectstorage.com');
    expect(line).toContain('TimeoutError');
  });

  it('keeps any other error to one line', () => {
    const e = new Error('first line\nsecond line');
    e.name = 'WeirdError';
    expect(describeS3Error(e)).toBe('WeirdError: first line');
  });
});

describe('validateCredentials', () => {
  let provider: HetznerS3Provider;
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    provider = new HetznerS3Provider('ABCDEFGHIJ0123456789', 'x'.repeat(40), 'fsn1');
    send = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: inject the client
    (provider as any)._client = { send };
  });

  it('marks wrong keys as rejected', async () => {
    send.mockRejectedValue(err('SignatureDoesNotMatch', 403));
    const r = await provider.validateCredentials();
    expect(r).toMatchObject({ valid: false, rejected: true });
    expect(r.error).toContain('secret key');
  });

  it('does not call an unreachable endpoint a key problem', async () => {
    vi.useFakeTimers();
    try {
      send.mockRejectedValue(err('TimeoutError'));
      const pending = provider.validateCredentials();
      await vi.runAllTimersAsync();
      const r = await pending;
      expect(r).toMatchObject({ valid: false, rejected: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('bucketExists on a 403', () => {
  let provider: HetznerS3Provider;
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    provider = new HetznerS3Provider('ABCDEFGHIJ0123456789', 'x'.repeat(40), 'fsn1');
    send = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: inject the client
    (provider as any)._client = { send };
  });

  it('reports wrong keys, not a bucket owned by someone else, when the keys are bad', async () => {
    send.mockImplementation(async (cmd: { kind: string }) => {
      if (cmd.kind === 'HeadBucket') throw err('Forbidden', 403);
      if (cmd.kind === 'ListBuckets') throw err('SignatureDoesNotMatch', 403);
      throw new Error(`unexpected ${cmd.kind}`);
    });
    const p = provider.bucketExists('excitingai-88d16c-storage-2074c7');
    await expect(p).rejects.toThrow(/secret key/);
    await expect(provider.bucketExists('x')).rejects.not.toThrow(/another account/);
  });

  it('still reports a name owned by another account when the keys are fine', async () => {
    send.mockImplementation(async (cmd: { kind: string }) => {
      if (cmd.kind === 'HeadBucket') throw err('Forbidden', 403);
      if (cmd.kind === 'ListBuckets') return { Buckets: [] };
      throw new Error(`unexpected ${cmd.kind}`);
    });
    await expect(provider.bucketExists('taken')).rejects.toThrow(/owned by another account/);
  });
});

describe('pastedKeyShapeProblem', () => {
  it('accepts a well-formed Hetzner pair, even with stray whitespace or a newline', async () => {
    const { pastedKeyShapeProblem } = await import('../../../src/lib/operator-env.js');
    expect(pastedKeyShapeProblem('HETZNER_ACCESS_KEY', ' ABCDEFGHIJ0123456789\n')).toBeUndefined();
    expect(pastedKeyShapeProblem('HETZNER_SECRET_KEY', `${'aB3'.repeat(13)}x\n`)).toBeUndefined();
  });

  it('refuses an access key of the wrong length, naming the key and never the value', async () => {
    const { pastedKeyShapeProblem } = await import('../../../src/lib/operator-env.js');
    const msg = pastedKeyShapeProblem('HETZNER_ACCESS_KEY', 'ABCDEFGHIJ012345678');
    expect(msg).toContain('HETZNER_ACCESS_KEY');
    expect(msg).toContain('20 capital letters and digits');
    expect(msg).not.toContain('ABCDEFGHIJ012345678');
  });

  it('refuses a Hetzner secret pasted with part of the access key stuck on', async () => {
    const { pastedKeyShapeProblem } = await import('../../../src/lib/operator-env.js');
    expect(pastedKeyShapeProblem('HETZNER_SECRET_KEY', `${'a'.repeat(40)} ABCD`)).toContain(
      '40 letters and digits',
    );
  });

  it('only length-checks secrets whose format the provider does not pin down', async () => {
    const { pastedKeyShapeProblem } = await import('../../../src/lib/operator-env.js');
    expect(
      pastedKeyShapeProblem('DIGITALOCEAN_SECRET_KEY', `${'a+b/'.repeat(10)}xyz`),
    ).toBeUndefined();
  });
});

describe('formatS3SetupFailure', () => {
  it('is one line naming the cause, the endpoint and where the keys came from', async () => {
    const { formatS3SetupFailure } = await import('../../../src/lib/providers/s3-base.js');
    const line = formatS3SetupFailure(err('SignatureDoesNotMatch', 403), {
      endpoint: 'https://fsn1.your-objectstorage.com',
      source: "your project's .env.local",
    });
    expect(line).not.toContain('\n');
    expect(line).toContain("secret key doesn't match");
    expect(line).toContain('https://fsn1.your-objectstorage.com');
    expect(line).toContain("your project's .env.local");
    expect(line).not.toContain('another account');
  });
});
