/**
 * The deploy's own `dropRetired` (createDeployDropRetired, which the
 * orchestrator builds before it releases a DigitalOcean k8s cluster's retired
 * reserved IP), run for real: the real engine, a file:// backend, and a stack
 * whose state holds what a DigitalOcean k8s cluster made before 2026-11 held,
 * a `digitalocean:index/reservedIp:ReservedIp` named `ingress` and its
 * `ingress-assignment`, imported as DigitalOcean wrote them. No cloud call is
 * made: the builder opens the stack and rewrites its state, nothing more.
 *
 *   - it opens the existing stack (requireExisting), takes both resources out
 *     of its state, and records the address on the environment where the
 *     record named none (the surgery's recordAddresses);
 *   - a stack the backend does not hold is refused, never created empty in
 *     its place;
 *   - a second run on the same stack finds nothing to take out.
 *
 * Skipped locally where no pulumi CLI is installed. Under CI the integration
 * job installs it, and a missing CLI fails this test instead of skipping it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeployDropRetired } from '../../../src/lib/deploy/k8s/retired-reserved-ip.js';
import { getOrCreateStack, upStack } from '../../../src/lib/iac/index.js';

// The surgery's progress line ([pulumi] took ... out of ...'s state) and the
// state telemetry ([state] ...) go to the progress log: kept here, where the
// first test reads the surgery's line, and off the test output.
const progress: string[] = [];
vi.mock('../../../src/lib/cli/progress.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/cli/progress.js')>()),
  progressLog: (line: string) => progress.push(line),
}));

const hasPulumi = (() => {
  try {
    execFileSync('pulumi', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const PROJECT = 'droptest';
const dir = mkdtempSync(join(tmpdir(), 'vc-deploy-drop-'));
const backend = join(dir, 'state');
const ADDRESS = '203.0.113.77';
const stackFile = (stack: string) => join(backend, '.pulumi/stacks', PROJECT, `${stack}.json`);

type Resource = { urn: string; type: string; [k: string]: unknown };

/**
 * A stack holding a pre-2026-11 DigitalOcean cluster's reserved IP and its
 * assignment, with the provider resource they name. The assertion stops a
 * run that lost the backend from passing against the operator's own store.
 */
async function oldDigitalOceanStack(name: string) {
  await upStack(name, async () => ({}), { projectName: PROJECT });
  expect(existsSync(stackFile(name))).toBe(true);
  const stack = await getOrCreateStack(name, async () => ({}), {
    projectName: PROJECT,
    requireExisting: true,
  });
  const state = await stack.exportStack();
  const resources = state.deployment.resources as Resource[];
  const stackUrn = resources.find((r) => r.type === 'pulumi:pulumi:Stack')?.urn as string;
  const prefix = stackUrn.slice(0, stackUrn.indexOf('::pulumi:pulumi:Stack::'));
  const providerUrn = `${prefix}::pulumi:providers:digitalocean::default`;
  const ipUrn = `${prefix}::digitalocean:index/reservedIp:ReservedIp::ingress`;
  const provider = `${providerUrn}::provider-id`;
  resources.push(
    {
      urn: providerUrn,
      custom: true,
      id: 'provider-id',
      type: 'pulumi:providers:digitalocean',
      inputs: {},
      outputs: {},
      parent: stackUrn,
    },
    {
      urn: ipUrn,
      custom: true,
      id: ADDRESS,
      type: 'digitalocean:index/reservedIp:ReservedIp',
      inputs: { region: 'nyc3' },
      outputs: { ipAddress: ADDRESS, region: 'nyc3' },
      parent: stackUrn,
      provider,
    },
    {
      urn: `${prefix}::digitalocean:index/reservedIpAssignment:ReservedIpAssignment::ingress-assignment`,
      custom: true,
      id: `${ADDRESS}-424242`,
      type: 'digitalocean:index/reservedIpAssignment:ReservedIpAssignment',
      inputs: { ipAddress: ADDRESS, dropletId: 424242 },
      outputs: { ipAddress: ADDRESS, dropletId: 424242 },
      parent: stackUrn,
      provider,
      dependencies: [ipUrn],
      propertyDependencies: { ipAddress: [ipUrn] },
    },
  );
  await stack.importStack(state);
  return stack;
}

