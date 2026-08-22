/**
 * Private-NIC address guard — `carbon/cloud-init/k3s/_private-net-guard.sh`.
 *
 * RCA 2026-08-05 (4-day-old k8s-ha rig): two of three Hetzner nodes went
 * NotReady with `node.kubernetes.io/unreachable`. uptime 4d21h (never
 * rebooted), k3s-agent still ACTIVE — but `enp7s0`, the Hetzner private NIC,
 * had NO IPv4 address. Its DHCP lease was lost mid-life and never
 * re-acquired, severing the 10.0.1.x path to the master, after which
 * kubelet's apiserver tunnel died with TLS-handshake timeouts.
 *
 * The pre-existing dhcpcd self-heal (the `DHCP_TRIGGERED` block in each
 * role script's private-NIC wait loop) only runs during cloud-init. It
 * guards BOOT. Nothing guarded day 4 — so every long-lived cluster is
 * exposed, and the exposure grows with uptime.
 *
 * These tests pin the guard's contract on the RENDERED user-data, which is
 * the artifact that actually reaches a node.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCarbonAutoscalerConfig } from '../../../src/lib/deploy/k8s/k3s.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

const SNIPPET_PATH = join(__dirname, '../../../carbon/cloud-init/k3s/_private-net-guard.sh');
const snippet = readFileSync(SNIPPET_PATH, 'utf-8');

/** Body of the guard's `repair()` shell function, for order-sensitive checks. */
function repairBody(): string {
  const start = snippet.indexOf('\nrepair() {');
  expect(start, 'guard must define repair()').toBeGreaterThan(-1);
  const end = snippet.indexOf('\n}\n', start);
  expect(end, 'repair() must be closed').toBeGreaterThan(start);
  return snippet.slice(start, end);
}

const masterVars = {
  k3s_version: 'v1.31.5+k3s1',
  k3s_token: 'deadbeefcafe1234567890abcdef',
  cluster_name: 'acme-prod',
  disable_traefik: 'true',
  hcloud_token: 'htk_test_token_1234',
  network_id: 12345,
  floating_ip: '203.0.113.10',
  project_name: 'acme',
};
const workerVars = {
  k3s_version: 'v1.31.5+k3s1',
  k3s_token: 'deadbeefcafe1234567890abcdef',
  master_ip: '10.0.1.1',
  cluster_name: 'acme-prod',
};
const supabaseVars = {
  k3s_version: 'v1.31.5+k3s1',
  k3s_token: 'deadbeefcafe1234567890abcdef',
  master_ip: '10.0.1.1',
};

async function hetznerRenders() {
  return {
    master: await HetznerProvider.getK8sMasterUserData(masterVars),
    supabase: await HetznerProvider.getK8sSupabaseUserData(supabaseVars),
    worker: await HetznerProvider.getK8sWorkerUserData(workerVars),
  };
}

