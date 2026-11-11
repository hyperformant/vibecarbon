/**
 * locateBucket is the strict search the destroy purge and the Hetzner app key
 * fence trust before they call a bucket gone: null only when every region
 * answered not found. Any other answer stops the search with an error that
 * names the bucket, the region that answered, and what it said in plain
 * words, never the bare SDK error (an `UnknownError` with no message named
 * nothing an operator could act on).
 */
import { describe, expect, it, vi } from 'vitest';

/** What each Hetzner region answers to HeadBucket, by test. */
const answers = vi.hoisted(() => ({ byRegion: {} as Record<string, unknown> }));

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    region: string;
    constructor(config: { endpoint: string }) {
      this.region = /^https:\/\/([a-z0-9-]+)\./.exec(config.endpoint)?.[1] ?? '';
    }
    async send() {
      const answer = answers.byRegion[this.region];
      if (answer === 'here') return {};
      throw answer ?? Object.assign(new Error('NotFound'), { name: 'NotFound' });
    }
    destroy() {}
  }
  return { S3Client, HeadBucketCommand: class {} };
});

const { HetznerS3Provider } = await import('../../../src/lib/providers/hetzner-s3.js');
const store = () => new HetznerS3Provider('A'.repeat(20), 'x'.repeat(40), 'nbg1');

describe('locateBucket', () => {
  it('answers the region that holds the bucket, and null only when every region said not found', async () => {
    answers.byRegion = { hel1: 'here' };
    await expect(store().locateBucket('proj-abc-staging')).resolves.toBe('hel1');
    answers.byRegion = {};
    await expect(store().locateBucket('proj-abc-staging')).resolves.toBeNull();
  });

  it('any other answer names the bucket, the region and the answer', async () => {
    answers.byRegion = {
      nbg1: Object.assign(new Error('Access Denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      }),
    };
    const err = await store()
      .locateBucket('proj-abc-staging')
      .catch((e: unknown) => e as Error & { region?: string; bucket?: string; cause?: unknown });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(
      /^nbg1 answered ".*AccessDenied.*" when asked whether it holds bucket proj-abc-staging, so where the bucket is cannot be told$/,
    );
    expect(err).toMatchObject({
      name: 'BucketLocateError',
      region: 'nbg1',
      bucket: 'proj-abc-staging',
    });
    expect((err.cause as Error).name).toBe('AccessDenied');
  });

  it('an error with no message still says which region and bucket', async () => {
    answers.byRegion = {
      fsn1: Object.assign(new Error(''), {
        name: 'UnknownError',
        $metadata: { httpStatusCode: 503 },
      }),
    };
    await expect(store().locateBucket('proj-abc-old')).rejects.toThrow(
      'fsn1 answered "UnknownError (HTTP 503)" when asked whether it holds bucket proj-abc-old',
    );
  });
});
