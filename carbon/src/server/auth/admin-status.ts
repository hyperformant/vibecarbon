/**
 * Whether this process has confirmed the ADMIN_EMAIL super admin exists and
 * can sign in. Set by the startup bootstrap (bootstrap-admin.ts) and reported
 * as `adminReady` on `GET /api/health`, which is what `vibecarbon deploy`
 * waits for before calling a deploy done.
 *
 * Kept dependency-free so the health route can read it without loading the
 * auth instance.
 */
let adminReady = false;

export function setAdminReady(ready: boolean): void {
  adminReady = ready;
}

export function isAdminReady(): boolean {
  return adminReady;
}
