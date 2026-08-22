import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard: a systemd unit installed by cloud-init must be STARTED,
// not merely enabled.
//
// master-init.sh installed floating-ip.service — a Type=simple loop that
// re-adds the Hetzner Floating IP within 30s if networkd flushes it — and then
// ran a bare `systemctl enable`. `enable` only arms a unit for the NEXT boot.
// k8s masters are not rebooted, so for the node's entire life the single
// `ip addr add` earlier in the script was the only thing holding the address,
// and the watchdog the block exists to install never ran.
//
// Failure mode is silent and total: a netplan re-apply or a networkd
// DHCP-renewal flush drops the /32, the kernel discards every packet destined
// for the Floating IP (the cluster's public ingress —
// hetzner-k8s.js's `FloatingIp('ingress')`), and nothing re-adds it. Every node
// stays Ready, every pod healthy, kubectl clean.
//
// This is the boot-vs-whole-life class that #235 fixed for the private NIC.
// _private-net-guard.sh got it right — enable THEN restart — which is what
// makes the asymmetry visible in the first place.
//
// SCOPE. Only carbon/cloud-init/, where units are installed during boot and
// nothing later starts them. Deliberately NOT the deploy-time units:
// bundle.js's `${projectName}.service` (reconcile.sh runs `docker compose up`
// immediately before, so the stack is already running and the unit is purely
// reboot persistence) and wireguard.js's vibecarbon-wg0.service (the deploy
// brings wg0 up live in the same run). Their invariant is established by the
// deploy itself, not by the unit.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const cloudInitRoot = join(repoRoot, 'carbon/cloud-init');

function cloudInitFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(sh|ya?ml)$/.test(entry.name)) found.push(full);
    }
  };
  walk(cloudInitRoot);
  return found.sort();
}

describe('cloud-init starts the units it installs', () => {
  it('every `systemctl enable` either uses --now or is followed by an explicit start/restart', () => {
    const offenders: string[] = [];
    for (const file of cloudInitFiles()) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        // Skip comments — several blocks discuss `systemctl enable` in prose.
        if (/^\s*#/.test(line)) return;
        const enable = line.match(/systemctl\s+enable\s+(.*)$/);
        if (!enable) return;
        if (/--now/.test(enable[1])) return;
        // Unit name = first token that is not a flag.
        const unit = enable[1]
          .split(/\s+/)
          .find((tok) => tok && !tok.startsWith('-') && tok !== '||' && tok !== 'true');
        if (!unit) return;
        // A start/restart of the same unit within the next few lines counts.
        const followedByStart = lines
          .slice(i + 1, i + 5)
          .some((next) => new RegExp(`systemctl\\s+(start|restart)\\s+${unit}`).test(next));
        if (!followedByStart) {
          offenders.push(`${relative(repoRoot, file)}:${i + 1} — ${unit}`);
        }
      });
    }
    expect(
      offenders,
      '`systemctl enable` only arms a unit for the NEXT boot. These nodes are not ' +
        'rebooted, so a unit that guards a whole-life invariant never runs. Use ' +
        '`enable --now`, or start it explicitly on the next line:\n  ' +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('the Floating IP watchdog specifically is started at install time', () => {
    const master = readFileSync(join(cloudInitRoot, 'k3s/master-init.sh'), 'utf-8');
    expect(master).toMatch(/systemctl\s+enable\s+--now\s+floating-ip\.service/);
  });

  it('DigitalOcean installs no Floating-IP unit (its Reserved IP needs no OS binding)', () => {
    // Parity check, not a copy: DO's Reserved IP is provider-managed and
    // terminates at Traefik, so there is no address for the OS to hold and no
    // watchdog to start. If a DO floating-ip unit is ever added, it needs the
    // same --now treatment and this assertion should become one.
    const doMaster = readFileSync(join(cloudInitRoot, 'k3s/do-master-init.sh'), 'utf-8');
    expect(doMaster).not.toMatch(/floating-ip\.service/);
  });
});
