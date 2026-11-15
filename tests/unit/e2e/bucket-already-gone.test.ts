/**
 * Is a sweep's bucket-delete error really "the bucket is already gone"?
 *
 * Live veto 1 (run 33538738831, DO k8s-ha): every lifecycle step green, the
 * scenario branded [regression] because the sweep's stale listing named a
 * bucket final-destroy had already removed ("The specified bucket does not
 * exist").
 *
 * Live veto 2 (run 43757126064, DO k8s, 2026-11-15): the same stale listing,
 * but the delete failed with the message "UnknownError", which the
 * wording-only check missed. Reproduced on real Spaces (nyc3): for 1-3 s after
 * a delete, ListBuckets still names the bucket and ListObjectsV2 answers 404
 * with `<Code>NoSuchBucket</Code><Message></Message>`. The SDK keeps the code
 * on err.name and words the empty message "UnknownError".
 *
 * These tests feed the real SDK deserializer the raw bodies captured live,
 * through the product's emptyAndDeleteBucket, so the error under test is the
 * one the sweep actually receives.
 */
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { DigitalOceanSpacesProvider } from '../../../src/lib/providers/digitalocean-spaces.js';
import {
  classifyBucketDeleteError,
  saysBucketMissing,
} from '../../../tests/e2e/utils/bucket-already-gone.js';

const BUCKET = 'citest-k8s-1-abc-backups';

const xmlError = (code: string, message = '') =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message><BucketName>${BUCKET}</BucketName><RequestId>tx0</RequestId><HostId>h</HostId></Error>`;

// What nyc3 sent in the post-delete window (captured 2026-11-15).
const EMPTY_NO_SUCH_BUCKET = xmlError('NoSuchBucket');
const EMPTY_LIST = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET}</Name><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`;
const EMPTY_VERSIONS = `<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET}</Name><IsTruncated>false</IsTruncated></ListVersionsResult>`;
const ONE_UPLOAD = `<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${BUCKET}</Bucket><IsTruncated>false</IsTruncated><Upload><Key>k</Key><UploadId>u1</UploadId></Upload></ListMultipartUploadsResult>`;

type Call = 'ListObjectsV2' | 'ListObjectVersions' | 'ListMultipartUploads' | 'Abort' | 'Other';
type Reply = { status: number; body?: string };

function callOf(req: { method: string; query?: Record<string, unknown> }): Call {
  const q = req.query ?? {};
  if (req.method === 'DELETE' && 'uploadId' in q) return 'Abort';
  if (req.method === 'GET' && q['list-type'] === '2') return 'ListObjectsV2';
  if (req.method === 'GET' && 'versions' in q) return 'ListObjectVersions';
  if (req.method === 'GET' && 'uploads' in q) return 'ListMultipartUploads';
  return 'Other';
}

/** A Spaces store whose requests `reply` answers; the real SDK parses each answer. */
function storeAnswering(reply: (call: Call) => Reply) {
  const store = new DigitalOceanSpacesProvider('AKTEST', 'SKTEST', 'nyc3');
  // biome-ignore lint/suspicious/noExplicitAny: inject the client the provider builds lazily
  (store as any)._client = new S3Client({
    region: 'nyc3',
    endpoint: DigitalOceanSpacesProvider.ENDPOINTS.nyc3,
    forcePathStyle: true,
    credentials: { accessKeyId: 'AKTEST', secretAccessKey: 'SKTEST' },
    maxAttempts: 1,
    requestHandler: {
      async handle(request: { method: string; query?: Record<string, unknown> }) {
        const { status, body = '' } = reply(callOf(request));
        return {
          response: {
            statusCode: status,
            headers: { 'content-type': 'application/xml' },
            body: new TextEncoder().encode(body),
          },
        };
      },
    },
  });
  return store;
}

/** The error the sweep's `emptyAndDeleteBucket` call throws for this store. */
async function sweepDeleteError(reply: (call: Call) => Reply): Promise<unknown> {
  try {
    await storeAnswering(reply).emptyAndDeleteBucket(BUCKET);
  } catch (err) {
    return err;
  }
  throw new Error('expected emptyAndDeleteBucket to fail');
}

