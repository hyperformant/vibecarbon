/**
 * VultrProvider.getK8s{Master,Worker,Db}UserData render the
 * carbon/cloud-init/k3s/vultr-{master,worker}-init.sh templates; the db node
 * loads the worker script as the db role. Mirrors linode-k8s-user-data.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { csiImageRewriteVars, loadCloudInit } from '../../../src/lib/iac/cloud-init.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';
import { readRepoFile } from '../../_shared/source-files.js';
import { createTempDir } from '../../_shared/temp-dir.js';

// Full-length values: a 64-character join token, a full k3s version and the
// longest VPC address the program's 10.128.0.0/10 range gives.
const TOKEN = 'f'.repeat(64);
const masterVars = { k3s_version: 'v1.37.2+k3s1', k3s_token: TOKEN };
const agentVars = { k3s_version: 'v1.37.2+k3s1', k3s_token: TOKEN, master_ip: '10.191.255.254' };

function templatePlaceholders(source: string): string[] {
  return [...new Set([...source.matchAll(/\$\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]))].sort();
}

const roles = [
  ['master', masterVars, (v: typeof masterVars) => VultrProvider.getK8sMasterUserData(v)],
  ['worker', agentVars, (v: typeof agentVars) => VultrProvider.getK8sWorkerUserData(v)],
  ['db', agentVars, (v: typeof agentVars) => VultrProvider.getK8sDbUserData(v)],
] as const;
const render = (fn: unknown, vars: unknown) => (fn as (v: unknown) => Promise<string>)(vars);

describe('VultrProvider k8s user-data statics', () => {
  it.each(roles)('%s: placeholder set is exactly the documented vars', (role, vars) => {
    const raw =
      role === 'db'
        ? loadCloudInit('vultr-worker-init.sh', { role: 'db' })
        : loadCloudInit(`vultr-${role}-init.sh`);
    // The master's static adds the CSI install's image rewrites itself.
    const added = role === 'master' ? Object.keys(csiImageRewriteVars('vultr')) : [];
    expect(templatePlaceholders(raw)).toEqual([...Object.keys(vars), ...added].sort());
  });

  it.each(roles)('%s: renders with no placeholder left', async (_role, vars, fn) => {
    const rendered = await render(fn, vars);
    expect(rendered).not.toMatch(/\$\{(k3s_|master_)/);
    expect(rendered).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
  });

  it.each(roles)(
    '%s: stays under the user-data cap at full-length values',
    async (role, vars, fn) => {
      const bytes = Buffer.byteLength(await render(fn, vars), 'utf-8');
      // Repo caps: 28 KiB for worker and db, 31 KiB for the master.
      expect(bytes, `${role} render size`).toBeLessThan(role === 'master' ? 31 * 1024 : 28 * 1024);
    },
  );

  it.each(roles)(
    '%s: identity from Vultr metadata, k3s on the VPC interface, no cloud controller',
    async (_role, vars, fn) => {
      const rendered = await render(fn, vars);
      expect(rendered).toContain('http://169.254.169.254/v1.json');
      expect(rendered).toContain('--kubelet-arg="provider-id=vultr://$NODE_ID"');
      expect(rendered).toContain('--flannel-iface "$PRIVATE_IFACE"');
      expect(rendered).toContain('--node-ip "$PRIVATE_IP"');
      expect(rendered).toContain('--node-external-ip "$PUBLIC_IP"');
      expect(rendered).not.toContain('--disable-cloud-controller');
      expect(rendered).not.toContain('cloud-provider=external');
      expect(rendered).not.toContain('--flannel-backend');
      expect(rendered).not.toMatch(/linode|digitalocean|hetzner|hcloud|droplet|eth1/i);
    },
  );

  // Vultr's Ubuntu image boots with UFW active, which would drop the
  // cluster's own traffic (_host-firewall-off.sh).
  it.each(roles)('%s: turns UFW off before the k3s install', async (_role, vars, fn) => {
    const commands = (await render(fn, vars))
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    const disable = commands.indexOf('ufw --force disable');
    const install = commands.search(/curl[^\n]*get\.k3s\.io/);
    expect(disable, 'ufw disable').toBeGreaterThan(-1);
    expect(install, 'k3s install').toBeGreaterThan(-1);
    expect(disable).toBeLessThan(install);
  });

  it('master: advertises the private address, joins agents only, and creates no Secret', async () => {
    const rendered = await VultrProvider.getK8sMasterUserData(masterVars);
    expect(rendered).toContain('provider-id=vultr://');
    expect(rendered).toContain('--advertise-address "$PRIVATE_IP"');
    expect(rendered).toContain(`--agent-token "${TOKEN}"`);
    const commands = rendered.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    expect(commands.join('\n')).not.toMatch(/--token\b/);
    expect(rendered).not.toContain('create secret');
    expect(rendered.indexOf('_m e\n')).toBeLessThan(rendered.indexOf('touch /tmp/k3s-ready'));
  });

  it('master: the CSI driver, its node plugin on every node and our StorageClass, before the ready marker', async () => {
    const rendered = await VultrProvider.getK8sMasterUserData(masterVars);
    const at = (text: string) => {
      const i = rendered.indexOf(text);
      expect(i, text).toBeGreaterThan(-1);
      return i;
    };
    // The release manifest holds VolumeSnapshotClasses, which k3s has no CRD
    // for: upstream's install docs name these, at the snapshotter's version.
    const crds = ['volumesnapshotclasses', 'volumesnapshotcontents', 'volumesnapshots'].map(
      (kind) =>
        at(
          `kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.4.0/client/config/crd/snapshot.storage.k8s.io_${kind}.yaml`,
        ),
    );
    const established = at('kubectl wait --for=condition=established');
    const driver = at(
      'csi_fetch_mirrored https://raw.githubusercontent.com/vultr/vultr-csi/v0.19.1/docs/releases/v0.19.1.yml /root/csi-driver.yaml \\\n    && kubectl apply -f /root/csi-driver.yaml;',
    );
    // The node plugin ships with no toleration, so without this it never
    // runs on the tainted db node, whose claim it mounts.
    const patch = at(
      `kubectl patch daemonset csi-vultr-node -n kube-system --type=merge -p \\\n      '{"spec":{"template":{"spec":{"tolerations":[{"operator":"Exists"}]}}}}'`,
    );
    const sc = at('kind: StorageClass');
    const order = [at('_m x\n'), ...crds, established, driver, patch, sc, at('_m e\n')];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const heredoc = rendered.slice(
      rendered.indexOf('<< SCEOF\n') + 9,
      rendered.indexOf('\nSCEOF\n'),
    );
    expect(load(heredoc)).toEqual({
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: VultrProvider.K8S_STORAGE_CLASS },
      provisioner: 'block.csi.vultr.com',
      reclaimPolicy: 'Delete',
      allowVolumeExpansion: true,
      volumeBindingMode: 'WaitForFirstConsumer',
      parameters: { storage_type: 'block', disk_type: 'nvme' },
    });
    // Each step stops the boot when its tries run out: a cluster with no
    // driver, or a db node it cannot mount on, must never report ready.
    for (const what of [
      'the snapshot CRDs',
      'the Vultr CSI driver',
      'csi-vultr-node with a universal toleration',
      `the ${VultrProvider.K8S_STORAGE_CLASS} StorageClass`,
    ]) {
      expect(rendered).toMatch(new RegExp(`FATAL: could not (install|patch|apply) ${what}`));
    }
  });

  it('master mirrors its own private IP, agents mirror the master', async () => {
    const master = await VultrProvider.getK8sMasterUserData(masterVars);
    expect(master).toContain('"$PRIVATE_IP:5000":');
    for (const fn of [VultrProvider.getK8sWorkerUserData, VultrProvider.getK8sDbUserData]) {
      const rendered = await fn(agentVars);
      expect(rendered).toContain('"10.191.255.254:5000":');
      expect(rendered).toContain('K3S_URL="https://10.191.255.254:6443"');
      expect(rendered).toContain(`K3S_TOKEN="${TOKEN}"`);
    }
  });

  it('db: pins the dedicated=db label and taint and leaves the host reporter to SSH', async () => {
    const db = await VultrProvider.getK8sDbUserData(agentVars);
    expect(db).toContain('--node-label="dedicated=db"');
    expect(db).toContain('--node-taint="dedicated=db:NoSchedule"');
    expect(db).not.toContain('vibecarbon-host-reporter.path');
    const worker = await VultrProvider.getK8sWorkerUserData(agentVars);
    expect(worker).toContain('vibecarbon-host-reporter.path');
    expect(worker).not.toContain('--node-label="dedicated=db"');
  });

  // k3s names the node after the hostname. Run the script's own identity
  // block (the metadata include, then the name check) against a fake
  // metadata service.
  describe.each(roles)('%s: names the host after its Vultr hostname', (_role, vars, fn) => {
    const run = async (hostname: string) => {
      const rendered = await render(fn, vars);
      const start = rendered.indexOf('# Vultr instance metadata: one JSON document.');
      const endMarker = 'echo "Node name: $NODE_NAME"';
      const end = rendered.indexOf(endMarker);
      expect(start, 'identity block start').toBeGreaterThan(-1);
      expect(end, 'identity block end').toBeGreaterThan(start);
      const dir = createTempDir('vc-vultr-hostname-');
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const metadata = {
        'instance-v2-id': '6a3b5f0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
        hostname,
        interfaces: [
          { 'network-type': 'public', ipv4: { address: '203.0.113.7' } },
          { 'network-type': 'private', ipv4: { address: '10.130.5.3' } },
        ],
      };
      writeFileSync(join(dir, 'v1.json'), JSON.stringify(metadata));
      writeFileSync(join(bin, 'curl'), `#!/bin/sh\ncat ${join(dir, 'v1.json')}\n`, {
        mode: 0o755,
      });
      writeFileSync(
        join(bin, 'ip'),
        '#!/bin/sh\necho "3: enp8s0    inet 10.130.5.3/24 brd 10.130.5.255 scope global enp8s0"\n',
        { mode: 0o755 },
      );
      writeFileSync(join(bin, 'hostnamectl'), '#!/bin/sh\necho "$@" >> "$HOSTNAME_LOG"\n', {
        mode: 0o755,
      });
      const log = join(dir, 'hostnamectl.log');
      const result = spawnSync(
        'bash',
        ['-c', `set -euo pipefail\n${rendered.slice(start, end + endMarker.length)}`],
        {
          env: { PATH: `${bin}:${process.env.PATH}`, HOSTNAME_LOG: log },
          encoding: 'utf8',
          timeout: 20_000,
        },
      );
      const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
      rmSync(dir, { recursive: true, force: true });
      return { status: result.status, out: `${result.stdout}${result.stderr}`, calls };
    };

    it('sets the hostname to a valid name', async () => {
      const hostname = 'testapp-k8s-ha-1794098138605-8q2aul-v4-primary-ewr-0a1b2c3d';
      const { status, calls } = await run(hostname);
      expect(status).toBe(0);
      expect(calls.trim()).toBe(`set-hostname ${hostname}`);
    });

    it.each([
      ['64 characters', 'a'.repeat(64)],
      ['upper case', 'Testapp-master'],
      ['an underscore', 'testapp_master'],
      ['empty', ''],
    ])('refuses a hostname with %s and sets nothing', async (_why, hostname) => {
      const { status, out, calls } = await run(hostname);
      expect(status).toBe(1);
      expect(out).toContain('FATAL');
      expect(calls).toBe('');
    });
  });

  it('both templates, their includes and the db render are pure ASCII', async () => {
    const texts = [
      'vultr-master-init.sh',
      'vultr-worker-init.sh',
      '_vultr-metadata.sh',
      '_host-firewall-off.sh',
    ].map((f) => readRepoFile(`carbon/cloud-init/k3s/${f}`));
    texts.push(await VultrProvider.getK8sDbUserData(agentVars));
    for (const text of texts) {
      expect([...text].every((ch) => (ch.codePointAt(0) ?? 0) <= 0x7f)).toBe(true);
    }
  });
});
