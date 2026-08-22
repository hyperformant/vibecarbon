import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonPost, mountRoute } from '../../../_helpers/app';
import { makeContactSubmission } from '../../../_helpers/factories';

// `vi.hoisted` runs before the vi.mock factories below, so the same object
// reference is shared with the mocked env module. Per-test mutations to
// `fakeEnv` are visible inside the route under test.
const { insertMock, sendEmailMock, fakeEnv } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  sendEmailMock: vi.fn().mockResolvedValue(undefined),
  fakeEnv: {
    SMTP_ADMIN_EMAIL: undefined as string | undefined,
  } as Record<string, unknown>,
}));

vi.mock('@server/lib/supabase', () => ({
  supabaseAdmin: {
    from: () => ({ insert: insertMock }),
  },
}));

// Email is fired-and-forgotten on success — stub it so tests don't try
// to open an SMTP connection.
vi.mock('@server/lib/email', () => ({
  sendEmail: sendEmailMock,
}));

// The route reads `env.SMTP_ADMIN_EMAIL` at request time. The real env
// module evaluates zod schemas at import time, so vi.stubEnv can't shift
// values after the fact — mock the module instead with a mutable object.
vi.mock('@server/lib/env', () => ({
  env: fakeEnv,
}));

// The route file's `createRateLimiter` returns a Hono middleware. The
// real implementation builds an in-memory rate-limit store on a 60s
// setInterval — replace with a pass-through so the timer never starts.
vi.mock('@server/lib/rate-limiter', () => ({
  createRateLimiter: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { contactRoutes } = await import('@server/routes/v1/contact');
const app = mountRoute('/api/v1/contact', contactRoutes);

beforeEach(() => {
  insertMock.mockReset();
  sendEmailMock.mockClear();
  fakeEnv.SMTP_ADMIN_EMAIL = undefined;
});

describe('POST /api/v1/contact/submit', () => {
  it('inserts the submission and returns 200 on the happy path', async () => {
    insertMock.mockResolvedValueOnce({ error: null });

    const payload = makeContactSubmission();
    const res = await app.request('/api/v1/contact/submit', jsonPost(payload));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledWith({
      name: payload.name,
      email: payload.email,
      subject: payload.subject,
      message: payload.message,
    });
  });

  it('returns 400 with field errors when validation fails', async () => {
    const res = await app.request(
      '/api/v1/contact/submit',
      jsonPost({ name: '', email: 'not-an-email', subject: '', message: 'short' }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Name is required');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON', async () => {
    const res = await app.request('/api/v1/contact/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid JSON body');
  });

  it('rejects bot submissions that fill the honeypot field (zod max(0))', async () => {
    // The schema's `website: z.string().max(0).optional()` is the actual
    // bot trap — anything non-empty fails validation with 400. The
    // route's defensive `if (body.website)` is dead code as the schema
    // stands; we test the live protection here.
    const res = await app.request(
      '/api/v1/contact/submit',
      jsonPost(makeContactSubmission({ website: 'http://spam.example' })),
    );

    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the insert fails', async () => {
    insertMock.mockResolvedValueOnce({ error: { message: 'db down' } });

    const res = await app.request('/api/v1/contact/submit', jsonPost(makeContactSubmission()));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTypeOf('string');
  });

  it('fires the admin notification email when SMTP_ADMIN_EMAIL is set', async () => {
    fakeEnv.SMTP_ADMIN_EMAIL = 'admin@example.test';
    insertMock.mockResolvedValueOnce({ error: null });

    const payload = makeContactSubmission({ subject: 'Bug report' });
    const res = await app.request('/api/v1/contact/submit', jsonPost(payload));

    expect(res.status).toBe(200);
    // Email is sent async — wait a tick for the .catch chain to run.
    await new Promise((r) => setTimeout(r, 0));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'admin@example.test',
        subject: expect.stringContaining('Bug report'),
        replyTo: payload.email,
      }),
    );
  });

  it('escapes HTML in the notification email body', async () => {
    fakeEnv.SMTP_ADMIN_EMAIL = 'admin@example.test';
    insertMock.mockResolvedValueOnce({ error: null });

    await app.request(
      '/api/v1/contact/submit',
      jsonPost(
        makeContactSubmission({
          name: '<script>alert(1)</script>',
          message: 'hi & bye <b>bold</b>'.padEnd(20, ' '),
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));

    const html = sendEmailMock.mock.calls[0][0].html as string;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('hi &amp; bye &lt;b&gt;bold&lt;/b&gt;');
  });
});
