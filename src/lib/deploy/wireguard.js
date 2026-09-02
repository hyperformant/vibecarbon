/**
 * WireGuard config builders for the primary↔standby replication tunnel.
 *
 * Replication used to run over the public internet with app-layer TLS
 * (verify-ca). That transport is being replaced by a point-to-point WireGuard
 * tunnel between the two clusters' gateways: the wire is encrypted by
 * WireGuard itself, so Postgres traffic inside the tunnel runs plaintext
 * (see replication.js — sslmode=disable, plain `host` pg_hba lines).
 *
 * WG_PORT is deliberately NOT 51820 — in k3s that port belongs to
 * flannel's built-in wireguard backend (flannel-wg), so a distinct port is
 * required to avoid colliding with cluster networking.
 */

import { sshRun } from '../ssh.js';
import { APT_LOCK_TIMEOUT_SECONDS, aptGet } from './apt.js';

export const WG_PORT = 51821; // NOT 51820 — flannel-wg owns that in k3s
export const WG_SUBNET_CIDR = '10.99.0.0/30';
export const WG_PRIMARY_IP = '10.99.0.1';
export const WG_STANDBY_IP = '10.99.0.2';

// The TCP port the repl-gateway socat relay listens on (both clusters). The
// standby db pod dials <local-node-private-ip>:REPL_GATEWAY_PORT; the standby
// gateway relays that into the tunnel to the primary gateway, which relays to
// the primary's postgres at 127.0.0.1:5433 (the db StatefulSet hostPort).
// Arbitrary — chosen distinct from postgres 5432/5433 so it never collides on
// the host.
export const REPL_GATEWAY_PORT = 15433;

// The on-node WireGuard private key. Generated on each supabase node with
// umask 077 and NEVER read back into this process — only the derived public
// key ever crosses the wire.
const WG_KEY_PATH = '/etc/vibecarbon-wg.key';

// Reboot-persistence (item I-1, live-confirmed 2026-07-07): wg0 is an
// imperative, in-memory-only interface — a node reboot (scale resize, crash,
// host maintenance) drops it, the repl-gateway then can't bind its tunnel IP
// and crash-loops, and replication silently breaks. We persist a systemd
// oneshot that recreates wg0 on boot from an on-node bring-up script (which
// itself carries every peer param the imperative bring-up used). The private
// key already persists on-node by design (WG_KEY_PATH, mode 0600, never leaves
// the node), so boot bring-up needs nothing from the orchestrator.
export const WG_UNIT_NAME = 'vibecarbon-wg0.service';
export const WG_UNIT_PATH = `/etc/systemd/system/${WG_UNIT_NAME}`;
export const WG_BOOTSCRIPT_PATH = '/etc/vibecarbon-wg0-up.sh';

const WG_PUBKEY_RE = /^[A-Za-z0-9+/]{43}=$/; // base64 Curve25519 public key
const ENDPOINT_RE = /^(\d{1,3}\.){3}\d{1,3}:\d{1,5}$/;
const ALLOWED_IP_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

/**
 * Argv-safe `wg`/`ip` command sequence bringing up the point-to-point wg0
 * tunnel. Interpolated values are validated (they reach a remote shell), so a
 * malformed peer key/endpoint throws rather than injecting.
 */
export function buildWireguardInterfaceConfig({
  selfIp,
  selfPrivKeyPath,
  listenPort,
  peerPubKey,
  peerEndpoint,
  peerAllowedIp,
  keepalive = 25,
}) {
  if (!WG_PUBKEY_RE.test(peerPubKey || '')) {
    throw new Error(`wireguard: invalid peer pubkey '${peerPubKey}'`);
  }
  if (!ENDPOINT_RE.test(peerEndpoint || '')) {
    throw new Error(`wireguard: invalid peer endpoint '${peerEndpoint}'`);
  }
  if (!ALLOWED_IP_RE.test(peerAllowedIp || '')) {
    throw new Error(`wireguard: invalid peer allowed-ip '${peerAllowedIp}'`);
  }
  return [
    'ip link del wg0 2>/dev/null; true',
    'ip link add wg0 type wireguard',
    `ip addr add ${selfIp}/30 dev wg0`,
    `wg set wg0 private-key ${selfPrivKeyPath} listen-port ${listenPort} ` +
      `peer ${peerPubKey} allowed-ips ${peerAllowedIp} endpoint ${peerEndpoint} ` +
      `persistent-keepalive ${keepalive}`,
    'ip link set wg0 up',
    // Trust the encrypted point-to-point tunnel interface. Compose hosts run
    // UFW with a default-DROP INPUT policy (Ubuntu default), which silently
    // drops the standby's TCP to the primary's repl-gateway on wg0 — the tunnel
    // carries ICMP (ping works) but replication never connects ("no replica
    // connected"). Live RCA 2026-07-07 on the e2 rig. Guarded so it's a clean
    // no-op on k8s nodes (no UFW) and never aborts bring-up.
    '(command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active" ' +
      '&& ufw allow in on wg0) || true',
  ];
}

