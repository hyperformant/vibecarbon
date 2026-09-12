/**
 * activateLicense's v2 (project-scoped) routing branch.
 *
 * validator.js cannot parse a real v2 key until B4, so there's no way to
 * produce a `{ valid: true, format: 'v2', projectId }` validation result
 * from a real key today. This mocks validateLicenseKey (only for this
 * file) to exercise the routing skeleton activateLicense already has to
 * carry per the storage contract, without implementing any v2 parsing.
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
      tier: 'graphene',
      customerId: 'a1b2c3d4',
      projectId: PROJECT_ID,
      paidThrough: '2026-12-31',
      isLifetime: false,
      verified: true,
    });

    const result = activateLicense('vc2-fake-for-mock', { projectDir, stateDir });

    expect(result.success).toBe(true);
    expect(result.format).toBe('v2');
    expect(result.projectId).toBe(PROJECT_ID);

    const path = join(projectDir, '.vibecarbon.license');
    expect(existsSync(path)).toBe(true);
    const stored = JSON.parse(readFileSync(path, 'utf-8'));
    expect(stored).toEqual({
      key: 'vc2-fake-for-mock',
      format: 'v2',
      tier: 'graphene',
      customerId: 'a1b2c3d4',
      projectId: PROJECT_ID,
      paidThrough: '2026-12-31',
      activatedAt: stored.activatedAt,
      source: 'manual',
    });
  });

  it('refuses when run outside any Vibecarbon project', () => {
    vi.mocked(validateLicenseKey).mockReturnValue({
      valid: true,
      format: 'v2',
      tier: 'graphene',
      customerId: 'a1b2c3d4',
      projectId: PROJECT_ID,
      paidThrough: '2026-12-31',
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
      tier: 'graphene',
      customerId: 'a1b2c3d4',
      projectId: '99999999-9999-9999-9999-999999999999',
      paidThrough: '2026-12-31',
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
      tier: 'graphene',
      customerId: 'a1b2c3d4',
      projectId: PROJECT_ID,
      paidThrough: '2026-12-31',
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
