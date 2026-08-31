import { describe, expect, it } from 'vitest';
import { isNewerVersion } from '../../../src/lib/telemetry/semver.js';

describe('isNewerVersion', () => {
  it.each([
    ['0.42.0', '0.41.0', true],
    ['0.41.1', '0.41.0', true],
    ['1.0.0', '0.99.99', true],
    ['0.41.0', '0.41.0', false],
    ['0.41.0', '0.42.0', false],
    ['0.9.0', '0.41.0', false], // numeric, not lexicographic
  ])('(%s newer than %s) === %s', (latest, current, expected) => {
    expect(isNewerVersion(latest, current)).toBe(expected);
  });

  it('returns false for malformed input rather than throwing', () => {
    expect(isNewerVersion('banana', '0.41.0')).toBe(false);
    expect(isNewerVersion('0.42.0', '')).toBe(false);
    expect(isNewerVersion('0.42.0-rc.1', '0.41.0')).toBe(false); // prerelease: skip, never nag
  });
});