/**
 * The on-node bring-up script persisted at WG_BOOTSCRIPT_PATH and run by the
 * systemd oneshot on every boot. It is generated FROM buildWireguardInterfaceConfig
 * with the SAME validated params the live bring-up uses, so boot-time bring-up
 * can NEVER drift from deploy-time bring-up — and the peer params (pubkey,
 * endpoint, allowed-ips, listen-port, tunnel address) are baked into this file,
 * making it the durable on-node record of the tunnel config. `set -e` so a
 * failed step marks the unit failed (visible in `systemctl status`) rather than
 * leaving a half-up wg0; the `ip link del` guard + UFW `|| true` in the builder
 * already tolerate the idempotent/no-ufw cases.
 *
 * @param {Parameters<typeof buildWireguardInterfaceConfig>[0]} params
 * @returns {string}
 */
export function buildWireguardBootScript(params) {
  const cmds = buildWireguardInterfaceConfig(params); // validates params; throws on injection
  return ['#!/bin/bash', 'set -e', ...cmds, ''].join('\n');
}

/**
 * The systemd oneshot unit that recreates wg0 on boot. RemainAfterExit keeps it
 * `active` after the oneshot returns so `systemctl status` reflects the tunnel;
 * network-online ordering ensures routing to the peer endpoint is available.
 *
 * @param {object} [o]
 * @param {string} [o.scriptPath] - the on-node bring-up script (WG_BOOTSCRIPT_PATH)
 * @returns {string}
 */
