/**
 * Test assertions over RunResult + filesystem state.
 *
 * The harness throws plain Errors with descriptive messages rather than
 * using vitest's `expect(...).toBe(...)` directly. This gives a single,
 * legible failure message that includes the relevant slice of
 * RunResult — without it, you spend the first minute of every failure
 * reading raw stdout/stderr to figure out what command actually ran.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from './run-cli.js';

/** A project root directory — output of realProject(). */
export type ProjectPath = string;

function combined(r: RunResult): string {
  return `exit=${r.exitCode}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
}

export function assertSuccess(r: RunResult): void {
  if (r.exitCode !== 0) {
    throw new Error(`assertSuccess: expected exit 0\n${combined(r)}`);
  }
}

export function assertExitWith(r: RunResult, code: number, msg?: string | RegExp): void {
  if (r.exitCode !== code) {
    throw new Error(`assertExitWith: expected exit ${code}, got ${r.exitCode}\n${combined(r)}`);
  }
  if (msg !== undefined) {
    const haystack = `${r.stdout}\n${r.stderr}`;
    const matched = typeof msg === 'string' ? haystack.includes(msg) : msg.test(haystack);
    if (!matched) {
      throw new Error(
        `assertExitWith: output did not contain ${typeof msg === 'string' ? `"${msg}"` : msg}\n${combined(r)}`,
      );
    }
  }
}

export function assertFileWritten(
  fix: ProjectPath,
  relPath: string,
  contains?: string | RegExp,
): void {
  const full = join(fix, relPath);
  if (!existsSync(full)) {
    throw new Error(`assertFileWritten: ${relPath} does not exist in fixture ${fix}`);
  }
  if (contains !== undefined) {
    const body = readFileSync(full, 'utf-8');
    const matched = typeof contains === 'string' ? body.includes(contains) : contains.test(body);
    if (!matched) {
      throw new Error(
        `assertFileWritten: ${relPath} did not contain ${typeof contains === 'string' ? `"${contains}"` : contains}\nactual:\n${body}`,
      );
    }
  }
}

export function assertFileUnchanged(fix: ProjectPath, relPath: string, expectedBody: string): void {
  const full = join(fix, relPath);
  if (!existsSync(full)) {
    throw new Error(`assertFileUnchanged: ${relPath} disappeared from fixture ${fix}`);
  }
  const body = readFileSync(full, 'utf-8');
  if (body !== expectedBody) {
    throw new Error(
      `assertFileUnchanged: ${relPath} changed\nexpected:\n${expectedBody}\nactual:\n${body}`,
    );
  }
}

export function assertFileMissing(fix: ProjectPath, relPath: string): void {
  const full = join(fix, relPath);
  if (existsSync(full)) {
    throw new Error(`assertFileMissing: ${relPath} unexpectedly exists in fixture ${fix}`);
  }
}
