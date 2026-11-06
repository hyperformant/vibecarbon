/**
 * A state bucket this deploy just created has no `.pulumi/meta.yaml`, and an HA
 * pair must not meet there: two engines initializing one backend can fail with
 * `could not list bucket: ... NoSuchKey`, which nothing retries (2026-04-28,
 * k8s-ha). So the plan opens the backend once, before the fan-out, and a bucket
 * that already existed pays nothing.
 *
 * Runs the real plans, gates and effect with a fake Pulumi workspace. Every
 * other effect only records its name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pulumi = vi.hoisted(() => ({
  create: vi.fn(),
  whoAmI: vi.fn(),
  order: [] as string[],
}));

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: { create: pulumi.create },
}));

const { EFFECTS } = await import('../../../src/lib/deploy/effects/index.js');
const { planDeploy } = await import('../../../src/lib/deploy/plan/deploy-plan.js');
const { runPlan } = await import('../../../src/lib/deploy/plan/runner.js');
const { resolveBackendUrl } = await import('../../../src/lib/iac/index.js');
const { PROVIDERS } = await import('../../../src/lib/providers/index.js');

/** The step that starts both engines, per tier. */
const FAN_OUT = { 'compose-ha': 'haProvisionServers', 'k8s-ha': 'haK8sProvisionClusters' } as const;
const TIERS = Object.keys(FAN_OUT) as (keyof typeof FAN_OUT)[];

const s3Config = {
  bucket: 'app-storage',
  stateBucket: 'app-storage-pulumi-state-a1b2c3',
  endpoint: 'https://fr-par.example.com',
  region: 'fr-par',
  accessKey: 'AK',
  secretKey: 'SK',
};
const backend = (provider = 'hetzner') => ({ provider, s3Config, projectName: 'myapp' });

/** The real effect behind the open step, a recorder behind every other one. */
function effects() {
  const open = EFFECTS.openStateBackend;
  const stubs = Object.fromEntries(
    Object.keys(EFFECTS).map((name) => [
      name,
      async () => {
        pulumi.order.push(name);
      },
    ]),
  );
  return { ...stubs, openStateBackend: open };
}

beforeEach(() => {
  pulumi.order.length = 0;
  pulumi.whoAmI.mockReset();
  pulumi.whoAmI.mockImplementation(async () => {
    pulumi.order.push('whoAmI');
    return { user: 'me' };
  });
  pulumi.create.mockReset();
  pulumi.create.mockImplementation(async () => ({ whoAmI: pulumi.whoAmI }));
});

describe.each(TIERS)('%s', (tier) => {
  it('opens a new backend once, before the fan-out', async () => {
    await runPlan(planDeploy(tier, {}), { newStateBackend: backend() }, effects());
    expect(pulumi.order.filter((name) => name === 'whoAmI')).toHaveLength(1);
    expect(pulumi.order.indexOf('whoAmI')).toBeLessThan(pulumi.order.indexOf(FAN_OUT[tier]));
    expect(pulumi.order.filter((name) => name === FAN_OUT[tier])).toHaveLength(1);
  });

  it('does nothing at all on a bucket that already existed', async () => {
    await runPlan(planDeploy(tier, {}), { newStateBackend: null }, effects());
    expect(pulumi.create).not.toHaveBeenCalled();
    expect(pulumi.whoAmI).not.toHaveBeenCalled();
    expect(pulumi.order).toContain(FAN_OUT[tier]);
  });

  it('a backend that will not open stops the deploy before anything is provisioned', async () => {
    pulumi.whoAmI.mockRejectedValue(new Error('error: could not list bucket'));
    await expect(
      runPlan(planDeploy(tier, {}), { newStateBackend: backend() }, effects()),
    ).rejects.toThrow(/\[step:open-state-backend\].*could not list bucket/);
    expect(pulumi.whoAmI).toHaveBeenCalledOnce();
    expect(pulumi.order).not.toContain(FAN_OUT[tier]);
  });
});

describe('every provider', () => {
  it.each(Object.keys(PROVIDERS))('%s opens the backend its stacks will use', async (provider) => {
    await EFFECTS.openStateBackend({ newStateBackend: backend(provider) });
    expect(pulumi.create).toHaveBeenCalledOnce();
    const [opts] = pulumi.create.mock.calls[0];
    expect(opts.projectSettings).toMatchObject({
      name: 'myapp',
      backend: { url: resolveBackendUrl(s3Config, provider) },
    });
    expect(opts.envVars).toMatchObject({ AWS_ACCESS_KEY_ID: 'AK', AWS_SECRET_ACCESS_KEY: 'SK' });
  });
});
