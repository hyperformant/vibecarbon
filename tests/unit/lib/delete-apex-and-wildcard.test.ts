/**
 * M3 Task 9i — zero-orphan audit after the GREEN d3 run 7 found Cloudflare
 * still holding `*.d3.appcarbon.dev A <floating-ip>` post-final-destroy.
 * Deploy always creates root + wildcard ("DNS records created (root +
 * wildcard)"), but every Cloudflare destroy path deleted only the root —
 * the Hetzner paths right next to each one already deleted both (see
 * `deleteDNSRecord` pair coverage in dns-ownership.test.ts, and
 * `upsertApexAndWildcard`'s create-side counterpart in
 * dns-apex-wildcard.test.ts). The wildcard leaked on every Cloudflare-DNS
 * destroy, pointing at a released floating IP a stranger could later be
 * assigned.
 *
 * Fix round 1 (reviewer finding): the initial fix only covered destroy.js's
 * two sites (destroyComposeTier, destroyK8sTier). compose/ha.js's
 * `destroyComposeHA` has the identical bug at its own Cloudflare DNS
 * cleanup — same root cause, independent call site the first pass's
 * destroy.js-scoped audit didn't reach.
 *
 * `deleteApexAndWildcard` (src/lib/cloudflare-dns.js) is the fix, shared by all
 * three sites: it mirrors the Hetzner root+wildcard pair (Promise.all +
 * merge). It moved here (not destroy.js, where the first fix round put it)
 * because destroy.js registers process-level SIGINT/SIGTERM handlers at
 * module load — importing it from ha.js (loaded on every deploy/scale/
 * failover, not just destroy) would double-register those. cloudflare-dns.js is
 * a dependency both already have, with no such side effects.
 *
 * These tests exercise `deleteApexAndWildcard` directly — same pattern as
 * `recordPulumiDestroyOutcome` in record-pulumi-destroy-outcome.test.ts —
 * plus source-text pins proving all three call sites (destroyComposeTier,
 * destroyK8sTier, destroyComposeHA) actually route through it. The ha.js
 * site's own root+wildcard behavior (through the real `destroyComposeHA`,
 * not just this helper) is additionally covered end-to-end in
 * tests/unit/deploy/compose-ha-destroy-teardown.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteApexAndWildcard } from '../../../src/lib/cloudflare-dns.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/**
 * Root and wildcard delete concurrently (Promise.all), so we route by URL
 * content rather than call order — the two GET (list) requests race and
 * their exact interleaving isn't something a test should pin.
 */
function stubRecords(rootContent: string | null, wildcardContent: string | null) {
  fetchMock.mockImplementation((url: string, options?: RequestInit) => {
    if ((options?.method || 'GET') === 'DELETE') {
      return Promise.resolve(ok({ success: true }));
    }
    // deleteDNSRecord filters listed records by exact `r.name === name`, so
    // the stub must echo back the queried name, not a fixed placeholder.
    const name = url.match(/[?&]name=([^&]+)/)?.[1] || '';
    const isWildcardQuery = name.startsWith('*.');
    const content = isWildcardQuery ? wildcardContent : rootContent;
    const result = content
      ? [{ id: isWildcardQuery ? 'wc' : 'root', name, type: 'A', content }]
      : [];
    return Promise.resolve(ok({ result }));
  });
}

describe('deleteApexAndWildcard', () => {
  it('deletes both root and wildcard when both point at an owned IP', async () => {
    stubRecords('1.2.3.4', '1.2.3.4');

    const result = await deleteApexAndWildcard('token', 'zone', 'e1.example.com', ['1.2.3.4']);

    expect(result).toEqual({ deletedAny: true, preservedTargets: [] });
    const deleteCalls = fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'DELETE');
    expect(deleteCalls).toHaveLength(2);
  });

  it('deletes the root but preserves the wildcard when only the wildcard is unowned', async () => {
    stubRecords('1.2.3.4', '5.6.7.8');

    const result = await deleteApexAndWildcard('token', 'zone', 'e1.example.com', ['1.2.3.4']);

    expect(result).toEqual({ deletedAny: true, preservedTargets: ['5.6.7.8'] });
    const deleteCalls = fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'DELETE');
    expect(deleteCalls).toHaveLength(1);
  });

  it('deletes the wildcard but preserves the root when only the root is unowned (independent reporting, reversed)', async () => {
    stubRecords('5.6.7.8', '1.2.3.4');

    const result = await deleteApexAndWildcard('token', 'zone', 'e1.example.com', ['1.2.3.4']);

    expect(result).toEqual({ deletedAny: true, preservedTargets: ['5.6.7.8'] });
    const deleteCalls = fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'DELETE');
    expect(deleteCalls).toHaveLength(1);
  });

  it('preserves both and deletes neither when both point at unowned IPs', async () => {
    stubRecords('5.6.7.8', '9.10.11.12');

    const result = await deleteApexAndWildcard('token', 'zone', 'e1.example.com', ['1.2.3.4']);

    expect(result).toEqual({ deletedAny: false, preservedTargets: ['5.6.7.8', '9.10.11.12'] });
    const deleteCalls = fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'DELETE');
    expect(deleteCalls).toHaveLength(0);
  });

  it('reports not-found (not preserved) when neither record exists', async () => {
    stubRecords(null, null);

    const result = await deleteApexAndWildcard('token', 'zone', 'absent.example.com', ['1.2.3.4']);

    expect(result).toEqual({ deletedAny: false, preservedTargets: [] });
  });

  // M3 Task 9f made ownedIps include the floating/reserved IP a k8s cluster's
  // ingress DNS actually points at (see dns-ownership.test.ts). Both records
  // in a k8s destroy share that same target — confirms the pair-delete rides
  // on 9f's fix rather than needing its own ownership plumbing.
  it('deletes a k8s root+wildcard pair pointing at the floating IP once ownedIps includes it', async () => {
    stubRecords('129.212.153.70', '129.212.153.70');

    const result = await deleteApexAndWildcard('token', 'zone', 'e1.example.com', [
      '10.0.1.1',
      '129.212.153.70',
    ]);

    expect(result).toEqual({ deletedAny: true, preservedTargets: [] });
  });
});

