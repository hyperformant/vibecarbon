/**
 * S3-compatible object storage — generic base provider.
 *
 * Manages S3 bucket operations using AWS SDK v3 against any S3-compatible
 * endpoint. Subclasses (HetznerS3Provider, and future providers) supply the
 * region/endpoint map and any provider-specific quirks; everything else —
 * client construction, retry, bucket lifecycle, CORS, state-bucket helpers —
 * lives here so a new provider's S3 class stays thin.
 *
 * Subclass contract: statics `ENDPOINTS {region: url}`, `REGIONS`,
 * `resolveS3Region(deployRegion)`; ctor `(accessKeyId, secretAccessKey, region)`
 * throws on missing creds/unknown region, validated here against
 * `new.target.ENDPOINTS` so each subclass validates against its own map.
 *
 * Retry posture: every SDK call routes through `_send()`, which retries
 * transient errors (TimeoutError, ECONNRESET, EAI_AGAIN, 5xx, AWS SDK
 * "UnknownError" wrappers) with capped backoff. Operation-specific
 * conditions (NotFound, BucketAlreadyExists, BucketNotEmpty) are handled
 * by the caller via a `terminal` classifier so they don't waste retries.
 * Hetzner Ceph has a higher transient-error floor than AWS S3, so this
 * uniform posture is what keeps e2e off the whack-a-mole treadmill; the
 * same posture is a reasonable default for any S3-compatible backend.
 */

