import { describe, expect, it } from 'vitest';
import { composeServerStateSpec } from '../../../src/lib/iac/server-state.js';
import { testConfig } from '../../config.js';

/**
 * A compose scenario skips `scale` exactly where the CLI refuses it
 * (assertComposeScaleKeepsState reads composeServerStateSpec). Scaleway's
 * compose-ha row lacked the skip and failed the final run at a step that could
 * only ever refuse; the census also stops a skip outliving the refusal and
 * quietly dropping scale coverage from a provider that gains support.
 */
const composeScenarios = Object.entries(testConfig.e2e.providers).flatMap(([provider, entry]) =>
  entry.scenarios
    .filter((s) => s.mode === 'compose' || s.mode === 'compose-ha')
    .map((s) => ({ provider, ...s })),
);

describe('compose scale skips follow the CLI refusal', () => {
  it('walks every provider with a compose scenario', () => {
    expect(new Set(composeScenarios.map((s) => s.provider)).size).toBeGreaterThanOrEqual(5);
  });

  it.each(composeScenarios.map((s) => [`${s.provider}/${s.mode}`, s] as const))(
    '%s',
    (_name, scenario) => {
      const skips = ('skipSteps' in scenario ? scenario.skipSteps : []) as readonly string[];
      if (composeServerStateSpec(scenario.provider)) {
        expect(skips).not.toContain('scale');
        expect(skips).not.toContain('verify-scale');
      } else {
        expect(skips).toEqual(expect.arrayContaining(['scale', 'verify-scale']));
      }
    },
  );
});
