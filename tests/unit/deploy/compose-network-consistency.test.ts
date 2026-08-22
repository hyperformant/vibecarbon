import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard for e2e run 29177112956 (compose scale + compose-ha deploy
// both failed with `error while removing network … has active endpoints`).
//
// The h9 observability merge pinned vibecarbon-network's IPAM subnet at the
// TOP LEVEL of the OBSERVABILITY overlay (so Traefik can hold a static IP for
// the Grafana auth-proxy). Any docker-compose op that loaded a file set
// WITHOUT that overlay — compose scale's `docker compose run --rm db`,
// compose-ha's `docker compose -f base -f prod -f replication up -d db` —
// then saw vibecarbon-network with a DYNAMIC subnet, mismatching the live
// pinned network. Docker recreated the network mid-op, which failed because
// the sibling containers (app, supabase, grafana, …) still held endpoints.
//
// Fix: the subnet pin lives in the BASE compose file, so every overlay subset
// resolves the SAME vibecarbon-network definition and never recreates it.
//
// Second regression (swim, 2026-07-17): a LITERAL pin meant every generated
// project claimed the same 172.30.0.0/24, so a second project on one Docker
// daemon failed `up` with "Pool overlaps with other one on this address
// space". The subnet now derives from ${DEV_SUBNET_PREFIX} (written to .env
// by `vibecarbon up` when the default /24 is taken). The prefix expression —
// var name AND default — must stay IDENTICAL across the base subnet, the
// observability Traefik ipv4_address, and GF_AUTH_PROXY_WHITELIST, or overlay
// subsets diverge again / Grafana trusts the wrong IP.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const BASE = join(repoRoot, 'carbon/docker-compose.yml');
const OBS = join(repoRoot, 'services/observability/compose/docker-compose.yml');
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose ${VAR:-default} placeholder, not a JS template
const PREFIX_EXPR = '${DEV_SUBNET_PREFIX:-172.30.0}';

// Extract the top-level `networks:` block (a column-0 `networks:` key up to the
// next column-0 key or EOF) so an `ipv4_address` inside a service block doesn't
// count as a network-level definition.
function topLevelNetworksBlock(content: string): string {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => /^networks:\s*$/.test(l));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('vibecarbon-network is defined consistently across compose overlay subsets', () => {
  it('pins the IPAM subnet in the BASE compose file via the shared prefix expression', () => {
    const net = topLevelNetworksBlock(readFileSync(BASE, 'utf-8'));
    expect(net).toContain('vibecarbon-network');
    expect(net).toContain('ipam');
    expect(net).toContain(`${PREFIX_EXPR}.0/24`);
  });

  it('does NOT define the subnet in the observability overlay (would diverge from base)', () => {
    // The overlay may still set Traefik's `ipv4_address` on the network inside
    // its service block, but it must NOT define the network's IPAM subnet —
    // that lives in base so ops which omit this overlay resolve the identical
    // network and never trigger a recreate.
    const net = topLevelNetworksBlock(readFileSync(OBS, 'utf-8'));
    expect(net).not.toContain('subnet');
  });

  it("derives Traefik's static IP and Grafana's auth-proxy whitelist from the SAME prefix", () => {
    const obs = readFileSync(OBS, 'utf-8');
    expect(obs).toContain(`ipv4_address: ${PREFIX_EXPR}.10`);
    expect(obs).toContain(`GF_AUTH_PROXY_WHITELIST=${PREFIX_EXPR}.10`);
  });

  it('uses one identical DEV_SUBNET_PREFIX default everywhere', () => {
    for (const file of [BASE, OBS]) {
      const content = readFileSync(file, 'utf-8');
      const defaults = [...content.matchAll(/\$\{DEV_SUBNET_PREFIX:-([^}]+)\}/g)].map((m) => m[1]);
      expect(defaults.length).toBeGreaterThan(0);
      for (const d of defaults) expect(d).toBe('172.30.0');
    }
  });

  it('leaves no literal subnet octets that bypass the prefix expression', () => {
    // A hardcoded 172.30.x address in either file would silently detach from
    // the env-derived subnet the moment `up` writes a non-default prefix.
    for (const file of [BASE, OBS]) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      const literals = lines.filter(
        (l) => /172\.30\.\d+\.\d+/.test(l) && !l.trim().startsWith('#'),
      );
      expect(literals).toEqual([]);
    }
  });
});
