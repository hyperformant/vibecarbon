/**
 * vibecarbon status — runs against a real project. Read-only; no exec
 * stubs needed for the basic shape, no cloud calls when status hits a
 * not-deployed env.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  realProject,
  runCli,
} from '../../_harness/index.js';

describe('vibecarbon status', () => {
  let project: string;
  beforeEach(() => {
    project = realProject({ envs: ['prod', 'staging'] });
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('prints help', () => {
    const r = runCli('status', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, 'Vibecarbon Status');
  });

  it('rejects unknown -bogus flag', () => {
    const r = runCli('status', ['-bogus'], { cwd: project });
    assertExitWith(r, 1, /unknown flag/i);
  });

  it('runs in a project (no deployed state) without crashing', () => {
    const r = runCli('status', [], { cwd: project, timeoutMs: 30_000 });
    if (r.exitCode === null) throw new Error(`status timed out`);
  });

  it('-json emits parseable JSON when state is deployed', () => {
    destroyRealProject(project);
    project = realProject({ envs: ['prod'], withDeployedState: true });
    const r = runCli('status', ['-json'], { cwd: project, timeoutMs: 30_000 });
    if (r.exitCode === 0) {
      const parsed = JSON.parse(r.stdout.trim());
      expect(typeof parsed).toBe('object');
    }
  });

  it('-env <name> filters to one environment', () => {
    destroyRealProject(project);
    project = realProject({ envs: ['prod', 'staging'], withDeployedState: true });
    const r = runCli('status', ['-env', 'staging'], { cwd: project, timeoutMs: 30_000 });
    if (r.exitCode === null) throw new Error(`status timed out`);
  });

  it('-json includes remote container health, "no ssh key" without a deploy key', () => {
    destroyRealProject(project);
    project = realProject({ envs: ['prod'] });
    const configPath = join(project, '.vibecarbon.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.environments = {
      prod: {
        deployMode: 'compose',
        domain: 'example.invalid',
        servers: [{ name: 'prod', ip: '203.0.113.10' }],
      },
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    // No SSH key exists anywhere this HOME can see, so checkRemoteContainers
    // resolves every server to a "no ssh key" row instead of attempting SSH.
    const emptyHome = mkdtempSync(join(tmpdir(), 'vc-status-no-key-'));

    const r = runCli('status', ['-json'], {
      cwd: project,
      timeoutMs: 30_000,
      env: { HOME: emptyHome },
    });

    assertSuccess(r);
    const json = JSON.parse(r.stdout);
    expect(json.environments.prod.checks.containers).toEqual({
      prod: { kind: 'compose', ip: '203.0.113.10', rows: [], error: 'no ssh key' },
    });
    expect(json.environments.prod.checks.remoteHealth.url).toBe(
      'https://example.invalid/api/health/ready',
    );
    expect(r.exitCode).toBe(0);
  });
});
