/**
 * ScalewayProvider.getK8s{Master,Worker,Db}UserData render the
 * carbon/cloud-init/k3s/scaleway-{master,worker}-init.sh templates; the db
 * node loads the worker script as the db role. Mirrors
 * vultr-k8s-user-data.test.ts. The master installs no CSI driver yet (Part C
 * Task 3 adds it, and its image rewrites, between `_m x` and `_m e`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadCloudInit } from '../../../src/lib/iac/cloud-init.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { PUBLIC_NIC, scalewayHost } from '../../_shared/scaleway-host.js';
import { readRepoFile } from '../../_shared/source-files.js';

// Full-length values: a 64-character join token, a full k3s version and the
// longest private address the program's 10.128.0.0/10 range gives.
const TOKEN = 'f'.repeat(64);
const masterVars = { k3s_version: 'v1.37.2+k3s1', k3s_token: TOKEN };
const agentVars = { k3s_version: 'v1.37.2+k3s1', k3s_token: TOKEN, master_ip: '10.191.255.254' };

function templatePlaceholders(source: string): string[] {
  return [...new Set([...source.matchAll(/\$\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]))].sort();
}

const roles = [
  ['master', masterVars, (v: typeof masterVars) => ScalewayProvider.getK8sMasterUserData(v)],
  ['worker', agentVars, (v: typeof agentVars) => ScalewayProvider.getK8sWorkerUserData(v)],
  ['db', agentVars, (v: typeof agentVars) => ScalewayProvider.getK8sDbUserData(v)],
] as const;
const render = (fn: unknown, vars: unknown) => (fn as (v: unknown) => Promise<string>)(vars);
/** The systemd unit get.k3s.io installs for each role. */
const UNIT = { master: 'k3s', worker: 'k3s-agent', db: 'k3s-agent' } as const;
/** Lines that execute: comments dropped. */
const commandsOf = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

