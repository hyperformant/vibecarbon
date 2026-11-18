/**
 * Every node we boot sets net.core.txrehash=0 before it downloads anything, so
 * a TCP socket's IPv6 flow label never changes mid-connection.
 *
 * RCA 2026-11-06 to 2026-11-15: nine image pulls on fresh Linode nodes (compose
 * and k8s) failed with `failed to copy: read tcp [2600:3c05::...]->
 * [2606:50c0:800x::154]:443: read: connection reset by peer`, the k8s ones in
 * the runtime base prefetch, which fails the deploy. Probe 2026-11-15 (us-iad,
 * containerd pulling the deploy's images from boot): the resets came only on
 * Cloud-Firewalled nodes, and each node that saw one had
 * TcpExtTcpDuplicateDataRehash > 0 (0 on the clean node). The capture shows two
 * RSTs 0.5 ms apart answering our ACKs, one hop farther than the connection's
 * SYN-ACK, with another flow label: a GitHub server that never had the
 * connection. Linux v7.0: tcp_rcv_spurious_retrans rehashes the socket when
 * duplicate data arrives with a new flow label, and ip6_make_flowlabel derives
 * the label from that hash, so our ACKs take a new label and something on the
 * path picks the server by it. txrehash=0 is copied into every socket at
 * creation (af_inet.c, af_inet6.c) and stops both rehash paths.
 *
 * It only helps if it is set before the first download on every node class:
 * compose servers on every provider (bootcmd, ahead of runcmd's Docker
 * install), and the k3s master, db, static workers and autoscaler-created
 * workers (the shared snippet, ahead of the k3s install). So this walks every
 * k3s boot script and every provider's compose user data, not a hand list.
 * tests/unit/iac/docker-daemon-config-census.test.ts proves each compose
 * program hands its servers exactly getComposeUserData's text.
 *
 * Servers created before v0.54.1 never read this user data: every deploy sets
 * the same file and value on them over SSH, ahead of its pulls
 * (stable-flowlabel-deploy-census.test.ts).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { renderCarbonAutoscalerConfig } from '../../../src/lib/deploy/k8s/k3s.js';
import { loadCloudInit } from '../../../src/lib/iac/cloud-init.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';

const K3S_DIR = join(process.cwd(), 'carbon', 'cloud-init', 'k3s');
const SNIPPET = readFileSync(join(K3S_DIR, '_stable-flowlabel.sh'), 'utf-8');
const SYSCTL_WRITE = 'sysctl -q -w net.core.txrehash=0';
const SYSCTL_FILE = '/etc/sysctl.d/99-vibecarbon-stable-flowlabel.conf';
const SYSCTL_LINE = 'net.core.txrehash = 0';

// `_`-prefixed files are fragments spliced in by loadCloudInit's include.
const entrypoints = readdirSync(K3S_DIR)
  .filter((n) => n.endsWith('.sh') && !n.startsWith('_'))
  .sort();

type CloudConfig = {
  bootcmd?: unknown[];
  write_files?: Array<{ path?: string; content?: string }>;
  runcmd?: unknown[];
};

function commandText(entry: unknown): string {
  return Array.isArray(entry) ? entry.map(String).join(' ') : String(entry);
}

describe('stable flow label: every k3s node sets it before the k3s install', () => {
  it('walks every k3s boot script (never vacuously green)', () => {
    // master and worker for Hetzner, DigitalOcean and Linode; each db node
    // boots its provider's worker script.
    expect(entrypoints.length).toBeGreaterThanOrEqual(6);
  });

  it.each(entrypoints)('%s embeds the snippet before any download', (name) => {
    const script = loadCloudInit(name);
    const snippetAt = script.indexOf(SNIPPET);
    const installAt = script.indexOf('https://get.k3s.io');
    expect(snippetAt, `${name}: no _stable-flowlabel.sh include`).toBeGreaterThan(-1);
    expect(installAt, `${name}: no k3s install line`).toBeGreaterThan(-1);
    expect(snippetAt, `${name}: the sysctl must run before k3s downloads or pulls`).toBeLessThan(
      installAt,
    );
  });

  it('persists the setting for reboots and applies it now', () => {
    expect(SNIPPET).toContain(`printf '${SYSCTL_LINE}\\n' > ${SYSCTL_FILE}`);
    expect(SNIPPET).toContain(SYSCTL_WRITE);
    // No `|| true`: a key that exists but cannot be set fails the boot loudly.
    expect(SNIPPET).not.toMatch(/txrehash=0[^\n]*\|\|/);
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

describe('stable flow label: every compose server sets it before the Docker install', () => {
  it('covers every provider (never vacuously green)', () => {
    expect(Object.keys(PROVIDERS).length).toBeGreaterThanOrEqual(5);
  });

  it.each(Object.keys(PROVIDERS))('%s compose user data', async (id) => {
    const P = PROVIDERS[id as keyof typeof PROVIDERS];
    const text = (await P.getComposeUserData()) as string;
    const doc = loadYaml(text) as CloudConfig;

    // bootcmd runs in cloud-init's init stage, before runcmd (where every
    // provider splices the Docker install, which downloads from Docker's CDN).
    const boot = (doc.bootcmd ?? []).map(commandText);
    expect(
      boot.some((c) => c.includes(SYSCTL_WRITE)),
      `${id}: bootcmd must set txrehash`,
    ).toBe(true);
    expect(boot.join('\n')).not.toMatch(/txrehash=0[^\n]*\|\|/);
    // Nothing in runcmd may undo it.
    expect((doc.runcmd ?? []).map(commandText).join('\n')).not.toContain('txrehash');

    const file = (doc.write_files ?? []).find((f) => f.path === SYSCTL_FILE);
    expect(file, `${id}: ${SYSCTL_FILE} keeps it across reboots`).toBeDefined();
    expect(file?.content?.trim()).toBe(SYSCTL_LINE);
  });
});
