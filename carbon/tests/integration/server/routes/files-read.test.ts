import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonoVariables } from '@server/types';

const { fakeEnv } = vi.hoisted(() => ({
  fakeEnv: {} as Record<string, unknown>,
}));

vi.mock('@server/lib/env', () => ({ env: fakeEnv }));
vi.mock('@server/lib/rate-limiter', () => ({
  createRateLimiter: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));
vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { fileReadRoutes } = await import('@server/routes/v1/files');

function setS3(on: boolean) {
  fakeEnv.S3_ENDPOINT = on ? 'https://s3.example.test' : undefined;
  fakeEnv.S3_REGION = on ? 'eu-central' : undefined;
  fakeEnv.S3_BUCKET = on ? 'bucket' : undefined;
  fakeEnv.S3_ACCESS_KEY = on ? 'AKIATEST' : undefined;
  fakeEnv.S3_SECRET_KEY = on ? 'secret' : undefined;
}

function appFor(userId: string | null) {
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
    c.set('user', userId ? ({ id: userId } as any) : null);
    await next();
  });
  app.route('/api/files', fileReadRoutes);
  return app;
}

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const AVATAR = `avatars/u1/${UUID}.png`;
const PRIVATE = `private/u1/${UUID}.pdf`;

beforeEach(() => setS3(true));

describe('GET /api/files/*', () => {
  it('redirects an avatar to a presigned URL for anonymous callers', async () => {
    const res = await appFor(null).request(`/api/files/${AVATAR}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('X-Amz-Signature');
    expect(res.headers.get('location')).toContain(AVATAR);
    expect(res.headers.get('cache-control')).toBe('private, max-age=60');
  });

  it('404s a private key for anonymous callers', async () => {
    const res = await appFor(null).request(`/api/files/${PRIVATE}`);
    expect(res.status).toBe(404);
  });

  it('redirects a private key to its owner with attachment disposition', async () => {
    const res = await appFor('u1').request(`/api/files/${PRIVATE}`);
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('X-Amz-Signature');
    expect(location).toContain('response-content-disposition=attachment');
  });

  it('404s a private key for a different signed-in user', async () => {
    const res = await appFor('u2').request(`/api/files/${PRIVATE}`);
    expect(res.status).toBe(404);
  });

  it.each([
    ['dot-dot segments', 'avatars/u1/../x.png'],
    ['encoded slashes', `avatars%2Fu1%2F${UUID}.png`],
    ['non-prefixed path', 'etc/passwd'],
    ['encoded dot-dot', 'avatars/u1/%2e%2e/x.png'],
  ])('404s %s', async (_name, path) => {
    const res = await appFor('u1').request(`/api/files/${path}`);
    expect(res.status).toBe(404);
  });

  it('404s when storage is unconfigured', async () => {
    setS3(false);
    const res = await appFor(null).request(`/api/files/${AVATAR}`);
    expect(res.status).toBe(404);
  });
});
