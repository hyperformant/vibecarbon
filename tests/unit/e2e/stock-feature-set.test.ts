/**
 * Every e2e run is a stock deploy: the app and its database, no add-ons
 * (owner decision 2026-11-15). These tests pin the baseline, how a run's
 * feature set is chosen (an absent `--features` is never an override), and
 * that with the stock set every add-on-dependent check is off or skips,
 * never fails, and never reaches for a server.
 */
import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../config.js';
import { checkAddonsReady } from '../../e2e/checks/addons-ready.js';
import {
  checkN8nKeyShared,
  checkPromotedAddonsReady,
  checkPromotedPrimaryOnlyRunning,
  checkStandbyPrimaryOnlyAbsent,
} from '../../e2e/checks/standby-addons.js';
import {
  observabilityPlanForStep,
  provesObservabilityAfterReconverge,
} from '../../e2e/scenarios/observability-step-plan.js';
import { type DeployMode, STEP_NAMES } from '../../e2e/scenarios/types.js';
import {
  describeFeaturesRecord,
  isStockFeatures,
  isStockFeaturesRecord,
  parseFeaturesArg,
  resolveRunFeatures,
} from '../../e2e/utils/feature-set.js';

const MODES: DeployMode[] = ['compose', 'compose-ha', 'k8s', 'k8s-ha'];
const STOCK = testConfig.e2e.features;

describe('the e2e baseline', () => {
  it('is stock: no add-ons, not even observability', () => {
    expect([...STOCK]).toEqual([]);
    expect(isStockFeatures(STOCK)).toBe(true);
  });
});

describe('parseFeaturesArg', () => {
  it('is null when the flag is absent', () => {
    expect(parseFeaturesArg([])).toBeNull();
    expect(parseFeaturesArg(['--batch', '--provider', 'hetzner'])).toBeNull();
  });

  it('reads both spellings', () => {
    expect(parseFeaturesArg(['--features=observability, redis'])).toEqual([
      'observability',
      'redis',
    ]);
    expect(parseFeaturesArg(['--batch', '--features', 'observability,redis'])).toEqual([
      'observability',
      'redis',
    ]);
  });

  it('is an empty list when the flag is given without a value', () => {
    expect(parseFeaturesArg(['--features='])).toEqual([]);
    expect(parseFeaturesArg(['--features'])).toEqual([]);
    // The next flag is not a feature name.
    expect(parseFeaturesArg(['--features', '--batch'])).toEqual([]);
  });
});

describe('resolveRunFeatures', () => {
  it('falls through null and undefined alike to the stock baseline', () => {
    // The runner's own case: no option, no flag (parseFeaturesArg -> null).
    expect(resolveRunFeatures(undefined, null, STOCK)).toEqual([]);
    expect(resolveRunFeatures(null, undefined, STOCK)).toEqual([]);
    expect(resolveRunFeatures(undefined, parseFeaturesArg(['--batch']), STOCK)).toBe(STOCK);
  });

  it('takes the option first, then the flag, an empty list included', () => {
    expect(resolveRunFeatures(['redis'], ['observability'], STOCK)).toEqual(['redis']);
    expect(resolveRunFeatures(undefined, ['observability'], STOCK)).toEqual(['observability']);
    expect(resolveRunFeatures([], ['observability'], STOCK)).toEqual([]);
  });
});

describe('isStockFeaturesRecord', () => {
  it('only a JSON empty list is stock', () => {
    expect(isStockFeaturesRecord('[]')).toBe(true);
    expect(isStockFeaturesRecord(' [ ] ')).toBe(true);
    for (const raw of ['["observability"]', 'null', '{}', '', 'not json', null, undefined]) {
      expect(isStockFeaturesRecord(raw), String(raw)).toBe(false);
    }
  });

  it('describes a record for a log line', () => {
    expect(describeFeaturesRecord('["observability","redis"]')).toBe('observability, redis');
    expect(describeFeaturesRecord('[]')).toBe('none');
    expect(describeFeaturesRecord(null)).toBe('features not recorded');
    expect(describeFeaturesRecord('nope')).toMatch(/^unreadable features/);
  });
});

describe('with the stock set, every add-on check is off or skips', () => {
  it('observability is off at every step in every mode', () => {
    for (const mode of MODES) {
      for (const step of STEP_NAMES) {
        expect(observabilityPlanForStep(step, mode, STOCK), `${mode} ${step}`).toEqual({
          kind: 'off',
        });
      }
      expect(provesObservabilityAfterReconverge(mode, STOCK), mode).toBe(false);
    }
  });

  it('addons_ready skips in every mode without touching a server', async () => {
    for (const mode of MODES) {
      const run = vi.fn();
      const r = await checkAddonsReady({
        mode,
        projectName: 'demo',
        features: STOCK,
        ip: '203.0.113.9',
        sshKeyPath: '/k',
        run,
      });
      expect(r.status, mode).toBe('skip');
      expect(run).not.toHaveBeenCalled();
    }
  });

  it('every standby add-on check skips, even with no SSH handle', async () => {
    for (const mode of ['compose-ha', 'k8s-ha'] as const) {
      const run = vi.fn();
      const opts = { mode, projectName: 'demo', sshKeyPath: null, features: STOCK, run };
      const results = [
        await checkStandbyPrimaryOnlyAbsent({ ...opts, standbyIp: null }),
        await checkPromotedPrimaryOnlyRunning({ ...opts, primaryIp: null }),
        await checkPromotedAddonsReady({ ...opts, primaryIp: null }),
        await checkN8nKeyShared({ ...opts, primaryIp: null, standbyIp: null }),
      ];
      for (const r of results) expect(r.status, `${mode} ${r.checkName}`).toBe('skip');
      expect(run).not.toHaveBeenCalled();
    }
  });
});
