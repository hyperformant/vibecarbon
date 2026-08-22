// Vitest setupFile for the `integration` project.
//
// The server modules (env, supabase, email) validate required env vars at
// import time via zod. Tests don't connect to real Supabase/SMTP — but the
// schemas still need plausible values to pass `.url()` / `.min(1)` checks
// before `vi.mock()` swaps in the test doubles.
//
// Set them once here so individual tests stay focused on behavior.
const defaults: Record<string, string> = {
  SUPABASE_URL: 'http://supabase.test',
  SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  NODE_ENV: 'test',
};

for (const [key, value] of Object.entries(defaults)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}
