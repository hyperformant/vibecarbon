/**
 * Which step proves observability, per mode.
 *
 * Run 2026-10-20 (Hetzner k8s-ha): verify-failover failed
 * grafana_route_protected ("served 200 without a cookie") and grafana_health /
 * prometheus_targets ("200 but not JSON (text/html)"). That 200 was the app's
 * SPA: a k8s-ha pilot-light standby never installs observability, so the
 * cluster failover promoted has no Grafana until reconverge-deploy. These
 * tests pin the split: k8s-ha verify-failover records the three checks as
 * skips naming that design, compose-ha and every other step still run them,
 * and the post-reconverge path runs them and surfaces any failure.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  OBSERVABILITY_CHECK_NAMES,
  observabilityPlanForStep,
  observabilitySkipResults,
  provesObservabilityAfterReconverge,
  runPostReconvergeObservability,
} from '../../e2e/scenarios/observability-step-plan.js';
import type { VerificationResult } from '../../e2e/scenarios/types.js';

const OBS = ['observability'];
const DOMAIN = 'e4-h1-abc.appcarbon.dev';

const pass = (checkName: string): VerificationResult => ({ checkName, status: 'pass' });
const fail = (checkName: string, errorMessage: string): VerificationResult => ({
  checkName,
  status: 'fail',
  errorMessage,
});

describe('observabilityPlanForStep', () => {
  it('skips at k8s-ha verify-failover with a reason naming the pilot-light design', () => {
    const plan = observabilityPlanForStep('verify-failover', 'k8s-ha', OBS);
    expect(plan.kind).toBe('skip');
    if (plan.kind !== 'skip') return;
    expect(plan.reason).toMatch(/pilot-light/);
    expect(plan.reason).toMatch(/reconverge-deploy/);
  });

  it('runs at compose-ha verify-failover (its standby runs the full stack)', () => {
    expect(observabilityPlanForStep('verify-failover', 'compose-ha', OBS)).toEqual({
      kind: 'run',
    });
  });

  it.each([
    ['verify-deploy', 'k8s-ha'],
    ['verify-scale', 'k8s-ha'],
    ['verify-restore', 'k8s-ha'],
    ['verify-deploy', 'k8s'],
    ['verify-deploy', 'compose'],
    ['verify-deploy', 'compose-ha'],
  ])('runs at %s for %s', (step, mode) => {
    expect(observabilityPlanForStep(step, mode, OBS)).toEqual({ kind: 'run' });
  });

  it('is off when the observability feature is not enabled, even at k8s-ha verify-failover', () => {
    expect(observabilityPlanForStep('verify-failover', 'k8s-ha', ['redis'])).toEqual({
      kind: 'off',
    });
    expect(observabilityPlanForStep('verify-deploy', 'k8s', [])).toEqual({ kind: 'off' });
  });
});

describe('observabilitySkipResults', () => {
  it('records every observability check as a skip carrying the reason', () => {
    const results = observabilitySkipResults('why');
    expect(results.map((r) => r.checkName)).toEqual([...OBSERVABILITY_CHECK_NAMES]);
    for (const r of results) {
      expect(r.status).toBe('skip');
      expect(r.details).toEqual({ skipped: true, reason: 'why' });
    }
  });

  it('names the same checks runObservabilityChecks reports', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../e2e/checks/feature-observability.ts', import.meta.url)),
      'utf-8',
    );
    for (const name of OBSERVABILITY_CHECK_NAMES) expect(src).toContain(`'${name}'`);
  });
});

describe('provesObservabilityAfterReconverge', () => {
  it('is true for k8s-ha with observability', () => {
    expect(provesObservabilityAfterReconverge('k8s-ha', OBS)).toBe(true);
  });

  it.each([
    ['compose-ha', OBS],
    ['k8s', OBS],
    ['k8s-ha', []],
  ])('is false for %s with features %j', (mode, features) => {
    expect(provesObservabilityAfterReconverge(mode, features)).toBe(false);
  });
});

describe('runPostReconvergeObservability', () => {
  const jar = { tag: 'fresh-admin-jar' };

  it('signs in afresh and runs the k8s observability checks with that jar', async () => {
    const signIn = vi.fn(async () => ({ result: pass('auth_admin_login'), jar }));
    const runChecks = vi.fn(async () => OBSERVABILITY_CHECK_NAMES.map(pass));
    const results = await runPostReconvergeObservability(
      { domain: DOMAIN, adminEmail: 'a@b.c', adminPassword: 'pw', attempts: 12 },
      { signIn, runChecks },
    );
    expect(signIn).toHaveBeenCalledWith(DOMAIN, 'a@b.c', 'pw');
    expect(runChecks).toHaveBeenCalledWith(
      expect.objectContaining({ appDomain: DOMAIN, isCompose: false, adminJar: jar, attempts: 12 }),
    );
    expect(results.map((r) => r.checkName)).toEqual([
      'auth_admin_login',
      ...OBSERVABILITY_CHECK_NAMES,
    ]);
    expect(results.every((r) => r.status === 'pass')).toBe(true);
  });

  it('surfaces an observability failure (the SPA 200 that reddened verify-failover)', async () => {
    const results = await runPostReconvergeObservability(
      { domain: DOMAIN, adminEmail: 'a@b.c', adminPassword: 'pw' },
      {
        signIn: async () => ({ result: pass('auth_admin_login'), jar }),
        runChecks: async () => [
          fail('grafana_route_protected', 'served 200 without a cookie'),
          fail('grafana_health', '200 but not JSON (text/html)'),
          fail('prometheus_targets', '200 but not JSON (text/html)'),
        ],
      },
    );
    expect(results.filter((r) => r.status === 'fail').map((r) => r.checkName)).toEqual([
      ...OBSERVABILITY_CHECK_NAMES,
    ]);
  });

  it('keeps the failed sign-in as a fail and passes no jar to the checks', async () => {
    const runChecks = vi.fn(async () => [pass('grafana_route_protected')]);
    const results = await runPostReconvergeObservability(
      { domain: DOMAIN, adminEmail: 'a@b.c', adminPassword: 'pw' },
      { signIn: async () => ({ result: fail('auth_admin_login', '401') }), runChecks },
    );
    expect(results[0]).toMatchObject({ checkName: 'auth_admin_login', status: 'fail' });
    expect(runChecks).toHaveBeenCalledWith(
      expect.objectContaining({
        adminJar: undefined,
        adminUnavailableReason: expect.stringMatching(/reconverge-deploy/),
      }),
    );
  });

  it('fails, never skips, when admin credentials are missing', async () => {
    const signIn = vi.fn();
    const runChecks = vi.fn();
    const results = await runPostReconvergeObservability(
      { domain: DOMAIN, adminEmail: undefined, adminPassword: 'pw' },
      { signIn, runChecks },
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ checkName: 'auth_admin_login', status: 'fail' });
    expect(signIn).not.toHaveBeenCalled();
    expect(runChecks).not.toHaveBeenCalled();
  });
});

describe('lifecycle wiring', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../e2e/scenarios/_run-lifecycle.ts', import.meta.url)),
    'utf-8',
  );

  it('runVerificationChecks gates runObservabilityChecks on the step plan', () => {
    const planAt = src.indexOf('observabilityPlanForStep(stepName, config.mode, config.features)');
    expect(planAt).toBeGreaterThan(-1);
    const block = src.slice(planAt, planAt + 1500);
    expect(block).toContain('observabilitySkipResults(obsPlan.reason)');
    expect(block).toContain("obsPlan.kind === 'run'");
    expect(block).toContain('runObservabilityChecks(');
    // The old unconditional gate is gone.
    expect(src).not.toMatch(/if \(config\.features\.includes\('observability'\)\)/);
  });

  it('reconverge-deploy runs the observability checks after the deploy and throws on a fail', () => {
    const stepAt = src.indexOf("name: 'reconverge-deploy'");
    expect(stepAt).toBeGreaterThan(-1);
    const step = src.slice(stepAt);
    const deployAt = step.indexOf('runDeploy(');
    const proveAt = step.indexOf(
      'provesObservabilityAfterReconverge(config.mode, config.features)',
    );
    const runAt = step.indexOf('runPostReconvergeObservability(');
    expect(deployAt).toBeGreaterThan(-1);
    expect(proveAt).toBeGreaterThan(deployAt);
    expect(runAt).toBeGreaterThan(proveAt);
    const tail = step.slice(runAt, runAt + 2500);
    expect(tail).toContain('signIn: adminSignIn, runChecks: runObservabilityChecks');
    expect(tail).toContain("filter((r) => r.status === 'fail')");
    expect(tail).toContain('throw new Error(');
  });
});
