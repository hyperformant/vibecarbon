/**
 * vibecarbon create — flag matrix. Success-path tests already live in
 * tests/integration/template/create.test.ts (which actually scaffolds
 * a project + lints/builds it). Here: help + flag rejections only.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { assertExitWith, assertSuccess, runCli } from '../../_harness/index.js';

describe('vibecarbon create — flag rejections', () => {
  let parent: string;
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'vc-create-flags-'));
  });
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it('prints help', () => {
    const r = runCli('create', ['-h']);
    assertSuccess(r);
    assertExitWith(r, 0, 'Vibecarbon Create');
    assertExitWith(r, 0, '-pm');
  });

  it('rejects --use-npm (CLI sweep replaced with -pm)', () => {
    const r = runCli('create', ['app', '-y', '--use-npm'], { cwd: parent });
    assertExitWith(r, 1, 'unknown flag: --use-npm');
  });

  it('rejects --no-git (git init is unconditional; no opt-out flag exists)', () => {
    const r = runCli('create', ['app', '-y', '--no-git'], { cwd: parent });
    assertExitWith(r, 1, 'unknown flag: --no-git');
  });

  it('rejects -pm with invalid value', () => {
    const r = runCli(
      'create',
      ['app', '-y', '-pm', 'cargo', '-admin-email', 'a@b.c', '-admin-password', 'pw'],
      { cwd: parent, timeoutMs: 30_000 },
    );
    if (r.exitCode === 0) {
      throw new Error('create accepted -pm cargo');
    }
  });

  it('-y without admin-email exits non-zero with clear error', () => {
    const r = runCli('create', ['app', '-y'], { cwd: parent, timeoutMs: 30_000 });
    assertExitWith(r, 1, /admin-email/i);
  });

  it('-y without admin-password exits non-zero', () => {
    const r = runCli('create', ['app', '-y', '-admin-email', 'a@b.c'], {
      cwd: parent,
      timeoutMs: 30_000,
    });
    assertExitWith(r, 1, /admin-password/i);
  });
});
