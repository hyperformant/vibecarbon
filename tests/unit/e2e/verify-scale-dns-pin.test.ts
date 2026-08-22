/**
 * verify-scale DNS resolution pin + authoritative flip assertion.
 *
 * RCA 2026-08-17 (run 32013980356, compose-ha verify-scale FAIL): the
 * blue-green scale rewrites the apex + wildcard A records to the replacement
 * primary (single-writer since the apex-DNS gate) and DESTROYS both old
 * servers. verify-scale then rendered the frontend seconds after a TTL-60
 * flip — the operator resolver chain, caught mid-TTL, handed it the retired
 * address, and the renderer reported "Rendered text is 0 chars" against a
 * destroyed server. Exactly the class verify-failover's pin closed in the
 * 08-11 hardening; verify-scale flips the record the same way and never got
 * the pin.
 *
 * Same split as verify-failover, guarded here:
 *   1. SERVING — verify-scale's checks pin to the post-scale serving IP with
 *      Host/SNI kept on the domain (compose modes only; k8s scale is a
 *      Pulumi resize that never rewrites the record).
 *   2. PUBLISHING — an authoritative-NS flip assertion (`dns_scale_flip`)
 *      proves the record actually moved to the new IP.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runDnsFailoverFlipCheck } from '../../e2e/checks/dns-flip.js';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');

/** Drop line and block comments so source censuses match CODE, not prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const LIFECYCLE = stripComments(read('tests/e2e/scenarios/_run-lifecycle.ts'));

describe('verify-scale resolution pin wiring', () => {
  it('computes a pin for verify-scale on compose modes (the record-flipping scales)', () => {
    // The pin block must exist and be gated to the modes whose scale rewrites
    // the A record. k8s/k8s-ha scale is a Pulumi resize — no flip, no pin.
    expect(LIFECYCLE).toMatch(
      /stepName === 'verify-scale'[\s\S]{0,200}config\.mode\.startsWith\('compose'\)/,
    );
  });

  it('the verify-scale pin resolves the post-scale serving IP from .vibecarbon.json', () => {
    // compose-ha → the CURRENT primary via resolveHaDbIps (role-aware);
    // compose → the single server entry. Both live in the same gated block.
    const block = LIFECYCLE.match(
      /stepName === 'verify-scale'[\s\S]{0,1200}withResolutionPin/,
    )?.[0];
    expect(block, 'verify-scale pin block feeding withResolutionPin').toBeTruthy();
    expect(block).toContain('resolveHaDbIps');
  });

  it('pairs the pin with an authoritative dns_scale_flip assertion', () => {
    // Pin without the publish-half would let a never-published record pass.
    expect(LIFECYCLE).toMatch(/dns_scale_flip/);
    // And it must run for verify-scale, not just failover.
    expect(LIFECYCLE).toMatch(/stepName === 'verify-scale'[\s\S]{0,4500}dns_scale_flip/);
  });
});

describe('runDnsFailoverFlipCheck checkName override', () => {
  it('labels the result with the caller-supplied checkName', async () => {
    const result = await runDnsFailoverFlipCheck({
      domain: 'x.example.dev',
      expectedIp: null,
      skipReason: 'unit: label only',
      checkName: 'dns_scale_flip',
    });
    expect(result.checkName).toBe('dns_scale_flip');
    expect(result.status).toBe('skip');
  });

  it('defaults to dns_failover_flip when no override is given', async () => {
    const result = await runDnsFailoverFlipCheck({
      domain: 'x.example.dev',
      expectedIp: null,
      skipReason: 'unit: label only',
    });
    expect(result.checkName).toBe('dns_failover_flip');
  });
});