import {
  AbortMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

// Transient S3 error classifier. Matches AWS SDK error names ("TimeoutError",
// "UnknownError"), socket-level Node errors ("ECONNRESET", "EAI_AGAIN"), and
// 5xx HTTP statuses from $metadata.httpStatusCode. The regex covers cases
// where the status code is embedded in the error name/message (some SDK
// versions do this); the explicit $metadata check covers the common case
// where the provider returns a clean 502/503/504 with a typed name like
// "ServiceUnavailable" that wouldn't match the regex.
const TRANSIENT_S3_ERROR_RE =
  /TimeoutError|ETIMEDOUT|ECONNRESET|EAI_AGAIN|NetworkingError|Network failure|UnknownError|InternalError|503|504|502/i;
// 500 (2026-08-07 family sweep): AWS/Ceph serve `InternalError` as HTTP 500 —
// classify-failure and fetch-retry both already treat it as transient;
// this layer was the lone holdout treating it as fatal.
// 429/408: Ceph and Spaces rate-limit (SlowDown) under e2e load; fetch-retry
// already retries both. 425 deliberately absent — S3 never sends Too Early.
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function isTransientS3Error(error) {
  if (!error) return false;
  if (TRANSIENT_S3_ERROR_RE.test(error.name ?? '')) return true;
  if (TRANSIENT_S3_ERROR_RE.test(error.message ?? '')) return true;
  const status = error.$metadata?.httpStatusCode;
  if (status && TRANSIENT_HTTP_STATUSES.has(status)) return true;
  return false;
}

export class S3CompatibleProvider {
  /**
   * Create a new S3-compatible provider instance.
   * @param {string} accessKeyId - S3 access key
   * @param {string} secretAccessKey - S3 secret key
   * @param {string} region - Region, validated against the constructing
   *   subclass's own `ENDPOINTS` map (via `new.target`)
   */
  constructor(accessKeyId, secretAccessKey, region) {
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('S3 credentials are required');
    }

    if (!new.target.ENDPOINTS[region]) {
      throw new Error(
        `Invalid region: ${region}. Valid regions: ${Object.keys(new.target.ENDPOINTS).join(', ')}`,
      );
    }

    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.region = region;
    this.endpoint = new.target.ENDPOINTS[region];
    this._client = null;
  }

  /**
   * Get or create the S3 client (lazy initialization)
   * @returns {S3Client}
   */
  getClient() {
    if (!this._client) {
      // Explicit timeouts on the underlying http handler. The AWS SDK's
      // NodeHttpHandler defaults to no socket timeout, so an S3-compatible
      // endpoint that accepts the TCP connection but stops responding mid-
      // request will hang the call indefinitely. Observed in iter-initbackend
      // 2026-05-01 (Hetzner Ceph): compose destroy hung for 600s (test runner
      // SIGKILL) on emptyAndDeleteBucket → ListObjectsV2; the per-iteration
      // `client.send` never returned. With requestTimeout set, a stuck call
      // surfaces as a TimeoutError after 60s and `_send` retries. maxAttempts
      // here is the SDK's own internal retry; `_send` adds an outer layer with
      // backoff tuned for the provider's recovery cadence.
      this._client = new S3Client({
        // Signing region only — the endpoint below picks the actual
        // cluster. Subclasses whose backend rejects the AWS SDK's
        // auto-injected CreateBucket LocationConstraint (derived from this
        // value whenever it isn't us-east-1) pin S3_SIGNING_REGION — see
        // LinodeObjectStorageProvider and s3-signing-region.test.ts.
        region: this.constructor.S3_SIGNING_REGION ?? this.region,
        endpoint: this.endpoint,
        forcePathStyle: true, // path-style URLs are the common denominator across S3-compatible providers
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey,
        },
        maxAttempts: 3,
        requestHandler: {
          connectionTimeout: 10_000,
          requestTimeout: 60_000,
        },
      });
    }
    return this._client;
  }

  /**
   * Send a command through the S3 client with uniform transient-error retry.
   *
   * All SDK calls in this module route through here. The default 3-attempt
   * loop with [5s, 10s] backoff absorbs a typical blip envelope (one or two
   * failed dispatches followed by recovery). Callers that need different
   * retry economics — credential-validation prompts want fast failure,
   * createBucket wants 5×exponential to ride out the post-delete bucket-name
   * reservation window — pass `maxAttempts` and `backoffSeconds` explicitly.
   *
   * `terminal(error) → boolean` lets the caller short-circuit retry for
   * conditions that are deterministic outcomes rather than transient
   * faults (e.g., HeadBucket NotFound is "the bucket doesn't exist", not
   * "the provider blipped"). Without this, NotFound would cost 15s+ of retry
   * before bucketExists could return false.
   *
   * @param {object} command - AWS SDK command instance
   * @param {object} [opts]
   * @param {number} [opts.maxAttempts=3]
   * @param {number[]} [opts.backoffSeconds=[5,10]] - delays BETWEEN attempts; length should be maxAttempts-1 (last entry repeats if shorter)
   * @param {(error: Error) => boolean} [opts.terminal] - if returns true, throw immediately without retry
   * @returns {Promise<*>} SDK response
   */
  async _send(command, { maxAttempts = 3, backoffSeconds = [5, 10], terminal = null } = {}) {
    const client = this.getClient();
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await client.send(command);
      } catch (error) {
        lastError = error;
        if (terminal?.(error)) throw error;
        if (isTransientS3Error(error) && attempt < maxAttempts - 1) {
          const delay = backoffSeconds[Math.min(attempt, backoffSeconds.length - 1)];
          await new Promise((r) => setTimeout(r, delay * 1000));
          continue;
        }
        throw error;
      }
    }
    // Loop above always returns or throws on the final attempt.
    throw lastError;
  }

  /**
   * Validate credentials by listing buckets
   * @returns {Promise<{valid: boolean, error?: string}>}
   */
  async validateCredentials() {
    // Tight retry budget tuned for the credential-prompt UX: terminal auth
    // errors fail fast; transient errors get up to 3 quick re-tries before
    // we surface "credentials invalid" to the user. We bypass _send's own
    // retry (`maxAttempts: 1`) so the outer loop here is the single source
    // of retry, keeping the worst-case wait under ~5s.
    const terminalNames = new Set(['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied']);
    const maxAttempts = 3;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this._send(new ListBucketsCommand({}), { maxAttempts: 1 });
        return { valid: true };
      } catch (error) {
        lastError = error;
        if (terminalNames.has(error.name)) break;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
    }
    if (lastError.name === 'InvalidAccessKeyId') {
      return { valid: false, error: 'Invalid Access Key ID' };
    }
    if (lastError.name === 'SignatureDoesNotMatch') {
      return { valid: false, error: 'Invalid Secret Key' };
    }
    if (lastError.name === 'AccessDenied') {
      return { valid: false, error: 'Access denied. Check credentials permissions.' };
    }
    return {
      valid: false,
      error:
        lastError.message ||
        lastError.Code ||
        lastError.name ||
        `S3 error (HTTP ${lastError.$metadata?.httpStatusCode || 'unknown'})`,
    };
  }

  /**
   * List all buckets.
   *
   * `sendOptions` is `_send`'s retry economics, forwarded verbatim. Callers
   * that PROBE — walking every endpoint of a provider whose keys are
   * cluster-scoped, as the stale-bucket reaper does on Linode and Vultr — need
   * a rejection to come back fast: on Vultr, a wrong-cluster
   * `InvalidAccessKeyId` cost 15s per region under the default 3-attempt
   * ladder (live measurement 2026-08-11), turning an 8-region walk into two
   * minutes of waiting for an answer already known after the first response.
   * Omitting it keeps the default posture for every existing caller.
   *
   * @param {{maxAttempts?: number, backoffSeconds?: number[], terminal?: (e: Error) => boolean}} [sendOptions]
   * @returns {Promise<Array<{name: string, creationDate: Date}>>}
   */
  async listBuckets(sendOptions = undefined) {
    const response = await this._send(new ListBucketsCommand({}), sendOptions);
    return (response.Buckets || []).map((bucket) => ({
      name: bucket.Name,
      creationDate: bucket.CreationDate,
    }));
  }

  /**
   * Check if a bucket exists. NotFound and 403 short-circuit `_send`'s
   * retry via the terminal classifier — they're deterministic outcomes
   * (bucket missing / cross-account collision), not a provider blip. Only
   * actual transient errors (TimeoutError, 5xx) get retried by `_send`.
   * @param {string} bucketName - Bucket name
   * @returns {Promise<boolean>}
   */
  async bucketExists(bucketName) {
    const command = new HeadBucketCommand({ Bucket: bucketName });
    try {
      await this._send(command, {
        terminal: (err) => {
          const status = err.$metadata?.httpStatusCode;
          return err.name === 'NotFound' || status === 404 || status === 403;
        },
      });
      return true;
    } catch (error) {
      const status = error.$metadata?.httpStatusCode;
      if (error.name === 'NotFound' || status === 404) return false;
      if (status === 403) {
        throw new Error(
          `Bucket "${bucketName}" exists but is owned by another account. Try a different project name.`,
        );
      }
      throw error;
    }
  }

  /**
   * Return true if the bucket contains at least one object under `prefix`.
   * Tolerant of NoSuchBucket (returns false) so callers can probe a bucket
   * that may not exist yet. Used by the deploy-time Pulumi-state migration to
   * decide whether the dedicated state bucket has already been seeded and
   * whether the legacy app bucket still holds state to copy over.
   * @param {string} bucketName
   * @param {string} prefix
   * @returns {Promise<boolean>}
   */
  async hasObjectsWithPrefix(bucketName, prefix) {
    try {
      const res = await this._send(
        new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix, MaxKeys: 1 }),
        {
          terminal: (err) => {
            const status = err.$metadata?.httpStatusCode;
            return err.name === 'NoSuchBucket' || status === 404;
          },
        },
      );
      return (res.KeyCount ?? res.Contents?.length ?? 0) > 0;
    } catch (err) {
      const status = err.$metadata?.httpStatusCode;
      if (err.name === 'NoSuchBucket' || status === 404) return false;
      throw err;
    }
  }

  /**
   * Copy every object under `prefix` from `srcBucket` to `destBucket`,
   * preserving keys. Server-side copy (CopyObjectCommand) — no bytes transit
   * the operator. Used to migrate legacy Pulumi state (the `.pulumi/` prefix)
   * out of the app storage bucket into the dedicated state bucket. Both
   * buckets must be in this provider's region.
   * @param {string} srcBucket
   * @param {string} destBucket
   * @param {string} prefix
   * @returns {Promise<{copied: number}>}
   */
  async copyPrefix(srcBucket, destBucket, prefix) {
    let continuationToken;
    let copied = 0;
    do {
      const listResult = await this._send(
        new ListObjectsV2Command({
          Bucket: srcBucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of listResult.Contents || []) {
        await this._send(
          new CopyObjectCommand({
            Bucket: destBucket,
            Key: obj.Key,
            // CopySource must be URL-encoded; keys contain `/` path separators
            // (`.pulumi/stacks/...`) which encodeURI preserves.
            CopySource: encodeURI(`${srcBucket}/${obj.Key}`),
          }),
        );
        copied += 1;
      }
      continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
    } while (continuationToken);
    return { copied };
  }

  /**
   * Search all S3 regions (of this instance's own subclass) for a bucket we
   * own. Each region's HeadBucket failure is intentionally swallowed —
   * finding the bucket means we got a success on at least one region;
   * finding it nowhere means it doesn't exist anywhere we own. We
   * deliberately don't retry transients here because findBucketRegion is
   * itself a fallback called from createBucket's BucketAlreadyExists branch
   * — a per-region blip just means "try the next region", not "give up".
   * @param {string} bucketName
   * @returns {Promise<string|null>} The region where the bucket was found, or null
   */
  async findBucketRegion(bucketName) {
    for (const [region, endpoint] of Object.entries(this.constructor.ENDPOINTS)) {
      try {
        const client = new S3Client({
          // Same signing-region seam as getClient — the walked `region`
          // still selects the endpoint (the actual cluster probed).
          region: this.constructor.S3_SIGNING_REGION ?? region,
          endpoint,
          forcePathStyle: true,
          credentials: {
            accessKeyId: this.accessKeyId,
            secretAccessKey: this.secretAccessKey,
          },
        });
        await client.send(new HeadBucketCommand({ Bucket: bucketName }));
        return region;
      } catch {
        // Not in this region or not accessible — try next
      }
    }
    return null;
  }

  /**
   * Create a new bucket.
   *
   * Outer loop handles two operation-specific conditions that aren't
   * just "the provider blipped":
   *   - BucketAlreadyExists: object storage providers commonly reserve
   *     bucket names for a window after deletion; on a destroy→restore
   *     cycle we ride that window out with exponential backoff before
   *     declaring cross-account collision.
   *   - BucketAlreadyOwnedByYou: success-equivalent — return early.
   * Transient errors fall through to the same loop's backoff, courtesy
   * of `_send` (with maxAttempts=1 inside) so we don't double-retry.
   * @param {string} bucketName - Bucket name (must be globally unique)
   * @returns {Promise<{name: string, created: boolean}>}
   */
  async createBucket(bucketName) {
    if (await this.bucketExists(bucketName)) {
      return { name: bucketName, created: false, message: 'Bucket already exists' };
    }

    const command = new CreateBucketCommand({ Bucket: bucketName });
    const maxAttempts = 5;
    const backoffSeconds = [10, 20, 30, 40, 50];
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this._send(command, { maxAttempts: 1 });
        await this.waitForBucketVisible(bucketName);
        return { name: bucketName, created: true };
      } catch (error) {
        if (error.name === 'BucketAlreadyOwnedByYou') {
          return { name: bucketName, created: false, message: 'Bucket already exists' };
        }
        if (isTransientS3Error(error) && attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, backoffSeconds[attempt] * 1000));
          continue;
        }
        if (error.name === 'BucketAlreadyExists') {
          // Bucket names are globally unique but region-scoped for access.
          // HeadBucket returns 404 when checking a bucket that lives in a
          // different region. Try all regions to find the bucket before
          // assuming another account owns it.
          const foundRegion = await this.findBucketRegion(bucketName);
          if (foundRegion) {
            this.region = foundRegion;
            this.endpoint = this.constructor.ENDPOINTS[foundRegion];
            this._client = null;
            return { name: bucketName, created: false, message: 'Bucket already exists' };
          }
          if (attempt < maxAttempts - 1) {
            // Eventual consistency window — probably our own prior delete
            // hasn't fully propagated. Wait and retry.
            await new Promise((r) => setTimeout(r, backoffSeconds[attempt] * 1000));
            continue;
          }
          throw new Error(
            `Bucket name "${bucketName}" is already taken by another account. Try a different name.`,
          );
        }
        throw error;
      }
    }
    // Unreachable; loop above either returns or throws.
    throw new Error(`createBucket: unexpected exit after ${maxAttempts} attempts`);
  }

  /**
   * Some S3-compatible providers ack CreateBucket before the bucket is
   * usable on every frontend — an immediate read (e.g. Pulumi's first
   * `stack select`) can 404 with NoSuchBucket, and LIST authorization can
   * lag even after HEAD reports the bucket visible (Hetzner live-hit
   * 2026-08-07, e2 provisioning on a fresh-generation state bucket:
   * CreateBucket OK, HEAD visible, `pulumi up`'s first LIST → AccessDenied
   * 403 and the deploy died first-strike). Poll until the bucket answers
   * BOTH a HEAD and a LIST so callers can rely on create → use with either
   * operation.
   * SUSTAINED visibility, not one lucky sample (registry-500 RCA, runs
   * 31970876667/31984725162/31997668866): Hetzner's frontends propagate
   * bucket metadata independently and each new connection may land on a
   * different one — a single HEAD+LIST pass proved ONE frontend while the
   * in-cluster registry's S3 driver was still getting `s3aws: NoSuchBucket`
   * resolving upload sessions minutes later. The condition is therefore
   * K CONSECUTIVE clean HEAD+LIST rounds (a flap resets the streak — the
   * frontends must converge, not get lucky) followed by one
   * write → read → delete round-trip, proving the WRITE path every consumer
   * (registry uploads, wal-g, Pulumi state) actually depends on.
   *
   * Best-effort: on budget exhaustion we warn and proceed, leaving residual
   * raciness to the caller-side NoSuchBucket retry (see lib/iac
   * withStateBackendRetry) and the registry push's round-trip probe.
   */
  async waitForBucketVisible(bucketName, { budgetMs = 120_000, intervalMs = 2000 } = {}) {
    const REQUIRED_STREAK = 3;
    const deadline = Date.now() + budgetMs;
    const probeKey = `.vibecarbon-visibility-probe-${Date.now()}`;
    let streak = 0;
    for (;;) {
      // bucketExists translates HeadBucket 403 into a fatal "owned by another
      // account" — correct for cold lookups, WRONG here: during post-create
      // propagation the provider can 403 the bucket we created seconds ago
      // before its auth data reaches every frontend (Hetzner live-hit
      // 2026-07-07: fresh unique bucket, CreateBucket OK, first HEAD → 403 →
      // deploy died with the cross-account message). Inside this poll, ANY
      // error just means "not ready yet" and resets the streak.
      try {
        if (await this.bucketExists(bucketName)) {
          // HEAD visible — now require LIST too (the operation Pulumi's DIY
          // backend leads with; its auth propagates separately from HEAD).
          await this._send(new ListObjectsV2Command({ Bucket: bucketName, MaxKeys: 1 }), {
            maxAttempts: 1,
          });
          streak += 1;
          if (streak >= REQUIRED_STREAK) {
            // Streak held — prove the write path with a tiny round-trip.
            await this._send(
              new PutObjectCommand({ Bucket: bucketName, Key: probeKey, Body: 'probe' }),
              { maxAttempts: 1 },
            );
            await this._send(new GetObjectCommand({ Bucket: bucketName, Key: probeKey }), {
              maxAttempts: 1,
            });
            await this._send(new DeleteObjectCommand({ Bucket: bucketName, Key: probeKey }), {
              maxAttempts: 1,
            });
            return true;
          }
        } else {
          streak = 0;
        }
      } catch {
        streak = 0;
      }
      if (Date.now() + intervalMs > deadline) {
        console.warn(
          `[s3] bucket ${bucketName} created but not sustainably HEAD+LIST+write-ready after ${budgetMs}ms, proceeding`,
        );
        return false;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /**
   * Delete a bucket (must be empty).
   * Outer loop handles BucketNotEmpty (eventual-consistency: object
   * deletes from emptyAndDeleteBucket may not have fully propagated yet).
   * Transient errors get retried by `_send` itself; we only wrap
   * BucketNotEmpty in the operation-specific outer loop here.
   * @param {string} bucketName - Bucket name
   */
  async deleteBucket(bucketName) {
    // Some providers (observed on Hetzner's Ceph backend) return
    // BucketNotEmpty for some time after the last object deletion finishes
    // propagating, even when GET/LIST already report the bucket as empty
    // (observed >30s in prod-1 2026-05-26, and minutes in the 2026-07-07 e2e
    // run). We used to ride that lag out with a ~4.5-min ladder, which made
    // destroy the single slowest command in the matrix. But by the time we
    // call DeleteBucket the objects are already gone — the empty-shell
    // removal is cosmetic (an empty bucket holds no data and incurs no
    // storage cost). So we give the shell a short window to drop, then hand
    // a persistent BucketNotEmpty back to the caller to defer (see
    // emptyAndDeleteBucket). Transient faults are still retried by `_send`;
    // this budget is ONLY the BucketNotEmpty eventual-consistency wait.
    const delays = [2000, 3000];
    let lastErr;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await this._send(new DeleteBucketCommand({ Bucket: bucketName }));
        return;
      } catch (err) {
        lastErr = err;
        // AWS SDK v3 surfaces the S3 error code as err.name; older shapes used
        // err.Code — accept both plus the message text.
        const isNotEmpty =
          err.name === 'BucketNotEmpty' ||
          err.Code === 'BucketNotEmpty' ||
          err.message?.includes('not empty');
        if (!isNotEmpty || attempt === delays.length) throw err;
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
    throw lastErr;
  }

  /**
   * Empty all objects from a bucket and then delete it.
   * Handles current objects, versioned objects/delete markers, and incomplete
   * multipart uploads.
   *
   * Step errors that look like "API not supported by provider" (NotImplemented,
   * MethodNotAllowed, 405/501) are tolerated and recorded as warnings — not all
   * S3-compatible providers expose ListObjectVersions / multipart listing.
   * Real errors (timeouts, 5xx, auth) propagate so callers can surface them
   * instead of getting an opaque BucketNotEmpty downstream.
   *
   * If `deleteBucket` finally fails with BucketNotEmpty, the thrown error is
   * enriched with a fresh listing summary so the operator can see exactly
   * what's left blocking deletion.
   *
   * @param {string} bucketName
   * @returns {Promise<{deleted: boolean, objectsRemoved: number, warnings: string[]}>}
   */
  async emptyAndDeleteBucket(bucketName) {
    let objectsRemoved = 0;
    const warnings = [];

    // 1. Delete current objects via ListObjectsV2.
    let continuationToken;
    do {
      const listResult = await this._send(
        new ListObjectsV2Command({ Bucket: bucketName, ContinuationToken: continuationToken }),
      );
      if (listResult.Contents?.length > 0) {
        await this._send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: listResult.Contents.map((obj) => ({ Key: obj.Key })) },
          }),
        );
        objectsRemoved += listResult.Contents.length;
      }
      continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
    } while (continuationToken);

    // 2. Delete all object versions and delete markers (required for versioned
    // buckets — without this, DeleteBucket fails with BucketNotEmpty even after
    // removing current objects).
    try {
      let keyMarker;
      let versionIdMarker;
      do {
        const versionsResult = await this._send(
          new ListObjectVersionsCommand({
            Bucket: bucketName,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
          }),
        );
        const toDelete = [
          ...(versionsResult.Versions || []).map((v) => ({ Key: v.Key, VersionId: v.VersionId })),
          ...(versionsResult.DeleteMarkers || []).map((d) => ({
            Key: d.Key,
            VersionId: d.VersionId,
          })),
        ];
        if (toDelete.length > 0) {
          await this._send(
            new DeleteObjectsCommand({ Bucket: bucketName, Delete: { Objects: toDelete } }),
          );
          objectsRemoved += toDelete.length;
        }
        keyMarker = versionsResult.IsTruncated ? versionsResult.NextKeyMarker : undefined;
        versionIdMarker = versionsResult.IsTruncated
          ? versionsResult.NextVersionIdMarker
          : undefined;
      } while (keyMarker);
    } catch (err) {
      if (S3CompatibleProvider._isUnsupportedApiError(err)) {
        warnings.push(`ListObjectVersions not supported by provider: ${err.name || err.message}`);
      } else {
        throw new Error(`Failed to list/delete object versions in ${bucketName}: ${err.message}`, {
          cause: err,
        });
      }
    }

    // 3. Abort incomplete multipart uploads (can also prevent bucket deletion).
    try {
      const uploads = await this._send(new ListMultipartUploadsCommand({ Bucket: bucketName }));
      for (const upload of uploads.Uploads || []) {
        await this._send(
          new AbortMultipartUploadCommand({
            Bucket: bucketName,
            Key: upload.Key,
            UploadId: upload.UploadId,
          }),
        );
      }
    } catch (err) {
      if (S3CompatibleProvider._isUnsupportedApiError(err)) {
        warnings.push(`ListMultipartUploads not supported by provider: ${err.name || err.message}`);
      } else {
        throw new Error(`Failed to abort multipart uploads in ${bucketName}: ${err.message}`, {
          cause: err,
        });
      }
    }

    // Now delete the empty bucket. Steps 1-3 above removed every object, version,
    // delete-marker, and multipart upload — so a BucketNotEmpty here is
    // eventual-consistency lag on the shell removal, not real data. Rather
    // than block the operator for minutes waiting for the provider to catch
    // up, we defer: return success-with-warning and leave the empty shell for
    // the orphan sweep or the next destroy. An empty bucket holds no data and
    // incurs no storage cost, and a re-deploy reuses it via `bucketExists`.
    // Any OTHER error (auth, 5xx, a genuinely non-empty bucket) still
    // propagates so callers surface it.
    try {
      await this.deleteBucket(bucketName);
    } catch (err) {
      const isNotEmpty =
        err.name === 'BucketNotEmpty' ||
        err.Code === 'BucketNotEmpty' ||
        /not empty/i.test(err.message ?? '');
      if (!isNotEmpty) throw err;
      return {
        deleted: false,
        shellDeferred: true,
        objectsRemoved,
        warnings: [
          ...warnings,
          `${bucketName} emptied (${objectsRemoved} objects removed) but the empty shell could not be removed yet (S3 eventual-consistency lag); left for the orphan sweep; no data or storage cost remains`,
        ],
      };
    }
    return { deleted: true, shellDeferred: false, objectsRemoved, warnings };
  }

  /**
   * Best-effort listing of remaining bucket contents for diagnostics. Used
   * when DeleteBucket fails with BucketNotEmpty — returns a one-line summary
   * like `47 objects (e.g. .placeholder, public/avatar.png), 3 versions + 1
   * delete marker, 2 incomplete multipart uploads`. Each section is
   * independently try/caught so partial visibility beats none.
   * @param {string} bucketName
   * @returns {Promise<string>}
   */
  async _summarizeBucketContents(bucketName) {
    const parts = [];

    try {
      const r = await this._send(new ListObjectsV2Command({ Bucket: bucketName, MaxKeys: 5 }), {
        maxAttempts: 1,
      });
      const count = r.KeyCount ?? r.Contents?.length ?? 0;
      if (count > 0) {
        const examples = (r.Contents ?? [])
          .slice(0, 3)
          .map((o) => o.Key)
          .join(', ');
        const more = r.IsTruncated ? '+' : '';
        parts.push(`${count}${more} objects (e.g. ${examples})`);
      }
    } catch (err) {
      parts.push(`object listing failed: ${err.name || err.message}`);
    }

    try {
      const r = await this._send(
        new ListObjectVersionsCommand({ Bucket: bucketName, MaxKeys: 5 }),
        { maxAttempts: 1 },
      );
      const versionCount = (r.Versions ?? []).length;
      const markerCount = (r.DeleteMarkers ?? []).length;
      if (versionCount + markerCount > 0) {
        parts.push(
          `${versionCount} version${versionCount === 1 ? '' : 's'} + ${markerCount} delete marker${markerCount === 1 ? '' : 's'}`,
        );
      }
    } catch {
      // versioning API absent — covered by primary listing
    }

    try {
      const r = await this._send(new ListMultipartUploadsCommand({ Bucket: bucketName }), {
        maxAttempts: 1,
      });
      const uploadCount = (r.Uploads ?? []).length;
      if (uploadCount > 0) {
        parts.push(`${uploadCount} incomplete multipart upload${uploadCount === 1 ? '' : 's'}`);
      }
    } catch {
      // multipart API absent — covered above
    }

    // If all three listings succeeded and returned zero items, the bucket
    // *appears* empty but DeleteBucket still raised BucketNotEmpty. Almost
    // always eventual-consistency lag — the upstream caller has already
    // exhausted its retry budget by this point, so tell the operator how to
    // recover instead of the generic "unable to list" message which sounds
    // like the diagnostic itself broke.
    return parts.length > 0
      ? parts.join(', ')
      : 'bucket appears empty in all listings — likely S3 eventual-consistency lag. Wait ~60s, then retry the destroy or delete the bucket manually with `aws s3api delete-bucket --bucket <name> --endpoint-url <endpoint>`.';
  }

  /**
   * Heuristic: does this S3 error mean "the provider doesn't expose this API"
   * vs. a transient or auth failure that we should surface? AWS standard
   * error codes plus a few HTTP status fallbacks for non-AWS providers.
   */
  static _isUnsupportedApiError(err) {
    const name = err?.name ?? '';
    const code = err?.Code ?? '';
    const status = err?.$metadata?.httpStatusCode;
    if (name === 'NotImplemented' || code === 'NotImplemented') return true;
    if (name === 'MethodNotAllowed' || code === 'MethodNotAllowed') return true;
    if (status === 405 || status === 501) return true;
    return false;
  }

  /**
   * Configure CORS policy for browser uploads
   * @param {string} bucketName - Bucket name
   * @param {string[]} [allowedOrigins=['*']] - Allowed origins
   * @returns {Promise<void>}
   */
  async configureCORS(bucketName, allowedOrigins = ['*']) {
    const command = new PutBucketCorsCommand({
      Bucket: bucketName,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedHeaders: ['*'],
            AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
            AllowedOrigins: allowedOrigins,
            ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    });
    await this._send(command);
  }

  /**
   * Get the S3 endpoint URL for this region
   * @returns {string}
   */
  getEndpoint() {
    return this.endpoint;
  }

  /**
   * Get all available regions
   * @returns {Object<string, string>}
   */
  static getRegions() {
    // Deliberately polymorphic: must read the calling subclass's own REGIONS
    // map (S3CompatibleProvider itself declares none), so
    // `HetznerS3Provider.getRegions()` returns Hetzner's regions and a
    // future provider's subclass returns its own.
    // biome-ignore lint/complexity/noThisInStatic: see comment above
    return this.REGIONS;
  }

  /**
   * Get endpoint for a specific region
   * @param {string} region - Region ID
   * @returns {string|null}
   */
  static getEndpointForRegion(region) {
    // biome-ignore lint/complexity/noThisInStatic: deliberately polymorphic — see getRegions() above.
    return this.ENDPOINTS[region] || null;
  }
}

