/**
 * vibecarbon console — minimal matrix. -h wins over the missing <node>
 * (parseFlagsOrExit answers -h before it validates), and a bare `console`
 * prints its help and exits 1, since it has no useful default node.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  realProject,
  runCli,
} from '../../_harness/index.js';

const TITLE = "Vibecarbon Console - Open Hetzner's web VNC console for a node";

describe('vibecarbon console', () => {
  let project: string;
  beforeEach(() => {
    project = realProject();
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('-h with a node positional shows help', () => {
    const r = runCli('console', ['anynode', '-h'], { cwd: project });
    assertSuccess(r);
    expect(r.stdout.split('\n')[0]).toBe(TITLE);
  });

  it('without node positional: prints its help and exits 1', () => {
    const r = runCli('console', [], { cwd: '/tmp' });
    assertExitWith(r, 1, 'USAGE');
    expect(r.stdout.split('\n')[0]).toBe(TITLE);
  });
});
