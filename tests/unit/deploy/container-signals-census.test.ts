/**
 * Every k3s node turns off kernel.apparmor_restrict_unprivileged_unconfined
 * before k3s starts any container — carbon/cloud-init/k3s/_container-signals.sh.
 *
 * RCA 2026-11-13 (linode/k8s, two runs): db-0 sat Running and never Ready for
 * 900 s. On Linode's Ubuntu 26.04 kernel (7.0.0-43) that restriction turns the
 * AppArmor profile change k3s's runc makes for a container's first process
 * into a stack, so the container runs as `cri-containerd.apparmor.d//&unconfined`
 * and containerd's profile, which only allows signals to a peer labelled
 * exactly `cri-containerd.apparmor.d`, denies every signal inside it. gosu
 * spun forever in setgroups (Go signals each of its threads); its main thread
 * had gid 70 while the other four still had gid 0, and the kernel log showed
 * `apparmor="DENIED" operation="signal" ... comm="gosu" signal=rtmin+1`.
 * Setting the sysctl to 0 on the kept node and recreating db-0 made it Ready
 * in 10 s with the plain label.
 *
 * The snippet only helps if it runs before the k3s install, on every node
 * class: master, db, static workers, and the workers the cluster-autoscaler
 * creates (they boot the same worker script, rendered into its config). So
 * this walks every k3s entrypoint script rather than a hand-kept list.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCarbonAutoscalerConfig } from '../../../src/lib/deploy/k8s/k3s.js';
import { loadCloudInit } from '../../../src/lib/iac/cloud-init.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';

const K3S_DIR = join(process.cwd(), 'carbon', 'cloud-init', 'k3s');
const SNIPPET = readFileSync(join(K3S_DIR, '_container-signals.sh'), 'utf-8');
const SYSCTL_WRITE = 'sysctl -q -w kernel.apparmor_restrict_unprivileged_unconfined=0';

// `_`-prefixed files are fragments spliced in by loadCloudInit's include.
const entrypoints = readdirSync(K3S_DIR)
  .filter((n) => n.endsWith('.sh') && !n.startsWith('_'))
  .sort();

describe('container signals: every k3s node lifts the unconfined restriction before k3s', () => {
  it('walks every k3s boot script (never vacuously green)', () => {
    // master, db and worker for Hetzner, DigitalOcean and Linode.
    expect(entrypoints.length).toBeGreaterThanOrEqual(9);
  });

  it.each(entrypoints)('%s embeds the snippet before the k3s install', (name) => {
    const script = loadCloudInit(name);
    const snippetAt = script.indexOf(SNIPPET);
    const installAt = script.indexOf('https://get.k3s.io');
    expect(snippetAt, `${name}: no _container-signals.sh include`).toBeGreaterThan(-1);
    expect(installAt, `${name}: no k3s install line`).toBeGreaterThan(-1);
    expect(snippetAt, `${name}: the sysctl must run before k3s starts containers`).toBeLessThan(
      installAt,
    );
  });

  it('persists the setting for reboots and applies it now', () => {
    // A reboot re-reads /usr/lib/sysctl.d/10-apparmor.conf (=1); a later-sorting
    // /etc/sysctl.d file wins, so the node keeps working after a kernel update.
    expect(SNIPPET).toContain(
      "printf 'kernel.apparmor_restrict_unprivileged_unconfined = 0\\n' > /etc/sysctl.d/99-vibecarbon-container-signals.conf",
    );
    expect(SNIPPET).toContain(SYSCTL_WRITE);
    // No `|| true`: a key that exists but cannot be set fails the boot loudly
    // instead of leaving every container on the node hung.
    expect(SNIPPET).not.toMatch(/apparmor_restrict_unprivileged_unconfined=0[^\n]*\|\|/);
    // ASCII only (DigitalOcean user data), and no ${...} for renderScript to eat.
    expect([...SNIPPET].every((c) => c.charCodeAt(0) < 128)).toBe(true);
    expect(SNIPPET).not.toMatch(/\$\{/);
  });

  it.each([
    ['hetzner', HetznerProvider, 'nbg1', 'cx23'],
    ['digitalocean', DigitalOceanProvider, 'nyc3', 's-2vcpu-4gb'],
    ['linode', LinodeProvider, 'us-ord', 'g6-standard-2'],
  ])(
    '%s: autoscaler-created workers boot with it',
    async (providerId, ProviderClass, region, type) => {
      const cfg = JSON.parse(
        await renderCarbonAutoscalerConfig({
          k3sVersion: 'v1.37.2+k3s1',
          k3sToken: 'deadbeefcafe1234567890abcdef',
          clusterName: 'acme-prod',
          environment: 'prod',
          providerId,
          ProviderClass,
          region,
          workerServerType: type,
          minWorkers: 1,
          maxWorkers: 4,
        }),
      );
      expect(cfg.nodeGroups['worker-pool'].cloudInit).toContain(SYSCTL_WRITE);
    },
  );
});