/**
 * Sanitize a project name into a valid S3 bucket name
 * S3 bucket naming rules:
 * - 3-63 characters
 * - Lowercase letters, numbers, and hyphens only
 * - Must start and end with letter or number
 * - No consecutive periods or adjacent period/hyphen
 *
 * @param {string} projectName - Project name to sanitize
 * @param {string} [suffix='storage'] - Suffix to append
 * @returns {string} - Valid bucket name
 */
export function sanitizeBucketName(projectName, suffix = 'storage') {
  const baseName = suffix ? `${projectName}-${suffix}` : projectName;

  return baseName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-') // Replace invalid chars with hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, '') // Remove leading/trailing hyphens
    .slice(0, 63); // Truncate to max length
}

/**
 * Derive the dedicated Pulumi-state bucket name from the app storage bucket
 * name. Pulumi state used to live in the app storage bucket, which created a
 * destroy-time circular hazard (deleting the storage bucket nuked the state
 * backend mid-destroy). State now lives in a separate bucket derived once,
 * deterministically, from the app bucket — so the derivation is stable across
 * deploy / scale / destroy and identical for both HA stacks (they share one
 * state bucket).
 *
 * GENERATION (2026-08-07): when the project carries a
 * `stateBucketGeneration`, it is embedded in the name and ROTATED by a
 * verified destroy — so a redeploy after destroy derives a FRESH state-bucket
 * name instead of recreating the deleted one. Hetzner Object Storage can ack
 * writes against a just-deleted-and-recreated same-name bucket and then lose
 * them (e4 restore→failover, 2026-08-07: the standby's up succeeded, its
 * state was gone from the bucket 45+ minutes later — not staleness, loss).
 * Persisted names always win over derivation, so live environments are
 * untouched by a rotation; only future derivations move.
 *
 * The generation suffix must SURVIVE the 63-char clip (a tail `.slice` would
 * eat it on long project names — observed as `…-storage-pulumi-stat`), so the
 * BASE is clipped and the functional suffix is preserved whole.
 *
 * @param {string} appBucketName - The app storage bucket (e.g. `myapp-storage`)
 * @param {string} [generation] - 6-hex state-bucket generation; omitted for
 *   legacy projects (pre-generation names remain byte-stable)
 * @returns {string} - Valid state bucket name (e.g.
 *   `myapp-storage-pulumi-state-a1b2c3`)
 */
