/**
 * classifyDns01Semantics — the pure verdict behind
 * scripts/probe-dns01-semantics.js (provider-onboarding insurance from the
 * d4 campaign: coexistence, deletion keying, and authoritative propagation
 * are the three live-discoverable properties that cost five e2e runs).
 */
import { describe, expect, it } from 'vitest';
import { classifyDns01Semantics } from '../../../scripts/probe-dns01-semantics.js';

describe('classifyDns01Semantics', () => {
  it('clean provider: coexistence ok, value-keyed deletes, fast propagation, zero risks', () => {
    const v = classifyDns01Semantics({
      bothValuesVisible: true,
      survivorsAfterOneDelete: 1,
      authoritativeVisibleMs: 8_000,
    });
    expect(v).toMatchObject({ coexistence: 'ok', deletion: 'value-keyed', propagation: 'fast' });
    expect(v.risks).toEqual([]);
  });

  it('the DO shape: name-keyed deletion flags the cross-cluster clobber risk', () => {
    const v = classifyDns01Semantics({
      bothValuesVisible: true,
      survivorsAfterOneDelete: 0,
      authoritativeVisibleMs: 20_000,
    });
    expect(v.deletion).toBe('NAME-KEYED');
    expect(v.risks.join('\n')).toMatch(/sibling issuer.*pending token/);
  });

  it('clobbering coexistence mandates the single-issuer policy', () => {
    const v = classifyDns01Semantics({
      bothValuesVisible: false,
      survivorsAfterOneDelete: 0,
      authoritativeVisibleMs: 5_000,
    });
    expect(v.coexistence).toBe('CLOBBER');
    expect(v.risks.join('\n')).toMatch(/single-issuer policy is MANDATORY/);
  });

  it('slow or never propagation mandates recursive-only self-checks + the watchdog', () => {
    const slow = classifyDns01Semantics({
      bothValuesVisible: true,
      survivorsAfterOneDelete: 1,
      authoritativeVisibleMs: 300_000,
    });
    expect(slow.propagation).toBe('SLOW');
    expect(slow.risks.join('\n')).toMatch(/dns01-recursive-nameservers-only/);
    const never = classifyDns01Semantics({
      bothValuesVisible: true,
      survivorsAfterOneDelete: 1,
      authoritativeVisibleMs: null,
    });
    expect(never.propagation).toBe('NEVER');
  });
});
