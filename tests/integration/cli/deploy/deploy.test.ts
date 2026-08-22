/**
 * vibecarbon deploy — flag matrix against a real project.
 *
 * Real Pulumi-driven success-path tests live in tests/integration/cloud/.
 * Here: help, flag parsing, mode/region validation, project guard.
 */
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  realProject,
  runCli,
} from '../../_harness/index.js';

describe('vibecarbon deploy', () => {
  let project: string;
  beforeEach(() => {
    project = realProject({ envs: ['prod'] });
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('prints help', () => {
    const r = runCli('deploy', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, 'Vibecarbon Deploy');
    assertExitWith(r, 0, '-mode');
    assertExitWith(r, 0, '-region');
    assertExitWith(r, 0, '-full');
    // Finding #1: the HA replication gate opt-out is documented in help.
    assertExitWith(r, 0, '-allow-degraded');
  });

  it('-allow-degraded accepted by parser (finding #1 gate opt-out)', () => {
    const r = runCli('deploy', ['prod', '-mode', 'k8s-ha', '-allow-degraded', '-y'], {
      cwd: project,
      timeoutMs: 10_000,
    });
    if (/unknown flag: -allow-degraded/.test(r.stderr)) {
      throw new Error(`-allow-degraded rejected:\n${r.stderr}`);
    }
  });

  it.each(['compose', 'compose-ha', 'k8s', 'k8s-ha'])('-mode %s accepted by parser', (mode) => {
    const r = runCli('deploy', ['prod', '-mode', mode, '-y'], {
      cwd: project,
      timeoutMs: 10_000,
    });
    if (/unknown flag: -mode|invalid.*mode/i.test(r.stderr)) {
      throw new Error(`-mode ${mode} rejected:\n${r.stderr}`);
    }
  });

  it('rejects -mode kubernetes (not in enum)', () => {
    const r = runCli('deploy', ['prod', '-mode', 'kubernetes', '-y'], {
      cwd: project,
      timeoutMs: 10_000,
    });
    if (r.exitCode === 0) {
      throw new Error('deploy accepted -mode kubernetes (not in enum)');
    }
  });

  it.each(['hel1', 'nbg1', 'fsn1'])('-region %s accepted by parser', (region) => {
    const r = runCli('deploy', ['prod', '-region', region, '-y'], {
      cwd: project,
      timeoutMs: 10_000,
    });
    if (/unknown flag: -region/.test(r.stderr)) {
      throw new Error(`-region ${region} rejected`);
    }
  });

  it('rejects -region atlantis (unknown for Hetzner Cloud)', () => {
    const r = runCli('deploy', ['prod', '-y', '-region', 'atlantis'], {
      cwd: project,
      timeoutMs: 10_000,
    });
    assertExitWith(r, 1, /unknown region 'atlantis' for Hetzner Cloud[\s\S]*hel1/i);
  });

  it('rejects -profile (retired flag)', () => {
    const r = runCli('deploy', ['prod', '-y', '-profile', 'someprofile'], {
      cwd: project,
      timeoutMs: 10_000,
    });
    assertExitWith(r, 1, 'unknown flag: -profile');
  });

  it('-full accepted by parser', () => {
    const r = runCli('deploy', ['prod', '-full', '-y'], {
      cwd: project,
      timeoutMs: 10_000,
    });
    if (/unknown flag: -full/.test(r.stderr)) {
      throw new Error(`-full rejected`);
    }
  });

  it('rejects --k8s (CLI sweep collapsed mode flags)', () => {
    const r = runCli('deploy', ['prod', '--k8s', '-y'], { cwd: project });
    assertExitWith(r, 1, 'unknown flag: --k8s');
  });

  it('rejects -e short form (CLI sweep replaced with -env)', () => {
    const r = runCli('deploy', ['-e', 'prod', '-y'], { cwd: project });
    assertExitWith(r, 1, 'unknown flag: -e');
  });

  it('refuses outside a vibecarbon project', () => {
    const r = runCli('deploy', ['prod', '-y'], { cwd: '/tmp', timeoutMs: 10_000 });
    assertExitWith(r, 1, /Not in a Vibecarbon project/i);
  });
});
