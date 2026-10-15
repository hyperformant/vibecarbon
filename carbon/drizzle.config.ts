import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';
import { resolveDbPort } from './src/server/db/port';

// drizzle-kit is a schema tool here, not a migration runner. The SQL files in
// db/migrations/ stay the source of truth (`npm run db:migrate` applies
// them); src/server/db/schema.ts mirrors them for typed queries, and
// tests/db/schema-drift.test.ts fails if the two disagree.
//
// Use it to introspect a migrated local database when writing a new table's
// Drizzle definition:
//
//   npx drizzle-kit pull     # writes ./drizzle/schema.ts, copy what you need
//
// Connection uses the same discrete DB_* vars as the server (no URL, so the
// password never needs URL-encoding). Node's own loader reads .env.local, the
// file `npm run dev:server` uses.
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const host = process.env.DB_HOST ?? 'localhost';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  schemaFilter: ['public'],
  dbCredentials: {
    host,
    // The server's own rule (src/server/db/port.ts): the dev port shift only
    // for a localhost host outside production, so the two cannot drift.
    port: Number(resolveDbPort({ ...process.env, DB_HOST: host }) ?? 5432),
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? 'postgres',
    ssl: false,
  },
});
