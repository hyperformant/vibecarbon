import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { derivePublicKeyPem } from '../../../scripts/generate-license.js';
import { bindLicense, requestRelease } from '../../../src/lib/licensing/bind.js';
import { checkLicense } from '../../../src/lib/licensing/check.js';
import { signingKeyOrNull, startLicenseStub } from '../../e2e/utils/license-stub.js';

const { privateKey } = generateKeyPairSync('ed25519');
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUB = derivePublicKeyPem(PEM);
const PID = '11111111-1111-4111-8111-111111111111';
const PID2 = '22222222-2222-4222-8222-222222222222';

let stub: Awaited<ReturnType<typeof startLicenseStub>>;
let stateDir: string;
beforeEach(async () => {
  stub = await startLicenseStub({ privateKeyPem: PEM });
  stateDir = mkdtempSync(join(tmpdir(), 'vc-state-'));
});
afterEach(async () => {
  await stub.close();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('license stub', () => {
  it('serves signed verdicts the real client verifies', async () => {
    const { key, licenseId } = stub.mintKey();
    stub.seed({ licenseId, projectId: PID, tier: 'graphene', periodEndYmd: '2026-12-31' });
    const r = await checkLicense({
      key,
      projectId: PID,
      stateDir,
      env: { VIBECARBON_API_BASE: stub.baseUrl },
      publicKeyPem: PUB,
    });
    expect(r.source).toBe('live');
    expect(r.verdict).toMatchObject({ status: 'active', tier: 'graphene', projectId: PID });
  });
  it('answers unbound and wrong_project', async () => {
    const { key, licenseId } = stub.mintKey();
    stub.seed({ licenseId, projectId: null, periodEndYmd: '2026-12-31' });
    expect(
      (
        await checkLicense({
          key,
          projectId: PID,
          stateDir,
          env: { VIBECARBON_API_BASE: stub.baseUrl },
          publicKeyPem: PUB,
        })
      ).verdict?.status,
    ).toBe('unbound');
    stub.seed({ licenseId, projectId: PID2, periodEndYmd: '2026-12-31' });
    expect(
      (
        await checkLicense({
          key,
          projectId: PID,
          stateDir,
          env: { VIBECARBON_API_BASE: stub.baseUrl },
          publicKeyPem: PUB,
        })
      ).verdict?.status,
    ).toBe('wrong_project');
  });
  it('binds, refuses a second project, releases', async () => {
    const { key, licenseId } = stub.mintKey();
    stub.seed({ licenseId, periodEndYmd: '2026-12-31' });
    const env = { VIBECARBON_API_BASE: stub.baseUrl };
    expect((await bindLicense({ key, projectId: PID, env })).ok).toBe(true);
    expect((await bindLicense({ key, projectId: PID, env })).ok).toBe(true);
    expect(await bindLicense({ key, projectId: PID2, env })).toMatchObject({
      ok: false,
      reason: 'bound_to_other_project',
    });
    expect(await requestRelease({ key, env })).toEqual({ ok: true });
    expect(stub.state.get(licenseId)?.projectId).toBeNull();
    expect(stub.calls.map((c) => c.path)).toEqual([
      '/api/v1/license/bind',
      '/api/v1/license/bind',
      '/api/v1/license/bind',
      '/api/v1/license/release',
    ]);
  });
  it('401s an unknown key', async () => {
    const { key } = stub.mintKey();
    expect(
      await bindLicense({ key, projectId: PID, env: { VIBECARBON_API_BASE: stub.baseUrl } }),
    ).toMatchObject({ ok: false, reason: 'unknown_key' });
  });
});

describe('seed validation', () => {
  // A typo'd status would otherwise only surface as a signVerdictToken throw
  // inside the request handler — i.e. a hung fetch, not a failed seed.
  it('rejects a status no subscription row can hold', () => {
    const { licenseId } = stub.mintKey();
    expect(() => stub.seed({ licenseId, status: 'bogus', periodEndYmd: '2026-12-31' })).toThrow(
      "seed: unknown status 'bogus'",
    );
    // Verdict-only vocabulary is derived by /check, never seeded.
    expect(() => stub.seed({ licenseId, status: 'unbound', periodEndYmd: '2026-12-31' })).toThrow(
      "seed: unknown status 'unbound'",
    );
  });

  it('rejects a tier no subscription row can hold', () => {
    const { licenseId } = stub.mintKey();
    expect(() => stub.seed({ licenseId, tier: 'none', periodEndYmd: '2026-12-31' })).toThrow(
      "seed: unknown tier 'none'",
    );
  });
});

describe('signingKeyOrNull', () => {
  // Always a PLAIN OBJECT env, never process.env: the point of these cases is
  // what the passed env looks like AFTER the call.
  const PEM_IN_FILE = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-envfile-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an env value as-is without reading the file', () => {
    const env = { VIBECARBON_LICENSE_PRIVATE_KEY: 'from-env' } as NodeJS.ProcessEnv;
    // Nonexistent path: a read would be the only way this could differ.
    expect(signingKeyOrNull(env, join(dir, 'does-not-exist'))).toBe('from-env');
  });

  it('treats a present-but-empty value as absent and falls back to the file', () => {
    // An unset GitHub secret renders as exactly this.
    const file = join(dir, '.env.e2e');
    writeFileSync(file, `VIBECARBON_LICENSE_PRIVATE_KEY='${PEM_IN_FILE}'\n`);
    const env = { VIBECARBON_LICENSE_PRIVATE_KEY: '' } as NodeJS.ProcessEnv;
    // Multi-line, so this also proves the single-quoted dotenv round-trip.
    expect(signingKeyOrNull(env, file)).toBe(PEM_IN_FILE);
  });

  it('returns null when neither the env nor a file supplies one', () => {
    expect(signingKeyOrNull({} as NodeJS.ProcessEnv, join(dir, 'does-not-exist'))).toBeNull();
  });

  it('reads the one key it was asked for, side-loading nothing else from the file', () => {
    // tests/.env.e2e is the operator's CREDENTIAL file. Loading it into the
    // caller's env would hand every provider token in it to whatever that
    // process later spawns — the signing key is the only thing asked for.
    const file = join(dir, '.env.e2e');
    writeFileSync(
      file,
      `HETZNER_API_TOKEN='live'\nVIBECARBON_LICENSE_PRIVATE_KEY='${PEM_IN_FILE}'\n`,
    );
    const env = {} as NodeJS.ProcessEnv;
    expect(signingKeyOrNull(env, file)).toBe(PEM_IN_FILE);
    expect(Object.keys(env)).not.toContain('HETZNER_API_TOKEN');
    expect(env).toEqual({});
  });
});
