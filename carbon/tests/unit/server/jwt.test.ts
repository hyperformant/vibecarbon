import { describe, expect, it } from 'vitest';
import { decodeAalFromJwt } from '@server/lib/jwt';

// Build a JWT with the given payload. Signature is irrelevant — decodeAalFromJwt
// never verifies it (the real session middleware already did via getUser()).
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.fakesig`;
}

describe('decodeAalFromJwt', () => {
  it('returns aal2 for an aal2 token', () => {
    expect(decodeAalFromJwt(makeJwt({ aal: 'aal2', sub: 'u1' }))).toBe('aal2');
  });

  it('returns aal1 for an aal1 token', () => {
    expect(decodeAalFromJwt(makeJwt({ aal: 'aal1', sub: 'u1' }))).toBe('aal1');
  });

  it('returns null when the aal claim is absent', () => {
    expect(decodeAalFromJwt(makeJwt({ sub: 'u1' }))).toBeNull();
  });

  it('returns null for an unexpected aal value', () => {
    expect(decodeAalFromJwt(makeJwt({ aal: 'aal3' }))).toBeNull();
  });

  it('returns null for a non-JWT string (wrong segment count)', () => {
    expect(decodeAalFromJwt('not-a-jwt')).toBeNull();
  });

  it('returns null for malformed base64/JSON without throwing', () => {
    expect(decodeAalFromJwt('aaa.@@@notbase64@@@.bbb')).toBeNull();
  });

  it('returns null for undefined/empty input', () => {
    expect(decodeAalFromJwt(undefined)).toBeNull();
    expect(decodeAalFromJwt('')).toBeNull();
  });

  it('tolerates a leading "Bearer " prefix', () => {
    expect(decodeAalFromJwt(`Bearer ${makeJwt({ aal: 'aal2' })}`)).toBe('aal2');
  });
});
