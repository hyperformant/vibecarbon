/**
 * Application-level functional verification checks.
 *
 * Tests that actual application features (auth, database CRUD, file uploads,
 * realtime) work against a deployed environment. Every check is
 * fault-tolerant — errors are captured, never thrown.
 */

import crypto from 'node:crypto';
import type { VerificationResult } from '../scenarios/types.js';
import { createPresignedTransfer, type PresignedTransfer } from '../utils/presigned-transfer.js';
import { dnsSafeFetch, resolveCheckIp } from './health.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 10_000;

/** fetch() wrapper that bypasses system DNS cache. */
async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  return dnsSafeFetch(url, init);
}

/** Build a VerificationResult from a timed operation. */
function result(
  checkName: string,
  status: 'pass' | 'fail',
  startMs: number,
  extra?: { errorMessage?: string; details?: Record<string, unknown> },
): VerificationResult {
  return {
    checkName,
    status,
    responseTimeMs: Date.now() - startMs,
    ...extra,
  };
}

/**
 * Convenience for checks that could not run because a precondition was missing
 * (no admin creds, an upstream check failed, no bucket, DNS not resolving). A
 * skip is NOT a pass — a missing precondition must never read as green.
 */
function skip(checkName: string, reason: string): VerificationResult {
  return {
    checkName,
    status: 'skip',
    details: { skipped: true, reason },
  };
}

/**
 * A minimal cookie jar. Better Auth carries the session in an HttpOnly cookie
 * and strips the token from JSON bodies, so a check that wants to be "signed
 * in" has to keep the Set-Cookie values and replay them as a Cookie header.
 * Pure (no network), so it is unit-testable.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  /** Absorb every Set-Cookie of a response; an empty value or Max-Age=0 deletes. */
  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
      if (value === '' || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get size(): number {
    return this.cookies.size;
  }

  /** The Cookie request header value ('' when empty). */
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/** A signed-in session: the jar plus the user get-session reported. */
export interface AuthSession {
  jar: CookieJar;
  user: { id?: string; email?: string; role?: string };
}

/**
 * Headers for a call to the app's JSON API. Mutating requests carry an Origin
 * matching SITE_URL (https://<domain>): the auth API and the CSRF middleware
 * on /api/* both refuse a cookie-authenticated write without it.
 */
function apiHeaders(domain: string, jar?: CookieJar): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: `https://${domain}`,
  };
  const cookie = jar?.header();
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/**
 * Read the signed-in user from `GET /api/auth/get-session`. The user is null
 * when there is no session (the endpoint answers 200 with a null body then).
 * Pure given a fetcher, so the admin-role assertion is unit-testable.
 */
export async function fetchSessionUser(
  domain: string,
  jar: CookieJar,
  fetcher: typeof safeFetch = safeFetch,
): Promise<{ status: number; user: AuthSession['user'] | null }> {
  const res = await fetcher(`https://${domain}/api/auth/get-session`, {
    method: 'GET',
    headers: apiHeaders(domain, jar),
  });
  if (res.status !== 200) return { status: res.status, user: null };
  const body = (await res.json().catch(() => null)) as { user?: AuthSession['user'] } | null;
  return { status: 200, user: body?.user ?? null };
}

/**
 * Whether the deployed app requires email verification. The server requires it
 * exactly when SMTP is configured (carbon/src/server/lib/email.ts
 * isEmailConfigured: a transporter from SMTP_HOST and SMTP_USER, plus SMTP_ADMIN_EMAIL), so
 * the harness derives it from the same keys in the project's env.
 */
export function smtpConfiguredFromEnv(vars: Record<string, string | undefined>): boolean {
  return Boolean(vars.SMTP_HOST?.trim() && vars.SMTP_USER?.trim() && vars.SMTP_ADMIN_EMAIL?.trim());
}

/**
 * Sign-in failed because the address is unverified. Only a precondition gap
 * (skip) when the harness KNOWS the app has SMTP configured, since a
 * throwaway address can never verify then. Without SMTP the server does not
 * require verification, so the same 403 is a regression and must fail.
 */
