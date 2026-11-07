import { describe, expect, it, vi } from 'vitest';
import { haSshKeyName } from '../../../src/lib/deploy/k8s/ha-ssh-key.js';
import { renderCarbonAutoscalerConfig } from '../../../src/lib/deploy/k8s/k3s.js';

// The k8s-ha pair shares one SSH key, so its programs create no key of their
// own. carbon-autoscaler hands `sshKeyName` to the provider for every node it
// creates; a name that exists nowhere fails each scale-up.
const FakeProvider = {
  PROVIDER_ID_PREFIX: 'hcloud://',
  K8S_IMAGE: 'ubuntu-26.04',
  async getK8sWorkerUserData() {
    return '#!/bin/sh\n';
  },
};

const base = {
  k3sVersion: 'v1.37.2+k3s1',
  k3sToken: 'deadbeef',
  clusterName: 'acme-prod',
  environment: 'prod',
  providerId: 'hetzner',
  ProviderClass: FakeProvider,
  workerServerType: 'cx23',
  minWorkers: 1,
  maxWorkers: 4,
};

async function renderedKeyName(region: string, sshKeyName?: string) {
  const out = await renderCarbonAutoscalerConfig({ ...base, region, sshKeyName });
  return JSON.parse(out).sshKeyName;
}

describe('haSshKeyName', () => {
  it('is <project>-<environment>-ha-key', () => {
    expect(haSshKeyName('acme', 'prod')).toBe('acme-prod-ha-key');
  });
});

describe('autoscaler config SSH key', () => {
  it('keeps <clusterName>-<region>-key on a single k8s cluster', async () => {
    expect(await renderedKeyName('nbg1')).toBe('acme-prod-nbg1-key');
  });

  it('names the key the k8s-ha upload registered, for primary and standby', async () => {
    const deployK3s = vi.fn(async () => ({
      masterIp: '1.1.1.1',
      dbIp: '2.2.2.2',
      floatingIp: '3.3.3.3',
      dbPrivateIp: '10.0.1.2',
      kubeconfig: '/tmp/kubeconfig',
    }));
    vi.doMock('../../../src/lib/deploy/k8s/k3s.js', async (orig) => ({
      ...(await orig<typeof import('../../../src/lib/deploy/k8s/k3s.js')>()),
      deployK3s,
    }));
    vi.doMock('../../../src/lib/iac/index.js', () => ({
      summarizePulumiError: (e: unknown) => String(e),
    }));
    vi.doMock('../../../src/lib/deploy/k8s/ha/index.js', () => ({
      prepareReplicationTransport: vi.fn(async () => {}),
      configurePrimaryForReplication: vi.fn(async () => {}),
      setupReplication: vi.fn(async () => ({ streaming: true, lastState: '' })),
    }));
    vi.doMock('../../../src/lib/deploy/k8s/ha/image-copy.js', () => ({
      copyAppImageToStandby: vi.fn(async () => ({ digest: 'sha256:aa', skipped: true })),
    }));
    const { K8S_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/k8s-ha.js');

    // The upload registers the key under the OPERATOR's environment.
    const uploaded: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('/ssh_keys') && (init?.method ?? 'GET') === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ssh_keys: [], meta: {} }),
        } as Response;
      }
      uploaded.push(JSON.parse(String(init?.body)).name);
      return {
        ok: true,
        status: 201,
        json: async () => ({ ssh_key: { id: 77, name: uploaded[0] } }),
      } as Response;
    });
    const ctx: Record<string, unknown> = {
      options: {
        projectName: 'acme',
        environment: 'prod',
        region: 'nbg1',
        secondaryRegion: 'hel1',
        apiToken: 't',
      },
      sharedSshPublicKey: 'ssh-ed25519 AAAA deploy@host',
      s: { start: () => {}, stop: () => {} },
    };
    await K8S_HA_EFFECTS.haK8sUploadSshKey(ctx);
    expect(uploaded).toEqual(['acme-prod-ha-key']);
    await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);

    // The cluster stacks run as prod-primary / prod-standby, not prod.
    const calls = deployK3s.mock.calls.map(([o]) => o as Record<string, string>);
    expect(calls.map((o) => o.environment).sort()).toEqual(['prod-primary', 'prod-standby']);
    for (const o of calls) {
      const region = o.role === 'primary' ? 'nbg1' : 'hel1';
      // deployK3s hands options.sharedSshKeyName to applyK3sManifests, which
      // hands it to the renderer.
      expect(await renderedKeyName(region, o.sharedSshKeyName)).toBe('acme-prod-ha-key');
    }
  });
});
