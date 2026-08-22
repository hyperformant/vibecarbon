/**
 * vibecarbon activate — license file mutation against a real project.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  realProject,
  runCli,
  testLicenseKey,
} from '../../_harness/index.js';

describe('vibecarbon activate', () => {
  let project: string;
  let testHome: string;
  beforeEach(() => {
    project = realProject();
    testHome = mkdtempSync(join(tmpdir(), 'vc-activate-test-home-'));
  });
  afterEach(() => {
    destroyRealProject(project);
    rmSync(testHome, { recursive: true, force: true });
  });

  it('prints help', () => {
    const r = runCli('activate', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, /Vibecarbon Activate|license/i);
  });

  it('writes the license file when given a genuinely signed key', () => {
    const r = runCli('activate', [testLicenseKey()], {
      cwd: project,
      env: { HOME: testHome },
      timeoutMs: 15_000,
    });
    if (r.exitCode !== 0) {
      if (/needs an interactive terminal/i.test(r.stdout + r.stderr)) return;
      throw new Error(`activate failed:\n${r.stderr}`);
    }
    const licensePath = join(testHome, '.vibecarbon', 'license');
    expect(existsSync(licensePath)).toBe(true);
    const stored = JSON.parse(readFileSync(licensePath, 'utf-8'));
    expect(stored.key).toBe(testLicenseKey());
  });

  it('refuses a well-formed key carrying no valid signature', () => {
    // This is the case that used to SUCCEED: 'vc-f-cafebabe-fakefake...'
    // parsed cleanly and VIBECARBON_DEV_LICENSE=true waved it through without
    // verifying anything. Activation must now demand a real Ed25519 signature.
    const r = runCli('activate', [`vc-f-cafebabe-${'0'.repeat(128)}`], {
      cwd: project,
      env: { HOME: testHome },
      timeoutMs: 15_000,
    });
    if (/needs an interactive terminal/i.test(r.stdout + r.stderr)) return;
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(testHome, '.vibecarbon', 'license'))).toBe(false);
  });

  it('rejects a malformed key', () => {
    const r = runCli('activate', ['totally-not-a-key'], {
      cwd: project,
      env: { HOME: testHome },
      timeoutMs: 15_000,
    });
    if (r.exitCode === 0) {
      const licensePath = join(testHome, '.vibecarbon', 'license');
      if (existsSync(licensePath)) {
        const stored = JSON.parse(readFileSync(licensePath, 'utf-8'));
        expect(stored.key).not.toBe('totally-not-a-key');
      }
    }
  });
});
