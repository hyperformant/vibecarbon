import { describe, expect, it, vi } from 'vitest';
import {
  buildWireguardBootScript,
  buildWireguardInterfaceConfig,
  buildWireguardPersistInstall,
  buildWireguardSystemdUnit,
  exchangeAndBringUpTunnel,
  REPL_GATEWAY_PORT,
  WG_BOOTSCRIPT_PATH,
  WG_PORT,
  WG_PRIMARY_IP,
  WG_STANDBY_IP,
  WG_SUBNET_CIDR,
  WG_UNIT_NAME,
  WG_UNIT_PATH,
} from '../../../src/lib/deploy/wireguard.js';
import * as ssh from '../../../src/lib/ssh.js';

describe('wireguard constants', () => {
  it('uses a port distinct from flannel-wg (51820)', () => {
    expect(WG_PORT).toBe(51821);
    expect(WG_PORT).not.toBe(51820);
  });
  it('uses a /30 tunnel subnet clear of flannel + hetzner-private ranges', () => {
    expect(WG_SUBNET_CIDR).toBe('10.99.0.0/30');
    expect(WG_PRIMARY_IP).toBe('10.99.0.1');
    expect(WG_STANDBY_IP).toBe('10.99.0.2');
  });
});

describe('buildWireguardInterfaceConfig', () => {
  const base = {
    selfIp: '10.99.0.1',
    selfPrivKeyPath: '/etc/wg/priv',
    listenPort: 51821,
    peerPubKey: 'FWxNbddwB9ap1+Nfhv++GcS2CtEh/5CNPiCKF9UIkS4=',
    peerEndpoint: '157.180.115.19:51821',
    peerAllowedIp: '10.99.0.2/32',
    keepalive: 25,
  };
  it('emits the wg0 bring-up sequence with self IP, listen-port, peer + keepalive', () => {
    const cmds = buildWireguardInterfaceConfig(base).join('\n');
    expect(cmds).toContain('ip link add wg0 type wireguard');
    expect(cmds).toContain('ip addr add 10.99.0.1/30 dev wg0');
    expect(cmds).toContain('listen-port 51821');
    expect(cmds).toContain('peer FWxNbddwB9ap1+Nfhv++GcS2CtEh/5CNPiCKF9UIkS4=');
    expect(cmds).toContain('allowed-ips 10.99.0.2/32');
    expect(cmds).toContain('endpoint 157.180.115.19:51821');
    expect(cmds).toContain('persistent-keepalive 25');
    expect(cmds).toContain('ip link set wg0 up');
  });
  it('trusts the wg0 tunnel interface in UFW (guarded, no-op without ufw) so tunnel TCP is not dropped', () => {
    const cmds = buildWireguardInterfaceConfig(base).join('\n');
    expect(cmds).toContain('ufw allow in on wg0');
    // guarded: only when ufw is present + active, and never aborts bring-up
    expect(cmds).toContain('command -v ufw');
    expect(cmds).toMatch(/\|\| true/);
  });
  it('is idempotent — deletes any prior wg0 before adding', () => {
    expect(buildWireguardInterfaceConfig(base)[0]).toContain('ip link del wg0');
  });
  it('rejects a peer pubkey containing shell metacharacters', () => {
    expect(() => buildWireguardInterfaceConfig({ ...base, peerPubKey: 'x; rm -rf /' })).toThrow(
      /pubkey/i,
    );
  });
  it('rejects a non-IP:port endpoint', () => {
    expect(() => buildWireguardInterfaceConfig({ ...base, peerEndpoint: 'evil$(x):1' })).toThrow(
      /endpoint/i,
    );
  });
});

