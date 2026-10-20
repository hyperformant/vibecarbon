/**
 * Application-level functional verification checks.
 *
 * Tests that actual application features (auth, database CRUD, file uploads)
 * work against a deployed environment. Every check is fault-tolerant — errors
 * are captured, never thrown.
 */

import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appBucketEndpoint,
  BUCKET_SETTLE_BUDGET_MS,
  bucketNeedsSettle,
  makeAppBucketProbeRound,
  makeSignedHead,
  settleWindowFor,
  waitForBucketSettled,
} from '../../../src/lib/deploy/bucket-settle.js';
import type { DeployMode, StepName, VerificationResult } from '../scenarios/types.js';
import {
  bucketOfPresignedUrl,
  createPresignedTransfer,
  type PresignedTransfer,
} from '../utils/presigned-transfer.js';
import { resolveObjectStorageCreds } from './backup-evidence.js';
import { dnsSafeFetch } from './health.js';
import { type PsqlResult, type ReplTarget, resolveHaDbIps, runPsql } from './replication.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

  /** One cookie's value, or undefined when the jar does not hold it. */
  get(name: string): string | undefined {
    return this.cookies.get(name);
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
export function apiHeaders(domain: string, jar?: CookieJar): Record<string, string> {
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

/**
 * What a real sign-up answers: Better Auth's `{ user: { email, ... } }` (the
 * token is stripped from the body, see carbon/src/server/auth/
 * strip-session-token.ts). Null when the body is anything else. A bare 2xx is
 * not proof: anything that answers 200 at the path would read as a sign-up.
 */
export function signupBodyError(body: string, email: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return `not JSON: ${body.slice(0, 120)}`;
  }
  const user = (parsed as { user?: { email?: unknown } } | null)?.user;
  if (!user || typeof user.email !== 'string') return 'missing user.email';
  if (user.email.toLowerCase() !== email.toLowerCase()) {
    return `user.email is ${user.email}, not the address signed up`;
  }
  return null;
}

export async function checkAuthSignup(
  domain: string,
  email: string,
  password: string,
  deps: { fetcher?: typeof safeFetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<VerificationResult> {
  const fetcher = deps.fetcher ?? safeFetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = Date.now();
  const MAX_RETRIES = 4;
  const RETRY_DELAY_MS = 5_000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetcher(`https://${domain}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: apiHeaders(domain),
        body: JSON.stringify({ email, password, name: 'E2E Test' }),
      });

      const body = await res.text();

      if (res.ok) {
        const bodyError = signupBodyError(body, email);
        if (bodyError) {
          return result('auth_signup', 'fail', start, {
            errorMessage: `Signup returned ${res.status} but not a Better Auth user: ${bodyError}`,
            details: { attempts: attempt + 1 },
          });
        }
        return result('auth_signup', 'pass', start, { details: { attempt } });
      }

      // Retry only while the app is still coming up (gateway 502/503/504, or a
      // 404 before the route table is live). A 4xx from the auth API is a real
      // answer, and the sign-up cap (3 per 10s per IP) punishes blind retries.
      if ([404, 502, 503, 504].includes(res.status) && attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      return result('auth_signup', 'fail', start, {
        errorMessage: `Signup returned ${res.status}: ${body.slice(0, 300)}`,
        details: { attempts: attempt + 1 },
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
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

export async function checkAuthProtected(
  domain: string,
  jar: CookieJar,
  expectedEmail: string,
  fetcher: typeof safeFetch = safeFetch,
): Promise<VerificationResult> {
  const start = Date.now();
  try {
    // The session cookie from sign-in must resolve to the same user through
    // get-session. The user-context DB path is covered separately by
    // app_api_me_authenticated.
    const { status, user } = await fetchSessionUser(domain, jar, fetcher);

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
  return (await adminSignIn(domain, adminEmail, adminPassword, fetcher)).result;
}

/**
 * The auth_admin_login check, plus the signed-in super-admin session when it
 * passed. The observability checks reuse that session to mint the ForwardAuth
 * cookie instead of signing in again (password sign-in is capped at 10 per
 * 15 min per IP).
 */
export async function adminSignIn(
  domain: string,
  adminEmail: string,
  adminPassword: string,
  fetcher: typeof safeFetch = safeFetch,
): Promise<{ result: VerificationResult; jar?: CookieJar }> {
  const start = Date.now();
  const failed = (errorMessage: string, details?: Record<string, unknown>) => ({
    result: result('auth_admin_login', 'fail', start, { errorMessage, details }),
  });
  try {
    const { jar, status, body } = await signInWithPassword(
      domain,
      adminEmail,
      adminPassword,
      fetcher,
    );

    if (status < 200 || status >= 300) {
      return failed(
        `Admin sign-in returned ${status}: ${body.slice(0, 200)} — the configured admin ` +
          `(${adminEmail}) was not provisioned on this deploy mode (startup bootstrap gap)`,
      );
    }

    const session = await fetchSessionUser(domain, jar, fetcher);
    if (session.status !== 200 || !session.user) {
      return failed(
        `Admin signed in but get-session returned ${session.status} with ${session.user ? 'a user' : 'no session'}`,
      );
    }

    const role = session.user.role ?? null;
    if (role !== 'super_admin') {
      return failed(
        `Admin logged in but user.role is "${role ?? 'absent'}" (expected "super_admin")`,
        { role },
      );
    }

    return { result: result('auth_admin_login', 'pass', start, { details: { role } }), jar };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

// Request budget per verify pass against the per-IP caps
// (carbon/src/server/middleware/auth-rate-limits.ts): 2 password sign-ins (cap
// 10 per 15 min), 1 sign-up (cap 3 per 10 s), 2 get-session (shared 100 per
// min). Several verify passes inside 15 minutes still fit. The observability
// checks reuse the admin session returned here rather than a third sign-in.
async function runAuthChecks(
  domain: string,
  adminEmail?: string,
  adminPassword?: string,
  smtpConfigured = false,
): Promise<{ results: VerificationResult[]; jar?: CookieJar; adminJar?: CookieJar }> {
  const results: VerificationResult[] = [];
  let adminJar: CookieJar | undefined;

  // Admin login first — independent of the throwaway-signup pipeline below, so
  // a signup hiccup never masks (skips) the admin-provisioning regression. A
  // real deploy always has ADMIN_EMAIL/ADMIN_PASSWORD in .env.local; only skip
  // when they genuinely couldn't be parsed.
  if (adminEmail && adminPassword) {
    const admin = await adminSignIn(domain, adminEmail, adminPassword);
    results.push(admin.result);
    adminJar = admin.jar;
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
    return { results, adminJar };
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
    return { results, adminJar };
  }

  // Protected endpoint: the cookie resolves to the signed-in user
  results.push(await checkAuthProtected(domain, signinOutcome.jar, email));

  // User-context DB path through the app's own API (see check docstring)
  results.push(await checkAppApiMeAuthenticated(domain, signinOutcome.jar));

  return { results, jar: signinOutcome.jar, adminJar };
}

// ---------------------------------------------------------------------------
// Database CRUD checks
// ---------------------------------------------------------------------------

// Core application tables from the app's Drizzle schema
// (carbon/src/server/db/schema.ts). If any of these is missing, the migration
// didn't run and every DB-backed feature is broken.
// RCA prod-1 2026-05-26: the old check tested a synthetic `e2e_test_table`
// that no migration creates, so it 404'd and skip()'d to PASS every run —
// a deploy with 0 application tables sailed through e2e green.
export const CORE_TABLES = [
  'notifications',
  'organizations',
  'memberships',
  'subscriptions',
  'app_settings',
] as const;

/** Runs one single-line SQL statement against the deployed database. */
export type SqlRunner = (sql: string) => Promise<PsqlResult>;

/** psql -tA output → one trimmed value per non-empty line. */
function psqlLines(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Real-schema assertion + write round-trip, as direct SQL inside the deployed
 * database (the same SSH + `docker compose exec` / `kubectl exec` path the
 * replication checks use — see runPsql in ./replication.ts). The app has no
 * public table API to probe from outside, so the database is asked directly.
 * `sql` is a string instead of a runner when the run has no SSH handle to the
 * database host; it names the missing handle (see missingDbHandle). Both
 * checks then FAIL, never skip: every scenario that reaches a verify step has
 * deployed servers and a deploy key, so a missing handle is a broken harness,
 * and a skip would let the prod-1 regression guard below go quietly unrun.
 */
export async function runDbChecks(sql: SqlRunner | string): Promise<VerificationResult[]> {
  if (typeof sql === 'string') {
    const errorMessage = `Cannot reach the database: ${sql}`;
    return ['db_schema', 'db_write_roundtrip'].map((checkName) => ({
      checkName,
      status: 'fail' as const,
      errorMessage,
      details: { missing: sql },
    }));
  }
  const results: VerificationResult[] = [];

  // --- db_schema: assert the real app tables exist -------------------------
  // One catalog query for all of them. A missing table is the exact prod-1
  // failure mode. This FAILS — it does not skip.
  const schemaStart = Date.now();
  const tableList = CORE_TABLES.map((t) => `'${t}'`).join(',');
  const schema = await sql(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN (${tableList})`,
  );
  if (!schema.ok) {
    results.push(
      result('db_schema', 'fail', schemaStart, {
        errorMessage: `Schema query failed: ${schema.error ?? 'unknown error'}`,
        details: { checked: CORE_TABLES },
      }),
    );
    results.push(skip('db_write_roundtrip', 'Skipped: schema query failed (see db_schema)'));
    return results;
  }
  const present = new Set(psqlLines(schema.output));
  const missing = CORE_TABLES.filter((t) => !present.has(t));
  if (missing.length > 0) {
    results.push(
      result('db_schema', 'fail', schemaStart, {
        errorMessage: `Missing core tables: ${missing.join(', ')} (migrations likely didn't run)`,
        details: { missing, checked: CORE_TABLES },
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
  // notifications with is_active=false so the row is never surfaced to any
  // notification feed even if cleanup somehow fails. The marker is a UUID, so
  // the single-quoted literal can never break out of the statement.
  const marker = `e2e-probe-${crypto.randomUUID()}`;
  const deleteSql = `DELETE FROM public.notifications WHERE title = '${marker}' RETURNING title`;
  const roundtripStart = Date.now();
  const fail = (step: string, errorMessage: string): VerificationResult =>
    result('db_write_roundtrip', 'fail', roundtripStart, { errorMessage, details: { step } });

  const insert = await sql(
    `INSERT INTO public.notifications (title, is_active, visibility) VALUES ('${marker}', false, 'authenticated') RETURNING title`,
  );
  if (!insert.ok || !psqlLines(insert.output).includes(marker)) {
    results.push(fail('insert', `Insert failed: ${insert.error ?? insert.output.slice(0, 200)}`));
    // The INSERT may have committed even if its output was lost in transit.
    await sql(deleteSql);
    return results;
  }

  const query = await sql(`SELECT title FROM public.notifications WHERE title = '${marker}'`);
  const found = query.ok && psqlLines(query.output).includes(marker);
  const cleanup = await sql(deleteSql);
  const deleted = cleanup.ok && psqlLines(cleanup.output).includes(marker);

  if (!found) {
    results.push(
      fail('query', `Inserted row not found on read-back${query.error ? `: ${query.error}` : ''}`),
    );
  } else if (!deleted) {
    results.push(
      fail(
        'delete',
        `Delete did not remove the probe row${cleanup.error ? `: ${cleanup.error}` : ''}`,
      ),
    );
  } else {
    results.push(
      result('db_write_roundtrip', 'pass', roundtripStart, {
        details: { table: 'notifications', insert: true, query: true, cleanup: true },
      }),
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// Database runtime checks: migrations, scheduled jobs, server config
// ---------------------------------------------------------------------------

/**
 * The pg_cron jobs carbon/db/migrations/0002_baseline_post.sql schedules.
 * tests/unit/e2e/lean-stack-checks.test.ts keeps this list equal to the
 * cron.schedule() calls in that file.
 */
export const CRON_JOBS = [
  'cleanup-crawler-hits',
  'cleanup-expired-notifications',
  'cleanup-expired-sessions',
  'cleanup-job-history',
  'cleanup-login-attempts',
  'rollup-crawler-hits',
] as const;

/** Libraries the db image's postgresql.conf preloads (docker/postgres-walg/postgresql.conf). */
export const PRELOADED_LIBRARIES = ['pg_cron', 'pg_stat_statements'] as const;

/** Every deploy mode starts postgres with `-c config_file=` this path. */
export const DB_CONFIG_FILE = '/etc/postgresql/postgresql.conf';

const MIGRATIONS_JOURNAL = fileURLToPath(
  new URL('../../../carbon/db/migrations/meta/_journal.json', import.meta.url),
);

/** How many migrations the template ships, from drizzle's journal. */
export function templateMigrationCount(journalPath = MIGRATIONS_JOURNAL): number {
  const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as { entries?: unknown[] };
  return journal.entries?.length ?? 0;
}

/**
 * What the lean stack's database must be doing once a deploy is up, asked
 * directly over the same SSH psql path as runDbChecks:
 *
 * - db_migrations_applied: the app's startup migrator wrote its ledger
 *   (drizzle.__drizzle_migrations) with at least the template's migrations.
 *   Add-ons append their own, so more is fine; fewer means the app booted on
 *   a half-migrated database.
 * - db_cron_jobs: every scheduled job exists and is active, and the pg_cron
 *   launcher is running. A job row without the launcher never fires, which is
 *   what a db started without shared_preload_libraries looks like.
 * - db_server_config: postgres read the image's baked config file (it
 *   replaces the one initdb writes, so a wrong -c flag silently drops every
 *   setting in it): both libraries preloaded and created, pg_stat_statements
 *   readable, and bind parameters kept out of the server log.
 *
 * Like runDbChecks, a missing SSH handle FAILS all three, never skips.
 */
export async function runDbRuntimeChecks(
  sql: SqlRunner | string,
  expectedMigrations = templateMigrationCount(),
): Promise<VerificationResult[]> {
  const names = ['db_migrations_applied', 'db_cron_jobs', 'db_server_config'];
  if (typeof sql === 'string') {
    const errorMessage = `Cannot reach the database: ${sql}`;
    return names.map((checkName) => ({
      checkName,
      status: 'fail' as const,
      errorMessage,
      details: { missing: sql },
    }));
  }
  return [
    await checkMigrationsApplied(sql, expectedMigrations),
    await checkCronJobs(sql),
    await checkServerConfig(sql),
  ];
}

async function checkMigrationsApplied(
  sql: SqlRunner,
  expected: number,
): Promise<VerificationResult> {
  const start = Date.now();
  const fail = (errorMessage: string, details: Record<string, unknown> = {}) =>
    result('db_migrations_applied', 'fail', start, {
      errorMessage,
      details: { expected, ...details },
    });

  const ledger = await sql(`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL`);
  if (!ledger.ok) return fail(`Ledger lookup failed: ${ledger.error ?? 'unknown error'}`);
  if (psqlLines(ledger.output)[0] !== 't') {
    return fail('No drizzle.__drizzle_migrations ledger: the app never ran its migrations');
  }
  const count = await sql('SELECT count(*) FROM drizzle.__drizzle_migrations');
  const applied = Number(psqlLines(count.output)[0]);
  if (!count.ok || !Number.isInteger(applied)) {
    return fail(`Ledger count failed: ${count.error ?? count.output.slice(0, 200)}`);
  }
  if (applied < expected) {
    return fail(`Only ${applied} of the template's ${expected} migrations are applied`, {
      applied,
    });
  }
  return result('db_migrations_applied', 'pass', start, { details: { expected, applied } });
}

async function checkCronJobs(sql: SqlRunner): Promise<VerificationResult> {
  const start = Date.now();
  const fail = (errorMessage: string, details: Record<string, unknown> = {}) =>
    result('db_cron_jobs', 'fail', start, { errorMessage, details });

  const jobs = await sql('SELECT jobname FROM cron.job WHERE active');
  if (!jobs.ok) return fail(`cron.job query failed: ${jobs.error ?? 'unknown error'}`);
  const active = new Set(psqlLines(jobs.output));
  const missing = CRON_JOBS.filter((j) => !active.has(j));
  if (missing.length > 0) {
    return fail(`Missing or inactive cron jobs: ${missing.join(', ')}`, {
      missing,
      active: [...active],
    });
  }
  const launcher = await sql(
    `SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'pg_cron launcher'`,
  );
  if (!launcher.ok || Number(psqlLines(launcher.output)[0]) < 1) {
    return fail(
      `pg_cron launcher is not running, so no job will fire${launcher.error ? `: ${launcher.error}` : ''}`,
    );
  }
  return result('db_cron_jobs', 'pass', start, { details: { jobs: CRON_JOBS, launcher: true } });
}

async function checkServerConfig(sql: SqlRunner): Promise<VerificationResult> {
  const start = Date.now();
  const fail = (errorMessage: string, details: Record<string, unknown> = {}) =>
    result('db_server_config', 'fail', start, { errorMessage, details });

  // One row, `|`-separated (psql -tA). No `$` anywhere: the statement rides
  // inside a double-quoted shell argument.
  const row = await sql(
    `SELECT current_setting('config_file'), current_setting('shared_preload_libraries'), current_setting('log_parameter_max_length'), (SELECT coalesce(string_agg(extname, ',' ORDER BY extname), '') FROM pg_extension WHERE extname IN ('pg_cron','pg_stat_statements'))`,
  );
  if (!row.ok) return fail(`Settings query failed: ${row.error ?? 'unknown error'}`);
  const [configFile = '', preload = '', paramLength = '', extensions = ''] = (
    psqlLines(row.output)[0] ?? ''
  ).split('|');
  const preloaded = preload.split(',').map((l) => l.trim());
  const created = extensions.split(',').filter(Boolean);
  const details = {
    configFile,
    preloaded,
    extensions: created,
    logParameterMaxLength: paramLength,
  };

  const problems: string[] = [];
  if (configFile !== DB_CONFIG_FILE) {
    problems.push(`config_file is ${configFile || '(empty)'}, not ${DB_CONFIG_FILE}`);
  }
  const notPreloaded = PRELOADED_LIBRARIES.filter((l) => !preloaded.includes(l));
  if (notPreloaded.length > 0) problems.push(`not preloaded: ${notPreloaded.join(', ')}`);
  const notCreated = PRELOADED_LIBRARIES.filter((l) => !created.includes(l));
  if (notCreated.length > 0) problems.push(`extension not created: ${notCreated.join(', ')}`);
  if (paramLength !== '0') {
    problems.push(
      `log_parameter_max_length is ${paramLength || '(empty)'}, so bind values reach the log`,
    );
  }
  if (problems.length > 0) return fail(problems.join('; '), details);

  const stats = await sql('SELECT count(*) FROM monitoring.pg_stat_statements');
  if (!stats.ok || !Number.isInteger(Number(psqlLines(stats.output)[0]))) {
    return fail(
      `monitoring.pg_stat_statements is not readable: ${stats.error ?? stats.output.slice(0, 200)}`,
      details,
    );
  }
  return result('db_server_config', 'pass', start, { details });
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
 * The environment's app storage as `.vibecarbon.json` records it: what the
 * upload check needs to run the bucket settle gate.
 */
export interface AppStorage {
  providerId: string;
  bucket: string;
  region: string;
  endpoint: string;
  /** The environment's name; its bucket ends with `-<envName>-storage` unless pinned. */
  envName?: string;
  /** `.vibecarbon.json` environments.<env>.s3.bucketPin, when the operator pinned the bucket. */
  bucketPin?: string;
  /**
   * ISO string, or null when the deploy could not read it (treated as young).
   * Absent when nothing was recorded: a 0-window provider, or an env deployed
   * before creation times were recorded; neither runs the gate.
   */
  bucketCreatedAt?: string | null;
}

type ProbeRound = () => Promise<{ ok: number; total: number; failures: string[] }>;

/** Injection points for the settle gate (tests drive a fake clock). */
export interface SettleDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  probeRound?: ProbeRound;
}

type SettleOutcome =
  | { kind: 'skipped' }
  | { kind: 'settled'; rounds: number; elapsedSeconds: number }
  | { kind: 'failed'; message: string; details: Record<string, unknown> };

/**
 * The bucket settle gate, run before the first upload. A 0-window provider
 * returns at once: no probes, no delay. Otherwise, when the bucket is young
 * (or its age unknown), wait for three clean probe rounds in a row within
 * BUCKET_SETTLE_BUDGET_MS. Verification waits here so the deploy never has to.
 */
async function settleAppBucket(
  storage: AppStorage,
  origin: string,
  deps: SettleDeps,
): Promise<SettleOutcome> {
  if (storage.bucketCreatedAt === undefined) return { kind: 'skipped' };
  const windowMs = await settleWindowFor(storage.providerId);
  if (windowMs === 0) return { kind: 'skipped' };
  const now = deps.now ?? Date.now;
  const createdAt = storage.bucketCreatedAt ? new Date(storage.bucketCreatedAt) : null;
  const startedAt = now();
  if (!bucketNeedsSettle(createdAt, startedAt, windowMs)) return { kind: 'skipped' };

  const age = createdAt
    ? `${Math.floor((startedAt - createdAt.getTime()) / 60_000)} min old`
    : 'of unknown age';
  let probeRound = deps.probeRound;
  if (!probeRound) {
    // The preflights must hit the same endpoint as HeadBucket; the recorded
    // `endpoint` can be '' (relative URLs, every preflight failing for the
    // whole budget), so resolve it from the provider and fail fast if absent.
    let endpoint: string;
    try {
      endpoint = await appBucketEndpoint(storage.providerId, storage.region);
    } catch (err) {
      return {
        kind: 'failed',
        message: `bucket ${JSON.stringify(storage.bucket)} is ${age} and needs the settle gate, but ${(err as Error).message}`,
        details: { bucket: storage.bucket, region: storage.region },
      };
    }
    const creds = resolveObjectStorageCreds(storage.providerId);
    if ('missing' in creds) {
      return {
        kind: 'failed',
        message: `bucket ${JSON.stringify(storage.bucket)} is ${age} and needs the settle gate, but ${creds.missing.join(' and ')} not set`,
        details: { bucket: storage.bucket, missing: creds.missing },
      };
    }
    probeRound = makeAppBucketProbeRound({
      endpoint,
      bucket: storage.bucket,
      origin,
      signedHead: makeSignedHead({
        providerId: storage.providerId,
        accessKey: creds.accessKey,
        secretKey: creds.secretKey,
        region: storage.region,
        bucket: storage.bucket,
      }),
    });
  }
  const r = await waitForBucketSettled({
    probeRound,
    now,
    sleep: deps.sleep,
    budgetMs: BUCKET_SETTLE_BUDGET_MS,
  });
  const elapsedSeconds = Math.round((now() - startedAt) / 1000);
  if (r.settled) return { kind: 'settled', rounds: r.rounds, elapsedSeconds };
  return {
    kind: 'failed',
    message:
      `bucket ${JSON.stringify(storage.bucket)} (${age}) did not settle in ${elapsedSeconds}s ` +
      `over ${r.rounds} rounds; last failures: ${r.lastFailures.join(', ')}`,
    details: {
      bucket: storage.bucket,
      rounds: r.rounds,
      elapsedSeconds,
      lastFailures: r.lastFailures,
    },
  };
}

/**
 * Each environment owns its app bucket: `<project>-<salt>-<env>-storage`, or
 * `<project>-<salt>-<env>-<8hex>-storage` when the name had to be clipped
 * (deriveEnvAppBucketName). A pinned bucket may be named anything. Returns the
 * failure message, or null when the bucket is the env's own.
 */
function perEnvBucketFailure(storage: AppStorage | null | undefined, bucket: string | null) {
  if (!storage?.envName || storage.bucketPin || !bucket) return null;
  const own = new RegExp(`-${storage.envName.replace(/[^a-z0-9-]/gi, '')}(-[0-9a-f]{8})?-storage$`);
  if (own.test(bucket)) return null;
  return `the app presigned against bucket ${JSON.stringify(bucket)}, which is not environment ${JSON.stringify(storage.envName)}'s own bucket (expected a name ending in "-${storage.envName}-storage" unless s3.bucketPin is set)`;
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
  deps: {
    appFetch?: typeof safeFetch;
    transfer?: PresignedTransfer;
    /**
     * The app bucket the environment records (`.vibecarbon.json`
     * environments.<env>.s3.bucket): the bucket deploy created and put the
     * CORS rule on. When given, a presigned URL for any other bucket fails as
     * `bucket`, before the preflight, instead of surfacing as a CORS 403.
     */
    expectedBucket?: string | null;
    /**
     * The env's app storage (resolveAppStorage). When given, the bucket settle
     * gate runs before the first upload; a 0-window provider skips it.
     */
    storage?: AppStorage | null;
    settle?: SettleDeps;
  } = {},
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
    let settleDetail: Record<string, unknown> = {};
    if (deps.storage) {
      const origin = appDomain ? `https://${appDomain}` : 'http://localhost:3000';
      const settled = await settleAppBucket(deps.storage, origin, deps.settle ?? {});
      if (settled.kind === 'failed') return fail('settle', settled.message, settled.details);
      if (settled.kind === 'settled') {
        settleDetail = {
          settle: { rounds: settled.rounds, elapsedSeconds: settled.elapsedSeconds },
        };
      }
    }

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
    const bucket = bucketOfPresignedUrl(presign.url);
    if (deps.expectedBucket && bucket !== deps.expectedBucket) {
      return fail(
        'bucket',
        `the app presigned against bucket ${JSON.stringify(bucket)}, but the environment's bucket (.vibecarbon.json s3.bucket, the one deploy created and configured CORS on) is ${JSON.stringify(deps.expectedBucket)}`,
        { key, bucket, expectedBucket: deps.expectedBucket },
      );
    }

    const perEnvFailure = perEnvBucketFailure(deps.storage, bucket);
    if (perEnvFailure) return fail('bucket', perEnvFailure, { key, bucket });

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
        `preflight from ${appOrigin} to bucket ${JSON.stringify(bucket)} returned ${preflight.status}` +
          `${preflight.errorCode ? ` (${preflight.errorCode})` : ''}` +
          ` with Access-Control-Allow-Origin ${JSON.stringify(preflight.allowOrigin)}`,
        { key, bucket, errorCode: preflight.errorCode ?? null },
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

    return result('file_upload_roundtrip', 'pass', start, { details: { key, ...settleDetail } });
  } catch (err) {
    return fail('request', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The env's app storage from `.vibecarbon.json` (environments.<env>: its
 * provider and s3 block), or null when it records no bucket. Read from the
 * same file deploy writes, so the upload check compares the app's presigned
 * bucket against the bucket deploy created and configured CORS on, and runs
 * the settle gate against the creation time deploy recorded. The provider
 * falls back to hetzner, as the CLI's providerIdFor does.
 */
export function resolveAppStorage(projectDir: string, envPrefix: string): AppStorage | null {
  try {
    const configPath = join(projectDir, '.vibecarbon.json');
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      environments?: Record<
        string,
        {
          provider?: string;
          s3?: {
            bucket?: string;
            bucketPin?: string;
            region?: string;
            endpoint?: string;
            bucketCreatedAt?: string | null;
          };
        }
      >;
    };
    const env = config.environments?.[envPrefix];
    if (!env?.s3?.bucket) return null;
    return {
      providerId: (env.provider ?? 'hetzner').toLowerCase(),
      bucket: env.s3.bucket,
      envName: envPrefix,
      ...(env.s3.bucketPin && { bucketPin: env.s3.bucketPin }),
      region: env.s3.region ?? '',
      endpoint: env.s3.endpoint ?? '',
      ...(Object.hasOwn(env.s3, 'bucketCreatedAt') && {
        bucketCreatedAt: env.s3.bucketCreatedAt ?? null,
      }),
    };
  } catch {
    return null;
  }
}

/**
 * Which SSH handle to the database host is missing, in the same words as the
 * config-canary checks, or null when both are present.
 */
export function missingDbHandle(ip?: string | null, sshKeyPath?: string | null): string | null {
  if (ip && sshKeyPath) return null;
  if (!ip) return sshKeyPath ? 'no serverIp (sshKeyPath present)' : 'no serverIp and no sshKeyPath';
  return 'no sshKeyPath (serverIp present)';
}

/**
 * The node every SSH/exec-based verify check targets: serverIps[0] (compose's
 * VPS, compose-HA's role-primary, k8s's master, k8s-HA's primary master), or,
 * at verify-failover on an HA mode, the PROMOTED primary.
 *
 * Both HA modes retire the old primary on failover and neither reorders
 * servers[], so serverIps[0] would keep naming the decommissioned node.
 * resolveHaDbIps() reads both shapes (k8s-HA's swapped ha.primary/ha.standby,
 * compose-HA's in-place `role` flip). Two nights (2026-08-10, -11) of
 * compose-HA checks ran against the retired node when this read `=== 'k8s-ha'`.
 */
export function resolveSshCheckMasterIp(
  serverIps: readonly string[],
  opts: { stepName: StepName; mode: DeployMode; projectDir: string; envPrefix: string },
): string | undefined {
  let ip: string | undefined = serverIps[0];
  if (opts.stepName === 'verify-failover' && opts.mode.endsWith('-ha')) {
    const { primaryIp } = resolveHaDbIps(opts.projectDir, opts.envPrefix);
    if (primaryIp) ip = primaryIp;
  }
  return ip;
}

/**
 * The `db` argument for runAppFunctionalChecks: the SSH target that fronts the
 * database, or the missingDbHandle() reason when either half is absent.
 */
export function buildDbHandle(
  ip: string | null | undefined,
  sshKeyPath: string | null | undefined,
  opts: { mode: DeployMode; projectName: string },
): ReplTarget | string {
  if (ip && sshKeyPath) {
    return { ip, sshKeyPath, mode: opts.mode, projectName: opts.projectName, label: 'primary' };
  }
  // Non-null: the condition above is exactly its null case.
  return missingDbHandle(ip, sshKeyPath) as string;
}

/** The functional check results, plus the super-admin session when auth_admin_login passed. */
export interface AppFunctionalOutcome {
  results: VerificationResult[];
  adminJar?: CookieJar;
}

/**
 * Run all application functional checks against a deployed environment.
 * Returns the check results and the admin session (see AppFunctionalOutcome). `db` is the SSH target that
 * fronts the database, or the missingDbHandle() reason when there is none.
 */
export async function runAppFunctionalChecks(opts: {
  domain: string;
  db: ReplTarget | string;
  adminEmail?: string;
  adminPassword?: string;
  smtpConfigured?: boolean;
  /** The env's app storage: its bucket is checkFileUploadRoundtrip's `expectedBucket`, and it drives the settle gate. */
  appStorage?: AppStorage | null;
}): Promise<AppFunctionalOutcome> {
  const { domain, db, adminEmail, adminPassword, smtpConfigured = false, appStorage } = opts;
  const results: VerificationResult[] = [];

  // Run check groups sequentially — auth creates state the others do not
  // depend on, but sequential execution keeps resource usage predictable
  // and makes logs easier to follow during long e2e runs.
  const auth = await runAuthChecks(domain, adminEmail, adminPassword, smtpConfigured);
  results.push(...auth.results);

  const sql: SqlRunner | string =
    typeof db === 'string' ? db : (statement) => runPsql(db, statement);
  results.push(...(await runDbChecks(sql)));
  results.push(...(await runDbRuntimeChecks(sql)));

  // Uploads are an app feature (presign + read routes on the app domain), so
  // they run as the signed-in throwaway user from the auth checks above.
  results.push(
    auth.jar
      ? await checkFileUploadRoundtrip(domain, auth.jar, {
          expectedBucket: appStorage?.bucket ?? null,
          storage: appStorage,
        })
      : skip('file_upload_roundtrip', 'Skipped because no signed-in user (auth checks failed)'),
  );

  return { results, adminJar: auth.adminJar };
}
