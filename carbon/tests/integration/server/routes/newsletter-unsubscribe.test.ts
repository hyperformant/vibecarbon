import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountRoute } from '../../../_helpers/app';

const { returningMock, updateSpy } = vi.hoisted(() => ({
  returningMock: vi.fn(),
  updateSpy: vi.fn(),
}));

vi.mock('@server/db/client', () => ({
  adminDb: {
    update: (...args: unknown[]) => {
      updateSpy(...args);
      return { set: () => ({ where: () => ({ returning: returningMock }) }) };
    },
  },
}));
vi.mock('@server/lib/email', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/lib/env', () => ({ env: { SITE_URL: 'https://app.test' } }));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@server/lib/rate-limiter', () => ({
  createRateLimiter: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

const { newsletterRoutes } = await import('@server/routes/v1/newsletter');
const app = mountRoute('/api/v1/newsletter', newsletterRoutes);

beforeEach(() => {
  returningMock.mockReset();
  updateSpy.mockReset();
});

describe('GET /newsletter/unsubscribe token requirement (finding 6)', () => {
  it('SECURITY: rejects an unsubscribe with only an email (no token) and never touches the DB', async () => {
    const res = await app.request('/api/v1/newsletter/unsubscribe?email=victim@example.com');
    expect(res.status).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('unsubscribes when email + matching confirmation_token are supplied', async () => {
    returningMock.mockResolvedValue([{ id: 'sub-1' }]);
    const res = await app.request(
      '/api/v1/newsletter/unsubscribe?email=user@example.com&token=0b6f3d1e-5c1a-4a53-9a39-2f6d2b1e8c11'
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('newsletter=unsubscribed');
  });

  it('rejects a token that is not a uuid without touching the DB', async () => {
    const res = await app.request(
      '/api/v1/newsletter/unsubscribe?email=user@example.com&token=not-a-uuid'
    );
    expect(res.status).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('SECURITY: rejects a non-matching token (no row updated)', async () => {
    returningMock.mockResolvedValue([]);
    const res = await app.request(
      '/api/v1/newsletter/unsubscribe?email=user@example.com&token=7d1c8a40-3b0e-4c6e-8b3a-9a5e4f2d6c22'
    );
    expect(res.status).toBe(400);
  });
});
