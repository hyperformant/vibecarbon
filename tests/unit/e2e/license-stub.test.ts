import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { derivePublicKeyPem } from '../../../scripts/generate-license.js';
import { bindLicense, requestRelease } from '../../../src/lib/licensing/bind.js';
import { checkLicense } from '../../../src/lib/licensing/check.js';
import { startLicenseStub } from '../../e2e/utils/license-stub.js';

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
