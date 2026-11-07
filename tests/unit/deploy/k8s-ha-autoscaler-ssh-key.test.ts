import { describe, expect, it } from 'vitest';
import { autoscalerSshKeyName, haSshKeyName } from '../../../src/lib/deploy/k8s/ha-ssh-key.js';
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

// Same wiring deployK3s uses: the helper decides the name from the options,
// the renderer writes it.
async function renderedKeyName(region: string, sharedSshKeyId?: number) {
  const sshKeyName = autoscalerSshKeyName({
    projectName: 'acme',
    environment: 'prod',
    sharedSshKeyId,
  });
  const out = await renderCarbonAutoscalerConfig({ ...base, region, sshKeyName });
  return JSON.parse(out).sshKeyName;
}

describe('haSshKeyName', () => {
  it('is <project>-<environment>-ha-key', () => {
    expect(haSshKeyName('acme', 'prod')).toBe('acme-prod-ha-key');
  });
});

describe('autoscaler config SSH key', () => {
  it('names the shared HA key on the primary', async () => {
    expect(await renderedKeyName('nbg1', 4242)).toBe('acme-prod-ha-key');
  });

  it('names the shared HA key on the standby, not a per-region key', async () => {
    expect(await renderedKeyName('hel1', 4242)).toBe('acme-prod-ha-key');
  });

  it('keeps <clusterName>-<region>-key on a single k8s cluster', async () => {
    expect(await renderedKeyName('nbg1')).toBe('acme-prod-nbg1-key');
  });

  it('autoscalerSshKeyName is undefined when the cluster owns its key', () => {
    expect(
      autoscalerSshKeyName({ projectName: 'acme', environment: 'prod', sharedSshKeyId: undefined }),
    ).toBeUndefined();
  });
});
