/**
 * Byte transfer against a presigned object-storage URL, for the
 * `file_upload_roundtrip` check (tests/e2e/checks/app-functional.ts).
 *
 * Why this lives outside tests/e2e/checks/: every check module must reach the
 * ENVIRONMENT only through dnsSafeFetch, so verify-failover's resolution pin
 * can steer it at the promoted node (census in
 * tests/unit/e2e/verify-failover-dns-pin.test.ts). A presigned URL does not
 * point at the environment at all: it points at the provider's object storage
 * endpoint, which no failover moves and the pin does not cover. dnsSafeFetch
 * is also text-only (it stringifies request and response bodies), which would
 * corrupt the binary round-trip this check exists to assert.
 *
 * The refusal below keeps that claim honest: a presigned URL that resolves to
 * the environment's own domain is refused rather than fetched unpinned.
 */

const TRANSFER_TIMEOUT_MS = 15_000;

export interface PresignedTransfer {
  /**
   * Browser-shaped CORS preflight for a PUT with a Content-Type, from `origin`.
   * `errorCode` is the S3 `<Code>` of a refused preflight (CORSForbidden,
   * NoSuchBucket, AccessDenied...), the one field that tells "no matching CORS
   * rule" apart from "that bucket does not exist" in a 403.
   */
  preflight(
    url: string,
    origin: string,
  ): Promise<{ status: number; allowOrigin: string | null; errorCode?: string | null }>;
  put(
    url: string,
    headers: Record<string, string>,
    body: Uint8Array<ArrayBuffer>,
  ): Promise<{ status: number; body: string }>;
  get(url: string): Promise<{ status: number; bytes: Uint8Array }>;
}

/**
 * Throw when `url` targets the environment (`envDomain` or a subdomain of it).
 * Those requests must go through the pinned seam instead.
 */
export function assertObjectStorageUrl(url: string, envDomain: string): void {
  const host = new URL(url).hostname.toLowerCase();
  const env = envDomain.toLowerCase();
  if (host === env || host.endsWith(`.${env}`)) {
    throw new Error(
      `presigned URL host ${host} is the environment's own domain; it must be fetched through dnsSafeFetch`,
    );
  }
}

/** The `<Code>` of an S3 XML error body, or null when there is none. */
export function s3ErrorCode(body: string): string | null {
  const m = /<Code>([^<]{1,64})<\/Code>/.exec(body);
  return m ? m[1] : null;
}

/**
 * The bucket a path-style presigned URL targets (the template's S3 client
 * sets forcePathStyle, so it is the first path segment), or null.
 */
export function bucketOfPresignedUrl(url: string): string | null {
  const first = new URL(url).pathname.split('/')[1];
  return first ? decodeURIComponent(first) : null;
}

export function createPresignedTransfer(envDomain: string): PresignedTransfer {
  return {
    async preflight(url, origin) {
      assertObjectStorageUrl(url, envDomain);
      const res = await fetch(url, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'content-type',
        },
        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
      });
      const body = await res.text();
      return {
        status: res.status,
        allowOrigin: res.headers.get('access-control-allow-origin'),
        errorCode: res.ok ? null : s3ErrorCode(body),
      };
    },
    async put(url, headers, body) {
      assertObjectStorageUrl(url, envDomain);
      // Node's fetch derives Content-Length from the body, as a browser does.
      const sendHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() !== 'content-length') sendHeaders[name] = value;
      }
      const res = await fetch(url, {
        method: 'PUT',
        headers: sendHeaders,
        body,
        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
      });
      return { status: res.status, body: res.ok ? '' : (await res.text()).slice(0, 300) };
    },
    async get(url) {
      assertObjectStorageUrl(url, envDomain);
      const res = await fetch(url, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
      return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
    },
  };
}
