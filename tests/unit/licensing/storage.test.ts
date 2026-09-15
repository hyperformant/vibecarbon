/**
 * Per-project license storage: the legacy `~/.vibecarbon/license` slot and
 * the new `<projectDir>/.vibecarbon.license` project slot, and the routing
 * between them.
 *
 * The "valid" project-slot cases write a genuinely-signed v2 key
 * (`vc2-...`) into the file's `key` field, validated via an injected
 * `publicKeyPem` against an ephemeral keypair (see
 * signature-verification.test.ts). Routing is driven ONLY by what
 * validateLicenseKey derives from the key string; the stored file's own
 * fields are display data and are never trusted. The "ignored / corrupt"
 * cases don't need a valid key at all, so those hand-write files with
 * garbage or mismatched content directly.
 *
 * A v2 key carries no tier and no date: the subscription's status is a
 * signed verdict fetched at deploy time (see deploy-gate-seam.test.ts), so
 * nothing here asserts a paid-through date.
 */
import { sign as edSign, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateDeployEntitlement } from '../../../src/lib/licensing/entitlement.js';
import {
  activateLicense,
  deactivateLicense,
  getLicense,
  hasStoredLicense,
  listStoredLicenses,
} from '../../../src/lib/licensing/index.js';
import { buildDeployUpsell } from '../../../src/lib/licensing/upsell.js';
import { signedMessage } from '../../../src/lib/licensing/validator.js';

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

function signKey(privateKey: ReturnType<typeof makeKeypair>['privateKey'], customerId: string) {
  const message = `f-${customerId}`;
  const signatureHex = edSign(null, Buffer.from(message), privateKey).toString('hex');
  return `vc-f-${customerId}-${signatureHex}`;
}

/** Mint a genuine `vc2-...` key so project-slot round trips exercise the real B4 parser. */
function signV2Key(
  privateKey: ReturnType<typeof makeKeypair>['privateKey'],
  { customerId, projectId }: { customerId: string; projectId: string },
) {
  const projectId32 = projectId.replace(/-/g, '').toLowerCase();
  const message = signedMessage({ format: 'v2', customerId, projectId });
  const signatureHex = edSign(null, Buffer.from(message), privateKey).toString('hex');
  return `vc2-${customerId}-${projectId32}-${signatureHex}`;
}

