import { afterEach, describe, expect, it, vi } from 'vitest';

// env.ts validates process.env at import time (process.exit on failure), so
// every case supplies the required vars and varies only the DB_* ones.
const REQUIRED = {
  BETTER_AUTH_SECRET: 'test-auth-secret-at-least-32-characters-long',
  SITE_URL: 'http://app.test',
  NODE_ENV: 'test',
  DB_HOST: 'db.internal',
  DB_PASSWORD: 'pw',
};

const TOUCHED = [
  ...Object.keys(REQUIRED),
  'DB_PORT',
  'DB_USER',
  'DB_NAME',
  'DEV_DB_PORT',
  'DEV_PORT_OFFSET',
];

const saved: Record<string, string | undefined> = {};

async function loadEnv(overrides: Record<string, string | undefined>) {
  for (const k of TOUCHED) saved[k] = process.env[k];
  vi.resetModules();
  for (const k of TOUCHED) delete process.env[k];
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
  vi.restoreAllMocks();
});

describe('env DB_* connection vars', () => {
  it('defaults DB_PORT to 5432, DB_USER to app_service and DB_NAME to postgres', async () => {
    const env = await loadEnv({});
    expect(env.DB_HOST).toBe('db.internal');
    expect(env.DB_PORT).toBe(5432);
    expect(env.DB_USER).toBe('app_service');
    expect(env.DB_NAME).toBe('postgres');
    expect(env.DB_PASSWORD).toBe('pw');
  });

  it('keeps explicit values, including a password that would need URL-encoding', async () => {
    const env = await loadEnv({
      DB_PORT: '6543',
      DB_USER: 'someone',
      DB_NAME: 'appdb',
      DB_PASSWORD: 'p@ss:w/rd#?',
    });
    expect(env.DB_PORT).toBe(6543);
    expect(env.DB_USER).toBe('someone');
    expect(env.DB_NAME).toBe('appdb');
    expect(env.DB_PASSWORD).toBe('p@ss:w/rd#?');
  });

  it.each(['DB_HOST', 'DB_PASSWORD'])('refuses to start without %s', async (key) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(loadEnv({ [key]: undefined })).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('local dev port (mirrors how docker-up.js maps the db port)', () => {
  it('shifts a localhost DB_PORT by DEV_PORT_OFFSET', async () => {
    const env = await loadEnv({ DB_HOST: 'localhost', DB_PORT: '5432', DEV_PORT_OFFSET: '10' });
    expect(env.DB_PORT).toBe(5442);
  });

  it('lets an explicit DEV_DB_PORT win over the offset', async () => {
    const env = await loadEnv({
      DB_HOST: '127.0.0.1',
      DB_PORT: '5432',
      DEV_PORT_OFFSET: '10',
      DEV_DB_PORT: '15432',
    });
    expect(env.DB_PORT).toBe(15432);
  });

  it('leaves a non-local host alone', async () => {
    const env = await loadEnv({ DB_HOST: 'db', DB_PORT: '5432', DEV_PORT_OFFSET: '10' });
    expect(env.DB_PORT).toBe(5432);
  });

  it('never shifts in production', async () => {
    const env = await loadEnv({
      NODE_ENV: 'production',
      DB_HOST: 'localhost',
      DB_PORT: '5432',
      DEV_PORT_OFFSET: '10',
      DEV_DB_PORT: '15432',
    });
    expect(env.DB_PORT).toBe(5432);
  });
});
