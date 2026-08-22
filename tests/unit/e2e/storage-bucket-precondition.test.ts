/**
 * The storage checks must CREATE their precondition, not skip on it.
 *
 * `storage_upload` / `storage_download` / `storage_delete` skipped as
 * "test-bucket does not exist — skipped" in verify-deploy, verify-restore AND
 * verify-failover, on every provider, in every run — because nothing ever
 * created the bucket. Every green lifecycle record was therefore green with
 * the Storage path entirely unexercised (2026-08-20 vultr and scaleway
 * compose-HA passes both read "30 passed, 0 failed, 4 skipped").
 *
 * A skipped precondition is not a pass, but it reads like one in a summary
 * that only counts failures. These tests pin the shape that fixes it.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../e2e/checks/health.js', () => ({
  dnsSafeFetch: fetchMock,
  resolveCheckIp: vi.fn(async () => null),
}));

const { ensureTestBucket } = await import('../../e2e/checks/app-functional.js');

const res = (status: number, body = '') =>
  ({ ok: status >= 200 && status < 300, status, text: async () => body }) as Response;

afterEach(() => fetchMock.mockReset());

describe('ensureTestBucket', () => {
  it('creates a PUBLIC bucket named test-bucket via the storage admin API', async () => {
    fetchMock.mockResolvedValueOnce(res(200));

    expect(await ensureTestBucket('example.com', 'svc-key')).toBeNull();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/storage/v1/bucket');
    expect(init.method).toBe('POST');
    // public: the download check reads back through /object/public/.
    expect(JSON.parse(init.body)).toMatchObject({ name: 'test-bucket', public: true });
    // Service-role creds — bucket creation is an admin operation.
    expect(init.headers.Authorization).toBe('Bearer svc-key');
    expect(init.headers.apikey).toBe('svc-key');
  });

  it('is idempotent — an already-existing bucket is success, by status OR wording', async () => {
    // Runs it three times: verify-deploy, verify-restore, verify-failover. Only
    // the first can create it, and the later two must not report a failure.
    fetchMock.mockResolvedValueOnce(res(409, 'Duplicate'));
    expect(await ensureTestBucket('example.com', 'k')).toBeNull();

    // The wording has moved across Supabase versions, so the text is matched
    // independently of the status.
    fetchMock.mockResolvedValueOnce(res(400, 'The resource already exists'));
    expect(await ensureTestBucket('example.com', 'k')).toBeNull();
  });

  it('reports a real failure instead of swallowing it', async () => {
    fetchMock.mockResolvedValueOnce(res(500, 'internal error'));
    const err = await ensureTestBucket('example.com', 'k');
    expect(err).toMatch(/500/);
    expect(err).toMatch(/internal error/);
  });

  it('reports a thrown transport error rather than escaping', async () => {
    // Every check in this file is fault-tolerant by contract — it must never
    // throw into the verification loop.
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(ensureTestBucket('example.com', 'k')).resolves.toMatch(/ECONNRESET/);
  });
});

describe('storage operations address the right Storage paths', () => {
  // Second bug, revealed by fixing the first. The check used the PUBLIC read
  // path for upload and delete as well as download, which the Storage REST
  // contract does not accept — Supabase's own troubleshooting note says a
  // public bucket only means a public DOWNLOAD url exists and "you should use
  // the normal path for all other operations". It was invisible while the
  // bucket was missing: the not-found branch fired before the wrong path
  // could matter. CI l2 2026-08-20, first run with a real bucket:
  //   storage_bucket_ensure PASS, storage_upload FAIL "Bucket not found"
  //
  // Scoped to runStorageChecks' own body — the file has POST/GET calls for
  // auth and the app API too, and a whole-file search matches those first.
  const storageBody = () => {
    const src = readFileSync(new URL('../../e2e/checks/app-functional.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Comment-ONLY lines. A naive /\/\/.*$/ stripper also eats the `//`
      // inside `https://...`, which silently deleted the very URLs under test.
      .replace(/^\s*\/\/.*$/gm, '');
    const from = src.indexOf('async function runStorageChecks');
    expect(from, 'runStorageChecks not found').toBeGreaterThan(-1);
    const next = src.indexOf('async function ', from + 10);
    return src.slice(from, next === -1 ? undefined : next);
  };

  const callUrlFor = (body: string, method: string) => {
    const idx = body.indexOf(`method: '${method}'`);
    expect(idx, `no ${method} call in runStorageChecks`).toBeGreaterThan(-1);
    const window = body.slice(Math.max(0, idx - 300), idx);
    const m = window.match(/safeFetch\((\w+)/g);
    return m ? m[m.length - 1].replace('safeFetch(', '') : null;
  };

  it('builds a separate object url and public read url', () => {
    const body = storageBody();
    expect(body).toContain('/storage/v1/object/test-bucket/');
    expect(body).toContain('/storage/v1/object/public/test-bucket/');
  });

  it('uploads through the OBJECT url, not the public one', () => {
    expect(callUrlFor(storageBody(), 'POST')).toBe('objectUrl');
  });

  it('deletes through the OBJECT url, not the public one', () => {
    expect(callUrlFor(storageBody(), 'DELETE')).toBe('objectUrl');
  });

  it('downloads through the PUBLIC url — that leg proves the bucket is public', () => {
    expect(callUrlFor(storageBody(), 'GET')).toBe('publicUrl');
  });

  it('no single baseUrl is reused across all three operations again', () => {
    expect(storageBody()).not.toContain('const baseUrl');
  });
});

describe('the silent bucket-missing skip does not come back', () => {
  const src = () =>
    readFileSync(new URL('../../e2e/checks/app-functional.ts', import.meta.url), 'utf8');

  it('no longer skips the storage checks because the bucket is absent', () => {
    const code = src()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/skip\('storage_upload', 'test-bucket does not exist/);
  });

  it('still has the ensure wired into the storage checks', () => {
    const code = src()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/await ensureTestBucket\(domain, serviceRoleKey\)/);
    expect(code).toMatch(/storage_bucket_ensure/);
  });
});
