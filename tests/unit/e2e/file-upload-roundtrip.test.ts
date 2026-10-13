/**
 * The e2e `file_upload_roundtrip` check: presign through the app, PUT the bytes
 * to object storage, read them back through the app's 302, compare. These pin
 * the check's own logic with fakes; the live round-trip only runs on real infra.
 */
import { describe, expect, it, vi } from 'vitest';
import { checkFileUploadRoundtrip, ONE_PIXEL_PNG } from '../../e2e/checks/app-functional.js';
import {
  assertObjectStorageUrl,
  type PresignedTransfer,
} from '../../e2e/utils/presigned-transfer.js';

const DOMAIN = 'app.example.com';
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

function appFetchWith({
  presign = () => presignResponse(),
  read = () => new Response('', { status: 302, headers: { location: GET_URL } }),
}: {
  presign?: () => Response;
  read?: () => Response;
} = {}) {
  return vi.fn(async (url: string) => (url.endsWith('/api/v1/files/presign') ? presign() : read()));
}

function transferWith(overrides: Partial<PresignedTransfer> = {}): PresignedTransfer {
  return {
    put: vi.fn(async () => ({ status: 200, body: '' })),
    get: vi.fn(async () => ({ status: 200, bytes: new Uint8Array(ONE_PIXEL_PNG) })),
    ...overrides,
  };
}

describe('checkFileUploadRoundtrip', () => {
  it('passes when the bytes read back through the app equal the bytes uploaded', async () => {
    const appFetch = appFetchWith();
    const transfer = transferWith();
    const r = await checkFileUploadRoundtrip(DOMAIN, 'jwt', { appFetch, transfer });

    expect(r).toMatchObject({ checkName: 'file_upload_roundtrip', status: 'pass' });
    // Presign as the signed-in user, for a 1x1 png avatar of the exact size.
    const [presignUrl, presignInit] = appFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(presignUrl).toBe(`https://${DOMAIN}/api/v1/files/presign`);
    expect(presignInit.method).toBe('POST');
    expect((presignInit.headers as Record<string, string>).Authorization).toBe('Bearer jwt');
    expect(JSON.parse(presignInit.body as string)).toEqual({
      kind: 'avatar',
      contentType: 'image/png',
      size: ONE_PIXEL_PNG.length,
    });
    // PUT goes to the presigned URL with the signed headers; the read goes
    // through the app and the redirect target is what gets downloaded.
    expect(transfer.put).toHaveBeenCalledWith(PUT_URL, expect.any(Object), expect.any(Uint8Array));
    expect(appFetch.mock.calls[1][0]).toBe(`https://${DOMAIN}/api/files/${KEY}`);
    expect(transfer.get).toHaveBeenCalledWith(GET_URL);
  });

  it('fails on a presign refusal, naming the step and status (storage not configured)', async () => {
    const appFetch = appFetchWith({
      presign: () => new Response('{"error":"storage_not_configured"}', { status: 503 }),
    });
    const transfer = transferWith();
    const r = await checkFileUploadRoundtrip(DOMAIN, 'jwt', { appFetch, transfer });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/^presign: .*503.*storage_not_configured/);
    expect(transfer.put).not.toHaveBeenCalled();
  });

  it('fails on a presign 200 with the wrong shape', async () => {
    const r = await checkFileUploadRoundtrip(DOMAIN, 'jwt', {
      appFetch: appFetchWith({ presign: () => presignResponse({ url: undefined }) }),
      transfer: transferWith(),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/^presign: 200 but unexpected shape/);
  });

  it('fails when object storage rejects the PUT', async () => {
    const r = await checkFileUploadRoundtrip(DOMAIN, 'jwt', {
      appFetch: appFetchWith(),
      transfer: transferWith({
        put: vi.fn(async () => ({ status: 403, body: 'SignatureDoesNotMatch' })),
      }),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/^upload: .*403: SignatureDoesNotMatch/);
  });

  it('fails when the read route answers without a redirect', async () => {
    const r = await checkFileUploadRoundtrip(DOMAIN, 'jwt', {
      appFetch: appFetchWith({ read: () => new Response('Not Found', { status: 404 }) }),
      transfer: transferWith(),
    });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/^read: .*404/);
  });

  it('fails when the downloaded bytes differ from the uploaded bytes', async () => {
    const r = await checkFileUploadRoundtrip(DOMAIN, 'jwt', {
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
    const r = await checkFileUploadRoundtrip(DOMAIN, 'jwt', { appFetch, transfer: transferWith() });
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/^request: DNS resolution failed/);
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