/**
 * Pick the Pulumi state bucket for an environment, in precedence order.
 *
 *   1. `envStateBucket` — the environment's PERSISTED name. An env that has
 *      deployed keeps the exact bucket it has been using; nothing may move it.
 *   2. `projectPin` — a project-level `stateBucket` in `.vibecarbon.json`, for
 *      operators who want one named bucket to hold their Pulumi state instead
 *      of a derived name. Pulumi's DIY layout keys state as
 *      `.pulumi/stacks/<project>/<stack>.json` and our Pulumi project name is
 *      constant, so distinct stack names coexist in one bucket safely. This is
 *      also what lets the e2e harness point every scenario at a single
 *      long-lived bucket rather than creating a brand-new one per run — a fresh
 *      bucket is the worst window for state-backend staleness and throttling,
 *      and a real customer's bucket is warm by the time it matters.
 *   3. Derivation from the app bucket name.
 *
 * @param {object} args
 * @param {string} [args.envStateBucket]
 * @param {string} [args.projectPin]
 * @param {string} args.appBucket
 * @param {string} [args.generation]
 * @returns {string}
 */
export function resolveStateBucketName({ envStateBucket, projectPin, appBucket, generation }) {
  if (envStateBucket) return envStateBucket;
  if (projectPin !== undefined && projectPin !== null) {
    // Validate the pin HERE, before the deploy creates the app and backup
    // buckets: an invalid name surfacing later at createBucket leaves a
    // half-provisioned S3 setup with a raw provider error and no hint the pin
    // caused it — and an empty-string pin would otherwise win the fallback
    // chain and build the malformed backend URL `s3://?endpoint=...`
    // (review finding, 2026-08-15). Same rules sanitizeBucketName enforces,
    // but a pin is REJECTED rather than silently rewritten: the operator chose
    // this exact name, and deploying under a different one than they wrote is
    // worse than telling them to fix it.
    const pin = String(projectPin);
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(pin)) {
      throw new Error(
        `Invalid stateBucket pin ${JSON.stringify(projectPin)} in .vibecarbon.json: bucket ` +
          'names must be 3-63 chars of lowercase letters, digits and hyphens, starting and ' +
          'ending alphanumeric. Fix or remove the "stateBucket" entry.',
      );
    }
    return pin;
  }
  return deriveStateBucketName(appBucket, generation);
}

