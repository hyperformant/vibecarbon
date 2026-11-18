import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appWithUser } from '../../../_helpers/app';
import { setFakeS3 } from '../../../_helpers/env';

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

const setS3 = (on: boolean) => setFakeS3(fakeEnv, on);
const appFor = (userId: string | null) =>
  appWithUser(userId ? { id: userId } : null, '/api/files', fileReadRoutes);

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