describe('per-project license storage', () => {
  let stateDir: string;
  let projectDir: string;
  let publicKeyPem: string;
  let privateKey: ReturnType<typeof makeKeypair>['privateKey'];
  const customerId = 'a1b2c3d4';
  const PROJECT_ID = '11111111-2222-3333-4444-555555555555';

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'vc-license-state-'));
    projectDir = mkdtempSync(join(tmpdir(), 'vc-license-project-'));
    writeFileSync(
      join(projectDir, '.vibecarbon.json'),
      `${JSON.stringify({ version: '1', projectId: PROJECT_ID, services: {} }, null, 2)}\n`,
    );
    const kp = makeKeypair();
    publicKeyPem = kp.publicKeyPem;
    privateKey = kp.privateKey;
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function validKey() {
    return signKey(privateKey, customerId);
  }

  /** A genuine v2 key for PROJECT_ID. */
  function validV2Key() {
    return signV2Key(privateKey, { customerId, projectId: PROJECT_ID });
  }

  function writeProjectLicenseFile(data: Record<string, unknown>) {
    writeFileSync(join(projectDir, '.vibecarbon.license'), `${JSON.stringify(data, null, 2)}\n`);
  }

  describe('legacy slot', () => {
    it('read/write stays byte-for-byte identical to the pre-B3 shape', () => {
      const result = activateLicense(validKey(), { projectDir, stateDir, publicKeyPem });
      expect(result.success).toBe(true);

      const licensePath = join(stateDir, 'license');
      expect(existsSync(licensePath)).toBe(true);
      const raw = readFileSync(licensePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(Object.keys(parsed).sort()).toEqual(
        ['activatedAt', 'customerId', 'key', 'tier'].sort(),
      );
      expect(parsed.key).toBe(validKey());
      expect(parsed.tier).toBe('fullerene');
      expect(parsed.customerId).toBe(customerId);
      // No trailing newline — JSON.stringify(data, null, 2) with no `${}\n`.
      expect(raw.endsWith('\n')).toBe(false);
    });

    it('getLicense reads it back as active, v1, lifetime, global', () => {
      activateLicense(validKey(), { projectDir, stateDir, publicKeyPem });
      const license = getLicense({ projectDir, stateDir, publicKeyPem });
      expect(license.active).toBe(true);
      expect(license.tier).toBe('fullerene');
      expect(license.format).toBe('v1');
      expect(license.isLifetime).toBe(true);
      expect(license.projectId).toBeNull();
      expect(license.slot).toBe('legacy');
      expect(license.storedAt).toBe(join(stateDir, 'license'));
      expect(license.key).toBe(validKey());
    });

    it('a v2 key parked in the legacy slot grants nothing, but stays removable', () => {
      // The legacy slot is the global, lifetime slot and only v1 keys live
      // there. A v2 key that lands in it (hand-copied, or written by an
      // older CLI) must not be honored for this project or any other:
      // project keys belong in .vibecarbon.license. listStoredLicenses still
      // has to report it, or activate/deactivate UX would claim there is
      // nothing on disk while the file sits there.
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'license'),
        JSON.stringify({ key: validV2Key(), activatedAt: '2026-01-01T00:00:00.000Z' }),
      );

      const license = getLicense({ projectDir, stateDir, publicKeyPem });
      expect(license.active).toBe(false);
      expect(license.tier).toBe('graphite');
      expect(license.slot).toBeNull();

      const legacyEntry = listStoredLicenses({ projectDir, stateDir }).find(
        (e: { slot: string }) => e.slot === 'legacy',
      );
      expect(legacyEntry).toBeDefined();
      expect(legacyEntry?.key).toBe(validV2Key());
    });
  });

  describe('precedence', () => {
    it('legacy wins when both slots exist', () => {
      activateLicense(validKey(), { projectDir, stateDir, publicKeyPem });
      writeProjectLicenseFile({
        key: validV2Key(),
        format: 'v2',
        tier: 'fullerene',
        customerId,
        projectId: PROJECT_ID,
        paidThrough: '2026-12-31',
        activatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual',
      });

      const license = getLicense({ projectDir, stateDir, publicKeyPem });
      expect(license.slot).toBe('legacy');
      expect(license.format).toBe('v1');
    });
  });

  describe('project slot', () => {
    it('round trips: written via activateLicense-style file, read back active/v2', () => {
      writeProjectLicenseFile({
        key: validV2Key(),
        format: 'v2',
        tier: 'fullerene',
        customerId,
        projectId: PROJECT_ID,
        paidThrough: '2026-12-31',
        activatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual',
      });

      const license = getLicense({ projectDir, stateDir, publicKeyPem });
      expect(license.active).toBe(true);
      expect(license.tier).toBeNull();
      expect(license.format).toBe('v2');
      expect(license.isLifetime).toBe(false);
      expect(license.projectId).toBe(PROJECT_ID);
      expect(license.slot).toBe('project');
      expect(license.storedAt).toBe(join(projectDir, '.vibecarbon.license'));
      // The deploy-time check posts the key itself, so an active result has
      // to carry the raw string, not just the fields derived from it.
      expect(license.key).toBe(validV2Key());
    });

    it('a project key for a different projectId is ignored (falls back to no-license)', () => {
      writeProjectLicenseFile({
        key: 'irrelevant-since-projectId-mismatch-short-circuits',
        format: 'v2',
        tier: 'fullerene',
        customerId,
        projectId: '99999999-9999-9999-9999-999999999999',
        paidThrough: '2026-12-31',
        activatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual',
      });

      const license = getLicense({ projectDir, stateDir, publicKeyPem });
      expect(license.active).toBe(false);
      expect(license.tier).toBe('graphite');
      expect(license.slot).toBeNull();
    });

    it('a VALID project key for another project is reported as a mismatch, never as active', () => {
      const otherProjectId = '99999999-9999-9999-9999-999999999999';
      writeProjectLicenseFile({
        key: signV2Key(privateKey, {
          customerId,
          projectId: otherProjectId,
        }),
        format: 'v2',
        tier: 'fullerene',
        customerId,
        projectId: otherProjectId,
        paidThrough: '2026-12-31',
        activatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual',
      });

      const license = getLicense({ projectDir, stateDir, publicKeyPem });
      // Routing is unchanged: the key grants nothing.
      expect(license.active).toBe(false);
      expect(license.tier).toBe('graphite');
      expect(license.slot).toBeNull();
      expect(license.projectId).toBeNull();
      // ...but the gate can now say WHICH project it belongs to.
      expect(license.storedProjectId).toBe(otherProjectId);
    });

    it('names the id from the SIGNED key, not the file field an operator can edit', () => {
      const signedFor = '99999999-9999-9999-9999-999999999999';
      writeProjectLicenseFile({
        key: signV2Key(privateKey, {
          customerId,
          projectId: signedFor,
        }),
        format: 'v2',
        tier: 'fullerene',
        customerId,
        // A lie: neither this project, nor the project the key is signed for.
        projectId: '77777777-7777-7777-7777-777777777777',
        paidThrough: '2026-12-31',
        activatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual',
      });

      const license = getLicense({ projectDir, stateDir, publicKeyPem });
      expect(license.active).toBe(false);
      expect(license.storedProjectId).toBe(signedFor);
    });

    it('an UNSIGNED project key for another project stays a plain no-license', () => {
      // Nothing verifiable on disk, so there is no id worth naming and the
      // upsell must not print whatever the file happens to say.
      writeProjectLicenseFile({
        key: 'vc2-f-a1b2c3d4-99999999999999999999999999999999-20261231-beef',
        format: 'v2',
        tier: 'fullerene',
        customerId,
        projectId: '99999999-9999-9999-9999-999999999999',
        paidThrough: '2026-12-31',
        activatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual',
      });

      const license = getLicense({ projectDir, stateDir, publicKeyPem });
      expect(license.active).toBe(false);
      expect(license.storedProjectId).toBeNull();
    });

    it('drives the real gate to wrong-project, naming the other project in the upsell', () => {
      // The end-to-end path the deploy gate walks: real getLicense -> real
      // evaluateDeployEntitlement -> real upsell. A checked-in
      // .vibecarbon.license from another project must not produce the
      // generic "no license" upsell, which would send the operator to buy a
      // second subscription for a key they already hold.
      const otherProjectId = '99999999-9999-9999-9999-999999999999';
      writeProjectLicenseFile({
        key: signV2Key(privateKey, {
          customerId,
          projectId: otherProjectId,
        }),
        format: 'v2',
        tier: 'fullerene',
        customerId,
        projectId: otherProjectId,
        paidThrough: '2026-12-31',
        activatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual',
      });

      const license = getLicense({ projectDir, stateDir, publicKeyPem });
      const verdict = evaluateDeployEntitlement({
        license,
        deployTier: 'k8s',
        projectId: PROJECT_ID,
        check: { source: 'none', verdict: null },
        now: '2026-09-15',
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBe('wrong-project');
      expect(verdict.requiredTier).toBe('graphene');

      const upsell = buildDeployUpsell({
        verdict,
        deployTier: 'k8s',
        projectName: 'lictest',
        projectId: PROJECT_ID,
      }).join('\n');
      expect(upsell).toContain(
        `The stored key belongs to project ${otherProjectId}. Each project has its own subscription.`,
      );
    });

    it('projectId comparison is case-insensitive', () => {
      writeProjectLicenseFile({
        key: validV2Key(),
        format: 'v2',
        tier: 'fullerene',
        customerId,
        projectId: PROJECT_ID.toUpperCase(),
        paidThrough: '2026-12-31',
        activatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual',
      });

      const license = getLicense({ projectDir, stateDir, publicKeyPem });
      expect(license.active).toBe(true);
      expect(license.slot).toBe('project');
    });

    it('C1: an edited file projectId cannot claim a key signed for another project', () => {
      // The key is signed for otherProjectId. If getLicense trusted the
      // file's own projectId field, editing it to PROJECT_ID would let a
      // key bought for one project provision a different one.
      const otherProjectId = '99999999-9999-9999-9999-999999999999';
      writeProjectLicenseFile({
        key: signV2Key(privateKey, {
          customerId,
          projectId: otherProjectId,
        }),
        format: 'v2',
        tier: 'fullerene',
        customerId,
        projectId: PROJECT_ID,
        paidThrough: '2026-12-31',
        activatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual',
      });

      const license = getLicense({ projectDir, stateDir, publicKeyPem });
      expect(license.active).toBe(false);

      const verdict = evaluateDeployEntitlement({
        license,
        deployTier: 'k8s-ha',
        projectId: PROJECT_ID,
        check: { source: 'none', verdict: null },
        now: '2026-09-15',
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBe('wrong-project');
    });

    it('a corrupt project file yields no-license but hasStoredLicense stays true', () => {
      writeFileSync(join(projectDir, '.vibecarbon.license'), '{ this is not json');

      const license = getLicense({ projectDir, stateDir, publicKeyPem });
      expect(license.active).toBe(false);
      expect(license.tier).toBe('graphite');
      expect(hasStoredLicense({ projectDir, stateDir })).toBe(true);
    });

    it('a project file whose key fails validation degrades to no-license, never throws', () => {
      writeProjectLicenseFile({
        key: 'vc-f-a1b2c3d4-0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
        format: 'v2',
        tier: 'fullerene',
        customerId,
        projectId: PROJECT_ID,
        paidThrough: '2026-12-31',
        activatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual',
      });

      expect(() => getLicense({ projectDir, stateDir, publicKeyPem })).not.toThrow();
      const license = getLicense({ projectDir, stateDir, publicKeyPem });
      expect(license.active).toBe(false);
    });
  });

  describe('malformed .vibecarbon.json manifest', () => {
    // Before per-project licensing, getLicense() never touched the
    // manifest at all, so a corrupt one had zero effect on license
    // resolution. It must still have zero effect now: the legacy-key path
    // is entirely independent of the manifest, and a malformed manifest
    // must degrade to "no project" (projectId null) rather than throw.
    beforeEach(() => {
      writeFileSync(join(projectDir, '.vibecarbon.json'), '{ not valid json');
    });

    it('a valid legacy key still resolves, untouched by the corrupt manifest', () => {
      activateLicense(validKey(), { projectDir, stateDir, publicKeyPem });

      expect(() => getLicense({ projectDir, stateDir, publicKeyPem })).not.toThrow();
      const license = getLicense({ projectDir, stateDir, publicKeyPem });
      expect(license.active).toBe(true);
      expect(license.format).toBe('v1');
      expect(license.slot).toBe('legacy');
    });

    it('a project key with no legacy key falls back to no-license, never throws', () => {
      writeProjectLicenseFile({
        key: validV2Key(),
        format: 'v2',
        tier: 'fullerene',
        customerId,
        projectId: PROJECT_ID,
        paidThrough: '2026-12-31',
        activatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual',
      });

      expect(() => getLicense({ projectDir, stateDir, publicKeyPem })).not.toThrow();
      const license = getLicense({ projectDir, stateDir, publicKeyPem });
      expect(license.active).toBe(false);
      expect(license.tier).toBe('graphite');
      expect(license.slot).toBeNull();
    });

    it('hasStoredLicense/listStoredLicenses/deactivateLicense never throw either', () => {
      expect(() => hasStoredLicense({ projectDir, stateDir })).not.toThrow();
      expect(() => listStoredLicenses({ projectDir, stateDir })).not.toThrow();
      expect(() => deactivateLicense({ projectDir, stateDir })).not.toThrow();
    });
  });

  describe('hasStoredLicense', () => {
    it('is true when only the project file exists', () => {
      expect(hasStoredLicense({ projectDir, stateDir })).toBe(false);
      writeProjectLicenseFile({
        key: validV2Key(),
        format: 'v2',
        tier: 'fullerene',
        customerId,
        projectId: PROJECT_ID,
        paidThrough: '2026-12-31',
        activatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual',
      });
      expect(hasStoredLicense({ projectDir, stateDir })).toBe(true);
    });
  });

  describe('activateLicense routing', () => {
    it('routes a v1 key to the legacy slot unchanged', () => {
      const result = activateLicense(validKey(), { projectDir, stateDir, publicKeyPem });
      expect(result.success).toBe(true);
      expect(existsSync(join(stateDir, 'license'))).toBe(true);
      expect(existsSync(join(projectDir, '.vibecarbon.license'))).toBe(false);
    });
  });

  describe('deactivateLicense', () => {
    function seedBoth() {
      activateLicense(validKey(), { projectDir, stateDir, publicKeyPem });
      writeProjectLicenseFile({
        key: validV2Key(),
        format: 'v2',
        tier: 'fullerene',
        customerId,
        projectId: PROJECT_ID,
        paidThrough: '2026-12-31',
        activatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual',
      });
    }

    it('removes the project file when both exist, leaving legacy intact', () => {
      seedBoth();
      const result = deactivateLicense({ projectDir, stateDir });
      expect(result.success).toBe(true);
      expect(result.removed).toEqual([join(projectDir, '.vibecarbon.license')]);
      expect(existsSync(join(projectDir, '.vibecarbon.license'))).toBe(false);
      expect(existsSync(join(stateDir, 'license'))).toBe(true);
    });

    it('falls back to the legacy file when no project file exists', () => {
      activateLicense(validKey(), { projectDir, stateDir, publicKeyPem });
      const result = deactivateLicense({ projectDir, stateDir });
      expect(result.success).toBe(true);
      expect(result.removed).toEqual([join(stateDir, 'license')]);
      expect(existsSync(join(stateDir, 'license'))).toBe(false);
    });

    it('-all removes both', () => {
      seedBoth();
      const result = deactivateLicense({ projectDir, stateDir, all: true });
      expect(result.success).toBe(true);
      expect(result.removed.sort()).toEqual(
        [join(projectDir, '.vibecarbon.license'), join(stateDir, 'license')].sort(),
      );
      expect(existsSync(join(projectDir, '.vibecarbon.license'))).toBe(false);
      expect(existsSync(join(stateDir, 'license'))).toBe(false);
    });

    it('a corrupt project file is still removable', () => {
      writeFileSync(join(projectDir, '.vibecarbon.license'), '{ not json');
      expect(hasStoredLicense({ projectDir, stateDir })).toBe(true);
      const result = deactivateLicense({ projectDir, stateDir });
      expect(result.success).toBe(true);
      expect(existsSync(join(projectDir, '.vibecarbon.license'))).toBe(false);
    });

    it('is a graceful no-op when nothing is stored', () => {
      const result = deactivateLicense({ projectDir, stateDir });
      expect(result.success).toBe(true);
      expect(result.removed).toEqual([]);
    });
  });

  describe('listStoredLicenses', () => {
    it('lists both slots when both are populated', () => {
      seedBothForList();
      const entries = listStoredLicenses({ projectDir, stateDir });
      expect(entries.map((e: { slot: string }) => e.slot).sort()).toEqual(['legacy', 'project']);
    });

    function seedBothForList() {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'license'),
        JSON.stringify({ key: 'vc-f-cafebabe-deadbeef', activatedAt: '2026-01-01' }),
      );
      writeProjectLicenseFile({
        key: 'vc-f-cafebabe-deadbeef',
        format: 'v2',
        tier: 'fullerene',
        customerId: 'cafebabe',
        projectId: PROJECT_ID,
        paidThrough: '2026-12-31',
        activatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual',
      });
    }
  });
});
