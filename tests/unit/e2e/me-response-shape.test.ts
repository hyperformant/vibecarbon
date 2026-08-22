/**
 * Unit tests for validateMeResponse — the pure shape validator behind the e2e
 * `app_api_me_authenticated` check. That check exists because of the Kong
 * rest-v1 ACL regression (2026-07-08): the app's user-context DB path
 * (Hono → Kong anon-consumer + user JWT → PostgREST) had zero e2e coverage,
 * so a 403-at-Kong → 500-at-app regression sailed through a green matrix.
 */
import { describe, expect, it, vi } from 'vitest';
import { checkAppApiMeAuthenticated, validateMeResponse } from '../../e2e/checks/app-functional.js';

describe('validateMeResponse', () => {
  it('accepts a well-formed /api/v1/me envelope', () => {
    expect(
      validateMeResponse({
        user: { id: ' 528905bd', email: 'a@b.c' },
        memberships: [],
      }),
    ).toBeNull();
  });

  it('rejects a non-object body', () => {
    expect(validateMeResponse(null)).toMatch(/not an object/);
    expect(validateMeResponse('error')).toMatch(/not an object/);
  });

  it('rejects a missing or id-less user', () => {
    expect(validateMeResponse({ memberships: [] })).toMatch(/user/);
    expect(validateMeResponse({ user: { email: 'a@b.c' }, memberships: [] })).toMatch(/user/);
  });

  it('rejects missing memberships array (the RLS-scoped DB read)', () => {
    expect(validateMeResponse({ user: { id: 'x' } })).toMatch(/memberships/);
    expect(validateMeResponse({ user: { id: 'x' }, memberships: 'none' })).toMatch(/memberships/);
  });
});

describe('checkAppApiMeAuthenticated routing', () => {
  it('requests /api/v1/me on the APP domain it is given (not hardcoded to the Kong surface)', async () => {
    // RCA overnight 2026-07-08: the check ran inside runAuthChecks, which on
    // compose receives the Kong api-subdomain — /api/v1/me is an app Hono
    // route on the MAIN domain, so Kong 404'd ("no Route matched") and the
    // first post-release matrix failed compose verify-deploy. k8s masked the
    // bug because both surfaces share one domain there.
    const seen: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ user: { id: 'u1' }, memberships: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const res = await checkAppApiMeAuthenticated('app.example.com', 'tok-123', fetcher);
    expect(seen[0]).toBe('https://app.example.com/api/v1/me');
    expect(res.checkName).toBe('app_api_me_authenticated');
    expect(res.status).toBe('pass');
  });
});
