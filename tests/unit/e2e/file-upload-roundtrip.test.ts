/**
 * The e2e `file_upload_roundtrip` check: presign through the app, PUT the bytes
 * to object storage, read them back through the app's 302, compare. These pin
 * the check's own logic with fakes; the live round-trip only runs on real infra.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CookieJar,
  checkFileUploadRoundtrip,
  ONE_PIXEL_PNG,
  resolveAppStorage,
} from '../../e2e/checks/app-functional.js';
import {
  assertObjectStorageUrl,
  bucketOfPresignedUrl,
  type PresignedTransfer,
  s3ErrorCode,
} from '../../e2e/utils/presigned-transfer.js';

const DOMAIN = 'app.example.com';
const jar = new CookieJar();
jar.absorb(new Response('', { headers: { 'set-cookie': 's=tok' } }));
const KEY = 'avatars/11111111-2222-3333-4444-555555555555/abc.png';
const PUT_URL = 'https://fsn1.your-objectstorage.com/bucket/put?sig=1';
const GET_URL = 'https://fsn1.your-objectstorage.com/bucket/get?sig=2';

function presignResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      key: KEY,
      url: PUT_URL,
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(ONE_PIXEL_PNG.length) },
      expiresIn: 300,
      fileUrl: `/api/files/${KEY}`,
      ...overrides,
    }),
    { status: 200 },
  );
}

const STORAGE_ORIGIN = 'https://fsn1.your-objectstorage.com';
const CSP = `default-src 'self'; connect-src 'self' https://${DOMAIN} https://cloudflareinsights.com ${STORAGE_ORIGIN}; object-src 'none'`;

function appFetchWith({
  presign = () => presignResponse(),
  home = () =>
    new Response('<html></html>', { status: 200, headers: { 'content-security-policy': CSP } }),
  read = () => new Response('', { status: 302, headers: { location: GET_URL } }),
}: {
  presign?: () => Response;
  home?: () => Response;
  read?: () => Response;
} = {}) {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/api/v1/files/presign')) return presign();
    if (url === `https://${DOMAIN}/`) return home();
    return read();
  });
}

function transferWith(overrides: Partial<PresignedTransfer> = {}): PresignedTransfer {
  return {
    preflight: vi.fn(async () => ({ status: 200, allowOrigin: `https://${DOMAIN}` })),
    put: vi.fn(async () => ({ status: 200, body: '' })),
    get: vi.fn(async () => ({ status: 200, bytes: new Uint8Array(ONE_PIXEL_PNG) })),
    ...overrides,
  };
}

describe('checkFileUploadRoundtrip', () => {
  it('passes when the bytes read back through the app equal the bytes uploaded', async () => {
    const appFetch = appFetchWith();
    const transfer = transferWith();
    const r = await checkFileUploadRoundtrip(DOMAIN, jar, { appFetch, transfer });

    expect(r).toMatchObject({ checkName: 'file_upload_roundtrip', status: 'pass' });
    // Presign as the signed-in user, for a 1x1 png avatar of the exact size.
    const [presignUrl, presignInit] = appFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(presignUrl).toBe(`https://${DOMAIN}/api/v1/files/presign`);
    expect(presignInit.method).toBe('POST');
    expect((presignInit.headers as Record<string, string>).Cookie).toBe('s=tok');
    expect((presignInit.headers as Record<string, string>).Origin).toBe(`https://${DOMAIN}`);
    expect((presignInit.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(presignInit.body as string)).toEqual({
      kind: 'avatar',
      contentType: 'image/png',
      size: ONE_PIXEL_PNG.length,
    });
    // The page's CSP is read from `/`, and a browser-shaped CORS preflight hits
    // the presigned URL from the app's origin.
    expect(appFetch.mock.calls[1][0]).toBe(`https://${DOMAIN}/`);
    expect(transfer.preflight).toHaveBeenCalledWith(PUT_URL, `https://${DOMAIN}`);
    // PUT goes to the presigned URL with the signed headers; the read goes
    // through the app and the redirect target is what gets downloaded.
    expect(transfer.put).toHaveBeenCalledWith(PUT_URL, expect.any(Object), expect.any(Uint8Array));
    expect(appFetch.mock.calls[2][0]).toBe(`https://${DOMAIN}/api/files/${KEY}`);
    expect(transfer.get).toHaveBeenCalledWith(GET_URL);
  });

  it('fails on a presign refusal, naming the step and status (storage not configured)', async () => {
    const appFetch = appFetchWith({
      presign: () => new Response('{"error":"storage_not_configured"}', { status: 503 }),
    });
    const transfer = transferWith();
    const r = await checkFileUploadRoundtrip(DOMAIN, jar, { appFetch, transfer });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/^presign: .*503.*storage_not_configured/);
    expect(transfer.put).not.toHaveBeenCalled();
  });

  it('fails on a presign 200 with the wrong shape', async () => {
    const r = await checkFileUploadRoundtrip(DOMAIN, jar, {
      appFetch: appFetchWith({ presign: () => presignResponse({ url: undefined }) }),
      transfer: transferWith(),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/^presign: 200 but unexpected shape/);
  });

  it('fails when the page CSP connect-src does not allow the storage origin', async () => {
    const transfer = transferWith();
    const r = await checkFileUploadRoundtrip(DOMAIN, jar, {
      appFetch: appFetchWith({
        home: () =>
          new Response('', {
            status: 200,
            headers: { 'content-security-policy': "default-src 'self'; connect-src 'self'" },
          }),
      }),
      transfer,
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(
      /^csp: connect-src does not allow https:\/\/fsn1\.your-objectstorage\.com/,
    );
    expect(transfer.put).not.toHaveBeenCalled();
  });

  it('fails when the page carries no CSP header', async () => {
    const r = await checkFileUploadRoundtrip(DOMAIN, jar, {
      appFetch: appFetchWith({ home: () => new Response('', { status: 200 }) }),
      transfer: transferWith(),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/^csp: /);
  });

  it('fails when the CORS preflight does not echo the app origin', async () => {
    const transfer = transferWith({
      preflight: vi.fn(async () => ({ status: 403, allowOrigin: null })),
    });
    const r = await checkFileUploadRoundtrip(DOMAIN, jar, { appFetch: appFetchWith(), transfer });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/^cors: preflight .*403.*Access-Control-Allow-Origin/);
    expect(transfer.put).not.toHaveBeenCalled();
  });

  it('names the presigned bucket and the S3 error code in a refused preflight', async () => {
    // 2026-10-20 verify-restore: a bare "403 with Access-Control-Allow-Origin
    // null" could not tell "no CORS rule on this bucket" from "this bucket
    // does not exist"; the bucket and <Code> together do.
    const r = await checkFileUploadRoundtrip(DOMAIN, jar, {
      appFetch: appFetchWith(),
      transfer: transferWith({
        preflight: vi.fn(async () => ({
          status: 403,
          allowOrigin: null,
          errorCode: 'CORSForbidden',
        })),
      }),
    });
    expect(r.errorMessage).toBe(
      `cors: preflight from https://${DOMAIN} to bucket "bucket" returned 403 (CORSForbidden) with Access-Control-Allow-Origin null`,
    );
    expect(r.details).toMatchObject({ bucket: 'bucket', errorCode: 'CORSForbidden' });
  });

  it("fails as `bucket`, before any preflight, when the app presigns against a bucket other than the environment's", async () => {
    const transfer = transferWith();
    const r = await checkFileUploadRoundtrip(DOMAIN, jar, {
      appFetch: appFetchWith(),
      transfer,
      expectedBucket: 'myapp-cd9ecc-storage-7f3e8e',
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(
      /^bucket: the app presigned against bucket "bucket", .* is "myapp-cd9ecc-storage-7f3e8e"$/,
    );
    expect(transfer.preflight).not.toHaveBeenCalled();
  });

  it("fails as `prefix`, before any preflight, when the presigned path is outside the environment's key prefix", async () => {
    const transfer = transferWith();
    const r = await checkFileUploadRoundtrip(DOMAIN, jar, {
      appFetch: appFetchWith(),
      transfer,
      expectedBucket: 'bucket',
      expectedKeyPrefix: 'prod/',
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toContain('prefix: ');
    expect(r.errorMessage).toContain('"/bucket/prod/"');
    expect(r.errorMessage).toContain('"/bucket/put"');
    expect(transfer.preflight).not.toHaveBeenCalled();
  });

  it('passes when the presigned path starts with /<bucket>/<keyPrefix>', async () => {
    const r = await checkFileUploadRoundtrip(DOMAIN, jar, {
      appFetch: appFetchWith({
        presign: () =>
          presignResponse({
            url: 'https://fsn1.your-objectstorage.com/bucket/prod/avatars/x.png?sig=1',
          }),
      }),
      transfer: transferWith(),
      expectedBucket: 'bucket',
      expectedKeyPrefix: 'prod/',
    });
    expect(r.status).toBe('pass');
  });

  it('passes when the presigned bucket is the environment bucket', async () => {
    const r = await checkFileUploadRoundtrip(DOMAIN, jar, {
      appFetch: appFetchWith(),
      transfer: transferWith(),
      expectedBucket: 'bucket',
    });
    expect(r.status).toBe('pass');
  });

  it('fails when the preflight allows a different origin', async () => {
    const r = await checkFileUploadRoundtrip(DOMAIN, jar, {
      appFetch: appFetchWith(),
      transfer: transferWith({
        preflight: vi.fn(async () => ({ status: 200, allowOrigin: 'https://evil.example' })),
      }),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/^cors: /);
  });

  it('fails when object storage rejects the PUT', async () => {
    const r = await checkFileUploadRoundtrip(DOMAIN, jar, {
      appFetch: appFetchWith(),
      transfer: transferWith({
        put: vi.fn(async () => ({ status: 403, body: 'SignatureDoesNotMatch' })),
      }),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/^upload: .*403: SignatureDoesNotMatch/);
  });

  it('fails when the read route answers without a redirect', async () => {
    const r = await checkFileUploadRoundtrip(DOMAIN, jar, {
      appFetch: appFetchWith({ read: () => new Response('Not Found', { status: 404 }) }),
      transfer: transferWith(),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/^read: .*404/);
  });

  it('fails when the downloaded bytes differ from the uploaded bytes', async () => {
    const r = await checkFileUploadRoundtrip(DOMAIN, jar, {
      appFetch: appFetchWith(),
      transfer: transferWith({
        get: vi.fn(async () => ({ status: 200, bytes: new Uint8Array([1, 2, 3]) })),
      }),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/^compare: downloaded 3 bytes/);
  });

  it('reports a thrown request as a failure, never throws', async () => {
    const appFetch = vi.fn(async () => {
      throw new Error('DNS resolution failed for app.example.com after retries');
    });
    const r = await checkFileUploadRoundtrip(DOMAIN, jar, { appFetch, transfer: transferWith() });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/^request: DNS resolution failed/);
  });

  describe('the bucket settle gate before the first upload', () => {
    const MIN = 60_000;
    const T0 = Date.parse('2026-10-20T12:00:00Z');
    const storage = (providerId: string, ageMs: number | null) => ({
      providerId,
      bucket: 'bucket',
      keyPrefix: 'prod/',
      region: providerId === 'hetzner' ? 'fsn1' : 'fra1',
      endpoint: STORAGE_ORIGIN,
      bucketCreatedAt: ageMs === null ? null : new Date(T0 - ageMs).toISOString(),
    });
    const settleDeps = (
      probeRound: () => Promise<{ ok: number; total: number; failures: string[] }>,
    ) => {
      let t = T0;
      return {
        now: () => t,
        sleep: vi.fn(async (ms: number) => {
          t += ms;
        }),
        probeRound: vi.fn(probeRound),
      };
    };

    it('a 0-window provider with a 1-minute-old bucket makes zero probes and never sleeps', async () => {
      const settle = settleDeps(async () => ({ ok: 20, total: 20, failures: [] }));
      const transfer = transferWith();
      const r = await checkFileUploadRoundtrip(DOMAIN, jar, {
        appFetch: appFetchWith(),
        transfer,
        storage: storage('digitalocean', MIN),
        settle,
      });
      expect(r.status).toBe('pass');
      expect(settle.probeRound).not.toHaveBeenCalled();
      expect(settle.sleep).not.toHaveBeenCalled();
      expect(transfer.put).toHaveBeenCalledOnce();
      expect(r.details).not.toHaveProperty('settle');
    });

    it('an old Hetzner bucket runs no gate', async () => {
      const settle = settleDeps(async () => ({ ok: 20, total: 20, failures: [] }));
      const r = await checkFileUploadRoundtrip(DOMAIN, jar, {
        appFetch: appFetchWith(),
        transfer: transferWith(),
        storage: storage('hetzner', 30 * MIN),
        settle,
      });
      expect(r.status).toBe('pass');
      expect(settle.probeRound).not.toHaveBeenCalled();
    });

    it('a young Hetzner bucket waits for the gate, then uploads, with rounds and seconds in the detail', async () => {
      const settle = settleDeps(async () => ({ ok: 20, total: 20, failures: [] }));
      const transfer = transferWith();
      const r = await checkFileUploadRoundtrip(DOMAIN, jar, {
        appFetch: appFetchWith(),
        transfer,
        storage: storage('hetzner', MIN),
        settle,
      });
      expect(r.status).toBe('pass');
      expect(settle.probeRound).toHaveBeenCalledTimes(3);
      expect(r.details).toMatchObject({ settle: { rounds: 3, elapsedSeconds: 60 } });
      const firstPut = (transfer.put as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(settle.probeRound.mock.invocationCallOrder[2]).toBeLessThan(firstPut);
    });

    it('an unknown Hetzner bucket age is treated as young', async () => {
      const settle = settleDeps(async () => ({ ok: 20, total: 20, failures: [] }));
      await checkFileUploadRoundtrip(DOMAIN, jar, {
        appFetch: appFetchWith(),
        transfer: transferWith(),
        storage: storage('hetzner', null),
        settle,
      });
      expect(settle.probeRound).toHaveBeenCalled();
    });

    it('an exhausted gate fails with the bucket, its age and the last failures, and uploads nothing', async () => {
      const settle = settleDeps(async () => ({
        ok: 19,
        total: 20,
        failures: ['options:403'],
      }));
      const transfer = transferWith();
      const r = await checkFileUploadRoundtrip(DOMAIN, jar, {
        appFetch: appFetchWith(),
        transfer,
        storage: storage('hetzner', MIN),
        settle,
      });
      expect(r.status).toBe('fail');
      expect(r.errorMessage).toMatch(/^settle: bucket "bucket" .*1 min old.*options:403/);
      expect(r.details).toMatchObject({ step: 'settle', lastFailures: ['options:403'] });
      expect(transfer.put).not.toHaveBeenCalled();
    });
  });

  it('ships a real PNG (signature + IHDR), not arbitrary bytes', () => {
    expect([...ONE_PIXEL_PNG.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(ONE_PIXEL_PNG.subarray(12, 16).toString('latin1')).toBe('IHDR');
  });
});

describe('assertObjectStorageUrl', () => {
  it('allows a provider object-storage host', () => {
    expect(() => assertObjectStorageUrl(PUT_URL, DOMAIN)).not.toThrow();
  });

  it('refuses the environment apex and its subdomains (those must stay on the pinned seam)', () => {
    expect(() => assertObjectStorageUrl(`https://${DOMAIN}/x`, DOMAIN)).toThrow(/dnsSafeFetch/);
    expect(() => assertObjectStorageUrl(`https://s3.${DOMAIN}/x`, DOMAIN)).toThrow(/dnsSafeFetch/);
  });
});

describe('presigned URL helpers', () => {
  it('reads the bucket from a path-style presigned URL', () => {
    expect(bucketOfPresignedUrl(PUT_URL)).toBe('bucket');
    expect(bucketOfPresignedUrl('https://nbg1.your-objectstorage.com/')).toBeNull();
  });

  it('reads the <Code> of an S3 XML error body', () => {
    expect(
      s3ErrorCode(
        '<?xml version="1.0"?><Error><Code>NoSuchBucket</Code><BucketName>b</BucketName></Error>',
      ),
    ).toBe('NoSuchBucket');
    expect(s3ErrorCode('')).toBeNull();
  });
});

describe('resolveAppStorage', () => {
  it('reads the env provider and s3 block from .vibecarbon.json, null when there is no bucket', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-app-storage-'));
    try {
      expect(resolveAppStorage(dir, 'e1')).toBeNull();
      writeFileSync(
        join(dir, '.vibecarbon.json'),
        JSON.stringify({
          environments: {
            e1: {
              provider: 'hetzner',
              s3: {
                bucket: 'myapp-storage',
                keyPrefix: 'e1/',
                region: 'fsn1',
                endpoint: 'https://fsn1.your-objectstorage.com',
                bucketCreatedAt: '2026-10-20T12:00:00.000Z',
              },
            },
            e2: { s3: { bucket: 'other', region: 'fsn1', endpoint: 'https://x' } },
          },
        }),
      );
      expect(resolveAppStorage(dir, 'e1')).toEqual({
        providerId: 'hetzner',
        bucket: 'myapp-storage',
        keyPrefix: 'e1/',
        region: 'fsn1',
        endpoint: 'https://fsn1.your-objectstorage.com',
        bucketCreatedAt: '2026-10-20T12:00:00.000Z',
      });
      expect(resolveAppStorage(dir, 'e2')).toMatchObject({
        providerId: 'hetzner',
        keyPrefix: '',
        bucketCreatedAt: null,
      });
      expect(resolveAppStorage(dir, 'e3')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
