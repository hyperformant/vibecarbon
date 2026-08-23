/**
 * Application-level functional verification checks.
 *
 * Tests that actual application features (auth, database CRUD, storage,
 * realtime) work against a deployed environment. Every check is
 * fault-tolerant — errors are captured, never thrown.
 */

import crypto from 'node:crypto';
import type { VerificationResult } from '../scenarios/types.js';
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
 * Decode a GoTrue access-token JWT and return `app_metadata.role`, or null if
 * the token is malformed or carries no role. Pure (no network) so the role
 * assertion in checkAdminLogin is unit-testable without a live cluster.
 *
 * GoTrue mirrors the user's `raw_app_meta_data` into the JWT's `app_metadata`
 * claim, so a token minted for the configured admin carries
 * `app_metadata.role === 'super_admin'` — set identically by both provisioning
 * paths (compose createAdminUser + k8s provisionAdminUser, and the
 * super-admin.sql seed).
 */
export function extractAppMetadataRole(accessToken: string): string | null {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as {
      app_metadata?: { role?: unknown };
    };
    const role = payload.app_metadata?.role;
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auth checks
// ---------------------------------------------------------------------------

async function checkAuthSignup(
  domain: string,
  anonKey: string,
  email: string,
  password: string,
): Promise<VerificationResult> {
  const start = Date.now();
  const MAX_RETRIES = 4;
  const RETRY_DELAY_MS = 5_000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await safeFetch(`https://${domain}/auth/v1/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
        },
        body: JSON.stringify({ email, password }),
      });

      if (res.ok) {
        return result('auth_signup', 'pass', start, { details: { attempt } });
      }

      const body = await res.text();

      // Retry on 404 — Kong may still be loading declarative routes after health check passes
      if (res.status === 404 && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }

      return result('auth_signup', 'fail', start, {
        errorMessage: `Signup returned ${res.status}: ${body}`,
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

async function checkAuthSignin(
  domain: string,
  anonKey: string,
  email: string,
  password: string,
): Promise<{ result: VerificationResult; accessToken?: string }> {
  const start = Date.now();
  try {
    const res = await safeFetch(`https://${domain}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
      },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        result: result('auth_signin', 'fail', start, {
          errorMessage: `Signin returned ${res.status}: ${body}`,
        }),
      };
    }

    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      return {
        result: result('auth_signin', 'fail', start, {
          errorMessage: 'Response did not contain access_token',
        }),
      };
    }

    return {
      result: result('auth_signin', 'pass', start),
      accessToken: json.access_token,
    };
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
  anonKey: string,
  accessToken: string,
): Promise<VerificationResult> {
  const start = Date.now();
  try {
    // Verify the access token is valid by calling GoTrue's /auth/v1/user endpoint.
    // This tests the full auth pipeline: token issued by signup → validated by GoTrue.
    // The user-context DB path (anon consumer + user JWT through Kong to
    // PostgREST) is covered separately by app_api_me_authenticated.
    const res = await safeFetch(`https://${domain}/auth/v1/user`, {
      method: 'GET',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (res.status !== 200) {
      const body = await res.text();
      return result('auth_protected', 'fail', start, {
        errorMessage: `Auth user endpoint returned ${res.status}: ${body}`,
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
 * Authenticated app-API check: GET /api/v1/me with the throwaway user's JWT.
 *
 * This is the only check that exercises the app's USER-CONTEXT DB path:
 * Hono route → Supabase client (ANON key as Kong apikey + user JWT in
 * Authorization) → Kong rest-v1 ACL → PostgREST under RLS. Every other check
 * reaches PostgREST as service_role (Kong `admin` group) or stops at GoTrue.
 *
 * RCA 2026-07-08: the audit remediation (b8dc024) moved user-context clients
 * onto the anon apikey while Kong's rest-v1 ACL still allowed only `admin` —
 * every authenticated data query 403'd at Kong (surfaced as app 500s) and the
 * matrix stayed green because nothing tested this path.
 */
export async function checkAppApiMeAuthenticated(
  appDomain: string,
  accessToken: string,
  fetcher: typeof safeFetch = safeFetch,
): Promise<VerificationResult> {
  const start = Date.now();
  try {
    const res = await fetcher(`https://${appDomain}/api/v1/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
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
 * admin user from `vibecarbon create` was actually provisioned in PRODUCTION.
 *
 * RCA 2026-05-30: createAdminUser ran on compose-ha only — compose-single, k8s,
 * and k8s-ha shipped a prod app the operator couldn't log into (the admin user
 * lived only in their local Docker). e2e never caught it because the auth check
 * signs up a throwaway user rather than logging in as ADMIN_EMAIL. This check
 * closes that blind spot: it FAILS (not skips) when the admin can't sign in, or
 * signs in without the super_admin role.
 */
async function checkAdminLogin(
  domain: string,
  anonKey: string,
  adminEmail: string,
  adminPassword: string,
): Promise<VerificationResult> {
  const start = Date.now();
  try {
    const res = await safeFetch(`https://${domain}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
      },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    });

    if (!res.ok) {
      const body = await res.text();
      return result('auth_admin_login', 'fail', start, {
        errorMessage:
          `Admin sign-in returned ${res.status}: ${body.slice(0, 200)} — the configured admin ` +
          `(${adminEmail}) was not provisioned on this deploy mode (createAdminUser/provisionAdminUser gap)`,
      });
    }

    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      return result('auth_admin_login', 'fail', start, {
        errorMessage: 'Admin sign-in succeeded but the response carried no access_token',
      });
    }

    const role = extractAppMetadataRole(json.access_token);
    if (role !== 'super_admin') {
      return result('auth_admin_login', 'fail', start, {
        errorMessage: `Admin logged in but app_metadata.role is "${role ?? 'absent'}" (expected "super_admin")`,
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

async function runAuthChecks(
  domain: string,
  anonKey: string,
  adminEmail?: string,
  adminPassword?: string,
  // /api/v1/me is an APP route: on compose it lives on the main domain while
  // `domain` here is the Kong api-subdomain (k8s: same domain, so it masked
  // the difference — overnight 2026-07-08 compose verify-deploy 404).
  appDomain: string = domain,
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  // Admin login first — independent of the throwaway-signup pipeline below, so
  // a signup hiccup never masks (skips) the admin-provisioning regression. A
  // real deploy always has ADMIN_EMAIL/ADMIN_PASSWORD in .env.local; only skip
  // when they genuinely couldn't be parsed.
  if (adminEmail && adminPassword) {
    results.push(await checkAdminLogin(domain, anonKey, adminEmail, adminPassword));
  } else {
    results.push(skip('auth_admin_login', 'ADMIN_EMAIL/ADMIN_PASSWORD not found in .env.local'));
  }

  const uid = crypto.randomUUID();
  const email = `e2e-test-${uid}@test.local`;
  const password = 'TestPass123!';

  // Sign up
  const signupResult = await checkAuthSignup(domain, anonKey, email, password);
  results.push(signupResult);
  if (signupResult.status === 'fail') {
    results.push(skip('auth_signin', 'Skipped because signup failed'));
    results.push(skip('auth_protected', 'Skipped because signup failed'));
    results.push(skip('app_api_me_authenticated', 'Skipped because signup failed'));
    return results;
  }

  // Sign in
  const signinOutcome = await checkAuthSignin(domain, anonKey, email, password);
  results.push(signinOutcome.result);
  if (signinOutcome.result.status === 'fail' || !signinOutcome.accessToken) {
    results.push(skip('auth_protected', 'Skipped because signin failed'));
    results.push(skip('app_api_me_authenticated', 'Skipped because signin failed'));
    return results;
  }

  // Protected endpoint
  results.push(await checkAuthProtected(domain, anonKey, signinOutcome.accessToken));

  // User-context DB path through the app's own API (see check docstring)
  results.push(await checkAppApiMeAuthenticated(appDomain, signinOutcome.accessToken));

  return results;
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
// Storage checks
// ---------------------------------------------------------------------------

/**
 * Create `test-bucket` if it is not already there, so the storage checks
 * below have the precondition they need.
 *
 * WHY THIS EXISTS. Nothing in the product or the harness ever created this
 * bucket, so `storage_upload`/`storage_download`/`storage_delete` skipped as
 * "precondition missing" in verify-deploy, verify-restore AND verify-failover
 * — on every provider, in every run, since the checks were written. Every
 * green lifecycle record we have was green with the Storage path entirely
 * unexercised (confirmed on the 2026-08-20 vultr and scaleway compose-HA
 * passes: "30 passed, 0 failed, 4 skipped" three times over).
 *
 * The bucket is the TEST's fixture, not the product's — the template must not
 * ship a `test-bucket` — so the harness creates it. Doing it here rather than
 * as a separate lifecycle step means every caller of runStorageChecks gets it,
 * including the post-restore and post-failover ones where a re-created stack
 * has an empty storage schema again.
 *
 * Creating it through the Storage API is a bonus assertion: the admin path
 * (POST /storage/v1/bucket) has never been covered either.
 *
 * @returns null on success, or an operator-facing reason on failure
 */
export async function ensureTestBucket(
  domain: string,
  serviceRoleKey: string,
): Promise<string | null> {
  try {
    const res = await safeFetch(`https://${domain}/storage/v1/bucket`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: 'test-bucket', name: 'test-bucket', public: true }),
    });
    if (res.ok) return null;
    const body = await res.text();
    // Idempotent: a bucket that already exists is exactly what we wanted.
    // Supabase answers 409 for this, but the wording has moved across
    // versions, so match the status OR either spelling.
    if (res.status === 409 || /already exists|Duplicate/i.test(body)) return null;
    return `POST /storage/v1/bucket returned ${res.status}: ${body.slice(0, 300)}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function runStorageChecks(
  domain: string,
  serviceRoleKey: string,
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  const uid = crypto.randomUUID();
  const objectPath = `e2e-test-${uid}.txt`;
  const content = 'e2e test content';
  // TWO distinct paths, per the Storage REST contract:
  //   upload / delete -> /object/<bucket>/<key>          (authenticated)
  //   public download -> /object/public/<bucket>/<key>   (public read URL)
  // Supabase's own troubleshooting note is explicit: a public bucket only
  // means a public URL exists for DOWNLOAD; "use the normal path for all
  // other operations and not the public URL path with 'public' in it".
  //
  // This check used the public path for ALL THREE, so upload and delete were
  // always addressed wrong. It never showed up because the bucket did not
  // exist either, and the missing-bucket branch short-circuited before the
  // path could be wrong in a visible way. Creating the bucket
  // (ensureTestBucket) exposed it immediately: the very next CI run failed
  // storage_upload with `Bucket not found` against /object/public/... while
  // storage_bucket_ensure passed. Two bugs, one hiding the other.
  const objectUrl = `https://${domain}/storage/v1/object/test-bucket/${objectPath}`;
  const publicUrl = `https://${domain}/storage/v1/object/public/test-bucket/${objectPath}`;
  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
  };

  // Precondition, created rather than assumed — see ensureTestBucket. A
  // failure here FAILS the check rather than skipping it: "we could not set
  // up storage" is a storage result, and silently skipping is what hid this
  // whole surface for months.
  const bucketStart = Date.now();
  const bucketError = await ensureTestBucket(domain, serviceRoleKey);
  if (bucketError) {
    results.push(
      result('storage_bucket_ensure', 'fail', bucketStart, {
        errorMessage: `Could not create or find test-bucket: ${bucketError}`,
      }),
    );
    results.push(skip('storage_upload', 'Skipped because test-bucket could not be created'));
    results.push(skip('storage_download', 'Skipped because test-bucket could not be created'));
    results.push(skip('storage_delete', 'Skipped because test-bucket could not be created'));
    return results;
  }
  results.push(result('storage_bucket_ensure', 'pass', bucketStart));

  // Upload
  const uploadStart = Date.now();
  try {
    const res = await safeFetch(objectUrl, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'text/plain',
      },
      body: content,
    });

    if (!res.ok) {
      const body = await res.text();
      // "Bucket not found" USED to skip all three checks here. It cannot be a
      // skip any more: ensureTestBucket has just reported the bucket present,
      // so storage losing it between those two calls is a real defect and must
      // read as one. That old skip is precisely how this surface stayed
      // unexercised on every provider for months.
      const missing = body.includes('Bucket not found') || res.status === 404;
      results.push(
        result('storage_upload', 'fail', uploadStart, {
          errorMessage: missing
            ? `test-bucket vanished between creation and upload (${res.status}): ${body}`
            : `Upload returned ${res.status}: ${body}`,
        }),
      );
      results.push(skip('storage_download', 'Skipped because upload failed'));
      results.push(skip('storage_delete', 'Skipped because upload failed'));
      return results;
    }

    results.push(result('storage_upload', 'pass', uploadStart));
  } catch (err) {
    results.push(
      result('storage_upload', 'fail', uploadStart, {
        errorMessage: err instanceof Error ? err.message : String(err),
      }),
    );
    results.push(skip('storage_download', 'Skipped because upload failed'));
    results.push(skip('storage_delete', 'Skipped because upload failed'));
    return results;
  }

  // Download
  const downloadStart = Date.now();
  try {
    // Deliberately the PUBLIC url: reading back through the public path is
    // what proves the bucket is actually public and Kong routes it.
    const res = await safeFetch(publicUrl, {
      method: 'GET',
      headers: authHeaders,
    });

    if (!res.ok) {
      const body = await res.text();
      // DIAGNOSTIC RETRY — NOT AN ABSORBER. 2026-08-23 (matrix 32614839037,
      // hetzner compose verify-restore): the public download 404'd 137ms
      // after a successful upload, then the identical sequence passed on the
      // rerun. One data point cannot distinguish "object never readable"
      // from "read-after-write race on a restored stack". So on failure,
      // probe once more after 2s and FAIL EITHER WAY — the check stays red,
      // but its message now names which failure mode occurred, which is the
      // evidence the next occurrence needs. An absorbing retry here would be
      // an unregistered mitigation hiding an `ours` bug (mitigation policy).
      let retryNote = '';
      if (res.status === 404) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const again = await safeFetch(publicUrl, { method: 'GET', headers: authHeaders });
          retryNote = again.ok
            ? ` READ-AFTER-WRITE RACE: same URL succeeded on a 2s-later retry — the object became publicly readable late, it was not missing.`
            : ` Retry after 2s also failed (${again.status}) — not a settle race at this horizon.`;
        } catch (retryErr) {
          retryNote = ` Retry probe itself errored: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`;
        }
      }
      results.push(
        result('storage_download', 'fail', downloadStart, {
          errorMessage: `Download returned ${res.status}: ${body}${retryNote}`,
        }),
      );
    } else {
      const body = await res.text();
      if (body !== content) {
        results.push(
          result('storage_download', 'fail', downloadStart, {
            errorMessage: 'Downloaded content does not match uploaded content',
            details: { expected: content, received: body.slice(0, 200) },
          }),
        );
      } else {
        results.push(result('storage_download', 'pass', downloadStart));
      }
    }
  } catch (err) {
    results.push(
      result('storage_download', 'fail', downloadStart, {
        errorMessage: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  // Delete (best-effort cleanup)
  const deleteStart = Date.now();
  try {
    const res = await safeFetch(objectUrl, {
      method: 'DELETE',
      headers: authHeaders,
    });

    if (!res.ok) {
      const body = await res.text();
      // DIAGNOSTIC RETRY — NOT AN ABSORBER (same contract as the download
      // leg above). 2026-08-23 run 32646830369: upload and download passed,
      // then this DELETE got a bare storage-api 500 — the same hetzner
      // object-storage degradation family the registry-500 RCA documented.
      // One 5xx tells us nothing about blip-vs-broken, so probe once after
      // 2s and FAIL EITHER WAY with the mode named.
      let retryNote = '';
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const again = await safeFetch(objectUrl, { method: 'DELETE', headers: authHeaders });
          retryNote = again.ok
            ? ' S3-BACKEND BLIP: the identical delete succeeded on a 2s-later retry — transient backend error, not a broken delete path.'
            : ` Retry after 2s also failed (${again.status}) — the delete path itself is failing.`;
        } catch (retryErr) {
          retryNote = ` Retry probe itself errored: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`;
        }
      }
      results.push(
        result('storage_delete', 'fail', deleteStart, {
          errorMessage: `Delete returned ${res.status}: ${body}${retryNote}`,
        }),
      );
    } else {
      results.push(result('storage_delete', 'pass', deleteStart));
    }
  } catch (err) {
    results.push(
      result('storage_delete', 'fail', deleteStart, {
        errorMessage: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return results;
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
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  // Run check groups sequentially — auth creates state the others do not
  // depend on, but sequential execution keeps resource usage predictable
  // and makes logs easier to follow during long e2e runs.
  const authResults = await runAuthChecks(domain, anonKey, adminEmail, adminPassword, appDomain);
  results.push(...authResults);

  const dbResults = await runDbChecks(domain, serviceRoleKey);
  results.push(...dbResults);

  const storageResults = await runStorageChecks(domain, serviceRoleKey);
  results.push(...storageResults);

  const realtimeResults = await runRealtimeCheck(domain, anonKey);
  results.push(...realtimeResults);

  return results;
}
