/**
 * Unit tests for extractAppMetadataRole — the pure JWT-claim decoder behind the
 * e2e `auth_admin_login` check. Locks the role-assertion contract (the deploy
 * paths set app_metadata.role = super_admin) without needing a live cluster.
 */
import { describe, expect, it } from 'vitest';
import { extractAppMetadataRole } from '../../e2e/checks/app-functional.js';

/** Build a JWT-shaped token (header.payload.sig) with the given claims. */
function token(payload: unknown): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

describe('extractAppMetadataRole', () => {
  it('returns super_admin from a properly provisioned admin token', () => {
    expect(
      extractAppMetadataRole(token({ sub: 'abc', app_metadata: { role: 'super_admin' } })),
    ).toBe('super_admin');
  });

  it('returns the role even when it is not super_admin (caller asserts the value)', () => {
    expect(extractAppMetadataRole(token({ app_metadata: { role: 'authenticated' } }))).toBe(
      'authenticated',
    );
  });

  it('returns null when app_metadata is absent', () => {
    expect(extractAppMetadataRole(token({ sub: 'abc' }))).toBeNull();
  });

  it('returns null when app_metadata has no role', () => {
    expect(extractAppMetadataRole(token({ app_metadata: { provider: 'email' } }))).toBeNull();
  });

  it('returns null for a non-string role', () => {
    expect(extractAppMetadataRole(token({ app_metadata: { role: 123 } }))).toBeNull();
  });

  it('returns null for a malformed (non-three-part) token', () => {
    expect(extractAppMetadataRole('not.a-jwt')).toBeNull();
    expect(extractAppMetadataRole('')).toBeNull();
  });

  it('returns null when the payload segment is not valid JSON', () => {
    expect(extractAppMetadataRole('header.@@@notbase64json@@@.sig')).toBeNull();
  });
});
