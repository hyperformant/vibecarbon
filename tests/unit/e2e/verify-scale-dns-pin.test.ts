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

/**
 * The step that really runs. The first version of this guard searched the whole
 * file and passed for three months on a pin inside a `verify-scale` branch of
 * runVerificationChecks, which that step never calls: l1 on 2026-11-06 rendered
 * a dead address with this suite green.
 */
function liveStep(): string {
  const start = LIFECYCLE.indexOf("name: 'verify-scale',");
  expect(start, 'the verify-scale step').toBeGreaterThan(-1);
  const end = LIFECYCLE.indexOf("name: 'backup',", start);
  expect(end, 'the step after verify-scale').toBeGreaterThan(start);
  return LIFECYCLE.slice(start, end);
}

describe('verify-scale resolution pin wiring', () => {
  it('runs no shared branch: nothing calls runVerificationChecks for verify-scale', () => {
    expect(LIFECYCLE).not.toContain("runVerificationChecks('verify-scale')");
    expect(LIFECYCLE).not.toContain("stepName === 'verify-scale'");
  });

  it('pins compose modes only, to the post-scale server from .vibecarbon.json', () => {
    const helper = LIFECYCLE.match(/function postScaleResolutionPin\(\)[\s\S]*?\n {2}}\n/)?.[0];
    expect(helper, 'postScaleResolutionPin').toBeTruthy();
    expect(helper).toContain("config.mode.startsWith('compose')");
    expect(helper).toContain('resolveHaDbIps');
    expect(helper).toContain('readSingleServerIp');
  });

  it('the serving gate, the render and the certificate check all run on the pin', () => {
    const step = liveStep();
    const pinned = step.match(
      /withResolutionPin\(scalePin, async \(\) => \{[\s\S]*?\n {10}\}\);/,
    )?.[0];
    expect(pinned, 'the pinned gate and render').toBeTruthy();
    expect(pinned).toContain('waitForAppServing(config.domain)');
    expect(pinned).toContain('runFrontendSmokeChecks(config.domain)');
    expect(step).toContain("withResolutionPin(scalePin, () => recordTlsReused('verify-scale'))");
    // Once each, so nothing runs a second time outside the pin.
    expect(step.match(/waitForAppServing\(/g)).toHaveLength(1);
    expect(step.match(/runFrontendSmokeChecks\(/g)).toHaveLength(1);
  });

  it('pairs the pin with an authoritative dns_scale_flip that can fail the step', () => {
    // A pin without the publish half would let a never-published record pass.
    const step = liveStep();
    expect(step).toContain("checkName: 'dns_scale_flip'");
    expect(step).toContain('expectedIp: scalePin.ip');
    expect(step).toMatch(/flip\.status === 'fail'[\s\S]{0,120}throw new Error/);
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
