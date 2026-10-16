/**
 * Unit tests for validateMeResponse — the pure shape validator behind the e2e
 * `app_api_me_authenticated` check. That check exists because of the API gateway's
 * user-context DB regression class (gateway since removed; RCA 2026-07-08): the app's authenticated
 * data path had zero e2e coverage, so a failure there sailed through a green
 * matrix. The check now rides the session cookie, not a bearer token.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CookieJar,
  checkAppApiMeAuthenticated,
  validateMeResponse,
} from '../../e2e/checks/app-functional.js';

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
  it('requests /api/v1/me on the APP domain it is given (not hardcoded to the gateway surface)', async () => {
    // RCA overnight 2026-07-08: the check ran inside runAuthChecks, which on
    // compose receives the gateway api-subdomain — /api/v1/me is an app Hono
    // route on the MAIN domain, so the gateway 404'd ("no Route matched") and the
    // first post-release matrix failed compose verify-deploy. k8s masked the
    // bug because both surfaces share one domain there.
    const jar = new CookieJar();
    jar.absorb(new Response('', { headers: { 'set-cookie': 's=tok' } }));
    const seen: string[] = [];
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
      seen.push(url);
      return new Response(JSON.stringify({ user: { id: 'u1' }, memberships: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const res = await checkAppApiMeAuthenticated('app.example.com', jar, fetcher);
    expect(seen[0]).toBe('https://app.example.com/api/v1/me');
    const headers = (fetcher.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Cookie).toBe('s=tok');
    expect(headers.Authorization).toBeUndefined();
    expect(res.checkName).toBe('app_api_me_authenticated');
    expect(res.status).toBe('pass');
  });
});
