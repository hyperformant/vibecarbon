import { afterEach, describe, expect, it, vi } from 'vitest';

// env.ts validates process.env at import time and would call process.exit on
// failure, so we always supply the required vars and only vary the booleans.
const REQUIRED = {
  SUPABASE_URL: 'http://supabase.test',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  NODE_ENV: 'test',
};

const TOUCHED = [
  ...Object.keys(REQUIRED),
  'GOOGLE_ENABLED',
  'MAGIC_LINK_ENABLED',
];

const saved: Record<string, string | undefined> = {};

async function loadEnv(overrides: Record<string, string | undefined>) {
  for (const k of TOUCHED) saved[k] = process.env[k];
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...REQUIRED, ...overrides })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import('@server/lib/env');
  return mod.env;
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('env boolean parsing', () => {
  it('SECURITY: parses the literal "false" as false (z.coerce.boolean did NOT)', async () => {
    const env = await loadEnv({ GOOGLE_ENABLED: 'false' });
    expect(env.GOOGLE_ENABLED).toBe(false);
  });

  it('parses "true" as true', async () => {
    const env = await loadEnv({ GOOGLE_ENABLED: 'true' });
    expect(env.GOOGLE_ENABLED).toBe(true);
  });

  it('applies the default (false) when unset', async () => {
    const env = await loadEnv({ GOOGLE_ENABLED: undefined });
    expect(env.GOOGLE_ENABLED).toBe(false);
  });

  it('applies the default (true) for MAGIC_LINK_ENABLED when unset', async () => {
    const env = await loadEnv({ MAGIC_LINK_ENABLED: undefined });
    expect(env.MAGIC_LINK_ENABLED).toBe(true);
  });

  it('treats any non-"true" string as false', async () => {
    const env = await loadEnv({ GOOGLE_ENABLED: '1' });
    expect(env.GOOGLE_ENABLED).toBe(false);
  });
});
