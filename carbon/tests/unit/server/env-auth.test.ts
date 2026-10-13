import { afterEach, describe, expect, it, vi } from 'vitest';

// env.ts validates process.env at import time and exits on failure; each
// case supplies the required vars and varies only the auth ones.
const REQUIRED = {
  BETTER_AUTH_SECRET: 'test-auth-secret-at-least-32-characters-long',
  SITE_URL: 'https://app.example.com',
  DB_HOST: 'db.test',
  DB_PASSWORD: 'pw',
  NODE_ENV: 'test',
};

const TOUCHED = [...Object.keys(REQUIRED), 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'DEV_PORT_OFFSET'];
const saved: Record<string, string | undefined> = {};

async function loadEnv(overrides: Record<string, string | undefined>) {
  for (const k of TOUCHED) saved[k] = process.env[k];
  vi.resetModules();
  for (const k of TOUCHED) delete process.env[k];
  for (const [k, v] of Object.entries({ ...REQUIRED, ...overrides })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (await import('@server/lib/env')).env;
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

function expectExit() {
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return exit;
}

describe('env: auth configuration fails closed', () => {
  it('accepts the full set', async () => {
    const env = await loadEnv({ ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'long-enough' });
    expect(env.SITE_URL).toBe('https://app.example.com');
  });

  it.each([
    ['SITE_URL missing (emailed links would follow the Host header)', { SITE_URL: undefined }],
    ['SITE_URL empty', { SITE_URL: '' }],
    ['BETTER_AUTH_SECRET missing', { BETTER_AUTH_SECRET: undefined }],
    ['BETTER_AUTH_SECRET under 32 characters', { BETTER_AUTH_SECRET: 'short' }],
    ['ADMIN_PASSWORD under 8 characters', { ADMIN_PASSWORD: 'short' }],
  ])('refuses to start: %s', async (_name, overrides) => {
    const exit = expectExit();
    await expect(loadEnv(overrides)).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
