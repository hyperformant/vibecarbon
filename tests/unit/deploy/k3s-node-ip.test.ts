import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the ash/US k8s-ha failure (RCA 2026-06-23): the k3s init
 * scripts fetched the public IPv4 with a single `curl --max-time 10`. When the
 * Hetzner metadata service returned empty, k3s installed with `--node-ip ""`,
 * leaving the node InternalIP=<none> and unreachable from the control plane —
 * cert-manager-webhook never became Ready and the deploy timed out.
 *
 * Every k3s init script must fetch PUBLIC_IP robustly (retry + default-route
 * fallback) and FAIL the provision rather than install k3s with an empty
 * --node-ip.
 */
const K3S_DIR = join(process.cwd(), 'carbon', 'cloud-init', 'k3s');
const SCRIPTS = ['master-init.sh', 'worker-init.sh', 'supabase-init.sh'];

describe.each(SCRIPTS)('k3s init script %s — node-ip robustness', (name) => {
  const src = readFileSync(join(K3S_DIR, name), 'utf8');

  it('installs k3s with --node-ip "$PUBLIC_IP"', () => {
    expect(src).toMatch(/--node-ip\s+"\$PUBLIC_IP"/);
  });

  it('does NOT assign PUBLIC_IP from a single un-retried metadata curl', () => {
    // The exact buggy line that shipped an empty node-ip.
    expect(src).not.toMatch(
      /PUBLIC_IP=\$\(curl -s --max-time 10 http:\/\/169\.254\.169\.254[^\n]*\)\n/,
    );
  });

  it('retries the metadata endpoint in a loop', () => {
    expect(src).toMatch(/for i in \$\(seq 1 30\); do[\s\S]*169\.254\.169\.254/);
  });

  it('falls back to the default-route source address', () => {
    expect(src).toMatch(/ip -4 route get 1\.1\.1\.1[\s\S]*src \\K/);
  });

  it('fails fast (exit 1) rather than install an empty node-ip', () => {
    // A FATAL guard that exits before the k3s install when no IPv4 is found.
    expect(src).toMatch(/FATAL[\s\S]*empty node-ip/);
    expect(src).toMatch(/refusing to install k3s with an empty node-ip[\s\S]*exit 1/);
  });
});

describe('master-init.sh — private advertise-address', () => {
  const src = readFileSync(join(K3S_DIR, 'master-init.sh'), 'utf8');

  it('advertises the PRIVATE apiserver address (agent tunnels + in-cluster endpoint)', () => {
    // RCA 2026-07-17 e4 rig: with --advertise-address "$PUBLIC_IP", k3s agents
    // dial the reverse tunnel at master-public:6443, which the firewall admits
    // from operator CIDRs only (H-2 closeout c99f571) — every kubectl
    // exec/logs to a non-master node 502s and off-master apiserver clients
    // are locked out. 10.0.1.1 is the master's static ServerNetwork IP in the
    // Pulumi program — keep the three in lockstep.
    expect(src).toMatch(/--advertise-address\s+"10\.0\.1\.1"/);
    expect(src).not.toMatch(/--advertise-address\s+"\$PUBLIC_IP"/);
    expect(src).toMatch(/--tls-san\s+"10\.0\.1\.1"/);
  });

  it('keeps --node-ip PUBLIC (Hetzner CCM node matching depends on it)', () => {
    expect(src).toMatch(/--node-ip\s+"\$PUBLIC_IP"/);
  });
});

describe('master-init.sh — CSI volume attribution labels', () => {
  const src = readFileSync(join(K3S_DIR, 'master-init.sh'), 'utf8');

  it('stamps project labels onto CSI-created volumes', () => {
    // RCA 2026-07-18: pvc-* volumes carry no owner info; a concurrent run's
    // sweep deleted a live rig's legitimately-detached volumes mid-reseed.
    // HCLOUD_VOLUME_EXTRA_LABELS gives volumes the same `project=` label the
    // servers carry, and the e2e sweep filters on it.
    expect(src).toMatch(/HCLOUD_VOLUME_EXTRA_LABELS="project=\$\{project_name\}"/);
  });
});
