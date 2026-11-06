/**
 * DNS gate at run start: does this machine's resolver answer for each selected
 * provider's object-storage host the way a public resolver does?
 *
 * Why: on 2026-11-05 the router in front of this laptop failed
 * s3.fr-par.scw.cloud on and off (SERVFAIL, or AAAA-only on a machine with no
 * IPv6 route). A run that starts then fails in deploy, minutes in, with
 * `ENETUNREACH`, and final-destroy cannot verify its own cleanup. A read-only
 * comparison at the start refuses the run in seconds and names the host.
 *
 * The check only reads: one A lookup through the system resolver (what the CLI
 * and Pulumi use) and one through 1.1.1.1. It changes no resolver setting and
 * no /etc/hosts entry.
 *
 * Mismatch = no address in common. Two resolvers may rotate through different
 * members of one pool, so a partial overlap is fine; a disjoint pair or an
 * empty local answer is not.
 */
import { promises as dns, Resolver } from 'node:dns';
import { getProviderClass } from '../../../src/lib/providers/index.js';

export const PUBLIC_RESOLVER = '1.1.1.1';

export interface DnsGateDeps {
  /** A records through the system resolver; [] when it has no answer. */
  local: (host: string) => Promise<string[]>;
  /** A records through a public resolver; [] when it has no answer. */
  publicResolver: (host: string) => Promise<string[]>;
}

export interface DnsGateTarget {
  provider: string;
  /** The region the scenario deploys to; its storage host follows from it. */
  region: string;
}

export interface DnsGateFinding {
  provider: string;
  host: string;
  reason: string;
}

/** The object-storage host for a provider's region, as the CLI resolves it. */
export async function storageHostFor(provider: string, region: string): Promise<string> {
  const Provider = getProviderClass(provider);
  // biome-ignore lint/suspicious/noExplicitAny: the object-storage class is untyped JS (src/lib/providers)
  const S3: any = await Provider.getObjectStorageProviderClass();
  const endpoint: string | null | undefined = S3.getEndpointForRegion?.(S3.resolveS3Region(region));
  if (!endpoint) {
    throw new Error(`no storage endpoint known for ${provider} region ${region}`);
  }
  return new URL(endpoint).hostname;
}

const systemDeps: DnsGateDeps = {
  local: async (host) => {
    try {
      const all = await dns.lookup(host, { all: true, family: 4 });
      return all.map((a: { address: string }) => a.address);
    } catch {
      return [];
    }
  },
  publicResolver: async (host) => {
    const resolver = new Resolver({ timeout: 4000, tries: 2 });
    resolver.setServers([PUBLIC_RESOLVER]);
    try {
      return await new Promise<string[]>((resolve, reject) =>
        resolver.resolve4(host, (err, addrs) => (err ? reject(err) : resolve(addrs))),
      );
    } catch {
      return [];
    }
  },
};

/** Findings for every target whose storage host does not resolve like the public one. */
export async function checkStorageDns(
  targets: readonly DnsGateTarget[],
  deps: DnsGateDeps = systemDeps,
): Promise<DnsGateFinding[]> {
  const hosts = new Map<string, string>();
  const findings: DnsGateFinding[] = [];
  for (const t of targets) {
    try {
      const host = await storageHostFor(t.provider, t.region);
      if (!hosts.has(host)) hosts.set(host, t.provider);
    } catch (err) {
      findings.push({
        provider: t.provider,
        host: `(${t.provider} ${t.region})`,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  for (const [host, provider] of hosts) {
    const [local, pub] = await Promise.all([deps.local(host), deps.publicResolver(host)]);
    if (local.length === 0) {
      findings.push({
        provider,
        host,
        reason: `the local resolver has no A answer (${PUBLIC_RESOLVER} answers ${pub.join(', ') || 'nothing'})`,
      });
    } else if (pub.length === 0) {
      findings.push({
        provider,
        host,
        reason: `${PUBLIC_RESOLVER} has no A answer, so the local answer ${local.join(', ')} cannot be checked`,
      });
    } else if (!local.some((a) => pub.includes(a))) {
      findings.push({
        provider,
        host,
        reason: `the local resolver says ${local.join(', ')} but ${PUBLIC_RESOLVER} says ${pub.join(', ')}`,
      });
    }
  }
  return findings;
}

/** Throws, naming each host, when any selected provider's storage host fails the gate. */
export async function assertStorageDns(
  targets: readonly DnsGateTarget[],
  deps?: DnsGateDeps,
): Promise<void> {
  const findings = await checkStorageDns(targets, deps);
  if (findings.length === 0) return;
  throw new Error(
    `DNS gate: refusing to start. ${findings
      .map((f) => `${f.host} (${f.provider}): ${f.reason}`)
      .join('; ')}. ` +
      `Check with: dig A <host> @<your router> against @${PUBLIC_RESOLVER}. ` +
      'The run would fail in deploy, not at the provider; fix the resolver and start again.',
  );
}
