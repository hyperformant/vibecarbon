/**
 * checkLicense: the live HTTP call to vibecarbon.com plus the signed
 * per-machine verdict cache it falls back to when the server cannot be
 * reached. Modeled on signature-verification.test.ts / generate-license.test.ts
 * for the ephemeral keypair pattern.
 */

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { derivePublicKeyPem, signVerdictToken } from '../../../scripts/generate-license.js';
import { cachePathFor, checkLicense, readCachedVerdict } from '../../../src/lib/licensing/check.js';

function ephemeralPrivateKeyPem() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

const PROJECT_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_PROJECT_ID = '99999999-8888-7777-6666-555555555555';

/** Fields for an active graphene verdict, tweak per test. */
function verdictFields(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    status: 'active',
    tier: 'graphene',
    periodEnd: '2026-12-31',
    issued: '2026-09-14',
    ...overrides,
  };
}

/** A fetchImpl stub that resolves like the real fetch Response shape used here. */
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** A fetchImpl stub for a non-JSON (e.g. WAF/proxy) error body. */
function htmlResponse(status, html = '<html><body>blocked</body></html>') {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error('not json');
    },
    text: async () => html,
  };
}

describe('checkLicense', () => {
  let privateKeyPem: string;
  let publicKeyPem: string;
  let stateDir: string;

  beforeEach(() => {
    privateKeyPem = ephemeralPrivateKeyPem();
    publicKeyPem = derivePublicKeyPem(privateKeyPem);
    stateDir = mkdtempSync(join(tmpdir(), 'vibecarbon-check-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('1. 200 with a valid token for this project returns live and caches it at 0600', async () => {
    const token = signVerdictToken(privateKeyPem, verdictFields());
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { token }));

    const result = await checkLicense({
      key: 'vc2-a1b2c3d4-11111111222233334444555555555555-sig',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl,
      publicKeyPem,
    });

    expect(result.source).toBe('live');
    expect(result.verdict).toMatchObject({ status: 'active', tier: 'graphene' });

    const path = cachePathFor(stateDir, PROJECT_ID);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    expect(stored.token).toBe(token);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('2. 200 whose token verifies but names another project is rejected and writes nothing', async () => {
    const token = signVerdictToken(privateKeyPem, verdictFields({ projectId: OTHER_PROJECT_ID }));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { token }));

    const result = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl,
      publicKeyPem,
    });

    expect(result).toEqual({ source: 'rejected', verdict: null });
    expect(readCachedVerdict({ stateDir, projectId: PROJECT_ID, publicKeyPem })).toBeNull();
  });

  it('3. 200 whose token fails signature is rejected and writes nothing', async () => {
    const otherPrivateKeyPem = ephemeralPrivateKeyPem();
    const token = signVerdictToken(otherPrivateKeyPem, verdictFields());
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { token }));

    const result = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl,
      publicKeyPem,
    });

    expect(result).toEqual({ source: 'rejected', verdict: null });
    expect(readCachedVerdict({ stateDir, projectId: PROJECT_ID, publicKeyPem })).toBeNull();
  });

  it('4. 200 with cancelAtPeriodEnd true carries and caches it', async () => {
    const token = signVerdictToken(privateKeyPem, verdictFields());
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { token, cancelAtPeriodEnd: true }));

    const result = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl,
      publicKeyPem,
    });

    expect(result.source).toBe('live');
    expect(result.cancelAtPeriodEnd).toBe(true);

    const cached = readCachedVerdict({ stateDir, projectId: PROJECT_ID, publicKeyPem });
    expect(cached?.cancelAtPeriodEnd).toBe(true);
  });

  it('5. 401 with the app error shape is rejected, writes nothing, and leaves an existing cache untouched', async () => {
    const goodToken = signVerdictToken(privateKeyPem, verdictFields());
    const goodFetch = vi.fn().mockResolvedValue(jsonResponse(200, { token: goodToken }));
    await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl: goodFetch,
      publicKeyPem,
    });
    const before = readFileSync(cachePathFor(stateDir, PROJECT_ID), 'utf8');

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'bad_signature' }));
    const result = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl,
      publicKeyPem,
    });

    expect(result).toEqual({ source: 'rejected', verdict: null });
    const after = readFileSync(cachePathFor(stateDir, PROJECT_ID), 'utf8');
    expect(after).toBe(before);
  });

  it('5b. 404 with { error: "not_found" } is rejected', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { error: 'not_found' }));
    const result = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl,
      publicKeyPem,
    });

    expect(result).toEqual({ source: 'rejected', verdict: null });
  });

  it('5c. 400 with an empty body (no error field) is unreachable, not rejected', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, {}));
    const result = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl,
      publicKeyPem,
    });

    expect(result.source).toBe('none');
    expect(result.verdict).toBeNull();
    expect(result.unreachable).toBe('HTTP 400');
  });

  it('5d. 403 with an HTML body falls back to a valid cache, and is unreachable without one', async () => {
    const token = signVerdictToken(privateKeyPem, verdictFields());
    const seedFetch = vi.fn().mockResolvedValue(jsonResponse(200, { token }));
    await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl: seedFetch,
      publicKeyPem,
    });

    const cachedResult = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl: vi.fn().mockResolvedValue(htmlResponse(403)),
      publicKeyPem,
    });
    expect(cachedResult.source).toBe('cache');
    expect(cachedResult.verdict).toMatchObject({ status: 'active', tier: 'graphene' });

    const otherStateDir = mkdtempSync(join(tmpdir(), 'vibecarbon-check-'));
    const noCacheResult = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir: otherStateDir,
      fetchImpl: vi.fn().mockResolvedValue(htmlResponse(403)),
      publicKeyPem,
    });
    expect(noCacheResult.source).toBe('none');
    expect(noCacheResult.verdict).toBeNull();
    expect(noCacheResult.unreachable).toBe('HTTP 403');
  });

  it('5e. 404 with an HTML body is unreachable, not rejected', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse(404));
    const result = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl,
      publicKeyPem,
    });

    expect(result.source).toBe('none');
    expect(result.verdict).toBeNull();
    expect(result.unreachable).toBe('HTTP 404');
  });

  it('5f. 503 with a JSON error body is still unreachable, not rejected: falls back to cache when present', async () => {
    const token = signVerdictToken(privateKeyPem, verdictFields());
    const seedFetch = vi.fn().mockResolvedValue(jsonResponse(200, { token }));
    await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl: seedFetch,
      publicKeyPem,
    });

    const result = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(503, { error: 'internal' })),
      publicKeyPem,
    });

    expect(result.source).toBe('cache');
    expect(result.verdict).toMatchObject({ status: 'active', tier: 'graphene' });
  });

  it('5g. 503 with a JSON error body, no cache: none, nothing cached', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, { error: 'internal' }));
    const result = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl,
      publicKeyPem,
    });

    expect(result).toEqual({ source: 'none', verdict: null, unreachable: 'HTTP 503' });
    expect(existsSync(cachePathFor(stateDir, PROJECT_ID))).toBe(false);
  });

  it('5h. 429 with a JSON error body is still unreachable, not rejected: falls back to cache when present, else none, nothing cached', async () => {
    const token = signVerdictToken(privateKeyPem, verdictFields());
    const seedFetch = vi.fn().mockResolvedValue(jsonResponse(200, { token }));
    await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl: seedFetch,
      publicKeyPem,
    });

    const cachedResult = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(429, { error: 'rate_limited' })),
      publicKeyPem,
    });
    expect(cachedResult.source).toBe('cache');
    expect(cachedResult.verdict).toMatchObject({ status: 'active', tier: 'graphene' });

    const otherStateDir = mkdtempSync(join(tmpdir(), 'vibecarbon-check-'));
    const noCacheResult = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir: otherStateDir,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(429, { error: 'rate_limited' })),
      publicKeyPem,
    });
    expect(noCacheResult).toEqual({ source: 'none', verdict: null, unreachable: 'HTTP 429' });
    expect(existsSync(cachePathFor(otherStateDir, PROJECT_ID))).toBe(false);
  });

  describe('6. transient failures fall back to cache when present, else unreachable/none', () => {
    const cases: Array<{ name: string; fetchImpl: () => unknown; unreachable: string }> = [
      {
        name: '429',
        fetchImpl: () => vi.fn().mockResolvedValue(jsonResponse(429, {})),
        unreachable: 'HTTP 429',
      },
      {
        name: '500',
        fetchImpl: () => vi.fn().mockResolvedValue(jsonResponse(500, {})),
        unreachable: 'HTTP 500',
      },
      {
        name: '503',
        fetchImpl: () => vi.fn().mockResolvedValue(jsonResponse(503, {})),
        unreachable: 'HTTP 503',
      },
      {
        name: 'network throw',
        fetchImpl: () =>
          vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })),
        unreachable: 'ECONNREFUSED',
      },
      {
        name: 'AbortError (timeout)',
        fetchImpl: () =>
          vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
        unreachable: 'timeout',
      },
    ];

    for (const { name, fetchImpl: makeFetch, unreachable } of cases) {
      it(`${name}: with a valid cache returns cache`, async () => {
        const token = signVerdictToken(privateKeyPem, verdictFields());
        const seedFetch = vi.fn().mockResolvedValue(jsonResponse(200, { token }));
        await checkLicense({
          key: 'vc2-key',
          projectId: PROJECT_ID,
          stateDir,
          fetchImpl: seedFetch,
          publicKeyPem,
        });

        const result = await checkLicense({
          key: 'vc2-key',
          projectId: PROJECT_ID,
          stateDir,
          fetchImpl: makeFetch(),
          publicKeyPem,
        });

        expect(result.source).toBe('cache');
        expect(result.verdict).toMatchObject({ status: 'active', tier: 'graphene' });
      });

      it(`${name}: without a cache returns none with unreachable ${unreachable}`, async () => {
        const result = await checkLicense({
          key: 'vc2-key',
          projectId: PROJECT_ID,
          stateDir,
          fetchImpl: makeFetch(),
          publicKeyPem,
        });

        expect(result.source).toBe('none');
        expect(result.verdict).toBeNull();
        expect(result.unreachable).toBe(unreachable);
      });
    }
  });

  it('7. a cache file whose token was edited (status flipped) is ignored when offline', async () => {
    const token = signVerdictToken(privateKeyPem, verdictFields());
    const seedFetch = vi.fn().mockResolvedValue(jsonResponse(200, { token }));
    await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl: seedFetch,
      publicKeyPem,
    });

    const path = cachePathFor(stateDir, PROJECT_ID);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    // Flip the status by hand inside the token string - this breaks the signature.
    stored.token = stored.token.replace('-active-', '-canceled-');
    writeFileSync(path, JSON.stringify(stored));

    const offlineFetch = vi.fn().mockRejectedValue(new Error('offline'));
    const result = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl: offlineFetch,
      publicKeyPem,
    });

    expect(result.source).toBe('none');
    expect(result.verdict).toBeNull();
  });

  it('8. a cache file for another project id (copied by hand) is ignored', async () => {
    const token = signVerdictToken(privateKeyPem, verdictFields({ projectId: OTHER_PROJECT_ID }));
    const path = cachePathFor(stateDir, PROJECT_ID);
    const dir = join(path, '..');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      JSON.stringify({ token, checkedAt: new Date().toISOString(), cancelAtPeriodEnd: false }),
      {
        mode: 0o600,
      },
    );

    const offlineFetch = vi.fn().mockRejectedValue(new Error('offline'));
    const result = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl: offlineFetch,
      publicKeyPem,
    });

    expect(result.source).toBe('none');
    expect(result.verdict).toBeNull();
  });

  it('9. calls fetchImpl with the expected URL, method, body, and an AbortSignal', async () => {
    const token = signVerdictToken(privateKeyPem, verdictFields());
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { token }));

    await checkLicense({
      key: 'vc2-a1b2c3d4-xyz',
      projectId: PROJECT_ID,
      stateDir,
      env: {},
      fetchImpl,
      publicKeyPem,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://vibecarbon.com/api/v1/license/check');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(typeof body.cliVersion).toBe('string');
    expect(body).toEqual({
      key: 'vc2-a1b2c3d4-xyz',
      projectId: PROJECT_ID.toLowerCase(),
      cliVersion: body.cliVersion,
    });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('honors env.VIBECARBON_API_BASE for the host', async () => {
    const token = signVerdictToken(privateKeyPem, verdictFields());
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { token }));

    await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      env: { VIBECARBON_API_BASE: 'http://localhost:9999' },
      fetchImpl,
      publicKeyPem,
    });

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:9999/api/v1/license/check');
  });

  it('10. never throws: a non-JSON 200 resolves none/bad-json (cache consulted first)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    });

    const result = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir,
      fetchImpl,
      publicKeyPem,
    });

    expect(result.source).toBe('none');
    expect(result.unreachable).toBe('bad-json');
  });

  it('a read-only state dir does not turn a good live verdict into a failure', async () => {
    const token = signVerdictToken(privateKeyPem, verdictFields());
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { token }));
    // Point stateDir at a plain file, so mkdirSync(join(path, 'license-checks'))
    // fails with ENOTDIR instead of succeeding.
    const brokenStateDir = join(stateDir, 'not-a-dir');
    writeFileSync(brokenStateDir, 'not a directory');

    const result = await checkLicense({
      key: 'vc2-key',
      projectId: PROJECT_ID,
      stateDir: brokenStateDir,
      fetchImpl,
      publicKeyPem,
    });

    expect(result.source).toBe('live');
    expect(result.verdict).toMatchObject({ status: 'active', tier: 'graphene' });
  });
});