export function deriveStateBucketName(appBucketName, generation) {
  const suffix = generation ? `pulumi-state-${generation}` : 'pulumi-state';
  const clipped = appBucketName.slice(0, Math.max(3, 63 - suffix.length - 1));
  return sanitizeBucketName(clipped, suffix);
}

/**
 * Derive a project bucket name, embedding the project's bucket salt when it
 * has one: `<name>-<salt>-<suffix>`.
 *
 * The salt (6 hex chars, generated once by `vibecarbon create` and persisted
 * top-level in `.vibecarbon.json` as `bucketSalt`) exists because bucket
 * names are GLOBAL per provider namespace — two customers deploying projects
 * both named `myapp` would otherwise race for the same `myapp-storage`
 * bucket and the loser's deploy fails on a bucket it can't own.
 *
 * Projects created before the salt existed have no `bucketSalt` key and keep
 * deriving their legacy unsalted names — their deployed environments' destroy
 * paths find buckets by exactly those literals. The salt sits AFTER the
 * project name so prefix-based e2e sweeps (`testapp-*`) keep matching.
 *
 * @param {{ projectName: string, bucketSalt?: string }} projectConfig
 * @param {string} [suffix]
 * @returns {string}
 */
export function deriveProjectBucketName(projectConfig, suffix = 'storage') {
  const base = projectConfig.bucketSalt
    ? `${projectConfig.projectName}-${projectConfig.bucketSalt}`
    : projectConfig.projectName;
  // STORAGE generation (2026-08-17, registry-500 RCA run 32013980356): a
  // purge-destroy deletes the storage bucket and a redeploy used to recreate
  // it under the SAME name — Hetzner's delete→recreate propagation worst
  // case, which flapped NoSuchBucket at the in-cluster registry for >10
  // minutes. The generation (seeded by `create`, rotated by a verified
  // destroy that actually deleted the bucket) makes every recreate a FRESH
  // name. Persisted env bucket names win over derivation, so live
  // environments never move; legacy projects without the key keep their
  // byte-stable names. STORAGE ONLY: the backups bucket must keep its stable
  // name — restore finds its wal-g backups by it right after a destroy.
  // Clip-safe like deriveStateBucketName: the functional tail survives the
  // 63-char limit on long project names.
  if (suffix === 'storage' && projectConfig.storageBucketGeneration) {
    const genSuffix = `storage-${projectConfig.storageBucketGeneration}`;
    const clipped = base.slice(0, Math.max(3, 63 - genSuffix.length - 1));
    return sanitizeBucketName(clipped, genSuffix);
  }
  return sanitizeBucketName(base, suffix);
}
