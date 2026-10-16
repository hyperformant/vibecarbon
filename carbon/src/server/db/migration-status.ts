/**
 * Where this process's database migrations stand, reported as
 * `migrationStatus` (+ `migrationError`) on `GET /api/health`. Until it is
 * `applied` the server answers every route except /api/health with 503
 * (middleware/migrations-gate.ts), and `vibecarbon deploy` waits on it
 * together with `adminReady`.
 *
 * - `pending`: not run yet, or waiting on a condition: the database
 *   unreachable, or a standby whose ledger has not replicated yet.
 * - `applied`: every migration in db/migrations is in the ledger.
 * - `failed`:  a migration raised an error. Terminal for this boot (no
 *   retries): fix the migration, then restart the app.
 *
 * `migrationError` is non-secret on purpose (the health route is public):
 * the SQLSTATE code, never the message, which can quote data or SQL. The
 * app log has the full error.
 *
 * Kept dependency-free so the health route can read it cheaply.
 */
export type MigrationStatus = 'pending' | 'applied' | 'failed';

let status: MigrationStatus = 'pending';
let error: string | undefined;

export function setMigrationStatus(next: MigrationStatus, reason?: string): void {
  status = next;
  error = next === 'failed' ? reason : undefined;
}

export function getMigrationStatus(): MigrationStatus {
  return status;
}

export function getMigrationError(): string | undefined {
  return error;
}

export function areMigrationsApplied(): boolean {
  return status === 'applied';
}

/** The non-secret reason for a failed run: `SQLSTATE <code>` when Postgres gave one. */
export function migrationFailureReason(err: unknown): string {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return `SQLSTATE ${code}`;
    current = current.cause;
  }
  return 'migration error (see the app log)';
}
