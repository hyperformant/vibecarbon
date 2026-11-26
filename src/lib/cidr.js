/**
 * IPv4 and IPv6 address math: the operator access list's matching
 * (operator-ip.js) and the canonical network a Vultr firewall rule is
 * matched on (vultrRuleKey, providers/vultr.js).
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
export function ipv6ToBigInt(ip) {
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
