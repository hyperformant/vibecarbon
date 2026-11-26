/**
 * IPv4 and IPv6 address math: the operator access list's matching
 * (operator-ip.js), the canonical network a Vultr firewall rule is matched on
 * (vultrRuleKey, providers/vultr.js), the range a Scaleway security group
 * rule is compared on (canonicalScalewayRule, providers/scaleway.js), and
 * the Private Network address a Scaleway k8s program picks
 * (iac/programs/scaleway-k8s.js). No imports, so
 * a Pulumi program can use it without loading the provider registry.
 */

/**
 * An IPv4 address as a uint32, or null when it is not one.
 * @param {string} ip
 * @returns {number | null}
 */
export function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const num = Number(p);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    n = (n << 8) | num;
  }
  return n >>> 0;
}

/**
 * An IPv6 address (hex groups, `::` at most once; no zone, no embedded
 * IPv4) as a 128-bit BigInt, or null when it is not one.
 * @param {string} ip
 * @returns {bigint | null}
 */
function ipv6ToBigInt(ip) {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (head.length + tail.length > 8) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  const fillCount = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array(fillCount).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    result = (result << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return result;
}

/**
 * An IPv6 address in RFC 5952's form: lower case, no leading zeros, and the
 * longest run of two or more zero groups (the first, if tied) as `::`.
 * @param {bigint} n
 * @returns {string}
 */
function formatIpv6(n) {
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  let best = { start: -1, length: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > best.length) best = { start: i, length: j - i };
    i = j;
  }
  if (best.length < 2) return groups.join(':');
  const head = groups.slice(0, best.start).join(':');
  const tail = groups.slice(best.start + best.length).join(':');
  return `${head}::${tail}`;
}

/**
 * A CIDR in one canonical form, so two spellings of one network give the
 * same string: host bits zeroed, IPv4 dotted, IPv6 as formatIpv6 writes it.
 * Null when it is not a CIDR.
 * @param {string} cidr e.g. `203.0.113.5/24` (gives `203.0.113.0/24`)
 * @returns {string | null}
 */
export function canonicalCidr(cidr) {
  const slash = cidr.indexOf('/');
  if (slash < 0) return null;
  const base = cidr.slice(0, slash);
  const bitsText = cidr.slice(slash + 1);
  if (!/^\d{1,3}$/.test(bitsText)) return null;
  const bits = Number(bitsText);
  if (base.includes(':')) {
    const n = ipv6ToBigInt(base);
    if (n === null || bits > 128) return null;
    const hostBits = (1n << BigInt(128 - bits)) - 1n;
    return `${formatIpv6(n & ~hostBits)}/${bits}`;
  }
  const n = ipv4ToInt(base);
  if (n === null || bits > 32) return null;
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  const network = (n & mask) >>> 0;
  return `${[24, 16, 8, 0].map((shift) => (network >>> shift) & 255).join('.')}/${bits}`;
}

/**
 * A firewall source range in canonicalCidr's form, however it is spelled: a
 * CIDR, or a bare address, which is its host network (`/32` or `/128`).
 * Scaleway lists a host range bare (canonicalScalewayRule,
 * providers/scaleway.js). Null when it is neither.
 * @param {unknown} range e.g. `198.51.100.7` (gives `198.51.100.7/32`)
 * @returns {string | null}
 */
export function canonicalIpRange(range) {
  if (typeof range !== 'string') return null;
  if (range.includes('/')) return canonicalCidr(range);
  return canonicalCidr(`${range}/${range.includes(':') ? 128 : 32}`);
}

/**
 * Whether `cidr` contains `ip`. `version` is the address family (4 or 6) and
 * is required: a CIDR of the other family contains nothing, and a call
 * without it takes both as IPv6, so it is false for every IPv4 address.
 * @param {string} cidr e.g. `10.130.5.0/24`
 * @param {string} ip
 * @param {4 | 6} version
 * @returns {boolean}
 */
export function cidrContainsIp(cidr, ip, version) {
  const slashIdx = cidr.indexOf('/');
  if (slashIdx < 0) return false;
  const base = cidr.slice(0, slashIdx);
  const bits = Number(cidr.slice(slashIdx + 1));
  if (!Number.isInteger(bits) || bits < 0) return false;

  const cidrIsV6 = base.includes(':');
  if (cidrIsV6 !== (version === 6)) return false;

  if (version === 4) {
    if (bits > 32) return false;
    const baseNum = ipv4ToInt(base);
    const ipNum = ipv4ToInt(ip);
    if (baseNum === null || ipNum === null) return false;
    if (bits === 0) return true;
    if (bits === 32) return baseNum === ipNum;
    const mask = (-1 << (32 - bits)) >>> 0;
    return (baseNum & mask) === (ipNum & mask);
  }

  if (bits > 128) return false;
  const baseNum = ipv6ToBigInt(base);
  const ipNum = ipv6ToBigInt(ip);
  if (baseNum === null || ipNum === null) return false;
  if (bits === 0) return true;
  if (bits === 128) return baseNum === ipNum;
  const shift = BigInt(128 - bits);
  return baseNum >> shift === ipNum >> shift;
}