export function buildWireguardSystemdUnit({ scriptPath = WG_BOOTSCRIPT_PATH } = {}) {
  return [
    '[Unit]',
    'Description=Vibecarbon WireGuard replication tunnel (wg0)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    `ExecStart=${scriptPath}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

/**
 * Idempotent installer script that persists the boot script + systemd unit on a
 * node and enables the unit. Content is delivered base64-encoded so arbitrary
 * unit/script bytes never need shell escaping (the base64 alphabet is shell-safe).
 * Overwrites both files + re-enables on every call, so re-deploys and the scale
 * belt converge without churn. `enable` (not `start`): the tunnel is already up
 * live when this runs, so we only need it re-created on the NEXT boot.
 *
 * @param {object} o
 * @param {string} o.bootScript - buildWireguardBootScript output
 * @param {string} o.unit - buildWireguardSystemdUnit output
 * @param {string} [o.scriptPath]
 * @param {string} [o.unitPath]
 * @param {string} [o.unitName]
 * @returns {string}
 */
export function buildWireguardPersistInstall({
  bootScript,
  unit,
  scriptPath = WG_BOOTSCRIPT_PATH,
  unitPath = WG_UNIT_PATH,
  unitName = WG_UNIT_NAME,
}) {
  const b64Script = Buffer.from(bootScript, 'utf8').toString('base64');
  const b64Unit = Buffer.from(unit, 'utf8').toString('base64');
  return [
    'set -e',
    'umask 022',
    `echo ${b64Script} | base64 -d > ${scriptPath}`,
    `chmod 0700 ${scriptPath}`,
    `echo ${b64Unit} | base64 -d > ${unitPath}`,
    `chmod 0644 ${unitPath}`,
    'systemctl daemon-reload',
    `systemctl enable ${unitName}`,
    '',
  ].join('\n');
}

/**
 * Generate a WireGuard keypair on each supabase node, cross-distribute the
 * PUBLIC keys, and bring up the point-to-point wg0 tunnel between the two
 * clusters' supabase nodes.
 *
 * Key-exchange security contract:
 *   - The private key is generated ON the node (`wg genkey`, umask 077) into
 *     WG_KEY_PATH and NEVER read back into this process. `wg set` reads it from
 *     the file (`private-key <path>`), so the secret never transits argv, never
 *     gets logged, and is never returned.
 *   - Only the derived public key (`wg pubkey`) crosses the wire, and each node
 *     is configured with the PEER's public key + the peer's `<public-ip>:WG_PORT`
 *     endpoint.
 *
 * `primaryIp` / `standbyIp` are the two supabase nodes' PUBLIC IPv4 addresses —
 * they are BOTH the WireGuard endpoints (UDP WG_PORT) AND the SSH targets. All
 * SSH runs go through `sshRun`, which pins host keys and passes
 * `-o BatchMode=yes`.
 *
 * @param {object} o
 * @param {string} o.primaryIp - primary supabase node public IP (SSH + WG endpoint)
 * @param {string} o.standbyIp - standby supabase node public IP (SSH + WG endpoint)
 * @param {string} o.sshKeyPath - path to the shared HA SSH private key
 * @returns {Promise<{primaryPubKey: string, standbyPubKey: string}>}
 */
export async function exchangeAndBringUpTunnel({ primaryIp, standbyIp, sshKeyPath }) {
  if (!primaryIp || !standbyIp || !sshKeyPath) {
    throw new Error('exchangeAndBringUpTunnel requires primaryIp, standbyIp, and sshKeyPath');
  }

  // 1. Ensure wireguard-tools is installed and a private key exists on each
  //    node. Idempotent: the install is skipped when `wg` is already present,
  //    and the key is generated only if absent (so a re-deploy keeps the same
  //    keypair and does not churn the tunnel).
  for (const ip of [primaryIp, standbyIp]) {
    // `set -e` is load-bearing. This ran as a bare `||` chain, so a failed
    // install did NOT stop the script -- it fell through to `wg genkey` and
    // the step died reporting `wg: command not found`, burying the real
    // cause (the apt lock) under a symptom that reads like a missing
    // package. Live v2 2026-08-20: both errors in the same failure, and
    // only the second one made it into the step summary. The lock timeout
    // is the actual fix -- see apt.js; this node booted a minute or two
    // ago, so unattended-upgrades is very often still holding dpkg.
    //
    // The OUTER ssh timeout must exceed that INNER apt lock budget, or the
    // budget is unreachable: sshRun's 120s default killed this command at
    // ~197s of silent lock-wait while apt was still lawfully inside its
    // 300s window (reproduced three times on vultr restore re-deploys,
    // 2026-09-01/02 — the re-deploy reaches this step while first-boot
    // unattended-upgrades still holds dpkg; fresh deploys pass because the
    // lock has cleared by the time WG setup runs). 120s of headroom covers
    // the update + install themselves after the lock clears.
    await sshRun(
      ip,
      sshKeyPath,
      [
        'bash',
        '-c',
        'set -e; ' +
          'if ! command -v wg >/dev/null 2>&1; then ' +
          `DEBIAN_FRONTEND=noninteractive ${aptGet('update -qq')}; ` +
          `DEBIAN_FRONTEND=noninteractive ${aptGet('install -y -qq wireguard-tools')}; ` +
          'command -v wg >/dev/null 2>&1 || { ' +
          'echo "wireguard-tools installed but wg is still not on PATH" >&2; exit 1; }; ' +
          'fi; ' +
          `umask 077; [ -f ${WG_KEY_PATH} ] || wg genkey > ${WG_KEY_PATH}`,
      ],
      { timeout: (APT_LOCK_TIMEOUT_SECONDS + 120) * 1000 },
    );
  }

  // 2. Read back ONLY the public key from each node (private key stays on-node).
  const primaryPubKey = (
    await sshRun(primaryIp, sshKeyPath, ['bash', '-c', `wg pubkey < ${WG_KEY_PATH}`])
  ).trim();
  const standbyPubKey = (
    await sshRun(standbyIp, sshKeyPath, ['bash', '-c', `wg pubkey < ${WG_KEY_PATH}`])
  ).trim();

  // 3. Cross-configure + bring up each node with the PEER's pubkey + endpoint.
  // Keep the per-node params so the SAME values feed both the live bring-up and
  // the persisted boot script (buildWireguardBootScript) — no drift possible.
  const primaryParams = {
    selfIp: WG_PRIMARY_IP,
    selfPrivKeyPath: WG_KEY_PATH,
    listenPort: WG_PORT,
    peerPubKey: standbyPubKey,
    peerEndpoint: `${standbyIp}:${WG_PORT}`,
    peerAllowedIp: `${WG_STANDBY_IP}/32`,
  };
  const standbyParams = {
    selfIp: WG_STANDBY_IP,
    selfPrivKeyPath: WG_KEY_PATH,
    listenPort: WG_PORT,
    peerPubKey: primaryPubKey,
    peerEndpoint: `${primaryIp}:${WG_PORT}`,
    peerAllowedIp: `${WG_PRIMARY_IP}/32`,
  };
  const primaryUp = buildWireguardInterfaceConfig(primaryParams);
  const standbyUp = buildWireguardInterfaceConfig(standbyParams);
  await sshRun(primaryIp, sshKeyPath, ['bash', '-c', primaryUp.join(' && ')]);
  await sshRun(standbyIp, sshKeyPath, ['bash', '-c', standbyUp.join(' && ')]);

  // 4. Persist reboot-durable bring-up: write the boot script + systemd oneshot
  //    on each node and enable it (item I-1). Idempotent — overwrites + re-enables
  //    on every call, so this also self-heals an already-deployed env (predating
  //    this fix, or after the scale belt re-runs). The unit is only ENABLED, not
  //    started: wg0 is already up live above; we only need it back on NEXT boot.
  const unit = buildWireguardSystemdUnit();
  const primaryInstall = buildWireguardPersistInstall({
    bootScript: buildWireguardBootScript(primaryParams),
    unit,
  });
  const standbyInstall = buildWireguardPersistInstall({
    bootScript: buildWireguardBootScript(standbyParams),
    unit,
  });
  await sshRun(primaryIp, sshKeyPath, ['bash', '-c', primaryInstall]);
  await sshRun(standbyIp, sshKeyPath, ['bash', '-c', standbyInstall]);

  return { primaryPubKey, standbyPubKey };
}