describe('ScalewayProvider k8s user-data statics', () => {
  it.each(roles)('%s: placeholder set is exactly the documented vars', (role, vars) => {
    const raw =
      role === 'db'
        ? loadCloudInit('scaleway-worker-init.sh', { role: 'db' })
        : loadCloudInit(`scaleway-${role}-init.sh`);
    expect(templatePlaceholders(raw)).toEqual(Object.keys(vars).sort());
  });

  it('master takes the token and version; worker and db add master_ip', () => {
    expect(templatePlaceholders(loadCloudInit('scaleway-master-init.sh'))).toEqual([
      'k3s_token',
      'k3s_version',
    ]);
    for (const raw of [
      loadCloudInit('scaleway-worker-init.sh'),
      loadCloudInit('scaleway-worker-init.sh', { role: 'db' }),
    ]) {
      expect(templatePlaceholders(raw)).toEqual(['k3s_token', 'k3s_version', 'master_ip']);
    }
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
    '%s: identity from Scaleway metadata, flannel on the Private Network NIC, no cloud controller',
    async (role, vars, fn) => {
      const rendered = await render(fn, vars);
      expect(rendered).toContain("'http://169.254.42.42/conf?format=json'");
      expect(rendered).toContain(`K3S_UNIT=${UNIT[role]}\n`);
      expect(rendered).toContain('--kubelet-arg="provider-id=scaleway://$NODE_ID"');
      expect(rendered).toContain('--node-ip "$PRIVATE_IP"');
      expect(rendered).toContain('--node-external-ip "$PUBLIC_IP"');
      // The drop-in's start-time script names the interface at every k3s
      // start, so a NIC renamed across a reboot is found again.
      expect(rendered).toContain('ExecStartPre=/usr/local/sbin/vc-flannel-iface');
      expect(rendered).not.toContain('--flannel-iface');
      expect(rendered).not.toContain('--flannel-backend');
      expect(rendered).not.toContain('--disable-cloud-controller');
      expect(rendered).not.toContain('cloud-provider=external');
      expect(rendered).not.toMatch(
        /vultr|linode|digitalocean|hetzner|hcloud|droplet|eth1|169\.254\.169\.254/i,
      );
    },
  );

  // The UFW state of `ubuntu_resolute` is unconfirmed (_host-firewall-off.sh
  // does nothing without ufw); the container-signals sysctl must be in place
  // before the k3s install.
  it.each(roles)(
    '%s: turns UFW off and lets containers take signals before the k3s install',
    async (_role, vars, fn) => {
      const commands = commandsOf(await render(fn, vars));
      const install = commands.search(/curl[^\n]*get\.k3s\.io/);
      expect(install, 'k3s install').toBeGreaterThan(-1);
      for (const step of [
        'ufw --force disable',
        'kernel.apparmor_restrict_unprivileged_unconfined = 0',
      ]) {
        const at = commands.indexOf(step);
        expect(at, step).toBeGreaterThan(-1);
        expect(at, step).toBeLessThan(install);
      }
    },
  );

  it('master: advertises the private address, joins agents only, and creates no Secret', async () => {
    const rendered = await ScalewayProvider.getK8sMasterUserData(masterVars);
    expect(rendered).toContain('provider-id=scaleway://$NODE_ID');
    expect(rendered).toContain('--advertise-address "$PRIVATE_IP"');
    expect(rendered).toContain('K3S_UNIT=k3s\n');
    expect(rendered).toContain(`--agent-token "${TOKEN}"`);
    expect(commandsOf(rendered)).not.toMatch(/--token\b/);
    expect(rendered).not.toContain('create secret');
    expect(rendered.indexOf('_m e\n')).toBeLessThan(rendered.indexOf('touch /tmp/k3s-ready'));
    // No CSI driver yet: Part C Task 3 adds it between `_m x` and `_m e`.
    expect(commandsOf(rendered)).not.toMatch(/csi/i);
  });

  it('worker and db join as the k3s-agent unit', async () => {
    for (const fn of [ScalewayProvider.getK8sWorkerUserData, ScalewayProvider.getK8sDbUserData]) {
      const rendered = await fn(agentVars);
      expect(rendered).toContain('K3S_UNIT=k3s-agent\n');
      expect(rendered).not.toContain('--advertise-address');
    }
  });

  it('master mirrors its own private IP, agents mirror the master', async () => {
    const master = await ScalewayProvider.getK8sMasterUserData(masterVars);
    expect(master).toContain('"$PRIVATE_IP:5000":');
    for (const fn of [ScalewayProvider.getK8sWorkerUserData, ScalewayProvider.getK8sDbUserData]) {
      const rendered = await fn(agentVars);
      expect(rendered).toContain('"10.191.255.254:5000":');
      expect(rendered).toContain('K3S_URL="https://10.191.255.254:6443"');
      expect(rendered).toContain(`K3S_TOKEN="${TOKEN}"`);
    }
  });

  it('db: pins the dedicated=db label and taint and leaves the host reporter to SSH', async () => {
    const db = await ScalewayProvider.getK8sDbUserData(agentVars);
    expect(db).toContain('--node-label="dedicated=db"');
    expect(db).toContain('--node-taint="dedicated=db:NoSchedule"');
    expect(db).not.toContain('vibecarbon-host-reporter.path');
    const worker = await ScalewayProvider.getK8sWorkerUserData(agentVars);
    expect(worker).toContain('vibecarbon-host-reporter.path');
    expect(worker).not.toContain('--node-label="dedicated=db"');
  });

  // k3s names the node after the hostname. Run the script's own identity
  // block (the unit, the metadata include, then the name check) on a fake
  // host, with a hostnamectl that only logs.
  describe.each(roles)('%s: names the host after its metadata hostname', (role, vars, fn) => {
    const run = async (hostname: string) => {
      const rendered = await render(fn, vars);
      const start = rendered.indexOf('\nK3S_UNIT=') + 1;
      const endMarker = 'echo "Node name: $NODE_NAME"';
      const end = rendered.indexOf(endMarker);
      expect(start, 'identity block start').toBeGreaterThan(0);
      expect(end, 'identity block end').toBeGreaterThan(start);
      const host = scalewayHost('vc-scaleway-hostname-');
      try {
        host.setMetadata({
          id: '6a3b5f0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
          hostname,
          location: { zone_id: 'fr-par-1' },
          public_ips_v4: [{ address: '203.0.113.7' }],
        });
        host.setNics([
          PUBLIC_NIC,
          { name: 'ens5', mac: '02:00:00:aa:bb:cc', cidr: '10.130.5.3/24' },
        ]);
        const log = host.path('/hostnamectl.log');
        host.shim('hostnamectl', `echo "$@" >> '${log}'`);
        const result = host.run(
          `set -euo pipefail\n${host.sandbox(rendered.slice(start, end + endMarker.length))}`,
        );
        const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
        const dropIn = existsSync(
          host.path(`/etc/systemd/system/${UNIT[role]}.service.d/10-flannel-iface.conf`),
        );
        return { status: result.status, out: `${result.stdout}${result.stderr}`, calls, dropIn };
      } finally {
        host.cleanup();
      }
    };

    it('sets the hostname to a valid name, and the drop-in names its unit', async () => {
      const hostname = 'testapp-k8s-ha-1794098138605-8q2aul-v4-primary-par-0a1b2c3d';
      const { status, calls, dropIn } = await run(hostname);
      expect(status).toBe(0);
      expect(calls.trim()).toBe(`set-hostname ${hostname}`);
      expect(dropIn).toBe(true);
    });

    // A longer server name is the cloud's affair: the program and the
    // autoscaler name servers (Part C Task 5).
    it.each([
      ['64 characters', 'a'.repeat(64)],
      ['upper case', 'Testapp-master'],
      ['an underscore', 'testapp_master'],
      ['empty', ''],
    ])('refuses a metadata hostname that is not one DNS label (%s)', async (_why, hostname) => {
      const { status, out, calls } = await run(hostname);
      expect(status).toBe(1);
      expect(out).toContain('FATAL');
      expect(calls).toBe('');
    });
  });

  it('both templates, the include and the db render are pure ASCII', async () => {
    const texts = [
      'scaleway-master-init.sh',
      'scaleway-worker-init.sh',
      '_scaleway-metadata.sh',
    ].map((f) => readRepoFile(`carbon/cloud-init/k3s/${f}`));
    texts.push(await ScalewayProvider.getK8sDbUserData(agentVars));
    for (const text of texts) {
      expect([...text].every((ch) => (ch.codePointAt(0) ?? 0) <= 0x7f)).toBe(true);
    }
  });
});
