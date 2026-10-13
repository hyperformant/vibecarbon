// Vitest setupFile for the `integration` project.
//
// The server modules (env, auth, email) validate required env vars at
// import time via zod. Tests don't connect to a real database or SMTP — but
// the schemas still need plausible values to pass `.url()` / `.min(1)` checks
// before `vi.mock()` swaps in the test doubles.
//
// Set them once here so individual tests stay focused on behavior.
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  // Signs session cookies; any 32+ characters will do in tests.
  BETTER_AUTH_SECRET: 'test-auth-secret-at-least-32-characters-long',
  // The dev default; routes fall back to this same value when it is unset.
  SITE_URL: 'http://localhost:5173',
  // The DB pool connects lazily, so these are never dialed: routes that touch
  // the database mock @server/db/client.
  DB_HOST: 'db.test',
  DB_PASSWORD: 'test-db-password',
};

for (const [key, value] of Object.entries(defaults)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}