describe('deleteApexAndWildcard wiring (registry-driven destroy call sites)', () => {
  // DNS-seam convergence (2026-08-08): destroy paths no longer import a
  // specific backend — they dispatch `getDnsProvider(id).deleteApexAndWildcard`
  // through the registry. The invariant this file has always guarded (every
  // destroy path deletes the PAIR, never a hand-rolled single record — the
  // M3 Task 9i wildcard-orphan class) now holds per-backend: every
  // DNS_PROVIDERS module must export deleteApexAndWildcard built on exactly
  // two ownership-filtered deleteDNSRecord calls (root + wildcard).
  const destroySrc = readFileSync(join(__dirname, '../../../src/destroy.js'), 'utf-8');
  const haSrc = readFileSync(join(__dirname, '../../../src/lib/deploy/compose/ha.js'), 'utf-8');

  it('EVERY registered backend module addresses BOTH records in deleteApexAndWildcard', async () => {
    const { DNS_PROVIDERS } = await import('../../../src/lib/dns-provider.js');
    for (const [id, row] of Object.entries(DNS_PROVIDERS)) {
      const src = readFileSync(
        join(__dirname, '../../../src/lib', row.modulePath.replace(/^\.\//, '')),
        'utf-8',
      );
      // Extract the helper's body (up to the next top-level declaration) and
      // assert it targets the wildcard alongside the apex — deleting only the
      // root is exactly the orphan bug this file exists to prevent. Internal
      // delete plumbing may differ per backend (linode routes through a
      // shared removeRecords); the behavioral ownership cases live in each
      // backend's own unit suite.
      const body = src.split(/export async function deleteApexAndWildcard\(/)[1];
      expect(body, `${id}: missing deleteApexAndWildcard export`).toBeDefined();
      const fnBody = body.split(/\nexport /)[0];
      expect(fnBody, `${id}: pair helper must target the wildcard record`).toContain(
        '`*.${domain}`',
      );
      expect(fnBody, `${id}: pair helper must be ownership-filtered`).toContain('ownedIps');
    }
  });

  it('destroy.js dispatches the pair helper via the registry (no backend imports, no raw deletes)', () => {
    expect(destroySrc).toMatch(/dns\.deleteApexAndWildcard\(/);
    expect(destroySrc).not.toMatch(/from '\.\/lib\/cloudflare-dns\.js'/);
    expect(destroySrc).not.toMatch(/from '\.\/lib\/hetzner-dns\.js'/);
    expect(destroySrc).not.toMatch(/\bdeleteDNSRecord\b/);
  });

  it('destroy.js runs the shared DNS cleanup from both the compose-tier and k8s-tier sections', () => {
    const calls = destroySrc.match(/await cleanupDnsRecords\(\{/g) || [];
    expect(calls).toHaveLength(2);
  });

  it('ha.js (destroyComposeHA) dispatches the pair helper via the registry exactly once', () => {
    const calls = haSrc.match(/dns\.deleteApexAndWildcard\(/g) || [];
    expect(calls).toHaveLength(1);
    expect(haSrc).not.toMatch(/await import\(\s*'\.\.\/\.\.\/cloudflare-dns\.js'\s*\)/);
    expect(haSrc).not.toMatch(/await import\(\s*'\.\.\/\.\.\/hetzner-dns\.js'\s*\)/);
  });

  it('BOTH destroy-side cleanups fold the 0.0.0.0 warm-up sentinel into ownership', () => {
    // A deploy that died pre-provision leaves placeholder records no server
    // ever "owned" — each cleanup site must treat the warm-up sentinel as
    // ours or the filter refuses them forever (live evidence 2026-08-08:
    // d1 vs the DO outage). Behavioral coverage:
    // tests/unit/destroy/dns-cleanup-fallback.test.ts.
    expect(destroySrc).toMatch(/'0\.0\.0\.0'/);
    expect(haSrc).toMatch(/'0\.0\.0\.0'/);
  });
});
