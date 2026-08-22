/**
 * CD2 hard constraint: no top-level `@pulumi/*` import may enter the
 * provider module graph (base.js / hetzner.js / index.js). status.js and
 * deploy.js import the provider CLASS at CLI startup on EVERY command — if
 * `@pulumi/hcloud` or `@pulumi/pulumi` loaded as a side effect of that
 * import, every command (not just deploy/scale) would pay the Pulumi SDK's
 * load cost, a startup-latency regression.
 *
 * Mechanism: replace both `@pulumi/*` packages with a factory that throws
 * the moment it's actually evaluated. A `vi.mock` factory runs lazily,
 * exactly once, the first time some module in the graph resolves that
 * specifier — so this is a true runtime assertion of "was this package ever
 * loaded", not a text/regex scan of import statements. Vitest wraps a
 * factory-thrown error in its own "error when mocking a module" diagnostic
 * rather than propagating our message verbatim — the self-check assertions
 * below match on that wrapper text.
 *
 *   - Importing base.js / hetzner.js / providers/index.js must NOT throw —
 *     proves neither @pulumi package was touched by their static import
 *     graph.
 *   - Calling HetznerProvider.getComposeProgram()/getK8sProgram() — which
 *     dynamic-imports hetzner-compose.js/hetzner-k8s.js, files that DO
 *     import `@pulumi/*` at THEIR OWN top level by design — MUST throw via
 *     the same mock. This is the harness's self-check: it proves the mock is
 *     actually armed (not silently bypassed by module caching or a wrong
 *     specifier), so the "must not throw" assertions above are meaningful.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@pulumi/pulumi', () => {
  throw new Error('@pulumi/pulumi must not load eagerly');
});
vi.mock('@pulumi/hcloud', () => {
  throw new Error('@pulumi/hcloud must not load eagerly');
});
vi.mock('@pulumi/digitalocean', () => {
  throw new Error('@pulumi/digitalocean must not load eagerly');
});

describe('provider module graph never loads @pulumi/* eagerly (CD2)', () => {
  it('importing base.js does not touch @pulumi/*', async () => {
    await expect(import('../../../src/lib/providers/base.js')).resolves.toBeDefined();
  });

  it('importing hetzner.js does not touch @pulumi/*', async () => {
    await expect(import('../../../src/lib/providers/hetzner.js')).resolves.toBeDefined();
  });

  it('importing providers/index.js does not touch @pulumi/*', async () => {
    await expect(import('../../../src/lib/providers/index.js')).resolves.toBeDefined();
  });

  it('importing digitalocean.js does not touch @pulumi/*', async () => {
    await expect(import('../../../src/lib/providers/digitalocean.js')).resolves.toBeDefined();
  });

  it('self-check: the mock is armed — getComposeProgram trips it via the real program module', async () => {
    const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');
    await expect(
      HetznerProvider.getComposeProgram({ projectName: 'p', environment: 'e' }),
    ).rejects.toThrow(/error when mocking a module/);
  });

  it('self-check: the mock is armed — getK8sProgram trips it via the real program module', async () => {
    const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');
    await expect(
      HetznerProvider.getK8sProgram({ projectName: 'p', environment: 'e' }),
    ).rejects.toThrow(/error when mocking a module/);
  });

  it('self-check: the mock is armed — DigitalOceanProvider.getComposeProgram trips it via the real program module', async () => {
    const { DigitalOceanProvider } = await import('../../../src/lib/providers/digitalocean.js');
    await expect(
      DigitalOceanProvider.getComposeProgram({ projectName: 'p', environment: 'e' }),
    ).rejects.toThrow(/error when mocking a module/);
  });

  it('self-check: the mock is armed — DigitalOceanProvider.getK8sProgram trips it via the real program module (M3 Task 5)', async () => {
    const { DigitalOceanProvider } = await import('../../../src/lib/providers/digitalocean.js');
    await expect(
      DigitalOceanProvider.getK8sProgram({
        projectName: 'p',
        environment: 'e',
        allowedSshIps: ['203.0.113.5/32'],
        allowedK8sApiIps: ['203.0.113.5/32'],
      }),
    ).rejects.toThrow(/error when mocking a module/);
  });
});