describe('private-NIC guard is wired into every Hetzner k3s role', () => {
  it('installs the watchdog + its systemd unit in master, supabase, AND worker user-data', async () => {
    const renders = await hetznerRenders();
    for (const [role, script] of Object.entries(renders)) {
      expect(script, role).toContain('/usr/local/sbin/vibecarbon-private-net-guard');
      expect(script, role).toContain('/etc/systemd/system/vibecarbon-private-net.service');
      expect(script, role).toMatch(/systemctl enable[^\n]*vibecarbon-private-net/);
      expect(script, role).toMatch(/systemctl (start|restart)[^\n]*vibecarbon-private-net/);
    }
  });

  it('embeds the guard byte-identically in all three roles (no hand-copy drift)', async () => {
    const renders = await hetznerRenders();
    for (const [role, script] of Object.entries(renders)) {
      expect(script.includes(snippet), `${role} must embed the shared snippet verbatim`).toBe(true);
    }
  });

  it('installs the guard AFTER the private NIC is up, so it records a known-good config', async () => {
    // The snippet reads PRIVATE_IFACE/PRIVATE_IP, which the wait loop above
    // it sets. Installing before the loop would record an empty interface.
    const renders = await hetznerRenders();
    for (const [role, script] of Object.entries(renders)) {
      const loopIdx = script.indexOf('Waiting for private network interface...');
      const guardIdx = script.indexOf('/usr/local/sbin/vibecarbon-private-net-guard');
      expect(loopIdx, role).toBeGreaterThan(-1);
      expect(guardIdx, role).toBeGreaterThan(loopIdx);
    }
  });

  it('ships to cluster-autoscaler-spawned workers too (the node class with NO render-time IP)', async () => {
    // src/autoscaler/groups.js creates CA workers with `networks: [networkId]`
    // and no `ip`, so Hetzner assigns their private address dynamically and
    // no Pulumi constant exists for them. They are also the most numerous
    // node class in a scaled cluster — leaving them out would leave the bug
    // in place exactly where it bites hardest.
    const cfg = JSON.parse(
      await renderCarbonAutoscalerConfig({
        k3sVersion: 'v1.31.5+k3s1',
        k3sToken: 'deadbeefcafe1234567890abcdef',
        clusterName: 'acme-prod',
        environment: 'prod',
        providerId: 'hetzner',
        ProviderClass: HetznerProvider,
        region: 'nbg1',
        workerServerType: 'cx23',
        minWorkers: 1,
        maxWorkers: 4,
      }),
    );
    expect(cfg.nodeGroups['worker-pool'].cloudInit).toContain(
      '/usr/local/sbin/vibecarbon-private-net-guard',
    );
  });

  it('keeps every Hetzner render under the 32KiB user_data cap with headroom', async () => {
    // Hetzner's API rejects `user_data` over 32KiB, and it rejects it at
    // server-create time — i.e. mid-deploy, or mid-scale-up on a node the
    // autoscaler needed. The guard took master-init from ~12KiB to ~23KiB,
    // so the remaining headroom is real but no longer generous: this
    // threshold is the tripwire for the next thing that wants to be
    // "just a few more lines of cloud-init".
    const renders = await hetznerRenders();
    for (const [role, script] of Object.entries(renders)) {
      expect(Buffer.byteLength(script, 'utf-8'), role).toBeLessThan(28 * 1024);
    }
  });

  // The guard must use bare $VAR shell syntax, never brace-delimited, or
  // renderScript's placeholder pass would eat it (or leave it looking like an
  // unrendered template var to every drift guard in the suite).
  it('leaves no unrendered brace-delimited placeholders in any role', async () => {
    const renders = await hetznerRenders();
    for (const [role, script] of Object.entries(renders)) {
      expect(script, role).not.toMatch(/\$\{[a-zA-Z0-9_]+\}/);
    }
  });
});

