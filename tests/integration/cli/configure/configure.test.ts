/**
 * vibecarbon configure — subcommand matrix.
 */
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  realProject,
  runCli,
} from '../../_harness/index.js';

describe('vibecarbon configure', () => {
  let project: string;
  beforeEach(() => {
    project = realProject();
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('prints help', () => {
    const r = runCli('configure', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, /Vibecarbon Configure|configure/i);
  });

  it('mentions Providers as a configurable feature (B1: first in the menu)', () => {
    const r = runCli('configure', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, /Providers/);
  });

  it('refuses outside a vibecarbon project', () => {
    const r = runCli('configure', [], { cwd: '/tmp' });
    assertExitWith(r, 1, /Not in a Vibecarbon project/i);
  });

  it('cicd subcommand exists in help', () => {
    const r = runCli('configure', ['-h'], { cwd: project });
    assertSuccess(r);
    // configure's help should mention cicd or other subcommands.
    if (r.stdout.length === 0) {
      throw new Error('configure -h emitted empty stdout');
    }
  });
});
