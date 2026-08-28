#!/usr/bin/env node
/**
 * DNS-01 solver-semantics probe — provider-onboarding insurance.
 *
 * WHY (d4 campaign, 2026-08-28): the behaviors that cost five e2e runs were
 * all live-discoverable properties of a DNS provider's record API that no
 * spec advertises — whether two TXT values can coexist at one name (the
 * apex+wildcard dual-token requirement, and the two-cluster k8s-ha shape),
 * whether deletion is name-keyed (removing a sibling issuer's token — the
 * cross-cluster clobber) and how long a fresh record takes to serve from
 * the AUTHORITATIVE fleet (anycast POP lag stalled cert-manager's
 * self-check ~45 min and invalidated a Let's Encrypt order). Run this ONCE
 * when onboarding a DNS provider, before building anything ACME-bearing on
 * it, and record the verdict in the provider's step0 audit.
 *
 * Usage:
 *   node scripts/probe-dns01-semantics.js <dnsProvider> <zoneDomain>
 *   # e.g. node scripts/probe-dns01-semantics.js digitalocean do.appcarbon.dev
 *
 * The token resolves exactly like the deploy does (resolveDnsToken /
 * DNS_PROVIDERS[..].tokenEnv). Everything the probe creates lives under a
 * random `_vc-dns01-probe-*` label and is deleted in a finally block.
 */

import dns from 'node:dns';
import { randomBytes } from 'node:crypto';
import { DNS_PROVIDERS, getDnsProvider } from '../src/lib/dns-provider.js';

/**
 * Pure verdict from the three measurements. Exported for unit tests.
 *
 * @param {{bothValuesVisible: boolean, survivorsAfterOneDelete: number,
 *          authoritativeVisibleMs: number|null}} m
 * @returns {{coexistence: 'ok'|'CLOBBER', deletion: 'value-keyed'|'NAME-KEYED'|'unknown',
 *            propagation: 'fast'|'SLOW'|'NEVER', risks: string[]}}
 */
export function classifyDns01Semantics(m) {
  const risks = [];
  const coexistence = m.bothValuesVisible ? 'ok' : 'CLOBBER';
  if (coexistence === 'CLOBBER') {
    risks.push(
      'two TXT values at one name do not coexist — apex+wildcard dual-token orders and ' +
        'any second concurrent issuer (k8s-ha) will clobber each other; a single-issuer ' +
        'policy is MANDATORY on this provider',
    );
  }
  const deletion =
    m.survivorsAfterOneDelete === 1
      ? 'value-keyed'
      : m.survivorsAfterOneDelete === 0
        ? 'NAME-KEYED'
        : 'unknown';
  if (deletion === 'NAME-KEYED') {
    risks.push(
      'deletion removes every record at the name — one issuer finishing deletes a sibling ' +
        "issuer's pending token (the d4 cross-cluster clobber class)",
    );
  }
  const propagation =
    m.authoritativeVisibleMs === null
      ? 'NEVER'
      : m.authoritativeVisibleMs > 120_000
        ? 'SLOW'
        : 'fast';
  if (propagation !== 'fast') {
    risks.push(
      `authoritative fleet served the fresh record in ${
        m.authoritativeVisibleMs === null ? '>budget' : `${Math.round(m.authoritativeVisibleMs / 1000)}s`
      } — cert-manager MUST run --dns01-recursive-nameservers-only on this provider, and ` +
        'Let\'s Encrypt-side "No TXT record found" invalid orders are possible (watchdog required)',
    );
  }
  return { coexistence, deletion, propagation, risks };
}

