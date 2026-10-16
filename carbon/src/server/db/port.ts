/**
 * The Postgres port to dial, given the environment.
 *
 * `.env` carries the base DB_PORT. Locally the dev db container is published
 * the way scripts/docker-up.js maps it: an explicit DEV_DB_PORT, else the
 * base port + DEV_PORT_OFFSET. That shift applies only outside production
 * and only for a localhost DB_HOST; a deployed app reaches the db by service
 * name on its real port, so DB_PORT is returned unchanged.
 *
 * Pure (no imports, no side effects) so the server (lib/env.ts) and
 * drizzle.config.ts share one rule instead of two copies that drift.
 */
export function resolveDbPort(env: Record<string, string | undefined>): string | undefined {
  if (env.NODE_ENV === 'production') return env.DB_PORT;
  if (env.DB_HOST !== 'localhost' && env.DB_HOST !== '127.0.0.1') return env.DB_PORT;
  if (env.DEV_DB_PORT) return env.DEV_DB_PORT;
  const offset = Number.parseInt(env.DEV_PORT_OFFSET || '0', 10);
  return String(Number.parseInt(env.DB_PORT || '5432', 10) + offset);
}
