/**
 * LinodeProvider.getK8s{Master,Worker,Db}UserData render the
 * carbon/cloud-init/k3s/linode-{master,worker,db}-init.sh templates.
 * Mirrors digitalocean-k8s-user-data.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCloudInit } from '../../../src/lib/iac/cloud-init.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';

const masterVars = {
  k3s_version: 'v1.37.2+k3s1',
  k3s_token: 'deadbeefcafe1234567890abcdef',
  linode_token: 'linode_test_token_1234',
  project_tag: 'project:quorum',
};
const agentVars = {
  k3s_version: 'v1.37.2+k3s1',
  k3s_token: 'deadbeefcafe1234567890abcdef',
  master_ip: '10.0.1.2',
};

function templatePlaceholders(source: string): string[] {
  return [...new Set([...source.matchAll(/\$\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]))].sort();
}

const CSI_URL =
  'https://github.com/linode/linode-blockstorage-csi-driver/releases/download/v1.1.5/linode-blockstorage-csi-driver-v1.1.5.yaml';

const roles = [
  ['master', masterVars, (v: typeof masterVars) => LinodeProvider.getK8sMasterUserData(v)],
  ['worker', agentVars, (v: typeof agentVars) => LinodeProvider.getK8sWorkerUserData(v)],
  ['db', agentVars, (v: typeof agentVars) => LinodeProvider.getK8sDbUserData(v)],
] as const;

describe('LinodeProvider k8s user-data statics', () => {
  it.each(roles)('%s: placeholder set is exactly the documented vars', (role, vars) => {
    const raw = loadCloudInit(`linode-${role}-init.sh`);
    expect(templatePlaceholders(raw)).toEqual(Object.keys(vars).sort());
  });

  it.each(roles)('%s: renders with no placeholder left', async (_role, vars, render) => {
    const rendered = await (render as (v: unknown) => Promise<string>)(vars);
    expect(rendered).not.toMatch(/\$\{(k3s_|linode_|master_|project_)/);
    expect(rendered).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
  });

  it.each(roles)(
    '%s: identity comes from the Linode metadata token flow',
    async (_r, vars, render) => {
      const rendered = await (render as (v: unknown) => Promise<string>)(vars);
      expect(rendered).toContain(
        '-X PUT -H "Metadata-Token-Expiry-Seconds: 3600" http://169.254.169.254/v1/token',
      );
      expect(rendered).toContain('fetch_metadata "instance"');
      expect(rendered).toContain('fetch_metadata "network"');
      expect(rendered).toContain('FATAL: could not determine');
      expect(rendered).toContain('--kubelet-arg="provider-id=linode://$NODE_ID"');
      expect(rendered).toContain('--flannel-iface "eth1"');
      expect(rendered).toContain('--node-ip "$PRIVATE_IP"');
      expect(rendered).toContain('--node-external-ip "$PUBLIC_IP"');
      expect(rendered).not.toContain('--disable-cloud-controller');
      expect(rendered).not.toContain('cloud-provider=external');
      expect(rendered).not.toMatch(/digitalocean|hetzner|hcloud|droplet/i);
    },
  );

  it('master: creates the linode Secret, applies the pinned CSI asset and the tagged StorageClass', async () => {
    const rendered = await LinodeProvider.getK8sMasterUserData(masterVars);
    expect(rendered).toContain('create secret generic linode');
    expect(rendered).toContain('--from-literal=token="linode_test_token_1234"');
    expect(rendered).toContain(`kubectl apply -f ${CSI_URL}`);
    expect(rendered).toContain('name: linode-block-storage-vibecarbon');
    expect(rendered).toContain('provisioner: linodebs.csi.linode.com');
    expect(rendered).toContain('reclaimPolicy: Delete');
    expect(rendered).toContain('allowVolumeExpansion: true');
    expect(rendered).toContain('volumeBindingMode: WaitForFirstConsumer');
    expect(rendered).toContain('linodebs.csi.linode.com/volumeTags: "project:quorum"');
    expect(rendered).toContain('--advertise-address "$PRIVATE_IP"');
    // the marker comes after the StorageClass
    expect(rendered.indexOf('touch /tmp/k3s-ready')).toBeGreaterThan(
      rendered.indexOf('linode-block-storage-vibecarbon'),
    );
  });

  it('master mirrors its own private IP, agents mirror the master', async () => {
    const master = await LinodeProvider.getK8sMasterUserData(masterVars);
    expect(master).toContain('"$PRIVATE_IP:5000":');
    for (const render of [LinodeProvider.getK8sWorkerUserData, LinodeProvider.getK8sDbUserData]) {
      const rendered = await render(agentVars);
      expect(rendered).toContain('"10.0.1.2:5000":');
      expect(rendered).toContain('K3S_URL="https://10.0.1.2:6443"');
    }
  });

  it('db: pins the dedicated=db label and taint', async () => {
    const rendered = await LinodeProvider.getK8sDbUserData(agentVars);
    expect(rendered).toContain('--node-label="dedicated=db"');
    expect(rendered).toContain('--node-taint="dedicated=db:NoSchedule"');
  });

  it('the three templates are pure ASCII', () => {
    for (const role of ['master', 'worker', 'db']) {
      const text = readFileSync(
        join(__dirname, `../../../carbon/cloud-init/k3s/linode-${role}-init.sh`),
        'utf-8',
      );
      expect([...text].every((ch) => (ch.codePointAt(0) ?? 0) <= 0x7f)).toBe(true);
    }
  });
});
