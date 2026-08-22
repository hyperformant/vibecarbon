import { createHmac } from 'node:crypto';

/**
 * Build an HS256-signed JWT for tests.
 *
 * The default secret matches what the auth middleware's mock paths expect
 * — pass an explicit `secret` if you're testing the real JWT verifier.
 *
 * Example:
 *   const token = mockJwt({ sub: 'user-123', role: 'authenticated' });
 *   const res = await app.request('/api/v1/me', {
 *     headers: { authorization: `Bearer ${token}` },
 *   });
 */
export function mockJwt(payload: Record<string, unknown>, secret = 'test-secret'): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}
