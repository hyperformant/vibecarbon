/**
 * refreshLicense: the client for POST /api/v1/license/refresh.
 *
 * Modeled on tests/unit/telemetry/update-check.test.ts — an injected
 * fetchImpl, no real network — plus an ephemeral Ed25519 keypair so the
 * signature-verification branches (wrong signer, wrong project, wrong
 * customer, stale paidThrough) are exercised for real rather than mocked
 * away. mintV2Key/derivePublicKeyPem come from scripts/generate-license.js,
 * the same helpers storage.test.ts and generate-license.test.ts use, so
 * minting here can never drift from what validator.js actually checks.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { derivePublicKeyPem, mintV2Key } from '../../../scripts/generate-license.js';
import { activateLicense, getLicense } from '../../../src/lib/licensing/index.js';
import { refreshLicense } from '../../../src/lib/licensing/refresh.js';
import { VERSION } from '../../../src/lib/version.js';

const PROJECT_ID = '11111111-2222-3333-4444-555555555555';
const CUSTOMER_ID = 'a1b2c3d4';
const OTHER_CUSTOMER_ID = 'deadbeef';
const OTHER_PROJECT_ID = '99999999-8888-7777-6666-555555555555';

function ephemeralPrivateKeyPem() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

let projectDir: string;
let stateDir: string;
let privateKeyPem: string;
let publicKeyPem: string;
let licensePath: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'vc-refresh-project-'));
  stateDir = mkdtempSync(join(tmpdir(), 'vc-refresh-state-'));
  privateKeyPem = ephemeralPrivateKeyPem();
  publicKeyPem = derivePublicKeyPem(privateKeyPem);
  licensePath = join(projectDir, '.vibecarbon.license');

  writeFileSync(
    join(projectDir, '.vibecarbon.json'),
    `${JSON.stringify({ version: '1', projectId: PROJECT_ID, services: {} }, null, 2)}\n`,
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function mint(
  overrides: Partial<Parameters<typeof mintV2Key>[1]> = {},
  signingKey = privateKeyPem,
) {
  return mintV2Key(signingKey, {
    tier: 'graphene',
    customerId: CUSTOMER_ID,
    projectId: PROJECT_ID,
    paidThrough: '2026-06-01',
    ...overrides,
  });
}

/** Activate a genuine v2 key into the project slot as the starting state. */
function seedStoredKey(overrides: Partial<Parameters<typeof mintV2Key>[1]> = {}) {
  const key = mint(overrides);
  const result = activateLicense(key, { projectDir, stateDir, publicKeyPem });
  expect(result.success, result.error).toBe(true);
  return key;
}

function fileBytes() {
  return readFileSync(licensePath, 'utf-8');
}

function okFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('refreshLicense — no stored v2 key', () => {
  it('returns no-key and never calls fetchImpl when nothing is stored', async () => {
    const fetchImpl = okFetch({ key: 'irrelevant' });
    const result = await refreshLicense({ projectDir, stateDir, fetchImpl, publicKeyPem });
    expect(result).toEqual({ ok: false, reason: 'no-key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns no-key for a v1 (legacy) holder with no project-slot key', async () => {
    const legacyKey = `vc-f-${CUSTOMER_ID}-${'a'.repeat(128)}`;
    writeFileSync(
      join(stateDir, 'license'),
      JSON.stringify({ key: legacyKey, tier: 'fullerene', customerId: CUSTOMER_ID }),
    );
    const fetchImpl = okFetch({ key: 'irrelevant' });
    const result = await refreshLicense({ projectDir, stateDir, fetchImpl, publicKeyPem });
    expect(result).toEqual({ ok: false, reason: 'no-key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('refreshLicense — request shape', () => {
  it('pins the URL, method, headers, and body', async () => {
    const storedKey = seedStoredKey();
    const fetchImpl = okFetch({ key: mint({ paidThrough: '2027-01-01' }) });

    await refreshLicense({ projectDir, stateDir, fetchImpl, publicKeyPem, env: {} });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://vibecarbon.com/api/v1/license/refresh');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      key: storedKey,
      cliVersion: VERSION,
      releaseDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it('respects VIBECARBON_API_BASE, changing only the host', async () => {
    seedStoredKey();
    const fetchImpl = okFetch({ key: mint({ paidThrough: '2027-01-01' }) });

    await refreshLicense({
      projectDir,
      stateDir,
      fetchImpl,
      publicKeyPem,
      env: { VIBECARBON_API_BASE: 'http://localhost:4000' },
    });

    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:4000/api/v1/license/refresh');
  });
});

describe('refreshLicense — success', () => {
  it('stores a genuinely renewed key and reports the new paidThrough/tier', async () => {
    const oldKey = seedStoredKey({ tier: 'graphene', paidThrough: '2026-06-01' });
    const newKey = mint({ tier: 'fullerene', paidThrough: '2027-01-01' });
    const fetchImpl = okFetch({ key: newKey });

    const result = await refreshLicense({ projectDir, stateDir, fetchImpl, publicKeyPem });

    expect(result).toEqual({
      ok: true,
      updated: true,
      paidThrough: '2027-01-01',
      tier: 'fullerene',
    });

    const stored = getLicense({ projectDir, stateDir, publicKeyPem });
    expect(stored.paidThrough).toBe('2027-01-01');
    expect(stored.tier).toBe('fullerene');

    const onDisk = JSON.parse(fileBytes());
    expect(onDisk.key).toBe(newKey);
    expect(onDisk.key).not.toBe(oldKey);
    expect(onDisk.source).toBe('refresh');
  });

  it('accepts a paidThrough equal to the stored one (boundary, not strictly newer)', async () => {
    seedStoredKey({ paidThrough: '2026-06-01' });
    const sameDateKey = mint({ paidThrough: '2026-06-01' });
    const fetchImpl = okFetch({ key: sameDateKey });

    const result = await refreshLicense({ projectDir, stateDir, fetchImpl, publicKeyPem });

    expect(result.ok).toBe(true);
    expect(JSON.parse(fileBytes()).key).toBe(sameDateKey);
  });
});

describe('refreshLicense — a returned key that fails any check is rejected, and nothing is written', () => {
  it('older paidThrough than stored is ignored', async () => {
    seedStoredKey({ paidThrough: '2026-06-01' });
    const before = fileBytes();
    const olderKey = mint({ paidThrough: '2026-01-01' });
    const fetchImpl = okFetch({ key: olderKey });

    const result = await refreshLicense({ projectDir, stateDir, fetchImpl, publicKeyPem });

    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(fileBytes()).toBe(before);
  });

  it('a key for a different project is ignored', async () => {
    seedStoredKey();
    const before = fileBytes();
    const wrongProjectKey = mint({ projectId: OTHER_PROJECT_ID, paidThrough: '2027-01-01' });
    const fetchImpl = okFetch({ key: wrongProjectKey });

    const result = await refreshLicense({ projectDir, stateDir, fetchImpl, publicKeyPem });

    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(fileBytes()).toBe(before);
  });

  it('a key for a different customer is ignored', async () => {
    seedStoredKey();
    const before = fileBytes();
    const wrongCustomerKey = mint({ customerId: OTHER_CUSTOMER_ID, paidThrough: '2027-01-01' });
    const fetchImpl = okFetch({ key: wrongCustomerKey });

    const result = await refreshLicense({ projectDir, stateDir, fetchImpl, publicKeyPem });

    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(fileBytes()).toBe(before);
  });

  it('a key signed by a different private key is rejected (bad signature)', async () => {
    seedStoredKey();
    const before = fileBytes();
    const otherSignerKey = mint({ paidThrough: '2027-01-01' }, ephemeralPrivateKeyPem());
    const fetchImpl = okFetch({ key: otherSignerKey });

    const result = await refreshLicense({ projectDir, stateDir, fetchImpl, publicKeyPem });

    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(fileBytes()).toBe(before);
  });

  it('a malformed / missing key field in the 200 response is rejected', async () => {
    seedStoredKey();
    const before = fileBytes();
    const fetchImpl = okFetch({ nope: true });

    const result = await refreshLicense({ projectDir, stateDir, fetchImpl, publicKeyPem });

    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(fileBytes()).toBe(before);
  });
});

describe('refreshLicense — server status mapping', () => {
  it('402 maps to not-renewed and writes nothing', async () => {
    seedStoredKey();
    const before = fileBytes();
    const fetchImpl = okFetch({ error: 'subscription_inactive', paidThrough: '2026-06-01' }, 402);

    const result = await refreshLicense({ projectDir, stateDir, fetchImpl, publicKeyPem });

    expect(result).toEqual({ ok: false, reason: 'not-renewed' });
    expect(fileBytes()).toBe(before);
  });

  it('404 maps to not-found and writes nothing', async () => {
    seedStoredKey();
    const before = fileBytes();
    const fetchImpl = okFetch({ error: 'not_found' }, 404);

    const result = await refreshLicense({ projectDir, stateDir, fetchImpl, publicKeyPem });

    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(fileBytes()).toBe(before);
  });

  it('a network error maps to offline and writes nothing', async () => {
    seedStoredKey();
    const before = fileBytes();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await refreshLicense({ projectDir, stateDir, fetchImpl, publicKeyPem });

    expect(result).toEqual({ ok: false, reason: 'offline' });
    expect(fileBytes()).toBe(before);
  });

  it('a timeout (abort) maps to offline and writes nothing', async () => {
    seedStoredKey();
    const before = fileBytes();
    const abortError = new DOMException('The operation timed out.', 'TimeoutError');
    const fetchImpl = vi.fn().mockRejectedValue(abortError);

    const result = await refreshLicense({
      projectDir,
      stateDir,
      fetchImpl,
      publicKeyPem,
      timeoutMs: 5,
    });

    expect(result).toEqual({ ok: false, reason: 'offline' });
    expect(fileBytes()).toBe(before);
  });

  it('non-JSON 200 body maps to offline and writes nothing', async () => {
    seedStoredKey();
    const before = fileBytes();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));

    const result = await refreshLicense({ projectDir, stateDir, fetchImpl, publicKeyPem });

    expect(result).toEqual({ ok: false, reason: 'offline' });
    expect(fileBytes()).toBe(before);
  });

  it('an unexpected non-ok status (e.g. 400/401/500) maps to invalid, not offline', async () => {
    seedStoredKey();
    const before = fileBytes();
    for (const status of [400, 401, 500]) {
      const fetchImpl = okFetch({ error: 'nope' }, status);
      const result = await refreshLicense({ projectDir, stateDir, fetchImpl, publicKeyPem });
      expect(result, `status ${status}`).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(fileBytes()).toBe(before);
  });
});

describe('refreshLicense — never throws', () => {
  it('a synchronously-throwing fetchImpl resolves to offline instead of throwing', async () => {
    seedStoredKey();
    const before = fileBytes();
    const fetchImpl = vi.fn(() => {
      throw new Error('boom');
    });

    await expect(
      refreshLicense({ projectDir, stateDir, fetchImpl, publicKeyPem }),
    ).resolves.toEqual({ ok: false, reason: 'offline' });
    expect(fileBytes()).toBe(before);
  });
});
