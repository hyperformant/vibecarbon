/**
 * Module stubs for the tests that drive the real executeDeployment
 * (src/lib/deploy/orchestrator.js) up to its plan without touching the
 * operator's machine or a cloud. Each is the module a test's vi.mock factory
 * returns:
 *
 *   vi.mock('../../../src/lib/deploy/delta.js', async (orig) =>
 *     (await import('../helpers/deploy-to-plan.js')).noDeployDelta(await orig()),
 *   );
 *
 * A builder that takes `real` keeps every other export of the real module.
 * What a test stubs for its own case (the plan runner, the state tracker, the
 * storage provider, the spinner) stays in that test.
 */
import { vi } from 'vitest';
import type { projectConfigStore } from './project-config-store.js';

type Module = Record<string, unknown>;

/**
 * src/lib/config.js over a projectConfigStore: the project config is read from
 * the store's disk (a copy, or null before a store is set) and written through
 * its updateProjectConfig, and registering the project in the operator's home
 * does nothing. `current` is read at each call, so a test may swap stores.
 */
export function configOverStore(
  real: unknown,
  current: () => ReturnType<typeof projectConfigStore> | null,
) {
  return {
    ...(real as Module),
    loadProjectConfig: () => structuredClone(current()?.state.disk ?? null),
    updateProjectConfig: (fn: (c: Record<string, unknown>) => unknown) =>
      current()?.updateProjectConfig(fn),
    registerProject: () => {},
  };
}

/** src/lib/deploy/delta.js with no change to show before the deploy. */
export function noDeployDelta(real: unknown) {
  return {
    ...(real as Module),
    collectDeployDelta: () => ({}),
    formatDeployDeltaLines: () => [],
  };
}

/**
 * src/lib/deploy/preflight.js passing: the operator config, the local tools
 * and the scaffold's role file are all in order, and no operator env is read.
 * Only these four exports; a fresh vi.fn each per mocked module.
 */
export function preflightPasses() {
  return {
    assertOperatorConfig: vi.fn(),
    assertScaffoldSupportsRoleFile: vi.fn(),
    checkDeployPrerequisites: vi.fn(),
    operatorCheckEnvs: () => [],
  };
}

/** src/lib/ci-setup.js with no CI to push to: the app image builds locally. */
export function localBuildNoCi(real: unknown) {
  return {
    ...(real as Module),
    ciAvailable: () => false,
    resolveBuildMode: () => 'local',
  };
}

/**
 * src/lib/deploy/app-storage-credential.js handing the app a freshly minted,
 * isolated key (AK/SK) with no record, and syncing no Hetzner fences. Both are
 * vi.fn, so a case may answer resolveAppStorageCredential differently.
 */
export function mintedAppStorageKey(real: unknown) {
  return {
    ...(real as Module),
    resolveAppStorageCredential: vi.fn(async () => ({
      accessKey: 'AK',
      secretKey: 'SK',
      record: null,
      tier: 'isolated',
      scoping: 'mint',
    })),
    syncHetznerFences: vi.fn(),
  };
}
