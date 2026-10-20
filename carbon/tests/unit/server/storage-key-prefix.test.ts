import { afterEach, describe, expect, it, vi } from 'vitest';

const fakeEnv = vi.hoisted(() => ({
  S3_ENDPOINT: 'http://localhost:8333' as string | undefined,
  S3_REGION: 'us-east-1' as string | undefined,
  S3_BUCKET: 'test-bucket' as string | undefined,
  S3_ACCESS_KEY: 'test' as string | undefined,
  S3_SECRET_KEY: 'test' as string | undefined,
  S3_KEY_PREFIX: '' as string,
}));
vi.mock('@server/lib/env', () => ({ env: fakeEnv }));

import { presignRead, presignUpload } from '@server/lib/storage';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

afterEach(() => {
  fakeEnv.S3_KEY_PREFIX = '';
});

describe('S3_KEY_PREFIX at the S3 boundary', () => {
  it('signs uploads under the prefix while the returned key stays unprefixed', async () => {
    fakeEnv.S3_KEY_PREFIX = 'prod/';
    const r = await presignUpload({
      kind: 'avatar',
      userId: 'u1',
      contentType: 'image/png',
      size: 100,
    });
    expect(r.key).toMatch(/^avatars\//);
    expect(new URL(r.url).pathname).toContain('/test-bucket/prod/avatars/');
  });

  it('signs reads under the prefix', async () => {
    fakeEnv.S3_KEY_PREFIX = 'prod/';
    const url = await presignRead(`avatars/u1/${UUID}.png`);
    expect(new URL(url).pathname).toContain('/test-bucket/prod/avatars/');
  });

  it('adds nothing with an empty prefix', async () => {
    const url = await presignRead(`avatars/u1/${UUID}.png`);
    expect(new URL(url).pathname).toBe(`/test-bucket/avatars/u1/${UUID}.png`);
  });
});

describe('S3_KEY_PREFIX env validation', () => {
  const REQUIRED = {
    BETTER_AUTH_SECRET: 'test-auth-secret-at-least-32-characters-long',
    SITE_URL: 'http://app.test',
    NODE_ENV: 'test',
    DB_HOST: 'db.internal',
    DB_PASSWORD: 'pw',
  };
  const saved: Record<string, string | undefined> = {};

  async function loadEnv(prefix: string | undefined) {
    const keys = [...Object.keys(REQUIRED), 'S3_KEY_PREFIX'];
    for (const k of keys) saved[k] = process.env[k];
    vi.resetModules();
    vi.doUnmock('@server/lib/env');
    for (const [k, v] of Object.entries(REQUIRED)) process.env[k] = v;
    if (prefix === undefined) delete process.env.S3_KEY_PREFIX;
    else process.env.S3_KEY_PREFIX = prefix;
    return (await import('@server/lib/env')).env;
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it('defaults to empty and accepts <env>/', async () => {
    expect((await loadEnv(undefined)).S3_KEY_PREFIX).toBe('');
    expect((await loadEnv('prod/')).S3_KEY_PREFIX).toBe('prod/');
  });

  it.each(['../', 'prod', '/prod/', 'Prod/', 'a/b/'])('refuses %s', async (bad) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    await expect(loadEnv(bad)).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
