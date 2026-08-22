import { describe, expect, it } from 'vitest';
// @ts-expect-error — JS module without types
import { strictestObjectStorageLimits } from '../../../src/lib/iac/state-telemetry.js';
// @ts-expect-error — JS module without types
import { PROVIDERS } from '../../../src/lib/providers/index.js';

/**
 * Every provider must DECLARE its documented object-storage limits — request
 * ceilings and consistency model — as data. This is what makes the state-layer
 * fix hold for providers we have not added yet: a new provider cannot land
 * without stating what its store guarantees and where that is documented.
 *
 * The declaration is data, not a behavioral switch. Recovery behavior is
 * uniform across providers by decision (2026-08-15); these values feed the
 * telemetry summary and size the strictest-common budget.
 */

const CONSISTENCY_VALUES = ['strong-documented', 'strong-claimed', 'undocumented'];

describe('object-storage limits census', () => {
  const entries = Object.entries(PROVIDERS) as [string, Record<string, unknown>][];

  it('covers every registered provider (not vacuously green)', () => {
    expect(entries.map(([id]) => id).sort()).toEqual([
      'digitalocean',
      'hetzner',
      'linode',
      'scaleway',
      'vultr',
    ]);
  });

  for (const [id, ProviderClass] of entries) {
    describe(id, () => {
      it('declares OBJECT_STORAGE_LIMITS itself (no inherited default)', () => {
        // An inherited default would let a new provider land with another
        // store's numbers — the copy-by-analogy defect class.
        expect(Object.hasOwn(ProviderClass, 'OBJECT_STORAGE_LIMITS')).toBe(true);
      });

      it('has the full shape with evidence', () => {
        const l = (ProviderClass as { OBJECT_STORAGE_LIMITS: Record<string, unknown> })
          .OBJECT_STORAGE_LIMITS;
        for (const key of [
          'requestsPerSecondPerBucket',
          'requestsPerSecondPerSourceIp',
          'parallelConnectionsPerSourceIp',
        ]) {
          const v = l[key];
          expect(v === null || (typeof v === 'number' && v > 0), `${key}=${v}`).toBe(true);
        }
        expect(CONSISTENCY_VALUES).toContain(l.consistency);
        expect(String(l.evidenceUrl)).toMatch(/^https:\/\//);
        expect(String(l.verifiedOn)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });
    });
  }

  it('pins the documented values that drove the state-layer design', () => {
    // These are the numbers the serialization and budget decisions rest on.
    // If a vendor re-documents them, this test forces the re-verification to
    // be deliberate rather than silent.
    const h = (PROVIDERS.hetzner as { OBJECT_STORAGE_LIMITS: Record<string, unknown> })
      .OBJECT_STORAGE_LIMITS;
    expect(h.requestsPerSecondPerBucket).toBe(750);
    expect(h.requestsPerSecondPerSourceIp).toBe(750);
    expect(h.parallelConnectionsPerSourceIp).toBe(256);
    expect(h.consistency).toBe('undocumented');

    const d = (PROVIDERS.digitalocean as { OBJECT_STORAGE_LIMITS: Record<string, unknown> })
      .OBJECT_STORAGE_LIMITS;
    expect(d.requestsPerSecondPerBucket).toBe(800);
    expect(d.consistency).toBe('undocumented');

    // Vultr's strong-consistency claim appears only on product pages. It must
    // not silently become 'strong-documented' without a real doc citation.
    const v = (PROVIDERS.vultr as { OBJECT_STORAGE_LIMITS: Record<string, unknown> })
      .OBJECT_STORAGE_LIMITS;
    expect(v.consistency).toBe('strong-claimed');
  });

  it('the strictest-common budget is Hetzner-bound', () => {
    // 750 < 800 on the per-bucket dimension; the per-IP dimensions only
    // Hetzner documents at all. A uniform budget sized to these values is safe
    // on every provider we ship.
    expect(strictestObjectStorageLimits(Object.keys(PROVIDERS))).toEqual({
      requestsPerSecondPerBucket: 750,
      requestsPerSecondPerSourceIp: 750,
      parallelConnectionsPerSourceIp: 256,
    });
  });
});
