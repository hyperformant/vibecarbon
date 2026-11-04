import { describe, expect, it } from 'vitest';
import { attemptTagFor, runTagFor, scenarioDomain } from '../../e2e/utils/fresh-dns-names.js';

describe('fresh DNS names per run', () => {
  const runId = '0123abcd-4567-89ab-cdef-0123456789ab';

  it('runTag is the first 6 lowercase hex characters of the run id', () => {
    expect(runTagFor(runId)).toBe('0123ab');
    expect(runTagFor('ABCDEF12-0000')).toBe('abcdef');
  });

  it('scenario domain is <envPrefix>-<runTag>.<base>; envPrefix itself is untouched', () => {
    expect(scenarioDomain('d4', runTagFor(runId), 'do.appcarbon.dev')).toBe(
      'd4-0123ab.do.appcarbon.dev',
    );
  });

  it('every attempt of one run gets its own valid DNS label', () => {
    const a1 = scenarioDomain('d4', attemptTagFor(runId, 1), 'do.appcarbon.dev');
    const a2 = scenarioDomain('d4', attemptTagFor(runId, 2), 'do.appcarbon.dev');
    const a3 = scenarioDomain('d4', attemptTagFor(runId, 3), 'do.appcarbon.dev');
    expect(a1).toBe('d4-0123ab.do.appcarbon.dev');
    expect(new Set([a1, a2, a3]).size).toBe(3);
    for (const d of [a1, a2, a3]) {
      const label = d.split('.')[0];
      expect(label).toMatch(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);
      expect(label.length).toBeLessThanOrEqual(16);
    }
  });
});
