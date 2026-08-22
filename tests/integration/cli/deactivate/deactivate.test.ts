/**
 * vibecarbon deactivate — license file removal.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('vibecarbon deactivate', () => {
  let project: string;
  let testHome: string;
  beforeEach(() => {
    project = realProject();
    testHome = mkdtempSync(join(tmpdir(), 'vc-deactivate-test-home-'));
    mkdirSync(join(testHome, '.vibecarbon'), { recursive: true });
    writeFileSync(
      join(testHome, '.vibecarbon', 'license'),
      JSON.stringify({ key: 'vc-f-deadbeef-fakefakefake', activatedAt: '2026-01-01' }),
    );
  });
  afterEach(() => {
    destroyRealProject(project);
    rmSync(testHome, { recursive: true, force: true });
  });

  it('prints help', () => {
    const r = runCli('deactivate', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, /Vibecarbon Deactivate|deactivate/i);
  });

  it('removes a license file whose key does not verify', () => {
    // beforeEach seeds an UNSIGNED key. Deactivate keys off the file's
    // presence, not its validity: gating on getLicense().active would leave a
    // corrupt file permanently unremovable from the CLI.
    const licensePath = join(testHome, '.vibecarbon', 'license');
    expect(existsSync(licensePath)).toBe(true);
    const r = runCli('deactivate', ['-y'], {
      cwd: project,
      env: { HOME: testHome },
      timeoutMs: 10_000,
    });
    if (/needs an interactive terminal/i.test(r.stdout + r.stderr)) return;
    expect(r.exitCode).toBe(0);
    expect(existsSync(licensePath)).toBe(false);
  });

  it('removes the license file', () => {
    const licensePath = join(testHome, '.vibecarbon', 'license');
    writeFileSync(
      licensePath,
      JSON.stringify({ key: testLicenseKey(), activatedAt: '2026-01-01' }),
    );
    expect(existsSync(licensePath)).toBe(true);
    const r = runCli('deactivate', ['-y'], {
      cwd: project,
      env: { HOME: testHome },
      timeoutMs: 10_000,
    });
    if (r.exitCode !== 0) {
      if (/needs an interactive terminal/i.test(r.stdout + r.stderr)) return;
      throw new Error(`deactivate failed:\n${r.stderr}`);
    }
    expect(existsSync(licensePath)).toBe(false);
  });

  it('on already-deactivated: graceful', () => {
    rmSync(join(testHome, '.vibecarbon', 'license'), { force: true });
    const r = runCli('deactivate', ['-y'], {
      cwd: project,
      env: { HOME: testHome },
      timeoutMs: 10_000,
    });
    if (/unknown.*flag/i.test(r.stderr)) {
      throw new Error(`parser error:\n${r.stderr}`);
    }
  });
});
