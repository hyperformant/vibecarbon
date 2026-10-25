// Vitest setupFile for the `db` project.
//
// The server's DB module (src/server/db/client.ts) reads its connection from
// the validated env (DB_HOST, DB_PORT, ...). Point it at the same database the
// suites connect to (TEST_DB_*, see tests/db/_helpers.ts) so `adminDb` and
// `withUserDb` run against the real engine, as the app's own role,
// app_service, the way the app connects: a server path that lacks a
// privilege fails here with 42501, not in production. Its password is
// TEST_APP_DB_PASSWORD, else APP_DB_PASSWORD from .env.local (the value
// `npm run db:migrate` set on the role). The suites' own seed connections
// (connectTestDb) stay the owner. The other server env vars only need
// plausible values to pass validation; nothing here talks to them.
import { readEnvFiles } from '../../scripts/lib/dotenv.js';

const test = process.env;
const values: Record<string, string> = {
  DB_HOST: test.TEST_DB_HOST ?? 'localhost',
  DB_PORT: test.TEST_DB_PORT ?? '5432',
  DB_USER: 'app_service',
  DB_PASSWORD: test.TEST_APP_DB_PASSWORD || readEnvFiles('.').APP_DB_PASSWORD || 'unset',
  DB_NAME: test.TEST_DB_NAME ?? 'postgres',
  // TEST_DB_PORT is already the real port; never shift it.
  DEV_PORT_OFFSET: '0',
  NODE_ENV: 'test',
  // Signs session cookies; any 32+ characters will do in tests.
  BETTER_AUTH_SECRET: 'test-auth-secret-at-least-32-characters-long',
  SITE_URL: 'http://app.test',
};

for (const [key, value] of Object.entries(values)) process.env[key] = value;
delete process.env.DEV_DB_PORT;
