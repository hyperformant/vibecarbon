import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';
import { resolveDbPort } from './src/server/db/port';

// drizzle-kit writes the SQL migrations in db/migrations/ from
// src/server/db/schema.ts; the app applies them at startup with drizzle-orm's
// migrator (src/server/db/migrate.ts), ledger in drizzle.__drizzle_migrations.
// AGENTS.md "Changing the database schema" has the workflow:
//
//   npx drizzle-kit generate --name <slug>            # tables, indexes, policies
//   npx drizzle-kit generate --custom --name <slug>   # functions, triggers, cron
//
// `generate` needs no database. The credentials below are only for commands
// that connect (`drizzle-kit pull`, `studio`). Connection uses the same
// discrete DB_* vars as the server (no URL, so the password never needs
// URL-encoding). Node's own loader reads .env.local, the file
// `npm run dev:server` uses.
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const host = process.env.DB_HOST ?? 'localhost';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './db/migrations',
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
