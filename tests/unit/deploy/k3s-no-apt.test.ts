/**
 * k3s nodes boot without apt. Each of these scripts used to spend 27-60 s on
 * `apt-get update` plus an install of tools nothing consumes: curl ships on
 * the images, jq has no user on a node, and k3s image delivery goes through
 * `k3s ctr`, never docker. This walks the whole directory, so a new init
 * script (or an old one growing the lines back) is covered without a list.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const DIR = join(fileURLToPath(new URL('../../..', import.meta.url)), 'carbon/cloud-init/k3s');
const scripts = readdirSync(DIR)
  .filter((f) => f.endsWith('.sh'))
  .map((f) => ({ name: f, lines: readFileSync(join(DIR, f), 'utf8').split('\n') }));
const inits = scripts.filter((s) => s.name.endsWith('-init.sh'));

/** Lines that execute: comments dropped. */
const code = (lines: string[]) => lines.filter((l) => !l.trim().startsWith('#'));

describe('k3s cloud-init scripts', () => {
  it('walk finds all six init scripts, so the assertions below are not vacuous', () => {
    expect(inits.map((s) => s.name).sort()).toEqual([
      'db-init.sh',
      'do-db-init.sh',
      'do-master-init.sh',
      'do-worker-init.sh',
      'master-init.sh',
      'worker-init.sh',
    ]);
  });

  it.each(scripts.map((s) => [s.name, s] as const))('%s never runs apt', (_n, s) => {
    expect(code(s.lines).filter((l) => /\bapt(-get)?\b/.test(l))).toEqual([]);
  });

  it.each(inits.map((s) => [s.name, s] as const))('%s writes no apt phase mark', (_n, s) => {
    expect(code(s.lines).filter((l) => /^\s*_m a\b/.test(l))).toEqual([]);
  });

  it.each(inits.map((s) => [s.name, s] as const))('%s keeps the network phase mark', (_n, s) => {
    expect(code(s.lines).filter((l) => /^\s*_m n\b/.test(l))).toHaveLength(1);
  });

  it.each(scripts.map((s) => [s.name, s] as const))('%s runs no jq or docker command', (_n, s) => {
    const bare = /(^|[\s;|&(`])(jq|docker)\s/;
    expect(code(s.lines).filter((l) => bare.test(l))).toEqual([]);
  });

  it('no comment still describes a 30 s wait before dhcpcd', () => {
    for (const s of inits.filter((x) => !x.name.startsWith('do-'))) {
      const stale = s.lines.filter((l) => /no lease after 30s|After 30s with no 10\.0/.test(l));
      expect(stale, s.name).toEqual([]);
    }
  });
});

/**
 * The private-NIC wait loop of the three Hetzner scripts, actually run under
 * bash with shimmed ip / dhcpcd / sleep. The loop asks dhcpcd for a lease from
 * about 5 s in, when the NIC can exist while the attachment is still settling,
 * so it must keep asking until a lease lands instead of latching after one
 * failed attempt.
 */
describe('Hetzner private-NIC wait loop (executed)', () => {
  const START = 'echo "Waiting for private network interface..."';
  const END = 'echo "Private interface: $PRIVATE_IFACE"';
  const hetzner = ['master-init.sh', 'worker-init.sh', 'db-init.sh'];
  let tmp = '';

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  });

  function run(file: string, opts: { failFirst: number; leased: boolean; maxRetries: number }) {
    const text = readFileSync(join(DIR, file), 'utf8');
    const from = text.indexOf(START);
    const to = text.indexOf(END);
    expect(from, `${file}: loop start marker`).toBeGreaterThan(-1);
    expect(to, `${file}: loop end marker`).toBeGreaterThan(from);
    const loop = text.slice(from, to + END.length);

    tmp = mkdtempSync(join(tmpdir(), 'nicwait-'));
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    const shim = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    const leased = join(tmp, 'leased');
    const calls = join(tmp, 'dhcpcd-calls');
    if (opts.leased) writeFileSync(leased, '');
    shim(
      'ip',
      `case "$*" in
  "-4 addr show") [ -e ${leased} ] && echo "    inet 10.0.0.5/32 brd 10.0.0.255 scope global enp7s0" ;;
  "-o link show") echo "3: enp7s0: <BROADCAST,MULTICAST> mtu 1450 state DOWN" ;;
esac
exit 0`,
    );
    shim('sleep', 'exit 0');
    shim(
      'dhcpcd',
      `echo "$*" >> ${calls}
n=$(wc -l < ${calls})
if [ "$n" -gt ${opts.failFirst} ]; then touch ${leased}; exit 0; fi
exit 1`,
    );
    const script = `set -euo pipefail\nPRIVATE_IFACE=""\nRETRY_COUNT=0\nMAX_RETRIES=${opts.maxRetries}\n${loop}\n`;
    const r = spawnSync('bash', ['-c', script], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp },
      encoding: 'utf8',
      timeout: 20_000,
    });
    const callLines = existsSync(calls)
      ? readFileSync(calls, 'utf8').split('\n').filter(Boolean)
      : [];
    return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: callLines };
  }

  it.each(hetzner)('%s: keeps asking after failed attempts and ends with the interface', (f) => {
    const r = run(f, { failFirst: 2, leased: false, maxRetries: 120 });
    expect(r.out).not.toContain('FATAL');
    expect(r.out).toContain('Private interface: enp7s0');
    expect(r.status).toBe(0);
    expect(r.calls).toHaveLength(3);
  });

  it.each(hetzner)('%s: a lease that never comes ends at MAX_RETRIES with FATAL', (f) => {
    const r = run(f, { failFirst: 1_000_000, leased: false, maxRetries: 7 });
    expect(r.status).toBe(1);
    expect(r.out).toContain('FATAL: Private network interface not found after 7 retries');
    // Retry 0 never asks; every later pass does, bounded by MAX_RETRIES.
    expect(r.calls).toHaveLength(6);
  });

  it.each(hetzner)('%s: an address already present never calls dhcpcd', (f) => {
    const r = run(f, { failFirst: 0, leased: true, maxRetries: 120 });
    expect(r.status).toBe(0);
    expect(r.out).toContain('Private interface: enp7s0');
    expect(r.calls).toEqual([]);
  });

  it.each(hetzner)('%s: every dhcpcd call is bounded with -t', (f) => {
    const r = run(f, { failFirst: 3, leased: false, maxRetries: 120 });
    expect(r.calls.length).toBeGreaterThan(0);
    for (const c of r.calls) expect(c).toMatch(/(^|\s)-t \d+(\s|$)/);
  });
});
