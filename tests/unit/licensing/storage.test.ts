/**
 * Per-project license storage: the legacy `~/.vibecarbon/license` slot and
 * the new `<projectDir>/.vibecarbon.license` project slot, and the routing
 * between them.
 *
 * v2 keys cannot be parsed until B4 (validator.js only understands v1
 * keys). So the "valid" cases below hand-write the project-slot FILE with
 * the real B4 JSON shape (`format: "v2"`, `projectId`, `paidThrough`, ...)
 * but put a genuinely-signed V1-shaped key string in its `key` field,
 * validated via an injected `publicKeyPem` against an ephemeral keypair
 * (see signature-verification.test.ts). Routing off the project slot is
 * driven by the STORED FILE's own `format`/`projectId` fields, not by
 * anything validateLicenseKey derives — that's exactly what lets this
 * round-trip today without a real v2 parser. The "ignored / corrupt" cases
 * don't need a valid key at all, so those hand-write `format: "v2"` files
 * with garbage or mismatched content directly.
 */
import { sign as edSign, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateLicense,
  deactivateLicense,
  getLicense,
  hasStoredLicense,
  listStoredLicenses,
} from '../../../src/lib/licensing/index.js';

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
    });
  });

  describe('precedence', () => {
    it('legacy wins when both slots exist', () => {
      activateLicense(validKey(), { projectDir, stateDir, publicKeyPem });
      writeProjectLicenseFile({
        key: validKey(),
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
        key: validKey(),
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
      expect(license.tier).toBe('fullerene');
      expect(license.format).toBe('v2');
      expect(license.isLifetime).toBe(false);
      expect(license.projectId).toBe(PROJECT_ID);
      expect(license.paidThrough).toBe('2026-12-31');
      expect(license.slot).toBe('project');
      expect(license.storedAt).toBe(join(projectDir, '.vibecarbon.license'));
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

    it('projectId comparison is case-insensitive', () => {
      writeProjectLicenseFile({
        key: validKey(),
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
        key: validKey(),
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
        key: validKey(),
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
        key: validKey(),
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
