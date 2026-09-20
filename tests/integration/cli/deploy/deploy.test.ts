/**
 * vibecarbon deploy — flag matrix against a real project.
 *
 * Real Pulumi-driven success-path tests live in tests/integration/cloud/.
 * Here: help, flag parsing, mode/region validation, project guard.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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
import { FETCH_TRIPWIRE_SENTINEL } from './_fixtures/fetch-tripwire-sentinel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FETCH_TRIPWIRE = join(HERE, '_fixtures', 'fetch-tripwire.mjs');

/** Progress strings that only ever print from INSIDE gatherDeploymentConfig
 * or the step-1b lockfile guarantee — both run strictly after Gate 1
 * (src/deploy.js, before gatherDeploymentConfig is even called). Their
 * absence is what proves a Gate-1 refusal happened before any of that ran,
 * not just before provisioning. */
const PAST_GATE_1 = [
  "Checking this project's subscription", // licence check (paid tiers only)
  'Generating package-lock.json', // step 1b, real npm install
  'Checking operator IP access', // orchestrator, well past both
];

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

  // Operator config hygiene (fix round): a malformed-but-PRESENT operator
  // credential must stop the deploy before the FIRST network call it would
  // otherwise make — not just before provisioning. The original version of
  // this test ran past Gate 1 into gatherDeploymentConfig, where the
  // provider token's live verification (hetzner-guided-setup.js) and
  // fetchServerTypes() both fire before this task's code ever got a look —
  // review caught that this test proved the wrong thing. Gate 1
  // (src/deploy.js, before gatherDeploymentConfig is even called) is what
  // actually stops it now, using only what's knowable from the `-provider`
  // flag: no fake S3 keys, no live-verification workaround needed, because
  // nothing downstream of Gate 1 ever runs.
  //
  // FETCH_TRIPWIRE makes the proof airtight instead of inferred: it turns
  // ANY fetch() in the child into a printed sentinel + rejection, so
  // asserting the sentinel's absence is a checkable fact about this run,
  // not just "the test happened not to hit one".
  it('refuses a malformed operator credential before the first network call', () => {
    appendFileSync(join(project, '.env.local'), `\nHETZNER_API_TOKEN="${'a'.repeat(20)}"\n`);

    const r = runCli('deploy', ['prod', '-y', '-provider', 'hetzner'], {
      cwd: project,
      timeoutMs: 20_000,
      env: { NODE_OPTIONS: `--import=${FETCH_TRIPWIRE}` },
    });

    assertExitWith(r, 1, 'Configuration problems (nothing was provisioned):');
    assertExitWith(r, 1, /HETZNER_API_TOKEN/);
    assertExitWith(r, 1, 'Set them in .env.local');

    const out = `${r.stdout}\n${r.stderr}`;
    if (out.includes(FETCH_TRIPWIRE_SENTINEL)) {
      throw new Error(`deploy made a network call before the config gate:\n${out}`);
    }
    for (const marker of PAST_GATE_1) {
      if (out.includes(marker)) {
        throw new Error(`deploy ran past Gate 1 ("${marker}" printed):\n${out}`);
      }
    }
  });

  // Gate 1's access/tls/state scopes are ALWAYS checked, independent of
  // whether the provider/DNS are known yet — proven here on an EXISTING
  // environment (persisted `provider`/`deployMode`, no `-provider` flag
  // needed) so the scenario is a realistic redeploy, not a new-environment
  // edge case. ACME_CA_SERVER is checked purely locally (regex, no guided
  // setup, no provider), so this also demonstrates the gate does not need
  // ANY provider/DNS credential in hand to already be useful.
  it("Gate 1's always-known scopes refuse a malformed value before anything else (existing environment)", () => {
    const configPath = join(project, '.vibecarbon.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.environments = {
      prod: {
        provider: 'hetzner',
        deployMode: 'compose',
        region: 'nbg1',
        domain: 'prod.example.com',
        status: 'deployed',
      },
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    // ACME_CA_SERVER is runtime-config that lives in `.env` for the SERVER
    // (docker-compose.prod.yml interpolates it); the CLI's own read of it
    // (orchestrator.js / tls-ready.js staging detection, and this gate) is
    // from the operator shell, which is how the e2e harness sets it too
    // (tests/e2e/utils/e2e-env.js). It is NOT operator-secret, so
    // bootstrapOperatorEnv never folds it in from .env.local — hence the
    // shell env here, not a file append.
    const r = runCli('deploy', ['prod', '-y'], {
      cwd: project,
      timeoutMs: 20_000,
      env: { NODE_OPTIONS: `--import=${FETCH_TRIPWIRE}`, ACME_CA_SERVER: 'not-a-url' },
    });

    assertExitWith(r, 1, 'Configuration problems (nothing was provisioned):');
    assertExitWith(r, 1, /ACME_CA_SERVER/);

    const out = `${r.stdout}\n${r.stderr}`;
    if (out.includes(FETCH_TRIPWIRE_SENTINEL)) {
      throw new Error(`deploy made a network call before the config gate:\n${out}`);
    }
    for (const marker of PAST_GATE_1) {
      if (out.includes(marker)) {
        throw new Error(`deploy ran past Gate 1 ("${marker}" printed):\n${out}`);
      }
    }
  });
});