async function main() {
  const [providerId, zoneDomain] = process.argv.slice(2);
  if (!providerId || !zoneDomain || !DNS_PROVIDERS[providerId]) {
    console.error(
      `Usage: node scripts/probe-dns01-semantics.js <dnsProvider> <zoneDomain>\n` +
        `Known providers: ${Object.keys(DNS_PROVIDERS).join(', ')}`,
    );
    process.exit(1);
  }
  const tokenEnv = DNS_PROVIDERS[providerId].tokenEnv;
  const token = process.env[tokenEnv];
  if (!token) {
    console.error(`Missing ${tokenEnv} in the environment.`);
    process.exit(1);
  }

  const backend = getDnsProvider(providerId);
  const zones = await backend.getZones(token);
  const zone = zones.find((z) => z.name === zoneDomain);
  if (!zone) {
    console.error(`Zone ${zoneDomain} not found for ${providerId}. Zones: ${zones.map((z) => z.name).join(', ')}`);
    process.exit(1);
  }

  const label = `_vc-dns01-probe-${randomBytes(4).toString('hex')}`;
  const fqdn = `${label}.${zoneDomain}`;
  const valueA = `probe-A-${randomBytes(8).toString('hex')}`;
  const valueB = `probe-B-${randomBytes(8).toString('hex')}`;

  const resolver = new dns.promises.Resolver();
  const ns = await new dns.promises.Resolver().resolveNs(zoneDomain).catch(() => []);
  if (ns.length > 0) {
    const nsIps = (await Promise.all(ns.map((h) => dns.promises.resolve4(h).catch(() => [])))).flat();
    if (nsIps.length > 0) resolver.setServers(nsIps);
  }
  const readTxt = async () => {
    try {
      return (await resolver.resolveTxt(fqdn)).map((chunks) => chunks.join(''));
    } catch {
      return [];
    }
  };

  console.log(`[probe] ${providerId} zone=${zoneDomain} name=${fqdn}`);
  const started = Date.now();
  let authoritativeVisibleMs = null;
  let bothValuesVisible = false;
  let survivorsAfterOneDelete = -1;
  try {
    await backend.createDNSRecord(token, zone.id, { name: label, type: 'TXT', content: valueA, ttl: 60 });
    console.log('[probe] created TXT value A; polling authoritative visibility (budget 5m)...');
    while (Date.now() - started < 300_000) {
      const seen = await readTxt();
      if (seen.includes(valueA)) {
        authoritativeVisibleMs = Date.now() - started;
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    console.log(`[probe] value A visible after ${authoritativeVisibleMs === null ? '>300s (NEVER)' : `${Math.round(authoritativeVisibleMs / 1000)}s`}`);

    await backend.createDNSRecord(token, zone.id, { name: label, type: 'TXT', content: valueB, ttl: 60 });
    console.log('[probe] created TXT value B at the SAME name; checking coexistence (90s)...');
    const coexistDeadline = Date.now() + 90_000;
    while (Date.now() < coexistDeadline) {
      const seen = await readTxt();
      if (seen.includes(valueA) && seen.includes(valueB)) {
        bothValuesVisible = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    console.log(`[probe] coexistence: ${bothValuesVisible ? 'both values served' : 'CLOBBERED (one value survived)'}`);

    console.log('[probe] deleting by NAME once (our backend wrapper semantics)...');
    await backend.deleteDNSRecord(token, zone.id, label, [], 'TXT');
    await new Promise((r) => setTimeout(r, 15_000));
    const after = await readTxt();
    survivorsAfterOneDelete = after.filter((v) => v === valueA || v === valueB).length;
    console.log(`[probe] survivors after one delete: ${survivorsAfterOneDelete}`);
  } finally {
    // Belt-and-braces cleanup — deleteDNSRecord by name is idempotent.
    await backend.deleteDNSRecord(token, zone.id, label, [], 'TXT').catch(() => {});
  }

  const verdict = classifyDns01Semantics({ bothValuesVisible, survivorsAfterOneDelete, authoritativeVisibleMs });
  console.log('\n=== DNS-01 semantics verdict ===');
  console.log(`coexistence: ${verdict.coexistence}`);
  console.log(`deletion:    ${verdict.deletion}`);
  console.log(`propagation: ${verdict.propagation}`);
  for (const r of verdict.risks) console.log(`RISK: ${r}`);
  if (verdict.risks.length === 0) console.log('No elevated DNS-01 risks detected for this provider.');
}

// Only run as a CLI (the classifier above is imported by unit tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
