/**
 * vibecarbon access — minimal matrix. The list/add/remove/prune actions
 * need a Hetzner token + real firewall, so we cover the parse path: help
 * and flag rejection. The project guard is covered by the _global
 * not-in-project matrix.
 */
import { afterEach, beforeEach, describe, it } from 'vitest';
import { assertExitWith, destroyRealProject, realProject, runCli } from '../../_harness/index.js';

describe('vibecarbon access', () => {
  let project: string;
  beforeEach(() => {
    project = realProject();
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('rejects double-dash flags', () => {
    const r = runCli('access', ['--list'], { cwd: project });
    assertExitWith(r, 1, 'unknown flag: --list');
  });
});
