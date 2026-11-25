/**
 * Does the domain's registry still point at the DNS host that serves it?
 *
 * A lapsed registration leaves the zone in place: the provider's API lists it
 * and its nameservers answer for it, so every other preflight check passes and
 * the run dies about 20 minutes later at DNS propagation or at certificate
 * issuance. Only the registry knows, so this asks it, over RDAP.
 */

/** The nameservers each DNS provider hosts zones on, whole names only. */
const DNS_HOSTS: Record<string, RegExp> = {
  hetzner: /^[a-z]+\.ns\.hetzner\.(com|de)$/,
  cloudflare: /^[a-z]+\.ns\.cloudflare\.com$/,
  digitalocean: /^ns\d\.digitalocean\.com$/,
  linode: /^ns\d\.linode\.com$/,
  vultr: /^ns\d\.vultr\.com$/,
  scaleway: /^ns\d\.dom\.scw\.cloud$/,
};

const IANA_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
const TIMEOUT_MS = 10_000;

interface RegistryRecord {
  nameservers: string[];
  /** ISO timestamp, or null when the registry gave none. */
  expires: string | null;
}

/** The registrable domain of a zone. Every e2e domain sits right under its TLD. */
const apexOf = (zone: string) => zone.split('.').slice(-2).join('.');

/**
 * Judge one registry record. `delegated: false` only when the registry names
 * nameservers and none is the expected host's; anything unknown passes.
 *
 * A child zone (do.appcarbon.dev) is judged by whoever hosts its apex: the
 * registry says nothing about a delegation inside the domain.
 */
export function judgeDelegation(args: {
  dnsProvider: string;
  zone: string;
  /** tests/config.ts `e2e.domains`: which provider hosts which domain. */
  domains: Record<string, string>;
  record: RegistryRecord | null;
}): { delegated: boolean; detail: string } {
  const apex = apexOf(args.zone);
  const host =
    args.zone === apex
      ? args.dnsProvider
      : Object.keys(args.domains).find((id) => args.domains[id] === apex);
  const expected = host ? DNS_HOSTS[host] : undefined;
  const { record } = args;
  if (!expected) return { delegated: true, detail: `${apex}: no expected DNS host` };
  if (!record || record.nameservers.length === 0) {
    return { delegated: true, detail: `${apex}: registry not readable` };
  }
  if (!record.nameservers.some((ns) => expected.test(ns))) {
    return {
      delegated: false,
      detail:
        `the registry points ${apex} at ${record.nameservers.join(', ')}, not at ${host}: ` +
        'renew it, or point its nameservers back',
    };
  }
  return {
    delegated: true,
    detail: record.expires ? `${apex} registered to ${record.expires.slice(0, 10)}` : apex,
  };
}

/**
 * The registry's record of a domain, or null when it cannot be read. Never
 * throws: a registry outage is not a reason to stop a run.
 */
export async function readRegistry(
  apex: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegistryRecord | null> {
  const getJson = async (url: string) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? await res.json() : null;
  };
  try {
    const tld = apex.split('.').at(-1);
    const bootstrap = (await getJson(IANA_BOOTSTRAP)) as {
      services?: Array<[string[], string[]]>;
    } | null;
    const base = bootstrap?.services?.find(([tlds]) => tlds.includes(tld ?? ''))?.[1]?.[0];
    if (!base) return null;
    const record = (await getJson(`${base.replace(/\/?$/, '/')}domain/${apex}`)) as {
      nameservers?: Array<{ ldhName?: string }>;
      events?: Array<{ eventAction?: string; eventDate?: string }>;
    } | null;
    if (!record) return null;
    return {
      nameservers: (record.nameservers ?? [])
        .map((ns) => (ns.ldhName ?? '').toLowerCase().replace(/\.$/, ''))
        .filter(Boolean),
      expires: record.events?.find((e) => e.eventAction === 'expiration')?.eventDate ?? null,
    };
  } catch {
    return null;
  }
}

/** Read the registry for the zone's domain and judge what it says. */
export async function checkDelegation(args: {
  dnsProvider: string;
  zone: string;
  domains: Record<string, string>;
}): Promise<{ delegated: boolean; detail: string }> {
  return judgeDelegation({ ...args, record: await readRegistry(apexOf(args.zone)) });
}
