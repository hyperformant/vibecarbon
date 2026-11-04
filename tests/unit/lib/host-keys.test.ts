import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  knownHostsPath,
  knownHostsPathForKey,
  pinHostKey,
  seedKnownHosts,
} from '../../../src/lib/host-keys.js';

describe('knownHostsPath', () => {
  it('returns .vibecarbon/known_hosts_<env> under cwd', () => {
    expect(knownHostsPath('prod', '/tmp/proj')).toBe('/tmp/proj/.vibecarbon/known_hosts_prod');
  });

  it('defaults cwd to process.cwd() when not provided', () => {
    const p = knownHostsPath('staging');
    expect(p.endsWith('/.vibecarbon/known_hosts_staging')).toBe(true);
  });
});

describe('pinHostKey', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'vb-hostkeys-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes the given lines joined with \\n and a trailing newline', () => {
    pinHostKey('prod', ['1.2.3.4 ssh-ed25519 AAAA'], tmp);
    const content = readFileSync(knownHostsPath('prod', tmp), 'utf-8');
    expect(content).toBe('1.2.3.4 ssh-ed25519 AAAA\n');
  });

  it('writes multi-line host-key entries correctly', () => {
    pinHostKey('prod', ['1.2.3.4 ssh-ed25519 AAAA', '1.2.3.4 ssh-rsa BBBB'], tmp);
    const content = readFileSync(knownHostsPath('prod', tmp), 'utf-8');
    expect(content).toBe('1.2.3.4 ssh-ed25519 AAAA\n1.2.3.4 ssh-rsa BBBB\n');
  });

  it('replaces an existing file rather than appending', () => {
    pinHostKey('prod', ['FIRST'], tmp);
    pinHostKey('prod', ['SECOND'], tmp);
    const content = readFileSync(knownHostsPath('prod', tmp), 'utf-8');
    expect(content).toBe('SECOND\n');
  });

  it('creates .vibecarbon/ with no group or world perms', () => {
    pinHostKey('prod', ['x'], tmp);
    const mode = statSync(join(tmp, '.vibecarbon')).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it('writes the file with 0o600 mode (no group/world perms)', () => {
    pinHostKey('prod', ['x'], tmp);
    const mode = statSync(knownHostsPath('prod', tmp)).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it('enforces 0o700 on .vibecarbon/ even when it already exists with looser perms', () => {
    mkdirSync(join(tmp, '.vibecarbon'), { mode: 0o755 });
    pinHostKey('prod', ['x'], tmp);
    const mode = statSync(join(tmp, '.vibecarbon')).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it('enforces 0o600 on file even when overwriting a widened file', () => {
    pinHostKey('prod', ['FIRST'], tmp);
    chmodSync(knownHostsPath('prod', tmp), 0o644);
    pinHostKey('prod', ['SECOND'], tmp);
    const mode = statSync(knownHostsPath('prod', tmp)).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });
});

describe('knownHostsPathForKey', () => {
  it('derives known_hosts_<env> beside a deploy_key_<env> path', () => {
    expect(knownHostsPathForKey('/proj/.vibecarbon/deploy_key_prod')).toBe(
      '/proj/.vibecarbon/known_hosts_prod',
    );
  });

  it('derives known_hosts_<env> beside an ssh-<env> path', () => {
    expect(knownHostsPathForKey('/proj/.vibecarbon/ssh-staging')).toBe(
      '/proj/.vibecarbon/known_hosts_staging',
    );
  });

  it('keeps HA suffixes so primary/standby share one per-env file via the base key', () => {
    // getSSHKeyPath strips -primary/-standby and returns deploy_key_<baseEnv>,
    // so both arms derive the same known_hosts_<baseEnv>.
    expect(knownHostsPathForKey('/proj/.vibecarbon/deploy_key_prod')).toBe(
      '/proj/.vibecarbon/known_hosts_prod',
    );
  });
});

describe('seedKnownHosts', () => {
  let tmp: string;
  let khPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'vb-seed-'));
    khPath = join(tmp, '.vibecarbon', 'known_hosts_prod');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes scanned host keys with 0o600 and returns true', async () => {
    const keyscan = vi.fn().mockResolvedValue('1.2.3.4 ssh-ed25519 AAAA\n');
    const ok = await seedKnownHosts(khPath, '1.2.3.4', { keyscan });
    expect(ok).toBe(true);
    expect(readFileSync(khPath, 'utf-8')).toBe('1.2.3.4 ssh-ed25519 AAAA\n');
    expect(statSync(khPath).mode & 0o077).toBe(0);
    expect(statSync(join(tmp, '.vibecarbon')).mode & 0o077).toBe(0);
  });

  it('re-pins a recycled IP: drops the stale line for that IP, keeps other hosts', async () => {
    mkdirSync(join(tmp, '.vibecarbon'), { recursive: true, mode: 0o700 });
    writeFileSync(khPath, '1.2.3.4 ssh-ed25519 STALE\n5.6.7.8 ssh-ed25519 OTHER\n');
    const keyscan = vi.fn().mockResolvedValue('1.2.3.4 ssh-ed25519 FRESH\n');
    await seedKnownHosts(khPath, '1.2.3.4', { keyscan });
    const content = readFileSync(khPath, 'utf-8');
    expect(content).toContain('5.6.7.8 ssh-ed25519 OTHER');
    expect(content).toContain('1.2.3.4 ssh-ed25519 FRESH');
    expect(content).not.toContain('STALE');
  });

  it('returns false and does not create the file when the scan is empty (accept-new TOFU falls back)', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const keyscan = vi.fn().mockResolvedValue('');
    const ok = await seedKnownHosts(khPath, '1.2.3.4', { keyscan, attempts: 3, sleep });
    expect(ok).toBe(false);
    expect(keyscan).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // between attempts, not after the last
    expect(existsSync(khPath)).toBe(false);
  });

  it('seeds of several hosts into one file run concurrently and keep every host', async () => {
    // The deploy scans every node of a cluster at once (Promise.all at the
    // call sites, host-key-seed-parallel-census below). That is safe only
    // because each seed's read-merge-write of the file runs with no await in
    // it, after its own scan: scans that finish in any order still leave
    // every host's keys in the file.
    mkdirSync(join(tmp, '.vibecarbon'), { recursive: true, mode: 0o700 });
    writeFileSync(khPath, '9.9.9.9 ssh-ed25519 KEEP\n');
    const ips = ['10.0.0.1', '10.0.0.2', '10.0.0.3'];
    const release: Record<string, () => void> = {};
    let inFlight = 0;
    let peak = 0;
    const keyscan = (ip: string) =>
      new Promise<string>((resolve) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        release[ip] = () => {
          inFlight--;
          resolve(`${ip} ssh-ed25519 KEY-${ip}\n`);
        };
      });
    const all = Promise.all(ips.map((ip) => seedKnownHosts(khPath, ip, { keyscan })));
    await vi.waitFor(() => expect(Object.keys(release)).toHaveLength(3));
    expect(peak).toBe(3);
    // Finish out of order.
    for (const ip of ['10.0.0.3', '10.0.0.1', '10.0.0.2']) release[ip]();
    expect(await all).toEqual([true, true, true]);
    const lines = readFileSync(khPath, 'utf-8').trim().split('\n').sort();
    expect(lines).toEqual([
      '10.0.0.1 ssh-ed25519 KEY-10.0.0.1',
      '10.0.0.2 ssh-ed25519 KEY-10.0.0.2',
      '10.0.0.3 ssh-ed25519 KEY-10.0.0.3',
      '9.9.9.9 ssh-ed25519 KEEP',
    ]);
  });

  it('retries until a scan lands', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const keyscan = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('1.2.3.4 ssh-ed25519 AAAA\n');
    const ok = await seedKnownHosts(khPath, '1.2.3.4', { keyscan, sleep });
    expect(ok).toBe(true);
    expect(keyscan).toHaveBeenCalledTimes(2);
  });
});
