/**
 * Single-ACME-issuer policy — promote half (d4 runs 3/5 RCA, 2026-08-28).
 *
 * Both clusters used to run active ACME issuers for the SAME dns names;
 * cert-manager's name-keyed DigitalOcean solver made the standby-role
 * cluster's issuance live-lock against the primary's, and after a failover
 * the promoted cluster served the Traefik default cert indefinitely. The
 * deploy half points a pilot-standby's Certificate at the local self-signed
 * ClusterIssuer and stamps the REAL issuer name into the
 * `vibecarbon.dev/promote-issuer` annotation; this half — run right after
 * the promoted app tier scales up — reads that annotation and patches
 * issuerRef back, making the promoted cluster the SOLE ACME solver.
 *
 * Best-effort by contract: DNS has already flipped by the time a failure
 * here could abort, and a promoted site serving on a self-signed cert is
 * strictly better than an aborted failover — so failures WARN loudly and
 * the reconverge redeploy repairs issuer ownership.
 */
import { describe, expect, it, vi } from 'vitest';
import { promoteAcmeIssuer } from '../../../src/failover.js';

const CERT_JSON = (issuer: string, annotation?: string) =>
  JSON.stringify({
    metadata: annotation ? { annotations: { 'vibecarbon.dev/promote-issuer': annotation } } : {},
    spec: { issuerRef: { name: issuer, kind: 'ClusterIssuer' } },
  });

describe('promoteAcmeIssuer', () => {
  it('patches issuerRef to the annotated ACME issuer when the cert is on the standby self-signed issuer', async () => {
    const calls: string[][] = [];
    const kubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      calls.push(argv);
      // grafana-tls does not exist on a promoted ex-standby (observability is
      // skipped on the pilot path) — the real cluster answers NotFound.
      if (argv.includes('grafana-tls'))
        throw new Error('Error from server (NotFound): certificates.cert-manager.io not found');
      if (argv.includes('get'))
        return CERT_JSON('vibecarbon-standby-selfsigned', 'letsencrypt-staging-digitalocean');
      return '';
    });
    const result = await promoteAcmeIssuer({
      promotedIp: '203.0.113.9',
      sshKeyPath: '/k',
      deps: { kubectl },
    });
    expect(result.patched).toEqual(['vibecarbon/vibecarbon-tls']);
    const patch = calls.find((a) => a.includes('patch'));
    expect(patch).toBeDefined();
    expect(patch?.join(' ')).toContain('certificate');
    expect(patch?.join(' ')).toContain('vibecarbon-tls');
    expect(JSON.stringify(patch)).toContain('letsencrypt-staging-digitalocean');
  });

  it('no-ops when issuerRef already equals the annotated issuer (idempotent on re-promote)', async () => {
    const kubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      if (argv.includes('get'))
        return CERT_JSON('letsencrypt-staging-digitalocean', 'letsencrypt-staging-digitalocean');
      return '';
    });
    const result = await promoteAcmeIssuer({
      promotedIp: '203.0.113.9',
      sshKeyPath: '/k',
      deps: { kubectl },
    });
    expect(result.patched).toEqual([]);
    expect(kubectl.mock.calls.some((c) => c[2].includes('patch'))).toBe(false);
  });

  it('skips a certificate with no promote annotation (pre-policy cluster) without patching', async () => {
    const kubectl = vi.fn(async (_ip: string, _key: string, argv: string[]) => {
      if (argv.includes('get')) return CERT_JSON('letsencrypt-staging-digitalocean');
      return '';
    });
    const result = await promoteAcmeIssuer({
      promotedIp: '203.0.113.9',
      sshKeyPath: '/k',
      deps: { kubectl },
    });
    expect(result.patched).toEqual([]);
    expect(kubectl.mock.calls.some((c) => c[2].includes('patch'))).toBe(false);
  });

  it('a missing certificate (standby never installed it) is skipped, never thrown', async () => {
    const kubectl = vi.fn(async () => {
      throw new Error('Error from server (NotFound): certificates.cert-manager.io not found');
    });
    await expect(
      promoteAcmeIssuer({ promotedIp: '203.0.113.9', sshKeyPath: '/k', deps: { kubectl } }),
    ).resolves.toMatchObject({ patched: [] });
  });

  it('any other kubectl failure warns and resolves — a promoted site on a self-signed cert beats an aborted failover', async () => {
    const warns: string[] = [];
    const kubectl = vi.fn(async () => {
      throw new Error('Unable to connect to the server: TLS handshake timeout');
    });
    await expect(
      promoteAcmeIssuer({
        promotedIp: '203.0.113.9',
        sshKeyPath: '/k',
        deps: { kubectl, warn: (m: string) => warns.push(m) },
      }),
    ).resolves.toMatchObject({ patched: [] });
    expect(warns.join('\n')).toMatch(/promote-issuer|issuer/i);
  });
});