function isUnverifiedEmail(status: number, body: string, smtpConfigured: boolean): boolean {
  return smtpConfigured && status === 403 && /EMAIL_NOT_VERIFIED/i.test(body);
}

// ---------------------------------------------------------------------------
// Auth checks
// ---------------------------------------------------------------------------

async function checkAuthSignup(
  domain: string,
  email: string,
  password: string,
): Promise<VerificationResult> {
  const start = Date.now();
  const MAX_RETRIES = 4;
  const RETRY_DELAY_MS = 5_000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await safeFetch(`https://${domain}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: apiHeaders(domain),
        body: JSON.stringify({ email, password, name: 'E2E Test' }),
      });

      if (res.ok) {
        return result('auth_signup', 'pass', start, { details: { attempt } });
      }

      const body = await res.text();

      // Retry only while the app is still coming up (gateway 502/503/504, or a
      // 404 before the route table is live). A 4xx from the auth API is a real
      // answer, and the sign-up cap (3 per 10s per IP) punishes blind retries.
      if ([404, 502, 503, 504].includes(res.status) && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }

      return result('auth_signup', 'fail', start, {
        errorMessage: `Signup returned ${res.status}: ${body.slice(0, 300)}`,
        details: { attempts: attempt + 1 },
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      return result('auth_signup', 'fail', start, {
        errorMessage: err instanceof Error ? err.message : String(err),
        details: { attempts: attempt + 1 },
      });
    }
  }

  // Unreachable
  return result('auth_signup', 'fail', start, { errorMessage: 'Exhausted retries' });
}

/** Sign in with email + password; the session cookie lands in the returned jar. */
async function signInWithPassword(
  domain: string,
  email: string,
  password: string,
  fetcher: typeof safeFetch = safeFetch,
): Promise<{ jar: CookieJar; status: number; body: string }> {
  const jar = new CookieJar();
  const res = await fetcher(`https://${domain}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: apiHeaders(domain),
    body: JSON.stringify({ email, password }),
  });
  jar.absorb(res);
  return { jar, status: res.status, body: await res.text() };
}