const typesIn = async (name: string) => {
  const stack = await getOrCreateStack(name, async () => ({}), {
    projectName: PROJECT,
    requireExisting: true,
  });
  const state = await stack.exportStack();
  return (state.deployment.resources as Resource[]).map((r) => r.type);
};

/** The environment's record, written through the builder's updateConfig. */
function configFor(environment: string, env: Record<string, unknown>) {
  const config = { environments: { [environment]: env } };
  return {
    config,
    updateConfig: (fn: (c: typeof config) => void) => fn(config),
  };
}

describe.runIf(hasPulumi || process.env.CI)("the deploy's dropRetired on the real engine", () => {
  // Each test, not once: tests/setup/global-setup.ts resets process.env after
  // every test, and without this the CLI falls back to ~/.vibecarbon/pulumi-state.
  beforeEach(() => {
    process.env.PULUMI_BACKEND_URL = `file://${backend}`;
  });
  beforeAll(() => {
    mkdirSync(backend);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('takes the reserved IP and its assignment out of the state, and records the address', async () => {
    expect(hasPulumi, 'CI must install the pulumi CLI (test.yml integration job)').toBe(true);
    await oldDigitalOceanStack('prod');
    expect(await typesIn('prod')).toContain('digitalocean:index/reservedIp:ReservedIp');

    // An environment saved before the deploy recorded floatingIp: the stack
    // is the address's last record.
    const { config, updateConfig } = configFor('prod', { ingressIp: '198.51.100.7' });
    const dropRetired = createDeployDropRetired({
      environment: 'prod',
      providerId: 'digitalocean',
      providerToken: 'dop_v1_test',
      s3Config: null,
      projectName: PROJECT,
      updateConfig,
    });
    await dropRetired('prod');

    const types = await typesIn('prod');
    expect(types).not.toContain('digitalocean:index/reservedIp:ReservedIp');
    expect(types).not.toContain('digitalocean:index/reservedIpAssignment:ReservedIpAssignment');
    expect(types).toContain('pulumi:providers:digitalocean');
    expect(config.environments.prod).toEqual({ ingressIp: '198.51.100.7', floatingIp: ADDRESS });
    expect(progress).toContainEqual(
      expect.stringContaining("took ingress and ingress-assignment out of prod's state"),
    );

    // A second run finds nothing to take out, and changes nothing.
    await dropRetired('prod');
    expect(await typesIn('prod')).toEqual(types);
  });

  it('a k8s-ha side records the address on its own side', async () => {
    await oldDigitalOceanStack('e4-standby');
    const { config, updateConfig } = configFor('e4', {
      ha: { primary: { stack: 'e4-primary' }, standby: { stack: 'e4-standby' } },
    });
    await createDeployDropRetired({
      environment: 'e4',
      providerId: 'digitalocean',
      providerToken: 'dop_v1_test',
      s3Config: null,
      projectName: PROJECT,
      updateConfig,
    })('e4-standby');
    expect(config.environments.e4).toEqual({
      ha: {
        primary: { stack: 'e4-primary' },
        standby: { stack: 'e4-standby', floatingIp: ADDRESS },
      },
    });
    expect(await typesIn('e4-standby')).not.toContain('digitalocean:index/reservedIp:ReservedIp');
  });

  it('a stack the backend does not hold is refused, never created empty in its place', async () => {
    const { config, updateConfig } = configFor('ghost', { floatingIp: ADDRESS });
    const dropRetired = createDeployDropRetired({
      environment: 'ghost',
      providerId: 'digitalocean',
      providerToken: 'dop_v1_test',
      s3Config: null,
      projectName: PROJECT,
      updateConfig,
    });
    await expect(dropRetired('ghost')).rejects.toThrow(/was not found/);
    expect(existsSync(stackFile('ghost'))).toBe(false);
    expect(config.environments.ghost).toEqual({ floatingIp: ADDRESS });
  });
});
