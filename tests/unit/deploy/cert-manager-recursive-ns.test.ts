/**
 * cert-manager DNS-01 self-check must use PUBLIC RECURSIVE resolvers, not
 * the zone's authoritative servers (d4 run 3 RCA, 2026-08-28): both Hetzner
 * and DigitalOcean DNS are anycast, and the POP a region egresses to can
 * serve a freshly-written record MINUTES late — observed live as a TXT
 * visible from every external vantage and the cluster's own CoreDNS while
 * the pod's direct authoritative query returned empty, parking issuance on
 * "not yet propagated" indefinitely. Let's Encrypt validates from its own
 * vantage, so our gate should match a public recursive view.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(join(__dirname, '../../../src/lib/deploy/k8s/k3s.js'), 'utf8');

describe('cert-manager recursive-nameserver self-check', () => {
  it('sets both flags, recursive-only + explicit resolvers', () => {
    expect(SRC).toContain('--dns01-recursive-nameservers=1.1.1.1:53,8.8.8.8:53');
    expect(SRC).toContain('--dns01-recursive-nameservers-only');
  });

  it('patches BEFORE the cert-manager readiness wait (the rollout must carry the flags)', () => {
    const patchIdx = SRC.indexOf('--dns01-recursive-nameservers-only');
    const waitIdx = SRC.indexOf('2. Wait for cert-manager to be ready');
    expect(patchIdx).toBeGreaterThan(-1);
    expect(waitIdx).toBeGreaterThan(patchIdx);
  });

  it('is idempotent — args are appended only when absent (warm re-deploys never duplicate)', () => {
    const block = SRC.slice(
      SRC.indexOf('certManager.recursiveNameservers'),
      SRC.indexOf('2. Wait for cert-manager to be ready'),
    );
    expect(block).toContain('filter((f) => !existing.includes(f))');
    expect(block).toContain("op: 'add'");
  });
});
