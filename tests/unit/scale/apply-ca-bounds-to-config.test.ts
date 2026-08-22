import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// `applyCaBoundsToConfig` is a pure exported helper in src/scale.js (the CA
// bounds re-patch's mutate step — see `scaleApplyK8sChanges`). Importing
// scale.js pulls in its full module graph (clack prompts, kubectl/ssh command
// execution, converge-cluster orchestration, project-config I/O); none of
// that is exercised by a pure-function test, but the graph still needs to
// resolve cleanly at import time — same safety-mock recipe
// tests/unit/scale/replacement-server-args.test.ts uses to import scale.js's
// OTHER pure helpers.
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    log: { info() {}, warn() {}, error() {}, step() {}, success() {} },
    note() {},
    outro() {},
  };
});

vi.mock('node:fs', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

vi.mock('../../../src/lib/iac/converge-cluster.js', () => ({
  convergeClusterInfra: vi.fn(async () => ({ outputs: {} })),
}));

vi.mock('../../../src/lib/command.js', () => ({
  runCommand: vi.fn(() => ''),
}));

vi.mock('../../../src/lib/config.js', () => ({
  saveProjectConfig: vi.fn(),
}));

const { applyCaBoundsToConfig } = await import('../../../src/scale.js');
const { renderCarbonAutoscalerConfig } = await import('../../../src/lib/deploy/k8s/k3s.js');
// @ts-expect-error — JS module without types
const { loadConfig } = await import('../../../src/autoscaler/config.js');

// Fixture rendered by the REAL renderCarbonAutoscalerConfig (Task 8) — not a
// hand-written stand-in — so drift between what deploy renders and what scale
// mutates is caught by this file rather than surfacing only in production.
// K8S_IMAGE (M3 Task 2) must be a real value here — the config this produces
// is fed through the REAL src/autoscaler/config.js loadConfig validator
// below, which requires nodeGroups.*.image to be a non-empty string.
// getK8sWorkerUserData (M3 Task 5b) mirrors HetznerProvider's own static
// exactly (wraps worker-init.sh via loadCloudInit/renderScript) — this file
// only cares that renderCarbonAutoscalerConfig produces a stable document to
// mutate, not which provider's cloud-init shape ends up embedded.
const FakeProvider = {
  PROVIDER_ID_PREFIX: 'hcloud://',
  K8S_IMAGE: 'ubuntu-24.04',
  async getK8sWorkerUserData(vars: Record<string, unknown>) {
    const { loadCloudInit, renderScript } = await import('../../../src/lib/iac/cloud-init.js');
    return renderScript(loadCloudInit('worker-init.sh'), vars);
  },
};
const baseArgs = {
  k3sVersion: 'v1.31.5+k3s1',
  k3sToken: 'deadbeefcafe1234567890abcdef',
  clusterName: 'acme-prod',
  environment: 'prod',
  providerId: 'hetzner',
  ProviderClass: FakeProvider,
  region: 'nbg1',
  workerServerType: 'cx23',
  minWorkers: 1,
  maxWorkers: 4,
};

function renderFixture(): Promise<string> {
  return renderCarbonAutoscalerConfig(baseArgs);
}

describe('applyCaBoundsToConfig', () => {
  it('sets nodeGroups[worker-pool].maxSize = newMax - newMin (same headroom arithmetic as deploy)', async () => {
    const out = applyCaBoundsToConfig(await renderFixture(), {
      newMin: 1,
      newMax: 5,
      newType: 'cx23',
    });
    const cfg = JSON.parse(out);
    expect(cfg.nodeGroups['worker-pool'].maxSize).toBe(4);
  });

  it('clamps negative headroom (newMax <= newMin) to 0', async () => {
    const out = applyCaBoundsToConfig(await renderFixture(), {
      newMin: 5,
      newMax: 2,
      newType: 'cx23',
    });
    expect(JSON.parse(out).nodeGroups['worker-pool'].maxSize).toBe(0);
  });

  it('sets serverType to newType when it differs from the current value', async () => {
    const out = applyCaBoundsToConfig(await renderFixture(), {
      newMin: 1,
      newMax: 4,
      newType: 'cx33',
    });
    expect(JSON.parse(out).nodeGroups['worker-pool'].serverType).toBe('cx33');
  });

  it('leaves serverType untouched when newType is absent (bounds-only re-patch)', async () => {
    const out = applyCaBoundsToConfig(await renderFixture(), { newMin: 1, newMax: 4 });
    expect(JSON.parse(out).nodeGroups['worker-pool'].serverType).toBe('cx23');
  });

  it('leaves serverType untouched when newType equals the current value', async () => {
    const out = applyCaBoundsToConfig(await renderFixture(), {
      newMin: 1,
      newMax: 4,
      newType: 'cx23',
    });
    expect(JSON.parse(out).nodeGroups['worker-pool'].serverType).toBe('cx23');
  });

  it('throws a descriptive error when nodeGroups[worker-pool] is missing (hand-edited Secret)', async () => {
    const cfg = JSON.parse(await renderFixture());
    delete cfg.nodeGroups['worker-pool'];
    cfg.nodeGroups['other-pool'] = { minSize: 0, maxSize: 1 };
    expect(() =>
      applyCaBoundsToConfig(JSON.stringify(cfg), { newMin: 0, newMax: 2, newType: 'cx23' }),
    ).toThrow(/worker-pool/);
  });

  it('leaves every field other than maxSize/serverType byte-preserved', async () => {
    const original = JSON.parse(await renderFixture());
    const out = applyCaBoundsToConfig(await renderFixture(), {
      newMin: 2,
      newMax: 6,
      newType: 'cx33',
    });
    const mutated = JSON.parse(out);

    expect(mutated.provider).toBe(original.provider);
    expect(mutated.providerIdPrefix).toBe(original.providerIdPrefix);
    expect(mutated.clusterName).toBe(original.clusterName);
    expect(mutated.sshKeyName).toBe(original.sshKeyName);
    expect(mutated.firewallName).toBe(original.firewallName);
    expect(mutated.networkName).toBe(original.networkName);

    const origWp = original.nodeGroups['worker-pool'];
    const mutWp = mutated.nodeGroups['worker-pool'];
    expect(mutWp.minSize).toBe(origWp.minSize);
    expect(mutWp.region).toBe(origWp.region);
    expect(mutWp.image).toBe(origWp.image);
    expect(mutWp.cloudInit).toBe(origWp.cloudInit);
    expect(mutWp.serverLabels).toEqual(origWp.serverLabels);
    expect(mutWp.nodeLabels).toEqual(origWp.nodeLabels);
    expect(mutWp.taints).toEqual(origWp.taints);
    expect(mutWp.podsPerNode).toBe(origWp.podsPerNode);
  });

  it('produces a document that still passes src/autoscaler/config.js loadConfig after mutation (cross-module contract proof)', async () => {
    const out = applyCaBoundsToConfig(await renderFixture(), {
      newMin: 1,
      newMax: 4,
      newType: 'cx23',
    });
    const dir = mkdtempSync(join(tmpdir(), 'vc-ca-bounds-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, out);
    expect(() => loadConfig(path)).not.toThrow();
    const loaded = loadConfig(path);
    expect(loaded.nodeGroups['worker-pool'].maxSize).toBe(3);
  });
});
