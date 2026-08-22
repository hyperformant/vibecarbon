/**
 * vibecarbon shell — minimal matrix. Opens an interactive ssh; we
 * cover help + project-guard. Real-project fixture used.
 */
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  realProject,
  runCli,
} from '../../_harness/index.js';

describe('vibecarbon shell', () => {
  let project: string;
  beforeEach(() => {
    project = realProject();
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('prints help', () => {
    const r = runCli('shell', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, /Vibecarbon Shell|shell/i);
  });

  it('refuses outside a vibecarbon project', () => {
    const r = runCli('shell', [], { cwd: '/tmp' });
    assertExitWith(r, 1, /Not in a Vibecarbon project/i);
  });
});
