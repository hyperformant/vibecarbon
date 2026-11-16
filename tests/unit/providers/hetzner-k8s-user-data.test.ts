/**
 * HetznerProvider.getK8sMasterUserData / getK8sWorkerUserData /
 * getK8sDbUserData are a wrap around the
 * `carbon/cloud-init/k3s/{master,worker,db}-init.sh` templates. The wrap must
 * add nothing of its own: each static renders exactly what
 * loadCloudInit/renderScript render for the same vars, and a full vars
 * object leaves no placeholder behind.
 *
 * What the templates themselves must contain is pinned by the censuses that
 * own each snippet (tests/unit/deploy/*-census.test.ts), not by stored bytes
 * here.
 */
import { describe, expect, it } from 'vitest';
import { loadCloudInit, renderScript } from '../../../src/lib/iac/cloud-init.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

const masterVars = {
  k3s_version: 'v1.37.2+k3s1',
  k3s_token: 'deadbeefcafe1234567890abcdef',
  cluster_name: 'acme-prod',
  disable_traefik: 'true',
  floating_ip: '203.0.113.10',
  project_name: 'acme',
};

const workerVars = {
  k3s_version: 'v1.37.2+k3s1',
  k3s_token: 'deadbeefcafe1234567890abcdef',
  master_ip: '10.0.1.1',
  cluster_name: 'acme-prod',
};

const dbVars = {
  k3s_version: 'v1.37.2+k3s1',
  k3s_token: 'deadbeefcafe1234567890abcdef',
  master_ip: '10.0.1.1',
};

describe('HetznerProvider k8s user-data statics (the wrap adds nothing)', () => {
  it('getK8sMasterUserData is algebraically identical to calling loadCloudInit/renderScript directly (proves the wrap adds nothing)', async () => {
    const direct = renderScript(loadCloudInit('master-init.sh'), masterVars);
    const wrapped = await HetznerProvider.getK8sMasterUserData(masterVars);
    expect(wrapped).toBe(direct);
  });

  it('getK8sWorkerUserData is algebraically identical to calling loadCloudInit/renderScript directly (proves the wrap adds nothing)', async () => {
    const direct = renderScript(loadCloudInit('worker-init.sh'), workerVars);
    const wrapped = await HetznerProvider.getK8sWorkerUserData(workerVars);
    expect(wrapped).toBe(direct);
  });

  it('both renders leave no unrendered template placeholders with a full vars object', async () => {
    const master = await HetznerProvider.getK8sMasterUserData(masterVars);
    const worker = await HetznerProvider.getK8sWorkerUserData(workerVars);
    expect(master).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
    expect(worker).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
  });

  it('getK8sDbUserData is algebraically identical to calling loadCloudInit/renderScript directly (proves the wrap adds nothing)', async () => {
    const direct = renderScript(loadCloudInit('db-init.sh'), dbVars);
    const wrapped = await HetznerProvider.getK8sDbUserData(dbVars);
    expect(wrapped).toBe(direct);
  });

  it('getK8sDbUserData leaves no unrendered template placeholders with a full vars object', async () => {
    const dbRendered = await HetznerProvider.getK8sDbUserData(dbVars);
    expect(dbRendered).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
  });
});
