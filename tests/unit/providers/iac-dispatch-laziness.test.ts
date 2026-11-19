/**
 * CD2 hard constraint: no top-level `@pulumi/*` import may enter the
 * provider module graph (base.js, index.js and every provider module).
 * status.js and deploy.js import the provider CLASS at CLI startup on EVERY
 * command; if a Pulumi SDK loaded as a side effect of that import, every
 * command (not just deploy/scale) would pay its load cost, a
 * startup-latency regression.
 *
 * Mechanism: every Pulumi package this repo depends on (each `@pulumi/*` and
 * `@pulumiverse/*` in package.json, so a new provider's SDK is covered when
 * it is added there) is replaced by a factory that throws the moment it is
 * actually evaluated. A mock factory runs lazily, the first time some module
 * in the graph resolves that specifier, so this is a runtime assertion of
 * "was this package ever loaded", not a text scan of import statements.
 * Each case starts from a reset module graph, so it evaluates what it
 * imports instead of reading another case's cached copy. Vitest wraps a
 * factory-thrown error in its own "error when mocking a module" diagnostic,
 * which the self-checks match on.
 *
 *   - Importing base.js, providers/index.js or any provider module must NOT
 *     throw: none of them touched a Pulumi package.
 *   - Calling a provider's getComposeProgram()/getK8sProgram(), which
 *     dynamic-imports a program module that DOES import Pulumi at its own
 *     top level by design, MUST throw through the same mock. That is the
 *     self-check: it proves the mocks are armed (not bypassed by module
 *     caching or a wrong specifier), so the "must not throw" cases mean
 *     something. One per tier each registered provider sells.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Read for the provider ids and tiers only. This load runs before the mocks
// below are armed; every case resets the module graph and imports again
// under them.
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { readRepoFile } from '../../_shared/source-files.js';

const PULUMI_PACKAGES = Object.keys(JSON.parse(readRepoFile('package.json')).dependencies).filter(
  (name) => /^@pulumi(verse)?\//.test(name),
);
for (const name of PULUMI_PACKAGES) {
  vi.doMock(name, () => {
    throw new Error(`${name} must not load eagerly`);
  });
}

const PROGRAMS = Object.entries(PROVIDERS).flatMap(([id, Provider]) =>
  [
    { method: 'getComposeProgram', tier: 'compose' },
    { method: 'getK8sProgram', tier: 'k8s' },
  ]
    .filter(({ tier }) => Provider.SUPPORTED_TIERS.includes(tier))
    .map(({ method }) => ({ id, method })),
);

describe('provider module graph never loads @pulumi/* eagerly (CD2)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('arms a mock for @pulumi/pulumi and the provider SDKs', () => {
    expect(PULUMI_PACKAGES).toContain('@pulumi/pulumi');
    expect(PULUMI_PACKAGES).toContain('@pulumi/hcloud');
  });

  it('importing base.js does not touch @pulumi/*', async () => {
    await expect(import('../../../src/lib/providers/base.js')).resolves.toBeDefined();
  });

  it('importing providers/index.js does not touch @pulumi/*', async () => {
    await expect(import('../../../src/lib/providers/index.js')).resolves.toBeDefined();
  });

  it.each(Object.keys(PROVIDERS))('importing %s.js does not touch @pulumi/*', async (id) => {
    await expect(import(`../../../src/lib/providers/${id}.js`)).resolves.toBeDefined();
  });

  it.each(PROGRAMS)(
    'self-check: the mock is armed, $id $method trips it via the real program module',
    async ({ id, method }) => {
      const { PROVIDERS: fresh } = await import('../../../src/lib/providers/index.js');
      const Provider = fresh[id as keyof typeof fresh];
      await expect(
        (Provider[method as 'getComposeProgram'] as (c: unknown) => Promise<unknown>)({
          projectName: 'p',
          environment: 'e',
          allowedSshIps: ['203.0.113.5/32'],
          allowedK8sApiIps: ['203.0.113.5/32'],
        }),
      ).rejects.toThrow(/error when mocking a module/);
    },
  );
});
