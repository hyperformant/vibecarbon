/**
 * tests/unit/helpers/deploy-to-plan.ts: the module stubs that take the real
 * executeDeployment to its plan. Each answer the deploy reads is pinned here,
 * and each builder that takes the real module keeps its other exports.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  configOverStore,
  localBuildNoCi,
  mintedAppStorageKey,
  noDeployDelta,
  preflightPasses,
} from './deploy-to-plan.js';
import { projectConfigStore } from './project-config-store.js';

const real = { keep: () => 'real', collectDeployDelta: () => 'real' };

describe('configOverStore', () => {
  it('reads a copy of the current store, null before one is set', () => {
    let store: ReturnType<typeof projectConfigStore> | null = null;
    const config = configOverStore(real, () => store);
    expect(config.loadProjectConfig()).toBeNull();
    store = projectConfigStore({ projectName: 'p' });
    const read = config.loadProjectConfig();
    expect(read).toEqual({ projectName: 'p' });
    expect(read).not.toBe(store.state.disk);
  });

  it('writes through the current store, and nothing before one is set', () => {
    let store: ReturnType<typeof projectConfigStore> | null = null;
    const config = configOverStore(real, () => store);
    expect(config.updateProjectConfig((c) => ({ ...c, a: 1 }))).toBeUndefined();
    store = projectConfigStore({});
    config.updateProjectConfig((c) => ({ ...c, a: 1 }));
    expect(store.lastWrite()).toEqual({ a: 1 });
  });

  it('registers nothing and keeps the real exports', () => {
    const config = configOverStore(real, () => null) as Record<string, unknown>;
    expect((config.registerProject as () => unknown)()).toBeUndefined();
    expect(config.keep).toBe(real.keep);
  });
});

describe('noDeployDelta', () => {
  it('has no change to show, over the real module', () => {
    const delta = noDeployDelta(real) as Record<string, unknown>;
    expect((delta.collectDeployDelta as () => unknown)()).toEqual({});
    expect((delta.formatDeployDeltaLines as () => unknown)()).toEqual([]);
    expect(delta.keep).toBe(real.keep);
  });
});

describe('preflightPasses', () => {
  it('is the four preflight exports, passing, fresh per call', () => {
    const preflight = preflightPasses();
    expect(Object.keys(preflight).sort()).toEqual([
      'assertOperatorConfig',
      'assertScaffoldSupportsRoleFile',
      'checkDeployPrerequisites',
      'operatorCheckEnvs',
    ]);
    expect(vi.isMockFunction(preflight.assertOperatorConfig)).toBe(true);
    expect(preflight.assertOperatorConfig()).toBeUndefined();
    expect(preflight.assertScaffoldSupportsRoleFile()).toBeUndefined();
    expect(preflight.checkDeployPrerequisites()).toBeUndefined();
    expect(preflight.operatorCheckEnvs()).toEqual([]);
    expect(preflightPasses().assertOperatorConfig).not.toBe(preflight.assertOperatorConfig);
  });
});

describe('localBuildNoCi', () => {
  it('has no CI and builds locally, over the real module', () => {
    const ci = localBuildNoCi(real) as Record<string, unknown>;
    expect((ci.ciAvailable as () => unknown)()).toBe(false);
    expect((ci.resolveBuildMode as () => unknown)()).toBe('local');
    expect(ci.keep).toBe(real.keep);
  });
});

describe('mintedAppStorageKey', () => {
  it('mints an isolated AK/SK key with no record, as a vi.fn a case may answer', async () => {
    const cred = mintedAppStorageKey(real);
    await expect(cred.resolveAppStorageCredential()).resolves.toEqual({
      accessKey: 'AK',
      secretKey: 'SK',
      record: null,
      tier: 'isolated',
      scoping: 'mint',
    });
    expect(vi.isMockFunction(cred.resolveAppStorageCredential)).toBe(true);
    expect(vi.isMockFunction(cred.syncHetznerFences)).toBe(true);
    expect(cred.syncHetznerFences()).toBeUndefined();
    expect((cred as Record<string, unknown>).keep).toBe(real.keep);
  });
});
