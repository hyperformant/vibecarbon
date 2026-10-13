#!/usr/bin/env node
/**
 * Quiet database migration runner for local dev (`npm run db:migrate`).
 *
 * Applies every /migrations/*.sql (lexical order) inside the running `db`
 * compose service. The super admin is not seeded here: the app creates it at
 * startup from ADMIN_EMAIL / ADMIN_PASSWORD (src/server/auth/bootstrap-admin.ts).
 * psql runs with notices suppressed (client_min_messages=warning), command
 * tags silenced (-q), and stdout discarded (>/dev/null), so a normal
 * idempotent re-run prints ~one line per file instead of ~200. Real WARNING/ERROR text is preserved on stderr and the
 * first error aborts the run (ON_ERROR_STOP + set -e).
 */
import { spawnSync } from 'node:child_process';

/** The bash program run inside the db container. Exported for unit testing. */
export function buildMigrateScript() {
  // Single quiet psql invocation, parameterised by the shell var "$f" / a path.
  const psql = (file) =>
    `PGOPTIONS="-c client_min_messages=warning" ` +
    `psql -U postgres -d postgres -v ON_ERROR_STOP=1 --single-transaction -q -f ${file} >/dev/null`;

  return [
    'set -e',
    'for f in /migrations/*.sql; do',
    `  ${psql('"$f"')}`,
    '  echo "  ✓ $(basename "$f")"',
    'done',
  ].join('\n');
}

function main() {
  console.log('Running database migrations…');
  const res = spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'bash', '-c', buildMigrateScript()],
    { stdio: 'inherit' },
  );
  if (res.error) {
    console.error(res.error.message);
    process.exit(1);
  }
  process.exit(res.status ?? 0);
}

// Run only when invoked directly, not when imported by the test.
if (process.argv[1] && process.argv[1].endsWith('db-migrate.js')) {
  main();
}
