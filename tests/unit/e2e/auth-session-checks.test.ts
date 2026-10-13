/**
 * Unit tests for the e2e checks that drive the in-process auth API: the cookie
 * jar that carries the HttpOnly session, and the `auth_admin_login` role
 * assertion (user.role from get-session). The live calls only run on real
 * infra; these pin the logic with fakes.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  CookieJar,
  checkAdminLogin,
  checkAuthSignin,
  fetchSessionUser,
  smtpConfiguredFromEnv,
} from '../../e2e/checks/app-functional.js';
import { dnsSafeFetch } from '../../e2e/checks/health.js';

function hdrs(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

function responseWithCookies(cookies: string[], status = 200, body = '{}'): Response {
  const headers = new Headers();
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(body, { status, headers });
}

describe('CookieJar', () => {
  it('keeps name=value pairs and drops attributes', () => {
    const jar = new CookieJar();
    jar.absorb(
      responseWithCookies([
        '__Secure-app.session_token=abc.def; Path=/; HttpOnly; Secure; SameSite=Lax',
        'other=1; Path=/',
      ]),
    );
    expect(jar.header()).toBe('__Secure-app.session_token=abc.def; other=1');
    expect(jar.size).toBe(2);
  });

  it('deletes a cookie the server expires (empty value or Max-Age=0)', () => {
    const jar = new CookieJar();
    jar.absorb(responseWithCookies(['a=1', 'b=2']));
    jar.absorb(responseWithCookies(['a=; Max-Age=0', 'b=x; Max-Age=0']));
    expect(jar.size).toBe(0);
    expect(jar.header()).toBe('');
  });

  it('keeps a cookie value that contains "="', () => {
    const jar = new CookieJar();
    jar.absorb(responseWithCookies(['t=abc%3D%3D.sig=; Path=/']));
    expect(jar.header()).toBe('t=abc%3D%3D.sig=');
  });
});

describe('dnsSafeFetch response headers', () => {
  it('keeps each Set-Cookie separate (node hands them over as an array)', async () => {
    const httpsRequest = ((_o: unknown, cb: (res: unknown) => void) => {
      const res = new PassThrough() as PassThrough & Record<string, unknown>;
      res.statusCode = 200;
      res.statusMessage = 'OK';
      res.headers = {
        'content-type': 'application/json',
        'set-cookie': ['a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/', 'b=2; Path=/'],
      };
      setImmediate(() => {
        cb(res);
        res.end('{}');
      });
      const req = { on: () => req, write: () => {}, end: () => {}, destroy: () => {} };
      return req;
      // biome-ignore lint/suspicious/noExplicitAny: narrow stub for an injected seam
    }) as any;
    const res = await dnsSafeFetch('https://app.example.com/x', undefined, {
      resolveIp: async () => '203.0.113.9',
      httpsRequest,
    });
    expect(res.headers.getSetCookie()).toHaveLength(2);
    expect(res.headers.get('content-type')).toBe('application/json');
    const jar = new CookieJar();
    jar.absorb(res);
    expect(jar.header()).toBe('a=1; b=2');
  });
});

describe('fetchSessionUser', () => {
  it('replays the jar and sends the same-origin Origin header', async () => {
    const jar = new CookieJar();
    jar.absorb(responseWithCookies(['s=tok']));
    const fetcher = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ user: { email: 'a@b.c' } }), { status: 200 }),
    );
    const out = await fetchSessionUser('app.example.com', jar, fetcher);
    expect(out.user?.email).toBe('a@b.c');
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://app.example.com/api/auth/get-session');
    const h = hdrs(init);
    expect(h.Cookie).toBe('s=tok');
    expect(h.Origin).toBe('https://app.example.com');
  });

  it('reports a null user when get-session answers 200 with a null body', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response('null'));
    const out = await fetchSessionUser('app.example.com', new CookieJar(), fetcher);
    expect(out).toEqual({ status: 200, user: null });
  });
});

describe('checkAdminLogin', () => {
  function fetcherFor(opts: { signIn?: Response; session?: Response }) {
    return vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/api/auth/sign-in/email')) {
        return opts.signIn ?? responseWithCookies(['s=tok'], 200, '{"user":{}}');
      }
      return opts.session ?? new Response(JSON.stringify({ user: { role: 'super_admin' } }));
    });
  }

  it('passes when sign-in works and get-session reports super_admin', async () => {
    const fetcher = fetcherFor({});
    const r = await checkAdminLogin('app.example.com', 'a@b.c', 'pw', fetcher);
    expect(r).toMatchObject({ checkName: 'auth_admin_login', status: 'pass' });
    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({ email: 'a@b.c', password: 'pw' });
    expect(hdrs(init).Origin).toBe('https://app.example.com');
    // the session call carries the cookie the sign-in set
    const [, sessionInit] = fetcher.mock.calls[1];
    expect(hdrs(sessionInit).Cookie).toBe('s=tok');
  });

  it('fails when the role is not super_admin, naming the role', async () => {
    const r = await checkAdminLogin(
      'app.example.com',
      'a@b.c',
      'pw',
      fetcherFor({ session: new Response(JSON.stringify({ user: { role: 'user' } })) }),
    );
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/user\.role is "user"/);
  });

  it('fails when the role is absent', async () => {
    const r = await checkAdminLogin(
      'app.example.com',
      'a@b.c',
      'pw',
      fetcherFor({ session: new Response(JSON.stringify({ user: {} })) }),
    );
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/absent/);
  });

  it('fails (not skips) when the admin cannot sign in', async () => {
    const r = await checkAdminLogin(
      'app.example.com',
      'a@b.c',
      'pw',
      fetcherFor({ signIn: new Response('{"code":"INVALID_EMAIL_OR_PASSWORD"}', { status: 401 }) }),
    );
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/401.*not provisioned/);
  });

  it('fails when sign-in succeeds but there is no session', async () => {
    const r = await checkAdminLogin(
      'app.example.com',
      'a@b.c',
      'pw',
      fetcherFor({ session: new Response('null') }),
    );
    expect(r.status).toBe('fail');
    expect(r.errorMessage).toMatch(/no session/);
  });
});

describe('checkAuthSignin verification and cap handling', () => {
  const unverified = () => new Response('{"code":"EMAIL_NOT_VERIFIED"}', { status: 403 });
  const run = (smtp: boolean, res: () => Response) =>
    checkAuthSignin(
      'app.example.com',
      'a@b.c',
      'pw',
      smtp,
      vi.fn(async (_u: string, _i?: RequestInit) => res()),
    );

  it('skips on EMAIL_NOT_VERIFIED when SMTP is configured', async () => {
    const out = await run(true, unverified);
    expect(out.result.status).toBe('skip');
    expect(out.unverified).toBe(true);
  });

  it('fails with the 403 body when SMTP is not configured (a regression)', async () => {
    const out = await run(false, unverified);
    expect(out.result.status).toBe('fail');
    expect(out.result.errorMessage).toMatch(/403.*EMAIL_NOT_VERIFIED/);
  });

  it('names the per-IP cap on a 429', async () => {
    const out = await run(false, () => new Response('{}', { status: 429 }));
    expect(out.result.status).toBe('fail');
    expect(out.result.errorMessage).toMatch(/per-IP sign-in cap \(10 per 15 min\)/);
  });
});

describe('smtpConfiguredFromEnv', () => {
  it('needs SMTP_HOST, SMTP_USER and SMTP_ADMIN_EMAIL, as the server does', () => {
    const full = { SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_ADMIN_EMAIL: 'a@b.c' };
    expect(smtpConfiguredFromEnv(full)).toBe(true);
    expect(smtpConfiguredFromEnv({ ...full, SMTP_USER: '' })).toBe(false);
    expect(smtpConfiguredFromEnv({ SMTP_HOST: 'h', SMTP_ADMIN_EMAIL: 'a@b.c' })).toBe(false);
    expect(smtpConfiguredFromEnv({ SMTP_HOST: 'h' })).toBe(false);
    expect(smtpConfiguredFromEnv({ ...full, SMTP_HOST: '' })).toBe(false);
    expect(smtpConfiguredFromEnv({})).toBe(false);
  });
});
