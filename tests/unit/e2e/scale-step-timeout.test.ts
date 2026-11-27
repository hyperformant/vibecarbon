import { describe, expect, it } from 'vitest';
import { readRepoFile } from '../../_shared/source-files.js';
import { testConfig } from '../../config.js';
import { SCALE_STEP_TIMEOUT_MS, scaleStepTimeoutMs } from '../../e2e/scenarios/scale-timeout.js';
import type { Provider } from '../../e2e/scenarios/types.js';

const providers = Object.keys(testConfig.e2e.providers) as Provider[];

describe('the scale step budget follows the provider', () => {
  it('holds two serial Vultr stacks of migrating resizes', () => {
    // Run 45922250720: one standby stack was still resizing 20.3 min in.
    expect(scaleStepTimeoutMs('vultr')).toBe(60 * 60_000);
    expect(scaleStepTimeoutMs('vultr')).toBeGreaterThan(2 * 25 * 60_000);
  });

  it.each(providers.filter((p) => p !== 'vultr'))('%s keeps the 35 min default', (provider) => {
    expect(scaleStepTimeoutMs(provider)).toBe(SCALE_STEP_TIMEOUT_MS);
    expect(SCALE_STEP_TIMEOUT_MS).toBe(35 * 60_000);
  });

  it('no provider gets less than the default', () => {
    for (const p of providers)
      expect(scaleStepTimeoutMs(p)).toBeGreaterThanOrEqual(SCALE_STEP_TIMEOUT_MS);
  });

  it('the lifecycle passes the provider budget to runScale, and nothing else times the step', () => {
    const src = readRepoFile('tests/e2e/scenarios/_run-lifecycle.ts');
    const calls = [...src.matchAll(/runScale\(config\.envPrefix, \{[\s\S]*?\n\s+\}\);/g)].map(
      (m) => m[0],
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('timeout: scaleStepTimeoutMs(config.provider),');
    expect(src).not.toMatch(/TIMEOUTS\.scale\b|TIMEOUTS\['scale'\]/);
  });
});
