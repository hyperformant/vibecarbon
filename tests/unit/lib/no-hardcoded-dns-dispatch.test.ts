/**
 * Src-wide sweep banning hand-rolled DNS-provider dispatch (2026-08-08 DNS
 * seam convergence — twin of the compute axis's
 * no-hardcoded-provider-dispatch census).
 *
 * The pre-convergence tree had ~25 two-armed `dns.provider === 'cloudflare'`
 * / `=== 'hetzner'` branches whose else-arms assumed the OTHER provider —
 * so a third backend would have silently driven the wrong cloud's API from
 * failover, destroy, and scale. Convergence routed every site through
 * DNS_PROVIDERS / getDnsProvider / hasAutomatedDns / resolveDnsToken; this
 * census keeps it that way:
 *
 *  - No literal comparison of a dnsProvider value against a BACKEND id
 *    anywhere in src/ outside the registry file. Comparisons against
 *    'manual' stay allowed — manual is the sanctioned non-backend sentinel,
 *    and hasAutomatedDns covers the "is it automated" question.
 *  - No direct import of a backend module outside the registry, the
 *    backends themselves, and each backend's own guided-setup module —
 *    everything else dispatches via getDnsProvider so new backends are
 *    reachable from every command automatically.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DNS_PROVIDERS } from '../../../src/lib/dns-provider.js';

const SRC_DIR = fileURLToPath(new URL('../../../src', import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const BACKEND_IDS = Object.keys(DNS_PROVIDERS);

// Strip // line comments and /* */ blocks so prose ABOUT the old pattern
// (RCA notes, decision records) can't trip the code sweep. Good enough for
// this census: string literals containing `//` (URLs) lose their tails,
// which only ever REMOVES potential matches inside strings we don't police.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Files allowed to name backend ids / import backend modules directly.
const DISPATCH_ALLOWLIST = new Set([
  'lib/dns-provider.js', // the registry itself
]);
const IMPORT_ALLOWLIST = new Set([
  'lib/dns-provider.js', // registry rows
  'lib/cloudflare-guided-setup.js', // verifyToken from its own backend
  // External-domain onboarding primitives from its own backend — the same
  // "a guided-setup module may reach into the backend it onboards" exception
  // as cloudflare above, and the reason the rule is scoped to OTHER backends:
  // neither module can reach a second cloud this way.
  'lib/scaleway-guided-setup.js',
  ...BACKEND_IDS.map((id) => `lib/${id}-dns.js`), // backends import nothing DNS, but keep self-refs legal
]);

describe('no hand-rolled DNS-provider dispatch in src/', () => {
  const files = walk(SRC_DIR);

  it('no literal dnsProvider comparison against a backend id outside the registry', () => {
    const pattern = new RegExp(
      `(?:dnsProvider|dns\\??\\.provider|dns_provider)\\s*[!=]==?\\s*'(${BACKEND_IDS.join('|')})'`,
    );
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC_DIR, file);
      if (DISPATCH_ALLOWLIST.has(rel)) continue;
      const src = stripComments(readFileSync(file, 'utf-8'));
      const match = src.match(pattern);
      if (match) offenders.push(`${rel}: ${match[0]}`);
    }
    expect(
      offenders,
      'Route these through hasAutomatedDns / DNS_PROVIDERS[...] / getDnsProvider instead of a ' +
        'literal branch — the else-arm of a hand-branch silently assumes some OTHER backend.',
    ).toEqual([]);
  });

  it('no direct backend-module import outside the registry and guided-setup', () => {
    const pattern =
      /from\s+'[^']*\/(?:[a-z]+-dns)\.js'|import\(\s*'[^']*\/(?:[a-z]+-dns)\.js'\s*\)/;
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC_DIR, file);
      if (IMPORT_ALLOWLIST.has(rel)) continue;
      const src = stripComments(readFileSync(file, 'utf-8'));
      const match = src.match(pattern);
      if (match) offenders.push(`${rel}: ${match[0]}`);
    }
    expect(
      offenders,
      'Dispatch via getDnsProvider(id) — a direct backend import pins the caller to one cloud ' +
        'and hides it from the other four.',
    ).toEqual([]);
  });
});
