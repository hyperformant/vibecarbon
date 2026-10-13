import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit is a schema tool here, not a migration runner. The SQL files in
// supabase/migrations/ stay the source of truth (`npm run db:migrate` applies
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

const offset = Number.parseInt(process.env.DEV_PORT_OFFSET || '0', 10);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  schemaFilter: ['public'],
  dbCredentials: {
    host: process.env.DB_HOST ?? 'localhost',
    // Same rule as src/server/lib/env.ts: an explicit DEV_DB_PORT wins, else
    // the base port shifted by DEV_PORT_OFFSET (how docker-up.js maps it).
    port: Number(process.env.DEV_DB_PORT || Number(process.env.DB_PORT || 5432) + offset),
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? 'postgres',
    ssl: false,
  },
});
