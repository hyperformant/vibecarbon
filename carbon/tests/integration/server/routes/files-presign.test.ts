import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonoVariables } from '@server/types';
import { jsonPost } from '../../../_helpers/app';

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

const { filesRoutes } = await import('@server/routes/v1/files');

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
  app.route('/api/v1/files', filesRoutes);
  return app;
}

const URL_PATH = '/api/v1/files/presign';

beforeEach(() => setS3(true));

describe('POST /api/v1/files/presign', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await appFor(null).request(
      URL_PATH,
      jsonPost({ kind: 'avatar', contentType: 'image/png', size: 1000 })
    );
    expect(res.status).toBe(401);
  });

  it('presigns an avatar under the session user id and ignores extra body fields', async () => {
    const res = await appFor('user-1').request(
      URL_PATH,
      jsonPost({
        kind: 'avatar',
        contentType: 'image/png',
        size: 1000,
        userId: 'someone-else',
        path: '../x',
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key.startsWith('avatars/user-1/')).toBe(true);
    expect(body.fileUrl).toBe(`/api/files/${body.key}`);
    expect(body.url).toContain('X-Amz-Signature');
    expect(body.expiresIn).toBe(300);
    expect(body.headers['Content-Type']).toBe('image/png');
  });

  it('rejects svg avatars with type_not_allowed', async () => {
    const res = await appFor('user-1').request(
      URL_PATH,
      jsonPost({ kind: 'avatar', contentType: 'image/svg+xml', size: 1000 })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'type_not_allowed' });
  });

  it('rejects a 3 MB avatar with size_not_allowed', async () => {
    const res = await appFor('user-1').request(
      URL_PATH,
      jsonPost({ kind: 'avatar', contentType: 'image/png', size: 3 * 1024 * 1024 })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'size_not_allowed' });
  });

  it('rejects a body missing size with invalid_body', async () => {
    const res = await appFor('user-1').request(
      URL_PATH,
      jsonPost({ kind: 'avatar', contentType: 'image/png' })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_body' });
  });

  it('rejects non-JSON bodies with invalid_body', async () => {
    const res = await appFor('user-1').request(URL_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_body' });
  });

  it('returns 503 storage_not_configured when S3 env is unset', async () => {
    setS3(false);
    const res = await appFor('user-1').request(
      URL_PATH,
      jsonPost({ kind: 'avatar', contentType: 'image/png', size: 1000 })
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage_not_configured' });
  });
});
