/**
 * Connection and request bounds for every S3 client the CLI builds.
 *
 * The AWS SDK's Node handler has none by default, so an S3-compatible endpoint
 * that accepts the TCP connection and then goes quiet holds a call, and the
 * command waiting on it, forever. Observed twice: a Hetzner Ceph
 * ListObjectsV2 during destroy (600s, 2026-05-01) and a DigitalOcean Spaces
 * PUT of the TLS snapshot during a k8s-ha restore (9 minutes, 2026-11-04).
 * With these set, a stuck call surfaces as a TimeoutError the caller handles.
 * tests/unit/lib/s3-client-timeouts.test.ts keeps every `new S3Client` on them
 * (or on a caller's own, tighter bounds).
 */
export const S3_HTTP_TIMEOUTS = Object.freeze({
  connectionTimeout: 10_000,
  requestTimeout: 60_000,
});
