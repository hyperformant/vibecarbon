/**
 * Deterministic per-cluster VPC range inside 10.128.0.0/10, chosen by an
 * FNV-1a hash of the cluster name. DigitalOcean takes a /20 (its default),
 * Vultr a /24.
 *
 * WHY DERIVED: DigitalOcean enforces VPC CIDR uniqueness across the whole
 * account, not per region (live-verified 2026-08-28, d4 run 1: the standby
 * stack's VPC create 422'd "overlaps with another VPC network in your
 * account" against the primary's identical range in a different region). A
 * fixed default therefore caps an account at one vibecarbon k8s cluster:
 * k8s-ha (two stacks) could never provision, and neither could a second k8s
 * environment. Vultr keeps an HA pair's two VPCs apart the same way.
 *
 * WHY THIS SPACE: 10.128.0.0/10 avoids everything else in play: k3s pod
 * 10.42.0.0/16 and service 10.43.0.0/16, the WireGuard transport
 * 10.99.0.0/30, DigitalOcean's own auto-generated default-VPC ranges
 * (observed in 10.100 to 10.126), and the legacy fixed 10.10.0.0/20 that
 * pre-derive DigitalOcean stacks still hold.
 *
 * WHY A HASH: the value must be convergent. Every re-run of the program for
 * the same cluster (deploy, scale converge, failover reconverge) must produce
 * the same range, or Pulumi would replace the VPC under a live cluster. Two
 * clusters colliding on a block (birthday over 1024 /20 or 16384 /24 slots)
 * fail loudly at the provider's VPC create.
 *
 * @param {string} clusterName - `${projectName}-${environment}` (stack env)
 * @param {20 | 24} [maskBits] - 20 (default, DigitalOcean) or 24 (Vultr)
 * @returns {string} e.g. "10.153.64.0/20" or "10.153.64.0/24"
 */
export function vpcCidrForCluster(clusterName, maskBits = 20) {
  let h = 0x811c9dc5;
  for (let i = 0; i < clusterName.length; i++) {
    h ^= clusterName.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  if (maskBits === 24) {
    const idx = h % 16384; // 16384 /24 blocks in 10.128.0.0/10
    return `10.${128 + (idx >> 8)}.${idx & 255}.0/24`;
  }
  if (maskBits !== 20) {
    throw new Error(`vpcCidrForCluster: maskBits must be 20 or 24, got ${maskBits}`);
  }
  const idx = h % 1024; // 1024 /20 blocks in 10.128.0.0/10
  const secondOctet = 128 + (idx >> 4); // 128..191
  const thirdOctet = (idx & 15) * 16; // 0,16,...,240
  return `10.${secondOctet}.${thirdOctet}.0/20`;
}
