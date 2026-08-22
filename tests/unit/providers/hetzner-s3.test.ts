import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HetznerS3Provider, sanitizeBucketName } from '../../../src/lib/providers/hetzner-s3.js';

// Mock the AWS SDK
vi.mock('@aws-sdk/client-s3', () => {
  const MockS3Client = class {
    send = vi.fn();
  };
  return {
    S3Client: MockS3Client,
    CreateBucketCommand: class {},
    DeleteBucketCommand: class {},
    HeadBucketCommand: class {},
    ListBucketsCommand: class {},
    PutBucketCorsCommand: class {},
    ListObjectsV2Command: class {},
    ListObjectVersionsCommand: class {},
    DeleteObjectsCommand: class {},
    PutObjectCommand: class {},
    GetObjectCommand: class {},
    DeleteObjectCommand: class {},
    ListMultipartUploadsCommand: class {},
    AbortMultipartUploadCommand: class {},
  };
});

describe('HetznerS3Provider', () => {
  describe('static properties', () => {
    it('has correct endpoints for all regions', () => {
      expect(HetznerS3Provider.ENDPOINTS.fsn1).toBe('https://fsn1.your-objectstorage.com');
      expect(HetznerS3Provider.ENDPOINTS.nbg1).toBe('https://nbg1.your-objectstorage.com');
      expect(HetznerS3Provider.ENDPOINTS.hel1).toBe('https://hel1.your-objectstorage.com');
    });

    it('has correct region names', () => {
      expect(HetznerS3Provider.REGIONS.fsn1).toBe('Falkenstein, Germany');
      expect(HetznerS3Provider.REGIONS.nbg1).toBe('Nuremberg, Germany');
      expect(HetznerS3Provider.REGIONS.hel1).toBe('Helsinki, Finland');
    });

    it('getRegions returns all regions', () => {
      const regions = HetznerS3Provider.getRegions();
      expect(Object.keys(regions)).toHaveLength(3);
      expect(regions).toHaveProperty('fsn1');
      expect(regions).toHaveProperty('nbg1');
      expect(regions).toHaveProperty('hel1');
    });

    it('getEndpointForRegion returns correct endpoint', () => {
      expect(HetznerS3Provider.getEndpointForRegion('fsn1')).toBe(
        'https://fsn1.your-objectstorage.com',
      );
      expect(HetznerS3Provider.getEndpointForRegion('hel1')).toBe(
        'https://hel1.your-objectstorage.com',
      );
    });

    it('getEndpointForRegion returns null for invalid region', () => {
      expect(HetznerS3Provider.getEndpointForRegion('invalid')).toBeNull();
    });
  });

  describe('constructor', () => {
    it('creates provider with valid credentials', () => {
      const provider = new HetznerS3Provider('access-key', 'secret-key', 'fsn1');

      expect(provider.accessKeyId).toBe('access-key');
      expect(provider.secretAccessKey).toBe('secret-key');
      expect(provider.region).toBe('fsn1');
      expect(provider.endpoint).toBe('https://fsn1.your-objectstorage.com');
    });

    it('throws for missing access key', () => {
      expect(() => new HetznerS3Provider('', 'secret-key', 'fsn1')).toThrow(
        'S3 credentials are required',
      );
    });

    it('throws for missing secret key', () => {
      expect(() => new HetznerS3Provider('access-key', '', 'fsn1')).toThrow(
        'S3 credentials are required',
      );
    });

    it('throws for invalid region', () => {
      expect(() => new HetznerS3Provider('access-key', 'secret-key', 'invalid')).toThrow(
        'Invalid region',
      );
    });
  });

  describe('instance methods', () => {
    let provider: HetznerS3Provider;

    beforeEach(() => {
      provider = new HetznerS3Provider('test-access-key', 'test-secret-key', 'fsn1');
    });

    it('getEndpoint returns the endpoint URL', () => {
      expect(provider.getEndpoint()).toBe('https://fsn1.your-objectstorage.com');
    });

    it('getClient creates S3Client with correct config', () => {
      const client = provider.getClient();
      expect(client).toBeDefined();
    });

    it('getClient returns same instance on subsequent calls', () => {
      const client1 = provider.getClient();
      const client2 = provider.getClient();
      expect(client1).toBe(client2);
    });
  });

  describe('credential validation scenarios', () => {
    it('returns valid true when listBuckets succeeds', async () => {
      const provider = new HetznerS3Provider('valid-key', 'valid-secret', 'fsn1');

      // Mock successful list buckets
      const mockSend = vi.fn().mockResolvedValue({ Buckets: [] });
      // biome-ignore lint/suspicious/noExplicitAny: accessing private property for testing
      (provider as any)._client = { send: mockSend };

      const result = await provider.validateCredentials();
      expect(result.valid).toBe(true);
    });

    it('returns invalid for InvalidAccessKeyId error', async () => {
      const provider = new HetznerS3Provider('invalid-key', 'secret', 'fsn1');

      const mockSend = vi.fn().mockRejectedValue({ name: 'InvalidAccessKeyId' });
      // biome-ignore lint/suspicious/noExplicitAny: accessing private property for testing
      (provider as any)._client = { send: mockSend };

      const result = await provider.validateCredentials();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid Access Key');
    });

    it('returns invalid for SignatureDoesNotMatch error', async () => {
      const provider = new HetznerS3Provider('key', 'wrong-secret', 'fsn1');

      const mockSend = vi.fn().mockRejectedValue({ name: 'SignatureDoesNotMatch' });
      // biome-ignore lint/suspicious/noExplicitAny: accessing private property for testing
      (provider as any)._client = { send: mockSend };

      const result = await provider.validateCredentials();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid Secret Key');
    });

    it('returns invalid for AccessDenied error', async () => {
      const provider = new HetznerS3Provider('key', 'secret', 'fsn1');

      const mockSend = vi.fn().mockRejectedValue({ name: 'AccessDenied' });
      // biome-ignore lint/suspicious/noExplicitAny: accessing private property for testing
      (provider as any)._client = { send: mockSend };

      const result = await provider.validateCredentials();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Access denied');
    });
  });

  describe('bucket operations', () => {
    let provider: HetznerS3Provider;
    let mockSend: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      provider = new HetznerS3Provider('access-key', 'secret-key', 'fsn1');
      mockSend = vi.fn();
      // biome-ignore lint/suspicious/noExplicitAny: accessing private property for testing
      (provider as any)._client = { send: mockSend };
    });

    describe('listBuckets', () => {
      it('returns formatted bucket list', async () => {
        mockSend.mockResolvedValue({
          Buckets: [
            { Name: 'bucket1', CreationDate: new Date('2026-01-01') },
            { Name: 'bucket2', CreationDate: new Date('2026-02-01') },
          ],
        });

        const buckets = await provider.listBuckets();

        expect(buckets).toHaveLength(2);
        expect(buckets[0].name).toBe('bucket1');
        expect(buckets[1].name).toBe('bucket2');
      });

      it('returns empty array when no buckets', async () => {
        mockSend.mockResolvedValue({ Buckets: undefined });

        const buckets = await provider.listBuckets();
        expect(buckets).toEqual([]);
      });
    });

    describe('bucketExists', () => {
      it('returns true when bucket exists', async () => {
        mockSend.mockResolvedValue({});

        const exists = await provider.bucketExists('my-bucket');
        expect(exists).toBe(true);
      });

      it('returns false when bucket does not exist', async () => {
        mockSend.mockRejectedValue({ name: 'NotFound' });

        const exists = await provider.bucketExists('nonexistent');
        expect(exists).toBe(false);
      });

      it('returns false for 404 status', async () => {
        mockSend.mockRejectedValue({ $metadata: { httpStatusCode: 404 } });

        const exists = await provider.bucketExists('nonexistent');
        expect(exists).toBe(false);
      });

      it('rethrows other errors', async () => {
        mockSend.mockRejectedValue(new Error('Network error'));

        await expect(provider.bucketExists('bucket')).rejects.toThrow('Network error');
      });
    });

    describe('createBucket', () => {
      it('creates bucket and returns result', async () => {
        vi.useFakeTimers();
        try {
          // First call: bucketExists (HeadBucket) - not found; everything
          // after the CreateBucket ack succeeds, so the sustained-visibility
          // condition (3 consecutive HEAD+LIST rounds + put/get/delete
          // write probe) completes on the happy path.
          mockSend.mockRejectedValueOnce({ name: 'NotFound' });
          mockSend.mockResolvedValue({});

          const pending = provider.createBucket('new-bucket');
          await vi.advanceTimersByTimeAsync(20_000);
          const result = await pending;

          expect(result.name).toBe('new-bucket');
          expect(result.created).toBe(true);
          // pre-check + create + 3×(HEAD+LIST) + put/get/delete = 11
          expect(mockSend).toHaveBeenCalledTimes(11);
        } finally {
          vi.useRealTimers();
        }
      });

      it('keeps polling when HEAD is visible but LIST still 403s (2026-08-07 e2 incident shape)', async () => {
        vi.useFakeTimers();
        try {
          mockSend.mockRejectedValueOnce({ name: 'NotFound' }); // pre-check
          mockSend.mockResolvedValueOnce({}); // CreateBucket ack
          // Propagation split-brain: HEAD already answers, but LIST auth has
          // not reached that frontend — pulumi's first `up` leads with LIST
          // and died first-strike on exactly this before the LIST probe.
          mockSend.mockResolvedValueOnce({}); // HEAD visible
          mockSend.mockRejectedValueOnce({
            name: 'AccessDenied',
            $metadata: { httpStatusCode: 403 },
          }); // LIST denied — resets the streak
          mockSend.mockResolvedValue({}); // then clean: 3 rounds + write probe

          const pending = provider.createBucket('list-lagging-bucket');
          await vi.advanceTimersByTimeAsync(30_000);
          const result = await pending;

          expect(result.created).toBe(true);
          // pre-check + create + flapped round (HEAD+LIST-denied) +
          // 3 clean rounds (6) + put/get/delete (3) = 13
          expect(mockSend).toHaveBeenCalledTimes(13);
        } finally {
          vi.useRealTimers();
        }
      });

      it('treats a 403 during post-create propagation as not-yet-visible, not cross-account', async () => {
        vi.useFakeTimers();
        try {
          mockSend.mockRejectedValueOnce({ name: 'NotFound' }); // pre-check
          mockSend.mockResolvedValueOnce({}); // CreateBucket ack
          // Propagation window: HEAD returns 403 (auth data not yet visible),
          // then the bucket appears. Must NOT throw "owned by another account".
          mockSend.mockRejectedValueOnce({ name: 'Forbidden', $metadata: { httpStatusCode: 403 } });
          mockSend.mockResolvedValue({});

          const pending = provider.createBucket('propagating-bucket');
          await vi.advanceTimersByTimeAsync(30_000);
          const result = await pending;

          expect(result.created).toBe(true);
        } finally {
          vi.useRealTimers();
        }
      });

      it('polls until a freshly-created bucket is HEAD-visible AND LIST-ready before returning', async () => {
        vi.useFakeTimers();
        try {
          mockSend.mockRejectedValueOnce({ name: 'NotFound' }); // pre-check
          mockSend.mockResolvedValueOnce({}); // CreateBucket ack
          // Hetzner ack'd the create but the bucket isn't visible yet on
          // the read frontend — two 404s, then it appears and lists.
          mockSend.mockRejectedValueOnce({ name: 'NotFound' });
          mockSend.mockRejectedValueOnce({ name: 'NotFound' });
          mockSend.mockResolvedValue({}); // visible from here: 3 rounds + probe

          const pending = provider.createBucket('slow-bucket');
          await vi.advanceTimersByTimeAsync(30_000);
          const result = await pending;

          expect(result.created).toBe(true);
          // pre-check + create + 2 not-found rounds + 3 clean rounds (6) +
          // put/get/delete (3) = 13
          expect(mockSend).toHaveBeenCalledTimes(13);
        } finally {
          vi.useRealTimers();
        }
      });

      it('returns existing bucket without creating', async () => {
        // First call: bucketExists - exists
        mockSend.mockResolvedValueOnce({});

        const result = await provider.createBucket('existing-bucket');

        expect(result.name).toBe('existing-bucket');
        expect(result.created).toBe(false);
        expect(result.message).toContain('already exists');
      });

      it('reuses bucket found in a different region on BucketAlreadyExists', async () => {
        // First call: bucketExists - not found (wrong region)
        mockSend.mockRejectedValueOnce({ name: 'NotFound' });
        // Second call: CreateBucket - already exists
        mockSend.mockRejectedValueOnce({ name: 'BucketAlreadyExists' });
        // findBucketRegion finds it in another region
        vi.spyOn(provider, 'findBucketRegion').mockResolvedValueOnce('fsn1');

        const result = await provider.createBucket('existing-bucket');
        expect(result.created).toBe(false);
        expect(result.message).toContain('already exists');
      });

      it('throws friendly error for BucketAlreadyExists when not found in any region', async () => {
        // Use fake timers: createBucket retries 5x with exp backoff (~150s worst case)
        // to ride out Hetzner's post-delete bucket-name reservation window.
        vi.useFakeTimers();
        // bucketExists - not found
        mockSend.mockRejectedValueOnce({ name: 'NotFound' });
        // Every subsequent CreateBucket call returns BucketAlreadyExists
        mockSend.mockRejectedValue({ name: 'BucketAlreadyExists' });
        // findBucketRegion consistently returns null
        vi.spyOn(provider, 'findBucketRegion').mockResolvedValue(null);

        // Attach rejection handler immediately to avoid an unhandled-rejection
        // warning when runAllTimersAsync drains the backoff loop before we
        // get a chance to await.
        const promise = provider.createBucket('taken-name').catch((err) => err);
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toMatch(/already taken/);
        vi.useRealTimers();
      });

      it('retries BucketAlreadyExists then succeeds (post-delete eventual consistency)', async () => {
        vi.useFakeTimers();
        // bucketExists - not found
        mockSend.mockRejectedValueOnce({ name: 'NotFound' });
        // First 2 CreateBucket attempts: still reserved from a recent delete
        mockSend.mockRejectedValueOnce({ name: 'BucketAlreadyExists' });
        mockSend.mockRejectedValueOnce({ name: 'BucketAlreadyExists' });
        // 3rd attempt succeeds
        mockSend.mockResolvedValueOnce({});
        vi.spyOn(provider, 'findBucketRegion').mockResolvedValue(null);

        const promise = provider.createBucket('recently-deleted-name');
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result.name).toBe('recently-deleted-name');
        expect(result.created).toBe(true);
        vi.useRealTimers();
      });
    });

    describe('configureCORS', () => {
      it('configures CORS with default origins', async () => {
        mockSend.mockResolvedValue({});

        await provider.configureCORS('my-bucket');

        expect(mockSend).toHaveBeenCalled();
      });

      it('configures CORS with custom origins', async () => {
        mockSend.mockResolvedValue({});

        await provider.configureCORS('my-bucket', ['https://example.com']);

        expect(mockSend).toHaveBeenCalled();
      });
    });

    // Central retry coverage. Every public method routes through `_send`;
    // these tests pin its observable behavior — transient errors trigger
    // backoff+retry, terminal errors propagate immediately. Without this,
    // a future "let's quietly drop retry from listBuckets" change would
    // pass the original suite while regressing e2e reliability.
    //
    // Helper: build a transient-style error with a real Error prototype.
    // Plain object rejections trip Node's unhandled-rejection tracker
    // before the await chain catches up under vitest fake timers.
    const makeErr = (props: Record<string, unknown>) =>
      Object.assign(new Error(String(props.name ?? 'err')), props);

    describe('_send central retry', () => {
      it('listBuckets retries transient TimeoutError then succeeds', async () => {
        vi.useFakeTimers();
        mockSend.mockRejectedValueOnce(makeErr({ name: 'TimeoutError' }));
        mockSend.mockRejectedValueOnce(makeErr({ name: 'TimeoutError' }));
        mockSend.mockResolvedValueOnce({ Buckets: [{ Name: 'b', CreationDate: new Date() }] });

        const promise = provider.listBuckets();
        await vi.runAllTimersAsync();
        const buckets = await promise;

        expect(buckets).toHaveLength(1);
        expect(mockSend).toHaveBeenCalledTimes(3);
        vi.useRealTimers();
      });

      it('listBuckets gives up after 3 transient attempts and rethrows', async () => {
        vi.useFakeTimers();
        mockSend.mockRejectedValue(makeErr({ name: 'TimeoutError', message: 'request timed out' }));

        const promise = provider.listBuckets().catch((e) => e);
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(mockSend).toHaveBeenCalledTimes(3);
        expect(result.name).toBe('TimeoutError');
        vi.useRealTimers();
      });

      it('bucketExists retries transient 503 then returns true', async () => {
        vi.useFakeTimers();
        mockSend.mockRejectedValueOnce(
          makeErr({ name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } }),
        );
        mockSend.mockResolvedValueOnce({});

        const promise = provider.bucketExists('b');
        await vi.runAllTimersAsync();
        const exists = await promise;

        expect(exists).toBe(true);
        expect(mockSend).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
      });

      it('bucketExists short-circuits on NotFound without retry', async () => {
        mockSend.mockRejectedValueOnce(makeErr({ name: 'NotFound' }));

        const exists = await provider.bucketExists('missing');

        expect(exists).toBe(false);
        // Terminal classifier means exactly 1 call — no backoff wait.
        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      it('bucketExists short-circuits on 403 cross-account', async () => {
        mockSend.mockRejectedValueOnce(
          makeErr({ name: 'Forbidden', $metadata: { httpStatusCode: 403 } }),
        );

        await expect(provider.bucketExists('taken')).rejects.toThrow(/owned by another account/);
        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      it('createBucket retries transient UnknownError then succeeds', async () => {
        vi.useFakeTimers();
        // bucketExists check: not found, 1 call.
        mockSend.mockRejectedValueOnce(makeErr({ name: 'NotFound' }));
        // CreateBucket: first attempt UnknownError (Hetzner Ceph blip), second succeeds.
        mockSend.mockRejectedValueOnce(makeErr({ name: 'UnknownError' }));
        mockSend.mockResolvedValueOnce({});
        // Post-create sustained-visibility rounds + write probe: all clean.
        mockSend.mockResolvedValue({});

        const promise = provider.createBucket('flaky-bucket');
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result.created).toBe(true);
        // 1 (bucketExists) + 2 (CreateBucket attempts) + 3×(HEAD+LIST) +
        // put/get/delete write probe (3) = 12.
        expect(mockSend).toHaveBeenCalledTimes(12);
        vi.useRealTimers();
      });

      it('retries HTTP 500 / InternalError (AWS-Ceph serves InternalError as 500; 2026-08-07 sweep)', async () => {
        vi.useFakeTimers();
        mockSend.mockRejectedValueOnce(
          makeErr({ name: 'InternalError', $metadata: { httpStatusCode: 500 } }),
        );
        mockSend.mockResolvedValueOnce({});
        const promise = provider.deleteBucket('flaky-bucket');
        await vi.runAllTimersAsync();
        await promise;
        expect(mockSend).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
      });

      it('retries HTTP 429 / SlowDown (Ceph and Spaces rate-limit under e2e load)', async () => {
        vi.useFakeTimers();
        mockSend.mockRejectedValueOnce(
          makeErr({ name: 'SlowDown', $metadata: { httpStatusCode: 429 } }),
        );
        mockSend.mockResolvedValueOnce({});
        const promise = provider.deleteBucket('rate-limited-bucket');
        await vi.runAllTimersAsync();
        await promise;
        expect(mockSend).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
      });

      it('retries HTTP 408 / RequestTimeout', async () => {
        vi.useFakeTimers();
        mockSend.mockRejectedValueOnce(
          makeErr({ name: 'RequestTimeout', $metadata: { httpStatusCode: 408 } }),
        );
        mockSend.mockResolvedValueOnce({});
        const promise = provider.deleteBucket('slow-bucket');
        await vi.runAllTimersAsync();
        await promise;
        expect(mockSend).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
      });

      it('deleteBucket retries transient ECONNRESET then succeeds', async () => {
        vi.useFakeTimers();
        mockSend.mockRejectedValueOnce(
          makeErr({ name: 'Error', message: 'socket hang up: ECONNRESET' }),
        );
        mockSend.mockResolvedValueOnce({});

        const promise = provider.deleteBucket('b');
        await vi.runAllTimersAsync();
        await promise;

        expect(mockSend).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
      });

      it('emptyAndDeleteBucket defers the empty shell on persistent BucketNotEmpty instead of blocking on a minutes-long ladder', async () => {
        vi.useFakeTimers();
        const notEmpty = makeErr({
          name: 'BucketNotEmpty',
          message: 'The bucket you tried to delete is not empty',
        });
        // Emptying (List*/DeleteObjects) succeeds; the empty-shell DeleteBucket
        // rides Hetzner Ceph eventual-consistency and never clears within the run.
        mockSend.mockImplementation((command: { constructor: { name: string } }) =>
          command?.constructor?.name === 'DeleteBucketCommand'
            ? Promise.reject(notEmpty)
            : Promise.resolve({}),
        );

        const promise = provider.emptyAndDeleteBucket('lagging-shell');
        await vi.runAllTimersAsync();
        const result = await promise;

        // Objects are gone (billing/data event done) so this is benign — resolve,
        // don't throw, and mark the shell as deferred to the sweep.
        expect(result.deleted).toBe(false);
        expect(result.shellDeferred).toBe(true);

        // The old code hammered DeleteBucket 11× across a ~272s ladder. The shell
        // removal is cosmetic once the bucket is empty, so it must give up fast.
        const deleteBucketAttempts = mockSend.mock.calls.filter(
          ([cmd]: [{ constructor: { name: string } }]) =>
            cmd?.constructor?.name === 'DeleteBucketCommand',
        ).length;
        expect(deleteBucketAttempts).toBeLessThanOrEqual(3);
        vi.useRealTimers();
      });

      it('configureCORS retries transient 502 then succeeds', async () => {
        vi.useFakeTimers();
        mockSend.mockRejectedValueOnce(
          makeErr({ name: 'BadGateway', $metadata: { httpStatusCode: 502 } }),
        );
        mockSend.mockResolvedValueOnce({});

        const promise = provider.configureCORS('b');
        await vi.runAllTimersAsync();
        await promise;

        expect(mockSend).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
      });

      it('validateCredentials does NOT inherit _send retry (fast UX)', async () => {
        vi.useFakeTimers();
        // Plain unknown failure (not a terminal auth name). validateCredentials
        // has its own outer 3-attempt retry with 1.5s/3s backoff; the inner
        // _send must use maxAttempts=1 so we don't get 3×3=9 total attempts.
        mockSend.mockRejectedValue(makeErr({ name: 'NetworkingError' }));

        const promise = provider.validateCredentials();
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result.valid).toBe(false);
        // validateCredentials's own loop = 3 attempts, _send doing 1 each = 3 total.
        expect(mockSend).toHaveBeenCalledTimes(3);
        vi.useRealTimers();
      });
    });
  });
});

describe('sanitizeBucketName (exported from provider)', () => {
  it('is exported and works correctly', () => {
    expect(sanitizeBucketName('MyApp')).toBe('myapp-storage');
  });
});
