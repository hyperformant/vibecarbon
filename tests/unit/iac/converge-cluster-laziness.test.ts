/**
 * Laziness guard for the extracted converge seam (mirrors
 * tests/unit/providers/iac-dispatch-laziness.test.ts).
 *
 * `convergeClusterInfra` lives in src/lib/iac/converge-cluster.js. It MUST
 * reach the Pulumi runtime (src/lib/iac/index.js, which imports
 * `@pulumi/pulumi/automation`) only through a *dynamic* import inside the
 * function body — never a top-level import — so that merely importing the
 * module (which failover/scale do at CLI startup) never pays the @pulumi SDK
 * load cost.
 *
 * Mechanism: arm both @pulumi/* packages to throw the instant they are
 * evaluated. Importing converge-cluster.js must NOT trip them; if a future
 * edit turns the `./index.js` dynamic import into a static one, the real
 * iac/index.js would load @pulumi at module-eval time and this import would
 * reject — failing the test.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@pulumi/pulumi', () => {
  throw new Error('@pulumi/pulumi must not load eagerly');
});
vi.mock('@pulumi/hcloud', () => {
  throw new Error('@pulumi/hcloud must not load eagerly');
});

describe('convergeClusterInfra never loads @pulumi/* eagerly', () => {
  it('importing converge-cluster.js does not touch @pulumi/*', async () => {
    await expect(import('../../../src/lib/iac/converge-cluster.js')).resolves.toBeDefined();
  });
});
