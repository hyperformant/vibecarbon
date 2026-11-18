/**
 * vibecarbon update: help, registry placement. Never reaches a server.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSuccess, destroyRealProject, realProject, runCli } from '../../_harness/index.js';

describe('vibecarbon update', () => {
  let project: string;
  beforeEach(() => {
    project = realProject({ deployMode: 'compose', envs: ['prod'], withDeployedState: true });
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('upgrade help points back at update', () => {
    const r = runCli('upgrade', ['-h'], { cwd: project });
    assertSuccess(r);
    expect(r.stdout).toContain('Looking for vibecarbon update?');
  });

  it('lists update [env] after scale [env] in the deploy commands', () => {
    const r = runCli('-h', [], { cwd: project });
    const block = r.stdout.slice(r.stdout.indexOf('DEPLOY COMMANDS'));
    expect(block.indexOf('update [env]')).toBeGreaterThan(block.indexOf('scale [env]'));
  });
});