describe('reboot persistence (item I-1)', () => {
  const params = {
    selfIp: WG_PRIMARY_IP,
    selfPrivKeyPath: '/etc/vibecarbon-wg.key',
    listenPort: WG_PORT,
    peerPubKey: 'FWxNbddwB9ap1+Nfhv++GcS2CtEh/5CNPiCKF9UIkS4=',
    peerEndpoint: '157.180.115.19:51821',
    peerAllowedIp: '10.99.0.2/32',
  };

  describe('buildWireguardBootScript', () => {
    it('is a bash script carrying the SAME bring-up commands + every peer param', () => {
      const script = buildWireguardBootScript(params);
      expect(script.startsWith('#!/bin/bash\n')).toBe(true);
      expect(script).toContain('set -e');
      // Config values baked in — this file IS the durable on-node tunnel record.
      expect(script).toContain('ip link add wg0 type wireguard');
      expect(script).toContain('ip addr add 10.99.0.1/30 dev wg0');
      expect(script).toContain('listen-port 51821');
      expect(script).toContain('peer FWxNbddwB9ap1+Nfhv++GcS2CtEh/5CNPiCKF9UIkS4=');
      expect(script).toContain('allowed-ips 10.99.0.2/32');
      expect(script).toContain('endpoint 157.180.115.19:51821');
      expect(script).toContain('ip link set wg0 up');
      expect(script).toContain('ufw allow in on wg0');
      // Reads the persisted private key from disk — never embeds the secret.
      expect(script).toContain('private-key /etc/vibecarbon-wg.key');
      expect(script).not.toContain('PRIVATE KEY');
    });
    it('cannot drift from the live bring-up (built from the same builder)', () => {
      const script = buildWireguardBootScript(params);
      for (const cmd of buildWireguardInterfaceConfig(params)) {
        expect(script).toContain(cmd);
      }
    });
    it('rejects an injected peer endpoint (validated through the shared builder)', () => {
      expect(() => buildWireguardBootScript({ ...params, peerEndpoint: 'evil$(x):1' })).toThrow(
        /endpoint/i,
      );
    });
  });

  describe('buildWireguardSystemdUnit', () => {
    it('is a oneshot unit that runs the boot script and installs to multi-user', () => {
      const unit = buildWireguardSystemdUnit();
      expect(unit).toContain('[Unit]');
      expect(unit).toContain('[Service]');
      expect(unit).toContain('[Install]');
      expect(unit).toContain('Type=oneshot');
      expect(unit).toContain('RemainAfterExit=yes');
      expect(unit).toContain(`ExecStart=${WG_BOOTSCRIPT_PATH}`);
      expect(unit).toContain('WantedBy=multi-user.target');
      expect(unit).toContain('After=network-online.target');
    });
  });

  describe('buildWireguardPersistInstall', () => {
    it('writes both files (base64, no escaping), daemon-reloads, and ENABLES (not starts)', () => {
      const bootScript = buildWireguardBootScript(params);
      const unit = buildWireguardSystemdUnit();
      const install = buildWireguardPersistInstall({ bootScript, unit });
      expect(install).toContain('set -e');
      // base64-decoded writes to the two canonical paths + tight modes.
      expect(install).toContain(`| base64 -d > ${WG_BOOTSCRIPT_PATH}`);
      expect(install).toContain(`chmod 0700 ${WG_BOOTSCRIPT_PATH}`);
      expect(install).toContain(`| base64 -d > ${WG_UNIT_PATH}`);
      expect(install).toContain(`chmod 0644 ${WG_UNIT_PATH}`);
      // enable/daemon-reload sequence: reload BEFORE enable.
      expect(install).toContain('systemctl daemon-reload');
      expect(install).toContain(`systemctl enable ${WG_UNIT_NAME}`);
      expect(install.indexOf('daemon-reload')).toBeLessThan(install.indexOf('enable'));
      // NOT started — wg0 is already up live; only needed on next boot.
      expect(install).not.toContain('systemctl start');
      // The encoded payload round-trips to the real content.
      const b64 = install.match(/echo (\S+) \| base64 -d > \/etc\/vibecarbon-wg0-up\.sh/)?.[1];
      expect(Buffer.from(b64 ?? '', 'base64').toString('utf8')).toBe(bootScript);
    });
  });
});

describe('REPL_GATEWAY_PORT', () => {
  it('is the socat relay port (15433), distinct from postgres 5432/5433', () => {
    expect(REPL_GATEWAY_PORT).toBe(15433);
  });
});

describe('exchangeAndBringUpTunnel', () => {
  it('generates keys on each node and cross-configures peers', async () => {
    const calls: string[] = [];
    vi.spyOn(ssh, 'sshRun').mockImplementation(async (_ip, _k, cmd) => {
      calls.push(String(cmd));
      if (String(cmd).includes('wg pubkey')) return 'FWxNbddwB9ap1+Nfhv++GcS2CtEh/5CNPiCKF9UIkS4=';
      return '';
    });
    const res = await exchangeAndBringUpTunnel({
      primaryIp: '167.233.150.173',
      standbyIp: '157.180.115.19',
      sshKeyPath: '/k',
    });
    expect(res.primaryPubKey).toMatch(/=$/);
    expect(res.standbyPubKey).toMatch(/=$/);
    // private key generated on-node, never returned/logged
    expect(JSON.stringify(res)).not.toContain('private');
    expect(calls.some((c) => c.includes('wg genkey'))).toBe(true);
    expect(calls.some((c) => c.includes('ip link add wg0'))).toBe(true);
    // the peer's PUBLIC endpoint is configured on each node
    expect(calls.some((c) => c.includes(`157.180.115.19:${WG_PORT}`))).toBe(true);
    expect(calls.some((c) => c.includes(`167.233.150.173:${WG_PORT}`))).toBe(true);
    vi.restoreAllMocks();
  });

  it('installs the reboot-persistence systemd unit on BOTH nodes (item I-1)', async () => {
    const perNode: Record<string, string[]> = {};
    vi.spyOn(ssh, 'sshRun').mockImplementation(async (ip, _k, cmd) => {
      const key = String(ip);
      if (!perNode[key]) perNode[key] = [];
      perNode[key].push(String(cmd));
      if (String(cmd).includes('wg pubkey')) return 'FWxNbddwB9ap1+Nfhv++GcS2CtEh/5CNPiCKF9UIkS4=';
      return '';
    });
    await exchangeAndBringUpTunnel({
      primaryIp: '167.233.150.173',
      standbyIp: '157.180.115.19',
      sshKeyPath: '/k',
    });
    // Each node gets a daemon-reload + enable of the persistence unit.
    for (const ip of ['167.233.150.173', '157.180.115.19']) {
      const joined = perNode[ip].join('\n');
      expect(joined).toContain('systemctl daemon-reload');
      expect(joined).toContain(`systemctl enable ${WG_UNIT_NAME}`);
      expect(joined).toContain(WG_BOOTSCRIPT_PATH);
      expect(joined).not.toContain('systemctl start');
    }
    vi.restoreAllMocks();
  });

  it('throws when required args are missing', async () => {
    await expect(
      exchangeAndBringUpTunnel({ primaryIp: '1.2.3.4', standbyIp: '', sshKeyPath: '/k' }),
    ).rejects.toThrow();
  });
});
