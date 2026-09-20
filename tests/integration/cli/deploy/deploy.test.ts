/**
 * vibecarbon deploy — flag matrix against a real project.
 *
 * Real Pulumi-driven success-path tests live in tests/integration/cloud/.
 * Here: help, flag parsing, mode/region validation, project guard.
 */
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  realProject,
  runCli,
} from '../../_harness/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BLOCK_HETZNER_FETCH = join(HERE, '_fixtures', 'block-hetzner-fetch.mjs');

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

  // Task 4 (operator config hygiene): a malformed-but-PRESENT operator
  // credential must stop the deploy before any provisioning, listing every
  // problem at once — not one live-401 / one Pulumi failure at a time.
  //
  // HETZNER_API_TOKEN is quoted and the wrong length (never a real token —
  // 20 filler characters): after operator-env.js's normalizer strips the
  // quotes it is a clean, non-empty string, so hetzner-guided-setup.js's
  // pre-existing live token check (unrelated to this task) still runs. That
  // check treats an unreachable Hetzner API as "proceed with the token as
  // given" (the same fallback a real network blip hits), so
  // BLOCK_HETZNER_FETCH simulates exactly that outage deterministically —
  // otherwise this test's result would depend on whether the sandbox
  // running it can reach the real internet. Once config is gathered, THIS
  // task's preflight (orchestrator.js, before checkDeployPrerequisites)
  // is what actually stops the deploy — see the malformed shape
  // (`expected 64 alphanumeric characters`) fail validateOperatorValue.
  it('refuses a malformed operator credential before any provisioning', () => {
    appendFileSync(
      join(project, '.env.local'),
      [
        '',
        `HETZNER_API_TOKEN="${'a'.repeat(20)}"`,
        'HETZNER_ACCESS_KEY=fake-access-key-id',
        'HETZNER_SECRET_KEY=fake-secret-key-not-real',
        '',
      ].join('\n'),
    );

    const r = runCli('deploy', ['prod', '-y', '-provider', 'hetzner'], {
      cwd: project,
      timeoutMs: 90_000,
      env: { NODE_OPTIONS: `--import=${BLOCK_HETZNER_FETCH}` },
    });

    assertExitWith(r, 1, 'Configuration problems (nothing was provisioned):');
    assertExitWith(r, 1, /HETZNER_API_TOKEN/);
    assertExitWith(r, 1, 'Set them in .env.local');
    // No provisioning-side output: the very next line after this task's
    // preflight in the real flow is the operator-IP-access spinner.
    if (/Checking operator IP access/.test(r.stdout + r.stderr)) {
      throw new Error(`deploy provisioned past the config gate:\n${r.stdout}\n${r.stderr}`);
    }
  });
});
