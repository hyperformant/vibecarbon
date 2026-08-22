import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — plain JS ops script, no types
import { isE2eScratchResource, scratchPrefixFor } from '../../../scripts/sweep-hetzner.js';

// `E2E_SCRATCH_PREFIX` and the default `prefix` of `isE2eScratchResource` are
// derived from `process.env.E2E_NAMESPACE` at *import time*. The e2e workflow
// exports `E2E_NAMESPACE=ci`, a laptop leaves it unset — so any assertion that
// reads that ambient-derived default is flaky (green locally, red in CI, or the
// reverse). To pin the env-derived behavior deterministically, re-import the
// module under an explicit namespace; everywhere else we pass an explicit
// prefix so the ambient env can never leak into the assertion.
async function loadWithNamespace(namespace: string) {
  vi.resetModules();
  vi.stubEnv('E2E_NAMESPACE', namespace);
  // @ts-expect-error — plain JS ops script, no types
  return import('../../../scripts/sweep-hetzner.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('sweep-hetzner scope', () => {
  it('sweeps default-namespace scratch resources (testapp-*)', async () => {
    const mod = await loadWithNamespace('');
    expect(mod.E2E_SCRATCH_PREFIX).toBe('testapp-');
    expect(mod.isE2eScratchResource('testapp-compose-ha-123-e2-primary')).toBe(true);
    expect(mod.isE2eScratchResource('testapp-k8s-ha-abc-e4-standby-firewall')).toBe(true);
  });

  it('sweeps ci-namespaced scratch resources (citest-*) when E2E_NAMESPACE=ci', async () => {
    const mod = await loadWithNamespace('ci');
    expect(mod.E2E_SCRATCH_PREFIX).toBe('citest-');
    expect(mod.isE2eScratchResource('citest-compose-123-ci1-primary')).toBe(true);
  });

  it('SAFETY: never sweeps a real deployment that merely shares the managed-by label', () => {
    // These carry `managed-by=vibecarbon` but are NOT e2e scratch — the sweep
    // must leave them alone or it would take down production infra. False under
    // any scratch prefix, so this holds regardless of the ambient namespace.
    for (const prefix of ['testapp-', 'citest-']) {
      expect(isE2eScratchResource('vibecarbon-web-prod', prefix)).toBe(false);
      expect(isE2eScratchResource('vibecarbon-web-prod-firewall', prefix)).toBe(false);
      expect(isE2eScratchResource('vibecarbon-web-prod-hil-key', prefix)).toBe(false);
      expect(isE2eScratchResource('prod', prefix)).toBe(false);
      expect(isE2eScratchResource('my-testapp-clone', prefix)).toBe(false); // prefix, not substring
    }
  });

  it('tolerates missing/non-string names', () => {
    expect(isE2eScratchResource(undefined, 'testapp-')).toBe(false);
    expect(isE2eScratchResource(null, 'testapp-')).toBe(false);
    expect(isE2eScratchResource(123, 'testapp-')).toBe(false);
  });
});

describe('namespace scoping (E2E_NAMESPACE)', () => {
  it('derives the same prefixes as tests/e2e/utils/namespace.ts', () => {
    expect(scratchPrefixFor('')).toBe('testapp-');
    expect(scratchPrefixFor('ci')).toBe('citest-');
  });

  it('a ci-namespaced sweep never matches default-namespace resources (and vice versa)', () => {
    const ciPrefix = scratchPrefixFor('ci');
    const defaultPrefix = scratchPrefixFor('');
    expect(isE2eScratchResource('citest-compose-123-ci1-primary', ciPrefix)).toBe(true);
    expect(isE2eScratchResource('testapp-compose-123-e1-primary', ciPrefix)).toBe(false);
    expect(isE2eScratchResource('citest-compose-123-ci1-primary', defaultPrefix)).toBe(false);
    expect(isE2eScratchResource('testapp-compose-123-e1-primary', defaultPrefix)).toBe(true);
  });
});
