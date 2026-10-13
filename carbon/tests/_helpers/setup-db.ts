// Vitest setupFile for the `db` project.
//
// The server's DB module (src/server/db/client.ts) reads its connection from
// the validated env (DB_HOST, DB_PORT, ...). Point it at the same database the
// suites connect to (TEST_DB_*, see tests/db/_helpers.ts) so `adminDb` and
// `withUserDb` run against the real engine. The other server env vars only
// need plausible values to pass validation; nothing here talks to them.
const test = process.env;
const values: Record<string, string> = {
  DB_HOST: test.TEST_DB_HOST ?? 'localhost',
  DB_PORT: test.TEST_DB_PORT ?? '5432',
  DB_USER: test.TEST_DB_USER ?? 'postgres',
  DB_PASSWORD: test.TEST_DB_PASSWORD ?? 'unset',
  DB_NAME: test.TEST_DB_NAME ?? 'postgres',
  // TEST_DB_PORT is already the real port; never shift it.
  DEV_PORT_OFFSET: '0',
  SUPABASE_URL: 'http://supabase.test',
  SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  NODE_ENV: 'test',
};

for (const [key, value] of Object.entries(values)) process.env[key] = value;
delete process.env.DEV_DB_PORT;
