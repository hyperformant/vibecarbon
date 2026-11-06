import { describe, expect, it } from 'vitest';
import { composeServerStateSpec } from '../../../src/lib/iac/server-state.js';
import { testConfig } from '../../config.js';

/**
 * Every provider runs compose scale, so every compose scenario runs it: a skip
 * here hides a product gap rather than saving test time. Scale replaces a
 * server outside Pulumi, so a provider also needs a state spec, or the next
 * deploy would build a second server. A new provider without one fails here.
 */
const composeScenarios = Object.entries(testConfig.e2e.providers).flatMap(([provider, entry]) =>
  entry.scenarios
    .filter((s) => s.mode === 'compose' || s.mode === 'compose-ha')
    .map((s) => ({ provider, ...s })),
);

describe('compose scale runs on every provider', () => {
  it('walks every provider with a compose scenario', () => {
    expect(new Set(composeScenarios.map((s) => s.provider)).size).toBeGreaterThanOrEqual(5);
  });

  it.each(composeScenarios.map((s) => [`${s.provider}/${s.mode}`, s] as const))(
    '%s',
    (_name, scenario) => {
      const skips = ('skipSteps' in scenario ? scenario.skipSteps : []) as readonly string[];
      expect(composeServerStateSpec(scenario.provider)).not.toBeNull();
      expect(skips).not.toContain('scale');
      expect(skips).not.toContain('verify-scale');
    },
  );
});
