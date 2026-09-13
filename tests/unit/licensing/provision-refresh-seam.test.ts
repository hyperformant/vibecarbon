/**
 * The refresh seam inside requireProvisionEntitlement (src/lib/licensing/
 * index.js's resolveVerdict): when a provisioning refusal is 'lapsed' or
 * 'tier-too-low' on a v2 key, it asks vibecarbon.com for a renewed key
 * (refreshLicense) before printing the upsell, and re-evaluates against
 * whatever ends up on disk.
 *
 * This exercises the REAL refreshLicense / activateLicense / getLicense /
 * evaluateEntitlement pipeline against an ephemeral Ed25519 keypair (via the
 * `publicKeyPem` injection every one of those functions already supports),
 * with only the network call (`fetchImpl`) stubbed — no module mocking
 * needed. paidThrough dates are chosen far in the past/future so the
 * verdict doesn't depend on when this test happens to run.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { derivePublicKeyPem, mintV2Key } from '../../../scripts/generate-license.js';
import { activateLicense, requireProvisionEntitlement } from '../../../src/lib/licensing/index.js';

const PROJECT_ID = '11111111-2222-3333-4444-555555555555';
const CUSTOMER_ID = 'a1b2c3d4';
const LAPSED_PAID_THROUGH = '2020-01-01'; // certainly in the past
const RENEWED_PAID_THROUGH = '2099-01-01'; // certainly in the future

function ephemeralPrivateKeyPem() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

let projectDir: string;
let stateDir: string;
let privateKeyPem: string;
let publicKeyPem: string;
let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'vc-seam-project-'));
  stateDir = mkdtempSync(join(tmpdir(), 'vc-seam-state-'));
  privateKeyPem = ephemeralPrivateKeyPem();
  publicKeyPem = derivePublicKeyPem(privateKeyPem);

  writeFileSync(
    join(projectDir, '.vibecarbon.json'),
    `${JSON.stringify({ version: '1', projectId: PROJECT_ID, services: {} }, null, 2)}\n`,
  );

  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function seedKey(overrides: Partial<Parameters<typeof mintV2Key>[1]> = {}) {
  const key = mintV2Key(privateKeyPem, {
    tier: 'graphene',
    customerId: CUSTOMER_ID,
    projectId: PROJECT_ID,
    paidThrough: LAPSED_PAID_THROUGH,
    ...overrides,
  });
  const result = activateLicense(key, { projectDir, stateDir, publicKeyPem });
  expect(result.success, result.error).toBe(true);
  return key;
}

function printedLines(): string {
  return logSpy.mock.calls.map((c) => c[0]).join('\n');
}

function okFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

async function callDeploy(deployTier: string, fetchImpl: ReturnType<typeof vi.fn>) {
  return requireProvisionEntitlement({
    deployTier,
    projectConfig: {},
    projectDir,
    stateDir,
    fetchImpl,
    env: {},
    publicKeyPem,
  });
}

describe('the refresh seam — lapsed v2 key', () => {
  it('a renewed key clears the gate: no exit, no upsell', async () => {
    seedKey({ tier: 'graphene', paidThrough: LAPSED_PAID_THROUGH });
    const renewedKey = mintV2Key(privateKeyPem, {
      tier: 'graphene',
      customerId: CUSTOMER_ID,
      projectId: PROJECT_ID,
      paidThrough: RENEWED_PAID_THROUGH,
    });
    const fetchImpl = okFetch({ key: renewedKey });

    await expect(callDeploy('k8s', fetchImpl)).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(printedLines()).not.toContain('License required');

    const onDisk = JSON.parse(readFileSync(join(projectDir, '.vibecarbon.license'), 'utf-8'));
    expect(onDisk.paidThrough).toBe(RENEWED_PAID_THROUGH);
    expect(onDisk.source).toBe('refresh');
  });

  it('an unreachable server leaves the refusal in place and adds the offline line', async () => {
    seedKey({ tier: 'graphene', paidThrough: LAPSED_PAID_THROUGH });
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(callDeploy('k8s', fetchImpl)).rejects.toThrow('process.exit(1)');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const printed = printedLines();
    expect(printed).toContain('License required');
    expect(printed).toContain(
      'Could not reach vibecarbon.com. If you renewed, run vibecarbon activate <key> from your email.',
    );

    // Never touches the stored file on a failed refresh.
    const onDisk = JSON.parse(readFileSync(join(projectDir, '.vibecarbon.license'), 'utf-8'));
    expect(onDisk.paidThrough).toBe(LAPSED_PAID_THROUGH);
    expect(onDisk.source).toBe('manual');
  });

  it('a definitive not-renewed refusal (402) refuses without the offline line', async () => {
    seedKey({ tier: 'graphene', paidThrough: LAPSED_PAID_THROUGH });
    const fetchImpl = okFetch(
      { error: 'subscription_inactive', paidThrough: LAPSED_PAID_THROUGH },
      402,
    );

    await expect(callDeploy('k8s', fetchImpl)).rejects.toThrow('process.exit(1)');

    const printed = printedLines();
    expect(printed).toContain('License required');
    expect(printed).not.toContain('Could not reach vibecarbon.com');
  });
});

describe('the refresh seam — tier-too-low v2 key', () => {
  it('a renewed key at the required tier clears the gate', async () => {
    // Graphene covers k8s but not k8s-ha; still well within its paidThrough,
    // so the refusal reason is tier-too-low, not lapsed.
    seedKey({ tier: 'graphene', paidThrough: RENEWED_PAID_THROUGH });
    const upgradedKey = mintV2Key(privateKeyPem, {
      tier: 'fullerene',
      customerId: CUSTOMER_ID,
      projectId: PROJECT_ID,
      paidThrough: RENEWED_PAID_THROUGH,
    });
    const fetchImpl = okFetch({ key: upgradedKey });

    await expect(callDeploy('k8s-ha', fetchImpl)).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('the refresh seam — never fires when it should not', () => {
  it('no-license never triggers a refresh attempt', async () => {
    const fetchImpl = okFetch({ key: 'unused' });

    await expect(callDeploy('k8s', fetchImpl)).rejects.toThrow('process.exit(1)');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('wrong-project never triggers a refresh attempt', async () => {
    const otherProjectKey = mintV2Key(privateKeyPem, {
      tier: 'fullerene',
      customerId: CUSTOMER_ID,
      projectId: '99999999-8888-7777-6666-555555555555',
      paidThrough: RENEWED_PAID_THROUGH,
    });
    writeFileSync(
      join(projectDir, '.vibecarbon.license'),
      `${JSON.stringify(
        {
          key: otherProjectKey,
          format: 'v2',
          tier: 'fullerene',
          customerId: CUSTOMER_ID,
          projectId: '99999999-8888-7777-6666-555555555555',
          paidThrough: RENEWED_PAID_THROUGH,
          activatedAt: '2026-01-01T00:00:00.000Z',
          source: 'manual',
        },
        null,
        2,
      )}\n`,
    );
    const fetchImpl = okFetch({ key: 'unused' });

    await expect(callDeploy('k8s', fetchImpl)).rejects.toThrow('process.exit(1)');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a legacy v1 (lifetime) key never triggers a refresh attempt', async () => {
    const legacyKey = `vc-f-${CUSTOMER_ID}-${'a'.repeat(128)}`;
    // getLicense() requires a genuinely-verifying key to become "active", so
    // sign one for real rather than hand-writing a fake signature.
    const { sign } = await import('node:crypto');
    const { createPrivateKey } = await import('node:crypto');
    const { signedMessage } = await import('../../../src/lib/licensing/validator.js');
    const message = signedMessage({ format: 'v1', tierChar: 'f', customerId: CUSTOMER_ID });
    const signature = sign(null, Buffer.from(message), createPrivateKey(privateKeyPem)).toString(
      'hex',
    );
    const realLegacyKey = `vc-f-${CUSTOMER_ID}-${signature}`;
    void legacyKey;

    writeFileSync(
      join(stateDir, 'license'),
      JSON.stringify({ key: realLegacyKey, tier: 'fullerene', customerId: CUSTOMER_ID }),
    );
    const fetchImpl = okFetch({ key: 'unused' });

    // A v1 lifetime key entitles every deploy tier, so this should succeed
    // outright without ever consulting the network.
    await expect(callDeploy('k8s-ha', fetchImpl)).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
