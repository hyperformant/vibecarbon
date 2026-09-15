/**
 * activateLicense's v2 (project-scoped) routing branch.
 *
 * validateLicenseKey is mocked (only for this file) so the routing can be
 * driven directly, without minting a key per case; the real parser and the
 * real crypto are covered in validator.test.ts, signature-verification.test.ts
 * and storage.test.ts.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/licensing/validator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/licensing/validator.js')>();
  return {
    ...actual,
    validateLicenseKey: vi.fn(actual.validateLicenseKey),
  };
});

import { activateLicense } from '../../../src/lib/licensing/index.js';
import { validateLicenseKey } from '../../../src/lib/licensing/validator.js';

const PROJECT_ID = '11111111-2222-3333-4444-555555555555';

describe('activateLicense v2 routing (mocked validator, no real v2 parser yet)', () => {
  let stateDir: string;
  let projectDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'vc-activate-v2-state-'));
    projectDir = mkdtempSync(join(tmpdir(), 'vc-activate-v2-project-'));
    vi.mocked(validateLicenseKey).mockReset();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('writes the project file when the key matches this project', () => {
    writeFileSync(
      join(projectDir, '.vibecarbon.json'),
      `${JSON.stringify({ version: '1', projectId: PROJECT_ID, services: {} }, null, 2)}\n`,
    );
    vi.mocked(validateLicenseKey).mockReturnValue({
      valid: true,
      format: 'v2',
      tier: null,
      customerId: 'a1b2c3d4',
      projectId: PROJECT_ID,
      isLifetime: false,
      verified: true,
    });

    const result = activateLicense('vc2-fake-for-mock', { projectDir, stateDir });

    expect(result.success).toBe(true);
    expect(result.format).toBe('v2');
    expect(result.projectId).toBe(PROJECT_ID);
    // A v2 key names no tier: which plan this project is on arrives as a
    // signed verdict at deploy time, so there is nothing to display here.
    expect(result.tier).toBeNull();
    expect(result.tierName).toBe('Project license');

    const path = join(projectDir, '.vibecarbon.license');
    expect(existsSync(path)).toBe(true);
    // Only the key is load-bearing; anything else in the file would be a
    // second, editable copy of a fact that is already signed.
    const stored = JSON.parse(readFileSync(path, 'utf-8'));
    expect(stored).toEqual({
      key: 'vc2-fake-for-mock',
      activatedAt: stored.activatedAt,
      source: 'manual',
    });
  });

  it('refuses when run outside any Vibecarbon project', () => {
    vi.mocked(validateLicenseKey).mockReturnValue({
      valid: true,
      format: 'v2',
      tier: null,
      customerId: 'a1b2c3d4',
      projectId: PROJECT_ID,
      isLifetime: false,
      verified: true,
    });

    const result = activateLicense('vc2-fake-for-mock', { projectDir, stateDir });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/run vibecarbon activate inside the project/i);
    expect(existsSync(join(projectDir, '.vibecarbon.license'))).toBe(false);
  });

  it('refuses when the key is for a different project', () => {
    writeFileSync(
      join(projectDir, '.vibecarbon.json'),
      `${JSON.stringify({ version: '1', projectId: PROJECT_ID, services: {} }, null, 2)}\n`,
    );
    vi.mocked(validateLicenseKey).mockReturnValue({
      valid: true,
      format: 'v2',
      tier: null,
      customerId: 'a1b2c3d4',
      projectId: '99999999-9999-9999-9999-999999999999',
      isLifetime: false,
      verified: true,
    });

    const result = activateLicense('vc2-fake-for-mock', { projectDir, stateDir });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/this key is for project/i);
    expect(existsSync(join(projectDir, '.vibecarbon.license'))).toBe(false);
  });

  it('a malformed manifest yields a clean failure, never throws', () => {
    // The manifest file exists (manifestExists() is true) but isn't valid
    // JSON, so loadManifest() would throw if that were ever unguarded.
    writeFileSync(join(projectDir, '.vibecarbon.json'), '{ not valid json');
    vi.mocked(validateLicenseKey).mockReturnValue({
      valid: true,
      format: 'v2',
      tier: null,
      customerId: 'a1b2c3d4',
      projectId: PROJECT_ID,
      isLifetime: false,
      verified: true,
    });

    let result: ReturnType<typeof activateLicense> | undefined;
    expect(() => {
      result = activateLicense('vc2-fake-for-mock', { projectDir, stateDir });
    }).not.toThrow();

    expect(result?.success).toBe(false);
    expect(typeof result?.error).toBe('string');
    expect(existsSync(join(projectDir, '.vibecarbon.license'))).toBe(false);
  });
});
