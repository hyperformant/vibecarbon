/**
 * Executable check of the private-NIC guard's hand-rolled Hetzner-metadata
 * parser.
 *
 * The guard parses `\/hetzner\/v1\/metadata\/private-networks` (YAML) with awk +
 * sed rather than pulling in a YAML dependency — a recovery path that runs
 * when the network is already broken cannot afford to install anything. That
 * trade is only sound if the parser is actually right, and a string-matching
 * assertion cannot show that. So these tests extract the guard's shell
 * functions and RUN them against real-shaped metadata.
 *
 * If this parser silently returns the wrong field, the guard pins a wrong
 * address onto a NIC during an outage — strictly worse than doing nothing.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const snippet = readFileSync(
  join(__dirname, '../../../carbon/cloud-init/k3s/_private-net-guard.sh'),
  'utf-8',
);

/**
 * The guard body, minus its trailing `while true` supervision loop, so it can
 * be sourced. Everything above the loop is pure function definitions.
 */
const guardFunctions = (() => {
  const open = snippet.indexOf("<< 'PNGUARDEOF'\n");
  const body = snippet.slice(snippet.indexOf('\n', open) + 1, snippet.indexOf('\nPNGUARDEOF'));
  const loopAt = body.indexOf('\nwhile true; do');
  expect(loopAt, 'guard must end in a supervision loop').toBeGreaterThan(-1);
  // Also drop the `. "$CONF"` + startup log, which touch the real filesystem.
  const tailAt = body.indexOf('\nif [ -r "$CONF" ]; then');
  return body.slice(0, tailAt > -1 ? tailAt : loopAt);
})();

/** Two networks — ours second — so a first-block shortcut fails the test. */
const METADATA = `- ip: 192.168.4.7
  alias_ips: []
  interface_num: 2
  mac_address: 86:00:00:11:22:33
  network_id: 999999
  network_name: unrelated-net
  network: 192.168.0.0/16
  subnet: 192.168.4.0/24
  gateway: 192.168.0.1
- ip: 10.0.1.14
  alias_ips: []
  interface_num: 1
  mac_address: 86:00:00:aa:bb:cc
  network_id: 4124728
  network_name: acme-prod-network
  network: 10.0.0.0/8
  subnet: 10.0.1.0/24
  gateway: 10.0.0.1
`;

/**
 * Run `script` with the guard's real functions in scope. The metadata blob is
 * passed as `$1` so the script under test never has to re-quote it.
 */
function sh(script: string): string {
  return execFileSync('bash', ['-c', `${guardFunctions}\n${script}`, 'guard-test', METADATA], {
    encoding: 'utf-8',
  }).trim();
}

describe('guard metadata parser (executed, not string-matched)', () => {
  it("selects the block matching THIS NIC's MAC, not merely the first one", () => {
    expect(sh(`BLOCK=$(meta_block "$1" "86:00:00:aa:bb:cc"); meta_value "$BLOCK" ip`)).toBe(
      '10.0.1.14',
    );
  });

  it('extracts gateway and network for the matched block', () => {
    expect(sh(`BLOCK=$(meta_block "$1" "86:00:00:aa:bb:cc"); meta_value "$BLOCK" gateway`)).toBe(
      '10.0.0.1',
    );
    expect(sh(`BLOCK=$(meta_block "$1" "86:00:00:aa:bb:cc"); meta_value "$BLOCK" network`)).toBe(
      '10.0.0.0/8',
    );
  });

  it('does not confuse `network:` with `network_id:` or `network_name:`', () => {
    // A greedy prefix match here would pin the route to "4124728" or to a
    // cluster name — the exact silent-wrong-answer this test exists to catch.
    const net = sh(`BLOCK=$(meta_block "$1" "86:00:00:aa:bb:cc"); meta_value "$BLOCK" network`);
    expect(net).not.toMatch(/^\d+$/);
    expect(net).not.toContain('acme');
  });

  it('falls back to the first block when no MAC matches (single-network case)', () => {
    expect(sh(`BLOCK=$(meta_block "$1" "de:ad:be:ef:00:00"); meta_value "$BLOCK" ip`)).toBe(
      '192.168.4.7',
    );
    expect(sh(`BLOCK=$(meta_block "$1" ""); meta_value "$BLOCK" ip`)).toBe('192.168.4.7');
  });

  it('yields nothing (rather than garbage) on an empty or junk metadata body', () => {
    expect(sh(`BLOCK=$(meta_block "" "86:00:00:aa:bb:cc"); meta_value "$BLOCK" ip`)).toBe('');
    expect(sh(`BLOCK=$(meta_block "not yaml at all" "x"); meta_value "$BLOCK" ip`)).toBe('');
  });

  it('is_private_ipv4 gates the repair on RFC1918 and rejects IPv4LL', () => {
    const verdict = (ip: string) =>
      sh(`if is_private_ipv4 "${ip}"; then echo yes; else echo no; fi`);
    expect(verdict('10.0.1.14')).toBe('yes');
    expect(verdict('172.16.0.9')).toBe('yes');
    expect(verdict('172.31.255.1')).toBe('yes');
    expect(verdict('192.168.0.2')).toBe('yes');
    // 169.254.x is what a DHCP client self-assigns when it CANNOT get a
    // lease — the guard must treat it as "still broken".
    expect(verdict('169.254.7.7')).toBe('no');
    expect(verdict('172.32.0.1')).toBe('no');
    expect(verdict('203.0.113.10')).toBe('no');
    expect(verdict('')).toBe('no');
  });
});

describe('guard shell body is valid bash', () => {
  it('parses under `bash -n` (catches a heredoc or quoting slip before a node does)', () => {
    const open = snippet.indexOf("<< 'PNGUARDEOF'\n");
    const body = snippet.slice(snippet.indexOf('\n', open) + 1, snippet.indexOf('\nPNGUARDEOF'));
    expect(() => execFileSync('bash', ['-n'], { input: body })).not.toThrow();
  });
});
