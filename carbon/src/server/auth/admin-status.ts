/**
 * Where the ADMIN_EMAIL super admin stands in this process, reported as
 * `adminReady` + `adminStatus` on `GET /api/health`, which is what
 * `vibecarbon deploy` waits for before calling a deploy done.
 *
 * - `pending`: waiting on a condition: the database unreachable, the auth
 *   tables not migrated yet, or a read-only standby without the admin row.
 *   The startup loop keeps checking (db/startup.ts).
 * - `ready`:   the admin exists with a password and can sign in.
 * - `skipped`: ADMIN_EMAIL / ADMIN_PASSWORD are not set. Terminal.
 * - `refused`: an account with that email exists that the operator's
 *   password does not prove ownership of (or a super admin without a
 *   password). Terminal; the app log says how to fix it.
 * - `failed`:  the last attempt hit an error waiting does not fix (see the
 *   log). Final for a deploy, which stops on it, but not for the app: the
 *   loop keeps retrying and moves to `ready` (or back to `pending` while it
 *   waits) once the cause is fixed.
 *
 * Only the state is exposed, never the email or the cause, since the health
 * route is public.
 *
 * Kept dependency-free so the health route can read it without loading the
 * auth instance.
 */
export type AdminStatus = 'pending' | 'ready' | 'skipped' | 'refused' | 'failed';

/** What one bootstrap attempt settled on (auth/bootstrap-admin.ts). */
export type BootstrapResult = 'skipped' | 'created' | 'promoted' | 'unchanged' | 'refused';

/** The status a settled bootstrap outcome maps to. */
export function adminStatusAfter(result: BootstrapResult): AdminStatus {
  if (result === 'created' || result === 'promoted' || result === 'unchanged') return 'ready';
  return result;
}

let status: AdminStatus = 'pending';

export function setAdminStatus(next: AdminStatus): void {
  status = next;
}

export function getAdminStatus(): AdminStatus {
  return status;
}

export function isAdminReady(): boolean {
  return status === 'ready';
}
