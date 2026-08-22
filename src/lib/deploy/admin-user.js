/**
 * Shared GoTrue admin-user provisioning.
 *
 * The production app super-admin — an `auth.users` row with
 * `app_metadata.role = super_admin` — is created post-deploy by POSTing to
 * GoTrue's admin API. The HTTP contract is identical across every deploy
 * mode; only the tunnel used to reach GoTrue differs:
 *   - compose / compose-ha: `ssh -L` to the gateway (Kong :8000, `/auth/v1`).
 *   - k8s / k8s-ha:          `kubectl port-forward` to auth (:9999, `/admin`).
 *
 * This module is the tunnel-agnostic half: given a reachable base URL it
 * polls health and upserts the admin user. Callers own the tunnel lifecycle
 * and pass the resolved URLs. Keeping the fetch logic here means the 422
 * idempotency + bearer-auth contract lives in exactly one place (and is
 * unit-tested without standing up SSH or a cluster).
 */

/**
 * The GoTrue admin-API request body for the super-admin.
 * `email_confirm: true` skips the confirmation email (the operator can log in
 * immediately); `app_metadata.role` is what the app's authz checks read.
 *
 * @param {string} adminEmail
 * @param {string} adminPassword
 */
export function adminUserBody(adminEmail, adminPassword) {
  return {
    email: adminEmail,
    password: adminPassword,
    email_confirm: true,
    app_metadata: { role: 'super_admin' },
  };
}

/**
 * Poll a forwarded GoTrue `/health` endpoint until it answers as GoTrue.
 *
 * @param {string} healthUrl - e.g. http://localhost:9999/health
 * @param {object} [opts]
 * @param {number} [opts.attempts=15]
 * @param {number} [opts.intervalMs=1000]
 * @param {typeof fetch} [opts.fetchImpl=fetch]
 * @returns {Promise<boolean>} true once reachable, false after attempts
 */
export async function waitForGotrueHealth(
  healthUrl,
  { attempts = 15, intervalMs = 1000, fetchImpl = fetch } = {},
) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(2000) });
      // GoTrue's /health returns 200 with a body naming itself; any 2xx from
      // the forwarded port means the tunnel + service are live.
      if (res.ok) return true;
    } catch {
      // tunnel/service not up yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Upsert the super-admin via GoTrue's admin API. Idempotent: a 422 means the
 * user already exists, which we treat as success so re-deploys are clean.
 *
 * @param {object} args
 * @param {string} args.adminUsersUrl - e.g. http://localhost:9999/admin/users
 * @param {string} args.serviceRoleKey - the Supabase service-role JWT
 * @param {string} args.adminEmail
 * @param {string} args.adminPassword
 * @param {typeof fetch} [args.fetchImpl=fetch]
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function postAdminUser({
  adminUsersUrl,
  serviceRoleKey,
  adminEmail,
  adminPassword,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(adminUsersUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(adminUserBody(adminEmail, adminPassword)),
    signal: AbortSignal.timeout(15000),
  });

  if (response.ok) {
    return { success: true, message: `Admin user created: ${adminEmail}` };
  }
  // 422 = "User already registered" — already provisioned on a prior deploy.
  if (response.status === 422) {
    return { success: true, message: `Admin user already exists: ${adminEmail}` };
  }
  const body = await response.text().catch(() => '');
  return {
    success: false,
    message: `GoTrue admin API returned ${response.status}: ${body.slice(0, 200)}`,
  };
}
