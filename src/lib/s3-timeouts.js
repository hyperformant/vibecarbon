/**
 * Connection and silence bounds for every S3 client the CLI builds.
 *
 * The AWS SDK's Node handler has none by default, so an S3-compatible endpoint
 * that accepts the TCP connection and then goes quiet holds a call, and the
 * command waiting on it, until the kernel gives up on the socket: about 15
 * minutes on Linux. Observed three times: a Hetzner Ceph ListObjectsV2 during
 * destroy (600s, 2026-05-01), a DigitalOcean Spaces PUT of the TLS snapshot
 * during a k8s-ha restore (9 minutes, 2026-11-04), and a Hetzner HeadBucket in
 * the settle gate (about 16 minutes, 2026-11-05).
 *
 * The bound is `socketTimeout`, not `requestTimeout`. The SDK treats
 * requestTimeout as a warning unless throwOnRequestTimeout is also set, and it
 * caps the whole request, which would fail a long upload on a slow link.
 * socketTimeout caps silence: data moving keeps a call alive, and a dead
 * connection surfaces as a TimeoutError the caller handles.
 * tests/unit/lib/s3-client-timeouts.test.ts proves it against a silent server
 * and keeps every `new S3Client` on these (or a caller's own, tighter bounds).
 */
export const S3_HTTP_TIMEOUTS = Object.freeze({
  connectionTimeout: 10_000,
  socketTimeout: 60_000,
});