describe('classifyBucketDeleteError', () => {
  it('reads the run-43757126064 answer as gone: a 404 NoSuchBucket with an empty message', async () => {
    const err = (await sweepDeleteError(() => ({
      status: 404,
      body: EMPTY_NO_SUCH_BUCKET,
    }))) as Error & { $metadata?: { httpStatusCode?: number } };
    // The shape the sweep printed as "FAILED ...: UnknownError".
    expect(err.message).toBe('UnknownError');
    expect(err.name).toBe('NoSuchBucket');
    expect(err.$metadata?.httpStatusCode).toBe(404);

    const locate = vi.fn().mockResolvedValue(null);
    expect(saysBucketMissing(err)).toBe(true);
    expect(await classifyBucketDeleteError(err, locate)).toMatchObject({ gone: true });
    expect(locate).toHaveBeenCalledTimes(1);
  });

  it('reads a bodiless 404 (the SDK names it NotFound) as a missing-bucket answer', async () => {
    const err = (await sweepDeleteError(() => ({ status: 404 }))) as Error;
    expect(err.name).toBe('NotFound');
    expect(err.message).toBe('UnknownError');
    expect(await classifyBucketDeleteError(err, async () => null)).toMatchObject({ gone: true });
  });

  it('reads a NoSuchBucket that emptyAndDeleteBucket wrapped (its version step) as gone', async () => {
    const err = (await sweepDeleteError((call) =>
      call === 'ListObjectsV2'
        ? { status: 200, body: EMPTY_LIST }
        : { status: 404, body: EMPTY_NO_SUCH_BUCKET },
    )) as Error;
    // The wrapper keeps only "UnknownError" in its words; the code is on the cause.
    expect(err.message).toMatch(/Failed to list\/delete object versions in .*: UnknownError$/);
    expect(await classifyBucketDeleteError(err, async () => null)).toMatchObject({ gone: true });
  });

  it('still reads the worded spellings as missing-bucket answers', async () => {
    for (const err of [
      new Error('The specified bucket does not exist'),
      new Error('bucket "x-backups" does not exist'),
      'The specified bucket does not exist',
    ]) {
      expect(saysBucketMissing(err)).toBe(true);
      expect(await classifyBucketDeleteError(err, async () => null)).toMatchObject({ gone: true });
    }
  });

  it("a missing-bucket answer is one endpoint's: a bucket some region still holds is a FAILURE", async () => {
    // Live 2026-11-15: nyc3 answers NoSuchBucket for a bucket that lives in sfo3.
    const err = await sweepDeleteError(() => ({ status: 404, body: EMPTY_NO_SUCH_BUCKET }));
    const verdict = await classifyBucketDeleteError(err, async () => 'sfo3');
    expect(verdict.gone).toBe(false);
    expect(verdict.why).toMatch(/sfo3/);
    expect(verdict.why).toMatch(/NoSuchBucket/);
  });

  it('a missing-bucket answer the search cannot confirm is a FAILURE', async () => {
    const err = await sweepDeleteError(() => ({ status: 404, body: EMPTY_NO_SUCH_BUCKET }));
    const verdict = await classifyBucketDeleteError(err, async () => {
      throw new Error('sgp1 answered "no answer from sgp1"');
    });
    expect(verdict.gone).toBe(false);
    expect(verdict.why).toMatch(/sgp1/);
  });

  it('keeps a 403 loud and never searches for it, coded or bodiless', async () => {
    for (const body of [xmlError('AccessDenied'), '']) {
      const err = await sweepDeleteError(() => ({ status: 403, body }));
      const locate = vi.fn().mockResolvedValue(null);
      expect(saysBucketMissing(err)).toBe(false);
      const verdict = await classifyBucketDeleteError(err, locate);
      expect(verdict.gone).toBe(false);
      expect(verdict.why).toMatch(/403/);
      expect(locate).not.toHaveBeenCalled();
    }
  });

  it('keeps an object-level 404 loud: NoSuchUpload from the multipart step is not the bucket', async () => {
    const err = await sweepDeleteError((call) => {
      if (call === 'ListObjectsV2') return { status: 200, body: EMPTY_LIST };
      if (call === 'ListObjectVersions') return { status: 200, body: EMPTY_VERSIONS };
      if (call === 'ListMultipartUploads') return { status: 200, body: ONE_UPLOAD };
      return {
        status: 404,
        body: xmlError('NoSuchUpload', 'The specified upload does not exist.'),
      };
    });
    expect((err as Error).message).toMatch(/Failed to abort multipart uploads/);
    const locate = vi.fn().mockResolvedValue(null);
    expect(saysBucketMissing(err)).toBe(false);
    expect((await classifyBucketDeleteError(err, locate)).gone).toBe(false);
    expect(locate).not.toHaveBeenCalled();
  });

  it('keeps network, throttling and other object-level failures loud', async () => {
    for (const err of [
      new Error('read ECONNRESET'),
      new Error('SlowDown'),
      new Error('NoSuchKey: object missing'),
      Object.assign(new Error('UnknownError'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      }),
      Object.assign(new Error('UnknownError'), {
        name: 'Unknown',
        $metadata: { httpStatusCode: 409 },
      }),
    ]) {
      const locate = vi.fn().mockResolvedValue(null);
      expect(saysBucketMissing(err)).toBe(false);
      expect((await classifyBucketDeleteError(err, locate)).gone).toBe(false);
      expect(locate).not.toHaveBeenCalled();
    }
  });

  it('names the code and the HTTP status in the FAILED reason, not just "UnknownError"', async () => {
    const err = await sweepDeleteError(() => ({ status: 403, body: xmlError('AccessDenied') }));
    const { why } = await classifyBucketDeleteError(err, async () => null);
    expect(why).toMatch(/AccessDenied/);
    expect(why).toMatch(/HTTP 403/);
  });
});
