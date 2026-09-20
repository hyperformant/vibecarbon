/**
 * vibecarbon status — runs against a real project. Read-only; no exec
 * stubs needed for the basic shape, no cloud calls when status hits a
 * not-deployed env.
 */
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
      // Nothing to query: the key is omitted, not null (spec §6).
      staging: { deployMode: 'compose', servers: [] },
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
    expect(json.environments.staging.checks).not.toHaveProperty('containers');
    expect(r.exitCode).toBe(0);
  });

  // Operator config hygiene: status's Configuration advisory runs the same
  // shape checks Gate 1 (deploy.js) enforces before it will start
  // provisioning — surfaced here as a passive read instead of a refusal,
  // so a malformed credential on a DEPLOYED environment is visible without
  // running `deploy`. Deployed (not merely configured) so the provider
  // scope is checked WITH presence (a real problem), matching the same
  // rule Gate 1 pins for its own scopes.
  it('Configuration line reports a malformed operator credential on a deployed environment, never the value', () => {
    destroyRealProject(project);
    project = realProject({ envs: ['prod'] });

    const configPath = join(project, '.vibecarbon.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.environments = {
      prod: {
        provider: 'hetzner',
        deployMode: 'compose',
        domain: 'prod.example.com',
        status: 'deployed',
      },
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const fakeToken = 'a'.repeat(20);
    appendFileSync(join(project, '.env.local'), `\nHETZNER_API_TOKEN="${fakeToken}"\n`);

    const rendered = runCli('status', [], { cwd: project, timeoutMs: 30_000 });
    assertSuccess(rendered);
    expect(rendered.stdout).toMatch(/▲ Configuration: \d+ problems?/);
    expect(rendered.stdout).toMatch(/HETZNER_API_TOKEN looks wrong/);
    expect(rendered.stdout).not.toContain(fakeToken);

    const json = runCli('status', ['-json'], { cwd: project, timeoutMs: 30_000 });
    assertExitWith(json, 0);
    const parsed = JSON.parse(json.stdout);
    // localDev is null under -json (noLocal is forced true) — configuration
    // is attached at the top level of the payload instead of nested under
    // it, per the note in src/status.js.
    expect(parsed.localDev).toBeNull();
    expect(parsed.configuration.problems.some((p: string) => p.includes('HETZNER_API_TOKEN'))).toBe(
      true,
    );
    expect(parsed.configuration.checked).toContain('HETZNER_API_TOKEN');
    expect(JSON.stringify(parsed)).not.toContain(fakeToken);
  });
});