describe('private-NIC guard behaviour', () => {
  it('runs for the whole node lifetime, not once at boot (the actual bug)', () => {
    // A oneshot unit reproduces exactly today's gap: boot-only coverage.
    expect(snippet).toContain('Type=simple');
    expect(snippet).not.toContain('Type=oneshot');
    expect(snippet).toContain('Restart=always');
    expect(snippet).toMatch(/while true/);
  });

  it('detects loss within one k8s node-monitor grace period (40s)', () => {
    const match = snippet.match(/^POLL_SECONDS=(\d+)$/m);
    expect(match, 'guard must declare POLL_SECONDS').not.toBeNull();
    expect(Number(match?.[1])).toBeLessThanOrEqual(20);
  });

  it('re-acquires via DHCP FIRST, so a healthy lease path stays authoritative', () => {
    // Ordering inside repair(): if the static pin ran first it would race the
    // DHCP client and could pin a stale address that Hetzner has reassigned.
    const body = repairBody();
    expect(body).toMatch(/dhcpcd -1/);
    const dhcpIdx = body.indexOf('dhcpcd -1');
    const staticIdx = body.indexOf('ip addr add');
    expect(staticIdx).toBeGreaterThan(dhcpIdx);
  });

  it('falls back to a STATIC pin using Hetzner-documented /32 + on-link route', () => {
    // https://docs.hetzner.com/networking/networks/server-configuration/ —
    // private IP is a /32; the route to the network range needs `on-link`
    // because the gateway is not inside the /32.
    expect(snippet).toMatch(/ip addr add[^\n]*\/32/);
    expect(snippet).toMatch(/ip route replace[^\n]*onlink/);
  });

  it('restores the Hetzner private-network MTU (1450) when it pins statically', () => {
    // DHCP delivers MTU 1450 via option 26; a hand-added address does not.
    // Leaving 1500 there silently blackholes large frames through flannel.
    expect(snippet).toMatch(/ip link set[^\n]*mtu/);
    expect(snippet).toContain('1450');
  });

  it('learns the address from the Hetzner metadata service, not a render-time constant', () => {
    expect(snippet).toContain('http://169.254.169.254/hetzner/v1/metadata/private-networks');
  });

  it('persists the recorded config so a repair survives a guard restart', () => {
    expect(snippet).toContain('/etc/vibecarbon/private-net.env');
  });

  it('repairs a missing ROUTE as well as a missing address', () => {
    // The incident showed a missing address, but a surviving address with a
    // dropped default-into-10/8 route is the same outage with a different
    // shape — and the check costs one `ip route show`.
    expect(snippet).toMatch(/ip -4 route show/);
  });

  it('never reconfigures the public NIC', () => {
    // master-init.sh legitimately puts the floating IP on eth0; the guard
    // must stay out of that entirely — a stray `dev eth0` here could flush
    // the primary address and lock the operator out of the box.
    expect(snippet).not.toMatch(/\beth0\b/);
  });

  it('accepts only RFC1918 addresses, so an IPv4LL self-assignment never reads as healthy', () => {
    // A DHCP client that cannot get a lease self-assigns 169.254.x. Treating
    // that as a healthy address would make the guard a no-op in exactly the
    // failure it exists for — so health is an RFC1918 allowlist, not
    // "any address".
    expect(snippet).toContain('is_private_ipv4');
    const re = snippet.match(/grep -qE '(\^\([^']+)'/);
    expect(re, 'guard must declare an RFC1918 allowlist regex').not.toBeNull();
    const allowlist = new RegExp(re?.[1] ?? '$^');
    expect(allowlist.test('10.0.1.5')).toBe(true);
    expect(allowlist.test('172.16.4.9')).toBe(true);
    expect(allowlist.test('192.168.1.2')).toBe(true);
    expect(allowlist.test('169.254.12.34')).toBe(false);
    expect(allowlist.test('203.0.113.10')).toBe(false);
    expect(allowlist.test('')).toBe(false);
  });

  it('cannot fail the deploy: every fallible install-time command is `|| true`-guarded', () => {
    // The install block runs inside the role script's `set -euo pipefail`.
    // A best-effort watchdog that aborts cloud-init when `systemctl` hiccups
    // or when `head -1` SIGPIPEs a `sed` would be a strictly worse bug than
    // the one it fixes — it would break FRESH deploys to protect old ones.
    const installOnly = snippet
      .replace(/<< 'PNGUARDEOF'\n[\s\S]*?\nPNGUARDEOF/, "<< 'PNGUARDEOF'\nPNGUARDEOF")
      .replace(/<< 'PNUNITEOF'\n[\s\S]*?\nPNUNITEOF/, "<< 'PNUNITEOF'\nPNUNITEOF")
      .replace(/<< PNCONFEOF\n[\s\S]*?\nPNCONFEOF/, '<< PNCONFEOF\nPNCONFEOF');
    const fallible = installOnly
      .split('\n')
      .filter((l) => /^\s*(systemctl|curl|ip )/.test(l) || /=\$\((cat|ip |curl|printf)/.test(l));
    expect(fallible.length, 'expected to find fallible install commands').toBeGreaterThan(4);
    for (const line of fallible) {
      expect(line, line.trim()).toMatch(/\|\|\s*(true|echo)/);
    }
  });

  it('never aborts the guard loop on a transient command failure', () => {
    // `set -e` inside a watchdog turns one failed `ip`/`curl` into a dead
    // watchdog — the opposite of what a guard is for. Restart=always would
    // recover it, but only after the unit dies, and only after the node has
    // already been unreachable for RestartSec.
    const body = snippet.slice(snippet.indexOf("<< 'PNGUARDEOF'"), snippet.indexOf('\nPNGUARDEOF'));
    expect(body).toMatch(/^set -uo pipefail$/m);
    expect(body).not.toMatch(/set -euo pipefail/);
  });
});

describe('provider + tier scoping (deliberate — do not widen without evidence)', () => {
  it('does NOT ship on DigitalOcean, whose VPC NIC is statically configured', async () => {
    // DO's cloud-init datasource renders eth1 statically from
    // /metadata/v1 — there is no lease to lose, and do-*-init.sh already
    // read the private IP from metadata rather than from the interface.
    // Shipping a dead watchdog there would be untested code on a provider
    // that cannot exhibit the bug.
    const doVars = {
      k3s_version: 'v1.31.5+k3s1',
      k3s_token: 'deadbeefcafe1234567890abcdef',
      master_ip: '10.116.0.2',
      cluster_name: 'acme-prod',
    };
    const worker = await DigitalOceanProvider.getK8sWorkerUserData(doVars);
    expect(worker).not.toContain('vibecarbon-private-net-guard');
    expect(worker).toContain('http://169.254.169.254/metadata/v1/');
  });

  it('the compose tier has no Hetzner private network to lose (grep-proof, not a claim)', () => {
    // hetzner-compose.js provisions NO hcloud.Network; compose-ha replicates
    // over WireGuard with hardcoded 10.99.0.x tunnel addresses
    // (src/lib/deploy/wireguard.js). No DHCP lease anywhere on that path.
    const composeProgram = readFileSync(
      join(__dirname, '../../../src/lib/iac/programs/hetzner-compose.js'),
      'utf-8',
    );
    expect(composeProgram).not.toMatch(/new hcloud\.Network\b/);
    const wg = readFileSync(join(__dirname, '../../../src/lib/deploy/wireguard.js'), 'utf-8');
    expect(wg).toMatch(/WG_PRIMARY_IP = '10\.99\.0\.1'/);
  });
});