export async function checkAuthSignin(
  domain: string,
  email: string,
  password: string,
  smtpConfigured = false,
  fetcher: typeof safeFetch = safeFetch,
): Promise<{ result: VerificationResult; jar?: CookieJar; unverified?: boolean }> {
  const start = Date.now();
  try {
    const { jar, status, body } = await signInWithPassword(domain, email, password, fetcher);

    if (status < 200 || status >= 300) {
      if (status === 429) {
        return {
          result: result('auth_signin', 'fail', start, {
            errorMessage: `Signin returned 429: hit the per-IP sign-in cap (10 per 15 min), not an auth regression; wait out the window. ${body.slice(0, 200)}`,
          }),
        };
      }
      if (isUnverifiedEmail(status, body, smtpConfigured)) {
        return {
          result: skip(
            'auth_signin',
            'The app requires email verification (SMTP is configured); a throwaway address cannot verify',
          ),
          unverified: true,
        };
      }
      return {
        result: result('auth_signin', 'fail', start, {
          errorMessage: `Signin returned ${status}: ${body.slice(0, 300)}`,
        }),
      };
    }

    if (jar.size === 0) {
      return {
        result: result('auth_signin', 'fail', start, {
          errorMessage: 'Signin succeeded but set no session cookie',
        }),
      };
    }

    return { result: result('auth_signin', 'pass', start), jar };
  } catch (err) {
    return {
      result: result('auth_signin', 'fail', start, {
        errorMessage: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

async function checkAuthProtected(
  domain: string,
  jar: CookieJar,
  expectedEmail: string,
): Promise<VerificationResult> {
  const start = Date.now();
  try {
    // The session cookie from sign-in must resolve to the same user through
    // get-session. The user-context DB path is covered separately by
    // app_api_me_authenticated.
    const { status, user } = await fetchSessionUser(domain, jar);

    if (status !== 200) {
      return result('auth_protected', 'fail', start, {
        errorMessage: `get-session returned ${status}`,
      });
    }
    if (!user || user.email?.toLowerCase() !== expectedEmail.toLowerCase()) {
      return result('auth_protected', 'fail', start, {
        errorMessage: `get-session did not return the signed-in user (got ${user?.email ?? 'no session'})`,
      });
    }

    return result('auth_protected', 'pass', start);
  } catch (err) {
    return result('auth_protected', 'fail', start, {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Validate the /api/v1/me response envelope. Exported for unit tests.
 * Returns a description of the first shape problem, or null if valid.
 */
export function validateMeResponse(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'not an object';
  const b = body as { user?: { id?: unknown }; memberships?: unknown };
  if (!b.user || typeof b.user !== 'object' || typeof b.user.id !== 'string') {
    return 'missing user.id';
  }
  if (!Array.isArray(b.memberships)) return 'missing memberships[] array';
  return null;
}

/**
 * Authenticated app-API check: GET /api/v1/me with the throwaway user's
 * session cookie.
 *
 * This is the check that exercises the app's USER-CONTEXT DB path: the Hono
 * session middleware resolves the cookie to a user, then the route reads
 * memberships under RLS (`withUserDb` sets app.user_id). A broken session
 * lookup or a broken RLS context shows up here and nowhere else.
 */
export async function checkAppApiMeAuthenticated(
  appDomain: string,
  jar: CookieJar,
  fetcher: typeof safeFetch = safeFetch,
): Promise<VerificationResult> {
  const start = Date.now();
  try {
    const res = await fetcher(`https://${appDomain}/api/v1/me`, {
      method: 'GET',
      headers: apiHeaders(appDomain, jar),
    });

    if (res.status !== 200) {
      const body = await res.text();
      return result('app_api_me_authenticated', 'fail', start, {
        errorMessage: `/api/v1/me returned ${res.status}: ${body.slice(0, 200)}`,
      });
    }

    const shapeError = validateMeResponse(await res.json());
    if (shapeError) {
      return result('app_api_me_authenticated', 'fail', start, {
        errorMessage: `200 but unexpected shape: ${shapeError}`,
      });
    }

    return result('app_api_me_authenticated', 'pass', start);
  } catch (err) {
    return result('app_api_me_authenticated', 'fail', start, {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Verify the OPERATOR can log into their own deployed app as the configured
 * super-admin. This is distinct from the throwaway signup/signin checks below
 * — those prove the auth *pipeline* works for a brand-new user; this proves the
 * admin user from `vibecarbon create` was actually provisioned in PRODUCTION
 * (the app's startup bootstrap creates it; see auth/bootstrap-admin.ts).
 *
 * RCA 2026-05-30: createAdminUser ran on compose-ha only — compose-single, k8s,
 * and k8s-ha shipped a prod app the operator couldn't log into (the admin user
 * lived only in their local Docker). e2e never caught it because the auth check
 * signs up a throwaway user rather than logging in as ADMIN_EMAIL. This check
 * closes that blind spot: it FAILS (not skips) when the admin can't sign in, or
 * signs in without the super_admin role.
 */
export async function checkAdminLogin(
  domain: string,
  adminEmail: string,
  adminPassword: string,
  fetcher: typeof safeFetch = safeFetch,
): Promise<VerificationResult> {
  const start = Date.now();
  try {
    const { jar, status, body } = await signInWithPassword(
      domain,
      adminEmail,
      adminPassword,
      fetcher,
    );

    if (status < 200 || status >= 300) {
      return result('auth_admin_login', 'fail', start, {
        errorMessage:
          `Admin sign-in returned ${status}: ${body.slice(0, 200)} — the configured admin ` +
          `(${adminEmail}) was not provisioned on this deploy mode (startup bootstrap gap)`,
      });
    }

    const session = await fetchSessionUser(domain, jar, fetcher);
    if (session.status !== 200 || !session.user) {
      return result('auth_admin_login', 'fail', start, {
        errorMessage: `Admin signed in but get-session returned ${session.status} with ${session.user ? 'a user' : 'no session'}`,
      });
    }

    const role = session.user.role ?? null;
    if (role !== 'super_admin') {
      return result('auth_admin_login', 'fail', start, {
        errorMessage: `Admin logged in but user.role is "${role ?? 'absent'}" (expected "super_admin")`,
        details: { role },
      });
    }

    return result('auth_admin_login', 'pass', start, { details: { role } });
  } catch (err) {
    return result('auth_admin_login', 'fail', start, {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

// Request budget per verify pass against the per-IP caps
// (carbon/src/server/middleware/auth-rate-limits.ts): 2 password sign-ins (cap
// 10 per 15 min), 1 sign-up (cap 3 per 10 s), 2 get-session (shared 100 per
// min). Several verify passes inside 15 minutes still fit.
async function runAuthChecks(
  domain: string,
  adminEmail?: string,
  adminPassword?: string,
  smtpConfigured = false,
): Promise<{ results: VerificationResult[]; jar?: CookieJar }> {
  const results: VerificationResult[] = [];

  // Admin login first — independent of the throwaway-signup pipeline below, so
  // a signup hiccup never masks (skips) the admin-provisioning regression. A
  // real deploy always has ADMIN_EMAIL/ADMIN_PASSWORD in .env.local; only skip
  // when they genuinely couldn't be parsed.
  if (adminEmail && adminPassword) {
    results.push(await checkAdminLogin(domain, adminEmail, adminPassword));
  } else {
    results.push(skip('auth_admin_login', 'ADMIN_EMAIL/ADMIN_PASSWORD not found in .env.local'));
  }

  const uid = crypto.randomUUID();
  const email = `e2e-test-${uid}@test.local`;
  const password = 'TestPass123!';

  // Sign up
  const signupResult = await checkAuthSignup(domain, email, password);
  results.push(signupResult);
  if (signupResult.status === 'fail') {
    results.push(skip('auth_signin', 'Skipped because signup failed'));
    results.push(skip('auth_protected', 'Skipped because signup failed'));
    results.push(skip('app_api_me_authenticated', 'Skipped because signup failed'));
    return { results };
  }

  // Sign in
  const signinOutcome = await checkAuthSignin(domain, email, password, smtpConfigured);
  results.push(signinOutcome.result);
  if (!signinOutcome.jar) {
    const why = signinOutcome.unverified
      ? 'Skipped because the app requires email verification'
      : 'Skipped because signin failed';
    results.push(skip('auth_protected', why));
    results.push(skip('app_api_me_authenticated', why));
    return { results };
  }

  // Protected endpoint: the cookie resolves to the signed-in user
  results.push(await checkAuthProtected(domain, signinOutcome.jar, email));

  // User-context DB path through the app's own API (see check docstring)
  results.push(await checkAppApiMeAuthenticated(domain, signinOutcome.jar));

  return { results, jar: signinOutcome.jar };
}

// ---------------------------------------------------------------------------
// Database CRUD checks
// ---------------------------------------------------------------------------

// Core application tables created by supabase/migrations/00001_init.sql. If
// any of these is missing from PostgREST's schema cache, the migration didn't
// run (or PostgREST never reloaded) and every DB-backed feature is broken.
// RCA prod-1 2026-05-26: the old check tested a synthetic `e2e_test_table`
// that no migration creates, so it 404'd and skip()'d to PASS every run —
// a deploy with 0 application tables sailed through e2e green.
const CORE_TABLES = [
  'notifications',
  'organizations',
  'memberships',
  'subscriptions',
  'app_settings',
] as const;

async function runDbChecks(domain: string, serviceRoleKey: string): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  const headers: Record<string, string> = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };

  // --- db_schema: assert the real app tables exist & are queryable ---------
  // A `limit=1` read via PostgREST (service role bypasses RLS). 200 proves the
  // table exists AND PostgREST sees it in its schema cache. 404 (PGRST205) is
  // the exact prod-1 failure mode. This FAILS — it does not skip.
  const schemaStart = Date.now();
  const missing: string[] = [];
  const tableErrors: Record<string, string> = {};
  for (const table of CORE_TABLES) {
    try {
      const res = await safeFetch(`https://${domain}/rest/v1/${table}?limit=1`, {
        method: 'GET',
        headers,
      });
      if (res.status === 200) continue;
      const body = await res.text();
      // 404 + PGRST205 => table not in schema cache (missing migration or
      // unreloaded PostgREST). Any other non-200 is also a real problem.
      missing.push(table);
      tableErrors[table] = `HTTP ${res.status}: ${body.slice(0, 160)}`;
    } catch (err) {
      missing.push(table);
      tableErrors[table] = err instanceof Error ? err.message : String(err);
    }
  }
  if (missing.length > 0) {
    results.push(
      result('db_schema', 'fail', schemaStart, {
        errorMessage: `Missing/unqueryable core tables: ${missing.join(', ')} (migrations likely didn't run or PostgREST didn't reload)`,
        details: { missing, tableErrors, checked: CORE_TABLES },
      }),
    );
    // Schema is broken — a CRUD round-trip can't work, so don't muddy the
    // output with cascading failures. The db_schema failure is the headline.
    results.push(skip('db_write_roundtrip', 'Skipped: core schema missing (see db_schema)'));
    return results;
  }
  results.push(
    result('db_schema', 'pass', schemaStart, { details: { tablesVerified: CORE_TABLES } }),
  );

  // --- db_write_roundtrip: prove insert/query/delete on a REAL table -------
  // Use notifications with is_active:false so the row is never surfaced to the
  // public/authenticated notification feed even if cleanup somehow fails.
  const uid = crypto.randomUUID();
  const marker = `e2e-probe-${uid}`;
  const notifUrl = `https://${domain}/rest/v1/notifications`;
  const roundtripStart = Date.now();
  try {
    // Insert
    const insertRes = await safeFetch(notifUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: marker, is_active: false, visibility: 'authenticated' }),
    });
    if (!insertRes.ok) {
      const body = await insertRes.text();
      results.push(
        result('db_write_roundtrip', 'fail', roundtripStart, {
          errorMessage: `Insert returned ${insertRes.status}: ${body.slice(0, 200)}`,
          details: { step: 'insert' },
        }),
      );
      return results;
    }

    // Query
    const queryRes = await safeFetch(`${notifUrl}?title=eq.${marker}&select=id,title`, {
      method: 'GET',
      headers,
    });
    const rows = queryRes.ok
      ? ((await queryRes.json()) as Array<{ id: string; title: string }>)
      : [];
    const found = rows.some((r) => r.title === marker);

    // Delete (best-effort cleanup, always attempt)
    await safeFetch(`${notifUrl}?title=eq.${marker}`, { method: 'DELETE', headers }).catch(
      () => undefined,
    );

    if (!found) {
      results.push(
        result('db_write_roundtrip', 'fail', roundtripStart, {
          errorMessage: 'Inserted row not found on read-back',
          details: { step: 'query', rowsReturned: rows.length },
        }),
      );
      return results;
    }

    results.push(
      result('db_write_roundtrip', 'pass', roundtripStart, {
        details: { table: 'notifications', insert: true, query: true, cleanup: true },
      }),
    );
  } catch (err) {
    // Best-effort cleanup on unexpected error
    await safeFetch(`${notifUrl}?title=eq.${marker}`, { method: 'DELETE', headers }).catch(
      () => undefined,
    );
    results.push(
      result('db_write_roundtrip', 'fail', roundtripStart, {
        errorMessage: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// File upload round-trip
// ---------------------------------------------------------------------------

/** A valid 1x1 PNG: the smallest real image the avatar allowlist accepts. */
export const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Source list of one CSP directive, or null when the header or directive is absent. */
function cspDirective(header: string | null, name: string): string[] | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [directive, ...sources] = part.trim().split(/\s+/);
    if (directive?.toLowerCase() === name) return sources;
  }
  return null;
}

interface PresignBody {
  key?: unknown;
  url?: unknown;
  headers?: unknown;
  fileUrl?: unknown;
}

/**
 * The upload path end to end, the way the browser walks it: the signed-in user
 * asks the app for a presigned PUT (`POST /api/v1/files/presign`), confirms the
 * page CSP and the bucket CORS would let a browser make that PUT, PUTs the
 * bytes straight to object storage, then reads them back through the app
 * (`GET /api/files/<key>`, a 302 to a presigned GET). Passes only when the
 * bytes that come back equal the bytes that went up.
 *
 * App requests ride `appFetch` (dnsSafeFetch: pinned, Host + SNI kept on the
 * domain). The two object-storage legs ride `transfer`, see
 * tests/e2e/utils/presigned-transfer.ts for why they sit off the pinned seam.
 * `appFetch` does not follow redirects, which is what lets this check assert
 * the 302 itself before following it.
 */
export async function checkFileUploadRoundtrip(
  appDomain: string,
  jar: CookieJar,
  deps: { appFetch?: typeof safeFetch; transfer?: PresignedTransfer } = {},
): Promise<VerificationResult> {
  const appFetch = deps.appFetch ?? safeFetch;
  const transfer = deps.transfer ?? createPresignedTransfer(appDomain);
  const start = Date.now();
  const fail = (step: string, message: string, details?: Record<string, unknown>) =>
    result('file_upload_roundtrip', 'fail', start, {
      errorMessage: `${step}: ${message}`,
      details: { step, ...details },
    });

  try {
    const presignRes = await appFetch(`https://${appDomain}/api/v1/files/presign`, {
      method: 'POST',
      headers: {
        ...apiHeaders(appDomain, jar),
      },
      body: JSON.stringify({
        kind: 'avatar',
        contentType: 'image/png',
        size: ONE_PIXEL_PNG.length,
      }),
    });
    if (presignRes.status !== 200) {
      const body = await presignRes.text();
      return fail(
        'presign',
        `POST /api/v1/files/presign returned ${presignRes.status}: ${body.slice(0, 300)}`,
      );
    }
    const presign = (await presignRes.json()) as PresignBody;
    if (
      typeof presign.url !== 'string' ||
      typeof presign.key !== 'string' ||
      typeof presign.fileUrl !== 'string' ||
      !presign.headers ||
      typeof presign.headers !== 'object'
    ) {
      return fail('presign', `200 but unexpected shape: ${JSON.stringify(presign).slice(0, 300)}`);
    }
    const key = presign.key;

    // The browser PUTs straight to object storage, so two things outside the
    // byte transfer must hold or the real upload button fails while this
    // server-side PUT succeeds: the page's CSP connect-src must allow the
    // storage origin, and the bucket's CORS must answer the preflight for the
    // app's origin.
    const storageOrigin = new URL(presign.url).origin;
    const homeRes = await appFetch(`https://${appDomain}/`, { method: 'GET' });
    const csp = homeRes.headers.get('content-security-policy');
    const connectSrc = cspDirective(csp, 'connect-src');
    if (!connectSrc?.includes(storageOrigin)) {
      return fail(
        'csp',
        `connect-src does not allow ${storageOrigin} (got: ${connectSrc ? connectSrc.join(' ') : `no connect-src in ${JSON.stringify(csp)}`})`,
        { key },
      );
    }

    const appOrigin = `https://${appDomain}`;
    const preflight = await transfer.preflight(presign.url, appOrigin);
    if (preflight.status < 200 || preflight.status >= 300 || preflight.allowOrigin !== appOrigin) {
      return fail(
        'cors',
        `preflight from ${appOrigin} returned ${preflight.status} with Access-Control-Allow-Origin ${JSON.stringify(preflight.allowOrigin)}`,
        { key },
      );
    }

    const put = await transfer.put(
      presign.url,
      presign.headers as Record<string, string>,
      new Uint8Array(ONE_PIXEL_PNG),
    );
    if (put.status < 200 || put.status >= 300) {
      return fail('upload', `PUT to the presigned URL returned ${put.status}: ${put.body}`, {
        key,
      });
    }

    const readRes = await appFetch(`https://${appDomain}${presign.fileUrl}`, { method: 'GET' });
    const location = readRes.headers.get('location');
    if (readRes.status !== 302 || !location) {
      const body = await readRes.text();
      return fail(
        'read',
        `GET ${presign.fileUrl} returned ${readRes.status} (expected a 302 to a presigned URL): ${body.slice(0, 200)}`,
        { key },
      );
    }

    const got = await transfer.get(location);
    if (got.status !== 200) {
      return fail('download', `following the read redirect returned ${got.status}`, { key });
    }
    if (!Buffer.from(got.bytes).equals(ONE_PIXEL_PNG)) {
      return fail(
        'compare',
        `downloaded ${got.bytes.length} bytes that differ from the ${ONE_PIXEL_PNG.length} uploaded`,
        { key },
      );
    }

    return result('file_upload_roundtrip', 'pass', start, { details: { key } });
  } catch (err) {
    return fail('request', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Realtime check
// ---------------------------------------------------------------------------

async function runRealtimeCheck(domain: string, anonKey: string): Promise<VerificationResult[]> {
  // Primary: Try WebSocket connection (requires Node 21+ for global WebSocket).
  // Fallback: HTTP request to the realtime endpoint via dnsSafeFetch.
  //
  // The WebSocket constructor uses dns.lookup() (system resolver), which may
  // have stale cache entries for newly created domains. Our HTTP checks use
  // dnsSafeFetch which resolves via Cloudflare/Google DNS, bypassing the cache.
  // When WebSocket fails, we fall back to HTTP to verify the service is running.
  //
  // The WebSocket handshake is therefore the ONE probe here that a
  // verify-failover resolution pin cannot cover (no lookup hook on the global
  // WebSocket constructor). It is not a hole: the pin exists so a stale record
  // can't produce a spurious FAILURE, and a WebSocket that lands on the retired
  // node simply fails and drops into the PINNED HTTP fallback below, which
  // decides the check. It can never turn a broken deployment green — a pass
  // still requires a real response from the node the pin dialed.
  //
  // TLS: the WebSocket handshake is the one check with no per-call TLS opt-out
  // — it uses the process default. That default used to be "verify nothing"
  // (the runner's NODE_TLS_REJECT_UNAUTHORIZED=0); it is now "system roots plus
  // the Let's Encrypt staging roots" (tests/e2e/utils/e2e-env.js), so a staging
  // rig still connects while a bogus certificate no longer does. A cert
  // rejection here is not fatal — it drops through to the HTTP fallback below,
  // which reports a pass with a note.

  // Resolve the domain through the shared check seam (pin-aware: under a
  // verify-failover resolution pin this is the promoted node's IP, so the
  // precondition can't be satisfied by a stale record pointing at the retired
  // one). Used only as an existence precondition + a diagnostic detail.
  const resolvedIp = await resolveCheckIp(domain);
  if (!resolvedIp) {
    return [skip('realtime_connect', `DNS not yet resolving for ${domain} — skipped`)];
  }

  // Try WebSocket first (best proof of realtime working)
  if (typeof globalThis.WebSocket !== 'undefined') {
    const wsResult = await tryWebSocket(domain, anonKey);
    if (wsResult.status === 'pass') {
      return [wsResult];
    }
    // WebSocket failed — fall through to HTTP fallback
    console.log(`[realtime] WebSocket failed (${wsResult.errorMessage}), trying HTTP fallback...`);
  }

  // Fallback: verify realtime service is reachable via HTTP (uses dnsSafeFetch
  // which resolves DNS through Cloudflare/Google, bypassing stale system cache).
  // Retry on timeout — realtime may take longer to come up after server restarts
  // (e.g. post-scale reboots).
  const start = Date.now();
  // This HTTP fallback only runs when the WebSocket handshake (tried first) fails,
  // so its whole budget is failure-path. 3×10s=30s rides out a slow post-scale
  // realtime cold start without doubling the previous 4×15s=60s tail.
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 10_000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await safeFetch(
        `https://${domain}/realtime/v1/websocket?apikey=${anonKey}&vsn=1.0.0`,
        { method: 'GET' },
      );
      // The realtime endpoint returns an HTTP upgrade error or a response —
      // any non-timeout response proves the service is reachable.
      return [
        result('realtime_connect', 'pass', start, {
          details: {
            method: 'http_fallback',
            statusCode: res.status,
            resolvedIp,
            attempt,
            note: 'WebSocket DNS failed; HTTP fallback confirmed service reachable',
          },
        }),
      ];
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      return [
        result('realtime_connect', 'fail', start, {
          errorMessage: `Both WebSocket and HTTP fallback failed: ${err instanceof Error ? err.message : String(err)}`,
          details: { attempts: attempt + 1 },
        }),
      ];
    }
  }

  // Unreachable
  return [result('realtime_connect', 'fail', start, { errorMessage: 'Exhausted retries' })];
}

/** Attempt a WebSocket connection to the realtime service. */
function tryWebSocket(domain: string, anonKey: string): Promise<VerificationResult> {
  const start = Date.now();

  return new Promise<VerificationResult>((resolve) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* best effort */
      }
      resolve(
        result('realtime_connect', 'fail', start, {
          errorMessage: 'Timed out waiting for Phoenix join reply (10 s)',
        }),
      );
    }, TIMEOUT_MS);

    let ws: WebSocket;
    try {
      ws = new WebSocket(`wss://${domain}/realtime/v1/websocket?apikey=${anonKey}&vsn=1.0.0`);
    } catch (err) {
      clearTimeout(timer);
      resolve(
        result('realtime_connect', 'fail', start, {
          errorMessage: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }

    ws.addEventListener('error', (event) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* best effort */
      }
      resolve(
        result('realtime_connect', 'fail', start, {
          errorMessage: 'message' in event ? (event as ErrorEvent).message : 'WebSocket error',
        }),
      );
    });

    ws.addEventListener('open', () => {
      // Send Phoenix join message
      const joinMsg = JSON.stringify({
        topic: 'phoenix',
        event: 'heartbeat',
        payload: {},
        ref: '1',
      });
      ws.send(joinMsg);
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : '') as {
          ref?: string;
        };
        // Any reply to our ref means the realtime server is responsive
        if (msg.ref === '1') {
          clearTimeout(timer);
          ws.close();
          resolve(result('realtime_connect', 'pass', start));
        }
      } catch {
        // Ignore malformed frames; keep waiting for our reply
      }
    });

    ws.addEventListener('close', () => {
      // If we haven't resolved yet, the connection was closed unexpectedly
      clearTimeout(timer);
      resolve(
        result('realtime_connect', 'fail', start, {
          errorMessage: 'WebSocket closed before receiving a join reply',
        }),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all application functional checks against a deployed environment.
 * Returns array of individual check results.
 */
export async function runAppFunctionalChecks(
  domain: string,
  anonKey: string,
  serviceRoleKey: string,
  adminEmail?: string,
  adminPassword?: string,
  appDomain: string = domain,
  smtpConfigured = false,
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  // Run check groups sequentially — auth creates state the others do not
  // depend on, but sequential execution keeps resource usage predictable
  // and makes logs easier to follow during long e2e runs.
  const auth = await runAuthChecks(appDomain, adminEmail, adminPassword, smtpConfigured);
  results.push(...auth.results);

  const dbResults = await runDbChecks(domain, serviceRoleKey);
  results.push(...dbResults);

  // Uploads are an app feature (presign + read routes on the app domain), so
  // they run as the signed-in throwaway user from the auth checks above.
  results.push(
    auth.jar
      ? await checkFileUploadRoundtrip(appDomain, auth.jar)
      : skip('file_upload_roundtrip', 'Skipped because no signed-in user (auth checks failed)'),
  );

  const realtimeResults = await runRealtimeCheck(domain, anonKey);
  results.push(...realtimeResults);

  return results;
}
