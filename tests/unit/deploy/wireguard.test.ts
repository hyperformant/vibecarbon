import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildWireguardBootScript,
  buildWireguardBringUp,
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
import { assertSshRunArgv } from '../../_shared/ssh-contract.js';

const KEY = '/etc/wireguard/vibecarbon-wg0.key';
const OLD_KEY = '/etc/vibecarbon-wg.key';

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
    selfPrivKeyPath: KEY,
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
      expect(script).toContain(`private-key ${KEY}`);
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
      assertSshRunArgv(cmd); // the real argv contract
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
    // The apt refresh waits for the daily apt units first, then refreshes with
    // no DEBIAN_FRONTEND prefix landing on the printf.
    const install = calls.find((c) => c.includes('wireguard-tools')) ?? '';
    const wait = install.indexOf('systemd-run --quiet --wait');
    expect(wait).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(install.indexOf('apt-get -c '));
    expect(install).not.toContain('DEBIAN_FRONTEND=noninteractive printf');
    expect(calls.some((c) => c.includes('ip link add wg0'))).toBe(true);
    // Both live bring-ups check first, so a redeploy leaves a good tunnel alone.
    expect(calls.filter((c) => c.includes('wg show wg0 dump'))).toHaveLength(2);
    // the peer's PUBLIC endpoint is configured on each node
    expect(calls.some((c) => c.includes(`157.180.115.19:${WG_PORT}`))).toBe(true);
    expect(calls.some((c) => c.includes(`167.233.150.173:${WG_PORT}`))).toBe(true);
    vi.restoreAllMocks();
  });

  // Ubuntu 26.04's AppArmor profile for `wg` only lets it read /etc/wireguard,
  // so a key anywhere else fails with `fopen: Permission denied` and wg0 stays
  // down (real servers on all five providers, 2026-11-05).
  describe('the private key lives where wg can read it', () => {
    async function bringUp() {
      const calls: string[] = [];
      vi.spyOn(ssh, 'sshRun').mockImplementation(async (_ip, _k, cmd) => {
        calls.push(String(cmd));
        return String(cmd).includes('wg pubkey') ? `${'B'.repeat(43)}=` : '';
      });
      await exchangeAndBringUpTunnel({
        primaryIp: '167.233.150.173',
        standbyIp: '157.180.115.19',
        sshKeyPath: '/k',
      });
      vi.restoreAllMocks();
      return calls;
    }

    it('every command that names the key names it under /etc/wireguard', async () => {
      const calls = await bringUp();
      const keyPaths = calls.join('\n').match(/\/\S+\.key\b/g) ?? [];
      const inUse = keyPaths.filter((path) => path !== OLD_KEY);
      expect(inUse.length).toBeGreaterThan(0);
      for (const path of inUse) expect(path).toBe(KEY);
    });

    /** Runs the key step against scratch files standing in for the two paths. */
    function runKeyStep(script: string, files: { old?: string; current?: string }) {
      const dir = mkdtempSync(join(tmpdir(), 'wg-key-'));
      const oldPath = join(dir, 'old');
      const current = join(dir, 'current');
      if (files.old) writeFileSync(oldPath, files.old, { mode: 0o600 });
      if (files.current) writeFileSync(current, files.current, { mode: 0o600 });
      writeFileSync(join(dir, 'wg'), '#!/bin/bash\necho generated\n', { mode: 0o755 });
      const step = script.slice(script.indexOf('umask 077'));
      const result = spawnSync(
        'bash',
        ['-c', step.replaceAll(OLD_KEY, oldPath).replaceAll(KEY, current)],
        { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf-8' },
      );
      const out = {
        status: result.status,
        current: existsSync(current) ? readFileSync(current, 'utf-8').trim() : null,
        oldStillThere: existsSync(oldPath),
      };
      rmSync(dir, { recursive: true, force: true });
      return out;
    }

    async function keyStep() {
      const calls = await bringUp();
      return calls.find((c) => c.includes('wg genkey')) ?? '';
    }

    it('generates a key on a new node', async () => {
      expect(runKeyStep(await keyStep(), {})).toEqual({
        status: 0,
        current: 'generated',
        oldStillThere: false,
      });
    });

    it('keeps the key a live node has at the old path, so its tunnel keeps its peer', async () => {
      expect(runKeyStep(await keyStep(), { old: 'live-key' })).toEqual({
        status: 0,
        current: 'live-key',
        oldStillThere: false,
      });
    });

    it('never replaces a key that is already in place', async () => {
      expect(runKeyStep(await keyStep(), { current: 'in-place' })).toEqual({
        status: 0,
        current: 'in-place',
        oldStillThere: false,
      });
    });
  });

  it('installs and reads keys on both nodes at once', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(ssh, 'sshRun').mockImplementation(async (ip, _k, cmd) => {
      const c = String(cmd);
      if (c.includes('wireguard-tools')) {
        started.push(String(ip));
        await gate;
        finished.push(String(ip));
        return '';
      }
      return c.includes('wg pubkey') ? 'FWxNbddwB9ap1+Nfhv++GcS2CtEh/5CNPiCKF9UIkS4=' : '';
    });
    const run = exchangeAndBringUpTunnel({
      primaryIp: '167.233.150.173',
      standbyIp: '157.180.115.19',
      sshKeyPath: '/k',
    });
    await new Promise((r) => setTimeout(r, 10));
    // Both installs are in flight before either has finished.
    expect(started.sort()).toEqual(['157.180.115.19', '167.233.150.173']);
    expect(finished).toEqual([]);
    release();
    await run;
    vi.restoreAllMocks();
  });

  it('a failing node surfaces its own error; the primary wins when both fail', async () => {
    vi.spyOn(ssh, 'sshRun').mockImplementation(async (ip, _k, cmd) => {
      if (String(cmd).includes('wireguard-tools')) {
        await new Promise((r) => setTimeout(r, ip === '1.1.1.1' ? 20 : 1));
        throw new Error(`apt failed on ${ip}`);
      }
      return '';
    });
    await expect(
      exchangeAndBringUpTunnel({ primaryIp: '1.1.1.1', standbyIp: '2.2.2.2', sshKeyPath: '/k' }),
    ).rejects.toThrow('apt failed on 1.1.1.1');
    vi.restoreAllMocks();
  });

  it('installs the reboot-persistence systemd unit on BOTH nodes (item I-1)', async () => {
    const perNode: Record<string, string[]> = {};
    vi.spyOn(ssh, 'sshRun').mockImplementation(async (ip, _k, cmd) => {
      assertSshRunArgv(cmd); // the real argv contract
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

describe('a tunnel that already matches is left alone', () => {
  // A deploy rebuilt wg0 every time, which drops replication for no reason.
  // These run the generated command in a real bash, with `ip` and `wg` stubs
  // replaying what a live node printed (DO k8s-ha rig, 2026-11-05).
  const params = {
    selfIp: '10.99.0.1',
    selfPrivKeyPath: KEY,
    listenPort: 51821,
    peerPubKey: 'B'.repeat(43) + '=',
    peerEndpoint: '157.245.209.44:51821',
    peerAllowedIp: '10.99.0.2/32',
  };
  const live = {
    address: '35: wg0    inet 10.99.0.1/30 scope global wg0\\       valid_lft forever',
    publicKey: 'SELF',
    keyFilePublicKey: 'SELF',
    port: '51821',
    peer: [
      params.peerPubKey,
      '(none)',
      params.peerEndpoint,
      params.peerAllowedIp,
      '1793',
      '10',
      '20',
      '25',
    ],
  };

  function run(overrides: Partial<typeof live> | 'no-interface' = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'wg-bringup-'));
    const state = overrides === 'no-interface' ? null : { ...live, ...overrides };
    const log = join(dir, 'calls.log');
    writeFileSync(
      join(dir, 'ip'),
      `#!/bin/bash
echo "ip $*" >> ${log}
case "$*" in
  "-4 -o addr show dev wg0 up") ${state ? `printf '%s\\n' '${state.address}'` : 'exit 1'} ;;
esac
`,
      { mode: 0o755 },
    );
    const dump = state ? `PRIVATE\tSELF\t51821\toff\n${state.peer.join('\t')}\n` : '';
    writeFileSync(
      join(dir, 'wg'),
      `#!/bin/bash
echo "wg $*" >> ${log}
case "$*" in
  "show wg0 public-key") ${state ? `echo '${state.publicKey}'` : 'exit 1'} ;;
  "show wg0 listen-port") ${state ? `echo '${state.port}'` : 'exit 1'} ;;
  "show wg0 dump") ${state ? `printf '${dump.replaceAll('\t', '\\t').replaceAll('\n', '\\n')}'` : 'exit 1'} ;;
  pubkey) echo '${state?.keyFilePublicKey ?? 'SELF'}' ;;
esac
`,
      { mode: 0o755 },
    );
    const keyFile = join(dir, 'key');
    writeFileSync(keyFile, 'unused');
    const result = spawnSync(
      'bash',
      ['-c', buildWireguardBringUp({ ...params, selfPrivKeyPath: keyFile })],
      { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf-8' },
    );
    const calls = existsSync(log) ? readFileSync(log, 'utf-8') : '';
    rmSync(dir, { recursive: true, force: true });
    return { status: result.status, calls, stdout: result.stdout };
  }

  it('does nothing to a matching interface', () => {
    const { status, calls, stdout } = run();
    expect(status).toBe(0);
    expect(calls).not.toContain('link del');
    expect(calls).not.toContain('wg set');
    expect(stdout).toBe('');
  });

  it.each([
    ['no interface yet', 'no-interface' as const],
    ['another tunnel address', { address: '35: wg0    inet 10.99.0.2/30 scope global wg0' }],
    ['a key that is not this one', { keyFilePublicKey: 'ROTATED' }],
    ['another listen port', { port: '51820' }],
    ['another peer key', { peer: ['C'.repeat(43) + '=', ...live.peer.slice(1)] }],
    [
      'another peer endpoint',
      { peer: [live.peer[0], '(none)', '1.2.3.4:51821', ...live.peer.slice(3)] },
    ],
    [
      'another allowed ip',
      { peer: [...live.peer.slice(0, 3), '10.99.0.9/32', ...live.peer.slice(4)] },
    ],
    ['another keepalive', { peer: [...live.peer.slice(0, 7), 'off'] }],
  ])('rebuilds on %s', (_name, overrides) => {
    const { status, calls } = run(overrides);
    expect(status).toBe(0);
    expect(calls).toContain('ip link del wg0');
    expect(calls).toContain('wg set wg0 private-key');
  });

  it('the boot script stays unconditional, because a booted node has no wg0', () => {
    expect(buildWireguardBootScript(params)).not.toContain('wg show');
  });

  it('the boot script brings wg0 up on a node that has none, as every boot does', () => {
    // `set -e` stopped the script at `ip link del wg0`, so the unit failed and
    // the tunnel stayed down after every reboot (real servers, 2026-11-05).
    const dir = mkdtempSync(join(tmpdir(), 'wg-boot-'));
    const log = join(dir, 'calls.log');
    writeFileSync(
      join(dir, 'ip'),
      `#!/bin/bash
echo "ip $*" >> ${log}
[ "$*" = "link del wg0" ] && { echo 'Cannot find device "wg0"' >&2; exit 1; }
exit 0
`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, 'wg'), `#!/bin/bash\necho "wg $*" >> ${log}\n`, { mode: 0o755 });
    const script = join(dir, 'boot.sh');
    writeFileSync(script, buildWireguardBootScript(params));
    const result = spawnSync('bash', [script], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf-8',
    });
    const calls = readFileSync(log, 'utf-8');
    rmSync(dir, { recursive: true, force: true });
    expect(result.status).toBe(0);
    expect(calls).toContain('ip link add wg0 type wireguard');
    expect(calls).toContain('wg set wg0 private-key');
    expect(calls).toContain('ip link set wg0 up');
  });

  it('never lets a key near the output of the comparison', () => {
    // `wg show wg0 dump` prints the private key on its first line.
    expect(buildWireguardBringUp(params)).toContain('wg show wg0 dump 2>/dev/null | tail -n +2');
  });
});
