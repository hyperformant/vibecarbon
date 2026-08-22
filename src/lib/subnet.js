/**
 * vibecarbon-network subnet collision handling.
 *
 * Every generated project pins vibecarbon-network's IPAM subnet (default
 * ${DEV_SUBNET_PREFIX:-172.30.0}.0/24 in the base compose file) so all
 * compose overlay subsets resolve one identical network definition. The flip
 * side: two projects on one Docker daemon would claim the same pool, and the
 * second `up` dies with "invalid pool request: Pool overlaps with other one
 * on this address space". These helpers detect that overlap and pick a free
 * /24 inside 172.30.0.0/16, mirroring how `up` handles port conflicts.
 */

import { execFileSync } from 'node:child_process';

/** Parse "a.b.c.d/n" into an inclusive uint32 range, or null if malformed. */
function cidrToRange(cidr) {
  const [ip, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some(Number.isNaN) || !(bits >= 0 && bits <= 32)) return null;
  const value = octets[0] * 2 ** 24 + octets[1] * 2 ** 16 + octets[2] * 2 ** 8 + octets[3];
  const size = 2 ** (32 - bits);
  const start = Math.floor(value / size) * size;
  return { start, end: start + size - 1 };
}

/**
 * Whether two IPv4 CIDR blocks share any addresses.
 */
export function cidrsOverlap(a, b) {
  const ra = cidrToRange(a);
  const rb = cidrToRange(b);
  if (!ra || !rb) return false;
  return ra.start <= rb.end && rb.start <= ra.end;
}

/**
 * Parse `docker network inspect` JSON into { name, project, subnets } rows.
 * `project` is the compose project label (null for non-compose networks like
 * `bridge`). IPv6 pools are dropped — the vibecarbon-network pin is IPv4-only.
 */
export function parseNetworkInspect(jsonText) {
  const parsed = JSON.parse(jsonText);
  return parsed.map((net) => ({
    name: net.Name,
    project: net.Labels?.['com.docker.compose.project'] ?? null,
    subnets: (net.IPAM?.Config ?? [])
      .map((cfg) => cfg?.Subnet)
      .filter((s) => typeof s === 'string' && !s.includes(':')),
  }));
}

/**
 * Docker Compose's default project name: the directory name lowercased,
 * stripped to [a-z0-9_-], with leading separators removed (compose project
 * names must start alphanumeric).
 */
export function deriveComposeProjectName(dirName) {
  return dirName
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[_-]+/, '');
}

/**
 * First network owned by ANOTHER compose project (or by no project) whose
 * IPv4 pool overlaps `<prefix>.0/24`, or null. This project's own network is
 * never a conflict: compose reuses it in place, and counting it would bump
 * the prefix on every restart and force a recreate against live endpoints.
 */
export function findSubnetConflict(prefix, networks, ownProject) {
  const candidate = `${prefix}.0/24`;
  for (const net of networks) {
    if (net.project === ownProject) continue;
    if (net.subnets.some((subnet) => cidrsOverlap(subnet, candidate))) return net;
  }
  return null;
}

/**
 * Lowest x in 0..255 where 172.30.x.0/24 overlaps no foreign network, or
 * null when the whole /16 is claimed (e.g. a VPN route or a blanket pool).
 */
export function pickFreeSubnetPrefix(networks, ownProject) {
  for (let x = 0; x <= 255; x++) {
    const prefix = `172.30.${x}`;
    if (!findSubnetConflict(prefix, networks, ownProject)) return prefix;
  }
  return null;
}

/**
 * Snapshot all Docker networks on the local daemon. Returns null when Docker
 * isn't reachable — callers skip the subnet check and let compose surface its
 * own error.
 */
export function listDockerNetworks() {
  const opts = { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] };
  try {
    const ids = execFileSync('docker', ['network', 'ls', '-q'], opts)
      .trim()
      .split('\n')
      .filter(Boolean);
    if (ids.length === 0) return [];
    return parseNetworkInspect(execFileSync('docker', ['network', 'inspect', ...ids], opts));
  } catch {
    return null;
  }
}
