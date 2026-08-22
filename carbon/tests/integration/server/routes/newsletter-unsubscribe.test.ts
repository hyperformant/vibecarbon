import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountRoute } from '../../../_helpers/app';

const { maybeSingleMock, fromSpy } = vi.hoisted(() => ({
  maybeSingleMock: vi.fn(),
  fromSpy: vi.fn(),
}));

vi.mock('@server/lib/supabase', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => {
      fromSpy(...args);
      return {
        update: () => ({
          eq: () => ({
            eq: () => ({ select: () => ({ maybeSingle: maybeSingleMock }) }),
          }),
        }),
      };
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
  maybeSingleMock.mockReset();
  fromSpy.mockReset();
});

describe('GET /newsletter/unsubscribe token requirement (finding 6)', () => {
  it('SECURITY: rejects an unsubscribe with only an email (no token) and never touches the DB', async () => {
    const res = await app.request('/api/v1/newsletter/unsubscribe?email=victim@example.com');
    expect(res.status).toBe(400);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it('unsubscribes when email + matching confirmation_token are supplied', async () => {
    maybeSingleMock.mockResolvedValue({ data: { id: 'sub-1' }, error: null });
    const res = await app.request(
      '/api/v1/newsletter/unsubscribe?email=user@example.com&token=good-token'
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('newsletter=unsubscribed');
  });

  it('SECURITY: rejects a non-matching token (no row updated)', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    const res = await app.request(
      '/api/v1/newsletter/unsubscribe?email=user@example.com&token=wrong-token'
    );
    expect(res.status).toBe(400);
  });
});
