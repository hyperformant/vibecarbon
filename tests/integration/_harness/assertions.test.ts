import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertExitWith,
  assertFileMissing,
  assertFileUnchanged,
  assertFileWritten,
  assertSuccess,
} from './assertions.js';
import { destroyRealProject, realProject } from './real-project.js';
import type { RunResult } from './run-cli.js';

const okResult: RunResult = { exitCode: 0, stdout: 'hello', stderr: '' };
const errResult: RunResult = { exitCode: 1, stdout: '', stderr: 'boom' };

describe('assertions', () => {
  let fix: string | undefined;
  afterEach(() => {
    if (fix) destroyRealProject(fix);
    fix = undefined;
  });

  it('assertSuccess passes on exit 0', () => {
    expect(() => assertSuccess(okResult)).not.toThrow();
  });

  it('assertSuccess throws on non-zero with full result in message', () => {
    expect(() => assertSuccess(errResult)).toThrow(/exit=1/);
    expect(() => assertSuccess(errResult)).toThrow(/boom/);
  });

  it('assertExitWith passes when code matches', () => {
    expect(() => assertExitWith(errResult, 1)).not.toThrow();
  });

  it('assertExitWith with string msg matches stderr', () => {
    expect(() => assertExitWith(errResult, 1, 'boom')).not.toThrow();
  });

  it('assertExitWith with regex msg matches', () => {
    expect(() => assertExitWith(errResult, 1, /b.om/)).not.toThrow();
  });

  it('assertExitWith fails when msg not found', () => {
    expect(() => assertExitWith(errResult, 1, 'kaboom')).toThrow(/kaboom/);
  });

  it('assertFileWritten passes when file exists and contains substring', () => {
    fix = realProject();
    writeFileSync(join(fix, 'extra.txt'), 'hello world');
    expect(() => assertFileWritten(fix, 'extra.txt')).not.toThrow();
    expect(() => assertFileWritten(fix, 'extra.txt', 'hello')).not.toThrow();
    expect(() => assertFileWritten(fix, 'extra.txt', /hello/)).not.toThrow();
  });

  it('assertFileWritten throws when file missing', () => {
    fix = realProject();
    expect(() => assertFileWritten(fix, 'nope.txt')).toThrow(/nope\.txt/);
  });

  it('assertFileWritten throws when contains substring not found', () => {
    fix = realProject();
    writeFileSync(join(fix, 'extra.txt'), 'hello');
    expect(() => assertFileWritten(fix, 'extra.txt', 'goodbye')).toThrow(/goodbye/);
  });

  it('assertFileUnchanged matches identical body', () => {
    fix = realProject();
    writeFileSync(join(fix, 'extra.txt'), 'frozen');
    expect(() => assertFileUnchanged(fix, 'extra.txt', 'frozen')).not.toThrow();
  });

  it('assertFileUnchanged throws on diff', () => {
    fix = realProject();
    writeFileSync(join(fix, 'extra.txt'), 'changed');
    expect(() => assertFileUnchanged(fix, 'extra.txt', 'frozen')).toThrow(/changed/);
  });

  it('assertFileMissing passes when file does not exist', () => {
    fix = realProject();
    expect(() => assertFileMissing(fix, 'nope.txt')).not.toThrow();
  });

  it('assertFileMissing throws when file exists', () => {
    fix = realProject();
    writeFileSync(join(fix, 'present.txt'), 'x');
    expect(() => assertFileMissing(fix, 'present.txt')).toThrow(/present\.txt/);
  });
});
