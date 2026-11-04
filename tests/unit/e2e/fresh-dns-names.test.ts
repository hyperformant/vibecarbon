import { describe, expect, it } from 'vitest';
import { dnsNameBelongsToEnv, runTagFor, scenarioDomain } from '../../e2e/utils/fresh-dns-names.js';

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

  it('sweep matcher accepts <envPrefix> and <envPrefix>-<6 hex> under the base domain', () => {
    expect(dnsNameBelongsToEnv('d4.do.appcarbon.dev', 'd4', 'do.appcarbon.dev')).toBe(true);
    expect(dnsNameBelongsToEnv('d4-0123ab.do.appcarbon.dev', 'd4', 'do.appcarbon.dev')).toBe(true);
    expect(dnsNameBelongsToEnv('*.d4-0123ab.do.appcarbon.dev', 'd4', 'do.appcarbon.dev')).toBe(
      true,
    );
  });

  it('sweep matcher rejects lookalikes', () => {
    const base = 'do.appcarbon.dev';
    expect(dnsNameBelongsToEnv('d40.do.appcarbon.dev', 'd4', base)).toBe(false);
    expect(dnsNameBelongsToEnv('d4-xyz.do.appcarbon.dev', 'd4', base)).toBe(false);
    expect(dnsNameBelongsToEnv('d4-0123abc.do.appcarbon.dev', 'd4', base)).toBe(false);
    expect(dnsNameBelongsToEnv('d4-0123AB.do.appcarbon.dev', 'd4', base)).toBe(false);
    expect(dnsNameBelongsToEnv('d4-0123ab.other.dev', 'd4', base)).toBe(false);
    expect(dnsNameBelongsToEnv('x.d4-0123ab.do.appcarbon.dev', 'd4', base)).toBe(false);
  });
});
