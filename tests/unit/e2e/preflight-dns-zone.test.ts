import { describe, expect, it } from 'vitest';
import { zoneCovers } from '../../e2e/utils/preflight.js';

/**
 * `zoneCovers` decides whether a preflight DNS check passes: it asks whether
 * the zone a provider's token can see actually contains the base domain the
 * scenarios will write into. A false positive here defeats the whole point
 * of the check (the run proceeds and dies at ACME); a false negative aborts
 * a healthy matrix.
 */
describe('zoneCovers', () => {
  it('matches an exact zone', () => {
    expect(zoneCovers('appcarbon.dev', 'appcarbon.dev')).toBe(true);
    expect(zoneCovers('carbonstack.dev', 'carbonstack.dev')).toBe(true);
  });

  it('matches a delegated subdomain zone against its own name', () => {
    // The DO/Linode e2e zones are 3-label delegations out of appcarbon.dev.
    expect(zoneCovers('do.appcarbon.dev', 'do.appcarbon.dev')).toBe(true);
    expect(zoneCovers('linode.appcarbon.dev', 'linode.appcarbon.dev')).toBe(true);
  });

  it('matches a base domain nested below a broader zone', () => {
    // A token holding the parent zone can legitimately write the child.
    expect(zoneCovers('do.appcarbon.dev', 'appcarbon.dev')).toBe(true);
  });

  it('does NOT match a different registrable domain sharing a suffix', () => {
    // The bug a bare endsWith() would have: 'evilappcarbon.dev' ends with
    // 'appcarbon.dev' but is a completely different domain the token has no
    // rights over. Matching must respect the label boundary.
    expect(zoneCovers('evilappcarbon.dev', 'appcarbon.dev')).toBe(false);
    expect(zoneCovers('notdo.appcarbon.dev', 'do.appcarbon.dev')).toBe(false);
  });

  it('does NOT match when the zone is narrower than the base domain', () => {
    // Seeing only 'do.appcarbon.dev' does not authorize 'appcarbon.dev'.
    expect(zoneCovers('appcarbon.dev', 'do.appcarbon.dev')).toBe(false);
  });

  it('normalizes trailing dots and case — DNS APIs are inconsistent about both', () => {
    expect(zoneCovers('do.appcarbon.dev.', 'do.appcarbon.dev')).toBe(true);
    expect(zoneCovers('do.appcarbon.dev', 'do.appcarbon.dev.')).toBe(true);
    expect(zoneCovers('DO.AppCarbon.dev', 'do.appcarbon.dev')).toBe(true);
  });

  it('treats empty/blank inputs as no match rather than matching everything', () => {
    expect(zoneCovers('do.appcarbon.dev', '')).toBe(false);
    expect(zoneCovers('do.appcarbon.dev', '   ')).toBe(false);
    expect(zoneCovers('', 'appcarbon.dev')).toBe(false);
  });
});
