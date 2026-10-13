/**
 * Where the ADMIN_EMAIL super admin stands in this process, reported as
 * `adminReady` + `adminStatus` on `GET /api/health`, which is what
 * `vibecarbon deploy` waits for before calling a deploy done.
 *
 * - `pending`: not settled yet (database unreachable or not migrated, or a
 *   transient error); the startup loop keeps trying (db/startup.ts).
 * - `ready`:   the admin exists with a password and can sign in.
 * - `skipped`: ADMIN_EMAIL / ADMIN_PASSWORD are not set. Terminal.
 * - `refused`: an account with that email exists that the operator's
 *   password does not prove ownership of (or a super admin without a
 *   password). Terminal; the app log says how to fix it.
 * - `failed`:  an error that waiting does not fix. Terminal; see the log.
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
