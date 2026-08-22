import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — JS module without types
import { loadConfig } from '../../../src/autoscaler/config.js';
import { renderCarbonAutoscalerConfig } from '../../../src/lib/deploy/k8s/k3s.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

describe('renderCarbonAutoscalerConfig', () => {
  // Stand-in for a provider class — renderCarbonAutoscalerConfig reads
  // PROVIDER_ID_PREFIX/K8S_IMAGE off it AND (M3 Task 5b) dispatches
  // getK8sWorkerUserData(vars) on it to render the worker cloud-init.
  // K8S_IMAGE (M3 Task 2) mirrors HetznerProvider's real 'ubuntu-24.04'
  // value; getK8sWorkerUserData mirrors HetznerProvider's own static
  // exactly (wraps worker-init.sh via loadCloudInit/renderScript) so the
  // shape-only assertions below stay decoupled from a specific real
  // provider class while still exercising real template substitution.
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

  it('returns valid JSON parseable by JSON.parse (plain, NOT base64)', async () => {
    const out = await renderCarbonAutoscalerConfig(baseArgs);
    expect(() => JSON.parse(out)).not.toThrow();
    const cfg = JSON.parse(out);
    expect(cfg).toBeTypeOf('object');
  });

  it('produces a document that passes src/autoscaler/config.js loadConfig (cross-module contract proof)', async () => {
    const out = await renderCarbonAutoscalerConfig(baseArgs);
    const dir = mkdtempSync(join(tmpdir(), 'vc-ca-config-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, out);
    expect(() => loadConfig(path)).not.toThrow();
    const loaded = loadConfig(path);
    expect(loaded.provider).toBe('hetzner');
  });

  it('sets the top-level provider/providerIdPrefix/clusterName/sshKeyName/firewallName/networkName fields', async () => {
    const cfg = JSON.parse(await renderCarbonAutoscalerConfig(baseArgs));
    expect(cfg.provider).toBe('hetzner');
    expect(cfg.providerIdPrefix).toBe('hcloud://');
    expect(cfg.clusterName).toBe('acme-prod');
    expect(cfg.sshKeyName).toBe('acme-prod-nbg1-key');
    expect(cfg.firewallName).toBe('acme-prod-firewall');
    expect(cfg.networkName).toBe('acme-prod-network');
  });

  it('threads providerIdPrefix from whatever ProviderClass is passed', async () => {
    const OtherProvider = {
      PROVIDER_ID_PREFIX: 'digitalocean://',
      K8S_IMAGE: 'ubuntu-24-04-x64',
      getK8sWorkerUserData: FakeProvider.getK8sWorkerUserData,
    };
    const cfg = JSON.parse(
      await renderCarbonAutoscalerConfig({
        ...baseArgs,
        providerId: 'digitalocean',
        ProviderClass: OtherProvider,
      }),
    );
    expect(cfg.provider).toBe('digitalocean');
    expect(cfg.providerIdPrefix).toBe('digitalocean://');
  });

  it('declares a worker-pool nodeGroup with minSize 0 always, regardless of minWorkers', async () => {
    const cfg = JSON.parse(await renderCarbonAutoscalerConfig({ ...baseArgs, minWorkers: 5 }));
    expect(cfg.nodeGroups['worker-pool'].minSize).toBe(0);
  });

  it('maxSize = maxWorkers - minWorkers (headroom above the Pulumi-static floor)', async () => {
    const cfg = JSON.parse(
      await renderCarbonAutoscalerConfig({ ...baseArgs, minWorkers: 2, maxWorkers: 4 }),
    );
    expect(cfg.nodeGroups['worker-pool'].maxSize).toBe(2);
  });

  it('clamps a negative headroom to 0 (maxWorkers <= minWorkers)', async () => {
    const cfg = JSON.parse(
      await renderCarbonAutoscalerConfig({ ...baseArgs, minWorkers: 5, maxWorkers: 2 }),
    );
    expect(cfg.nodeGroups['worker-pool'].maxSize).toBe(0);
  });

  it('caBoundsMin substitutes for minWorkers in the maxSize arithmetic (pilot-light dormant-bounds trick)', async () => {
    // Standby deploys with minWorkers: 0 (no Pulumi-provisioned workers) but
    // caBoundsMin carries the PRIMARY's static floor, so the standby's CA
    // config renders the SAME headroom the primary would.
    const cfg = JSON.parse(
      await renderCarbonAutoscalerConfig({
        ...baseArgs,
        minWorkers: 0,
        maxWorkers: 4,
        caBoundsMin: 2,
      }),
    );
    expect(cfg.nodeGroups['worker-pool'].maxSize).toBe(2);
  });

  it('caBoundsMin is ignored when undefined (single-cluster/primary unaffected)', async () => {
    const withCaBoundsMin = JSON.parse(
      await renderCarbonAutoscalerConfig({
        ...baseArgs,
        minWorkers: 1,
        maxWorkers: 4,
        caBoundsMin: 1,
      }),
    );
    const withoutCaBoundsMin = JSON.parse(
      await renderCarbonAutoscalerConfig({ ...baseArgs, minWorkers: 1, maxWorkers: 4 }),
    );
    expect(withCaBoundsMin.nodeGroups['worker-pool'].maxSize).toBe(
      withoutCaBoundsMin.nodeGroups['worker-pool'].maxSize,
    );
  });

  it('sets serverType/region/image on the worker-pool node group', async () => {
    const cfg = JSON.parse(
      await renderCarbonAutoscalerConfig({ ...baseArgs, workerServerType: 'cx23', region: 'hel1' }),
    );
    const wp = cfg.nodeGroups['worker-pool'];
    expect(wp.serverType).toBe('cx23');
    expect(wp.region).toBe('hel1');
    expect(wp.image).toBe('ubuntu-24.04');
  });

  it('sets serverLabels including the sweep signal, managed-by, environment, and cluster', async () => {
    const cfg = JSON.parse(await renderCarbonAutoscalerConfig(baseArgs));
    const { serverLabels } = cfg.nodeGroups['worker-pool'];
    expect(serverLabels).toEqual({
      'cluster-autoscaler/node': 'worker-pool',
      'managed-by': 'vibecarbon',
      environment: 'prod',
      cluster: 'acme-prod',
    });
  });

  it('sets nodeLabels {} taints [] and podsPerNode 110', async () => {
    const cfg = JSON.parse(await renderCarbonAutoscalerConfig(baseArgs));
    const wp = cfg.nodeGroups['worker-pool'];
    expect(wp.nodeLabels).toEqual({});
    expect(wp.taints).toEqual([]);
    expect(wp.podsPerNode).toBe(110);
  });

  it('substitutes k3s_token, k3s_version, and master_ip into the rendered cloudInit with zero residue', async () => {
    const cfg = JSON.parse(await renderCarbonAutoscalerConfig(baseArgs));
    const cloudInit: string = cfg.nodeGroups['worker-pool'].cloudInit;
    expect(typeof cloudInit).toBe('string');
    expect(cloudInit).toContain(baseArgs.k3sToken);
    expect(cloudInit).toContain(baseArgs.k3sVersion);
    expect(cloudInit).toContain('10.0.1.1');
    // No unsubstituted ${k3s_*} / ${master_ip} placeholders should remain —
    // the sidecar stuffs this verbatim into user-data, so anything
    // unresolved would surface as a runtime cloud-init failure.
    expect(cloudInit).not.toMatch(/\$\{k3s_token\}/);
    expect(cloudInit).not.toMatch(/\$\{k3s_version\}/);
    expect(cloudInit).not.toMatch(/\$\{master_ip\}/);
  });

  it('defaults masterPrivateIp to 10.0.1.1 when not supplied (matches the master server private IP)', async () => {
    const cfg = JSON.parse(await renderCarbonAutoscalerConfig(baseArgs));
    const cloudInit: string = cfg.nodeGroups['worker-pool'].cloudInit;
    expect(cloudInit).toMatch(/K3S_URL="https:\/\/10\.0\.1\.1:6443"/);
  });

  it('honors a passed-in masterPrivateIp override', async () => {
    const cfg = JSON.parse(
      await renderCarbonAutoscalerConfig({ ...baseArgs, masterPrivateIp: '10.42.0.5' }),
    );
    const cloudInit: string = cfg.nodeGroups['worker-pool'].cloudInit;
    expect(cloudInit).toMatch(/K3S_URL="https:\/\/10\.42\.0\.5:6443"/);
    expect(cloudInit).not.toMatch(/K3S_URL="https:\/\/10\.0\.1\.1:6443"/);
  });
});

describe('K8S_IMAGE fail-fast guard (T2 review)', () => {
  it('throws at render time when the provider class has no K8S_IMAGE', async () => {
    const NoImageProvider = { name: 'NoImageProvider', PROVIDER_ID_PREFIX: 'x://', K8S_IMAGE: '' };
    await expect(
      renderCarbonAutoscalerConfig({
        k3sVersion: 'v1.31.5+k3s1',
        k3sToken: 'tok',
        clusterName: 'c-e9',
        environment: 'e9',
        providerId: 'x',
        // biome-ignore lint/suspicious/noExplicitAny: minimal stand-in
        ProviderClass: NoImageProvider as any,
        region: 'r1',
        workerServerType: 't1',
        minWorkers: 1,
        maxWorkers: 2,
      }),
    ).rejects.toThrow(/no K8S_IMAGE/);
  });
});

describe('renderCarbonAutoscalerConfig dispatches through ProviderClass.getK8sWorkerUserData (M3 Task 5b Critical)', () => {
  const baseArgs = {
    k3sVersion: 'v1.31.5+k3s1',
    k3sToken: 'deadbeefcafe1234567890abcdef',
    clusterName: 'acme-prod',
    environment: 'prod',
    region: 'nyc3',
    workerServerType: 's-2vcpu-4gb',
    minWorkers: 1,
    maxWorkers: 4,
  };

  it('renders the DigitalOcean worker cloud-init (DO-only marker present, Hetzner-only marker absent) when given DigitalOceanProvider', async () => {
    const cfg = JSON.parse(
      await renderCarbonAutoscalerConfig({
        ...baseArgs,
        providerId: 'digitalocean',
        // A DO-realistic VPC private IP — NOT Hetzner's default '10.0.1.1'
        // (which do-worker-init.sh's own `${master_ip}:5000` registry-mirror
        // template var would otherwise happen to reproduce verbatim,
        // masking the marker check below).
        masterPrivateIp: '10.10.0.11',
        ProviderClass: DigitalOceanProvider,
      }),
    );
    const cloudInit: string = cfg.nodeGroups['worker-pool'].cloudInit;

    // DO-only: do-worker-init.sh derives provider-id from DO's metadata
    // service at boot — this literal never appears in Hetzner's template.
    expect(cloudInit).toContain('provider-id=digitalocean://');
    expect(cloudInit).toContain('10.10.0.11:5000');
    // Hetzner-only: worker-init.sh's metadata path / private-network-NIC
    // discovery grep / hardcoded registry-mirror literal — none of these
    // exist in DO's template (DO derives its own IPs from a different
    // metadata path and has no static 10.0.1.1 registry mirror).
    expect(cloudInit).not.toContain('hetzner/v1/metadata');
    expect(cloudInit).not.toContain('10.0.1.1:5000');
    expect(cloudInit).not.toContain("grep 'inet 10\\.0\\.'");
  });

  it('renders the Hetzner worker cloud-init (Hetzner-only marker present, DO-only marker absent) when given HetznerProvider', async () => {
    const cfg = JSON.parse(
      await renderCarbonAutoscalerConfig({
        ...baseArgs,
        providerId: 'hetzner',
        ProviderClass: HetznerProvider,
      }),
    );
    const cloudInit: string = cfg.nodeGroups['worker-pool'].cloudInit;

    expect(cloudInit).toContain('hetzner/v1/metadata');
    expect(cloudInit).not.toContain('provider-id=digitalocean://');
  });
});
