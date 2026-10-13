import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryChain } from '../../../_helpers/drizzle-mock';
import type { HonoVariables } from '@server/types';

const { selectMock, warnMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  warnMock: vi.fn(),
}));

// The app_settings.mfa_enabled read: adminDb.select().from().where().limit(1)
vi.mock('@server/db/client', () => ({
  adminDb: { select: () => queryChain(selectMock) },
}));
vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: warnMock, debug: vi.fn() },
}));

const { requireAal2, assertAal2 } = await import('@server/middleware/requireAal2');
const { __resetMfaSettingsCache } = await import('@server/lib/mfa-settings');

type Aal = 'aal1' | 'aal2' | null;

/** What the session middleware sets for a session at this level. */
function seed(c: { set: (k: never, v: never) => void }, user: unknown, aal: Aal) {
  const set = c.set as (k: string, v: unknown) => void;
  set('user', user);
  set('session', user ? { id: 'session-1', twoFactorVerified: aal === 'aal2' } : null);
  set('aal', aal);
}

// Build a fresh app whose injector middleware seeds user + session BEFORE the
// gated route (mountRoute can't be used here — it adds no pre-route middleware).
function gatedApp(opts: { user: unknown; aal: Aal }) {
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('*', async (c, next) => {
    seed(c, opts.user, opts.aal);
    await next();
  });
  app.delete('/gated', requireAal2, (c) => c.json({ ok: true }));
  return app;
}

const aUser = { id: 'user-1', email: 'u@test.com' };

function enableMfa() {
  selectMock.mockResolvedValue([{ value: { enabled: true } }]);
}
function disableMfa() {
  selectMock.mockResolvedValue([{ value: { enabled: false } }]);
}

beforeEach(() => {
  __resetMfaSettingsCache();
  selectMock.mockReset();
  warnMock.mockReset();
});

describe('requireAal2', () => {
  it('passes an aal2 session through (no settings read needed)', async () => {
    const res = await gatedApp({ user: aUser, aal: 'aal2' }).request('/gated', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('blocks an aal1 session with 403 mfa_required when MFA is globally enabled', async () => {
    enableMfa();
    const res = await gatedApp({ user: aUser, aal: 'aal1' }).request('/gated', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'mfa_required',
      current_aal: 'aal1',
      aal_required: 'aal2',
      mfa_enrolled: false,
      message: 'Set up two-factor authentication to continue.',
    });
  });

  it('reports current_aal as aal1 when the session carries no aal claim', async () => {
    enableMfa();
    const res = await gatedApp({ user: aUser, aal: null }).request('/gated', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'mfa_required',
      current_aal: 'aal1',
      aal_required: 'aal2',
      mfa_enrolled: false,
      message: 'Set up two-factor authentication to continue.',
    });
  });

  it('tells an enrolled user to verify a code from this session (step-up)', async () => {
    enableMfa();
    const res = await gatedApp({ user: { ...aUser, twoFactorEnabled: true }, aal: 'aal1' }).request(
      '/gated',
      { method: 'DELETE' },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'mfa_required',
      mfa_enrolled: true,
      message: 'Confirm a code from your authenticator app to continue.',
    });
  });

  it('reads the session row, not the derived aal variable', async () => {
    enableMfa();
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use('*', async (c, next) => {
      seed(c, aUser, 'aal1');
      c.set('aal', 'aal2');
      await next();
    });
    app.delete('/gated', requireAal2, (c) => c.json({ ok: true }));
    expect((await app.request('/gated', { method: 'DELETE' })).status).toBe(403);
  });

  it('passes an aal1 session through when MFA is globally disabled (gate inert)', async () => {
    disableMfa();
    const res = await gatedApp({ user: aUser, aal: 'aal1' }).request('/gated', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 401 when there is no authenticated user', async () => {
    const res = await gatedApp({ user: null, aal: null }).request('/gated', { method: 'DELETE' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('fails open (allows) and warns when the settings read throws', async () => {
    selectMock.mockRejectedValueOnce(new Error('db down'));
    const res = await gatedApp({ user: aUser, aal: 'aal1' }).request('/gated', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('mfa-settings'),
    );
  });

  it('assertAal2 returns a 403 inline for aal1 when MFA is enabled', async () => {
    enableMfa();
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use('*', async (c, next) => {
      seed(c, aUser, 'aal1');
      await next();
    });
    app.post('/inline', async (c) => {
      const blocked = await assertAal2(c);
      if (blocked) return blocked;
      return c.json({ ok: true });
    });
    const res = await app.request('/inline', { method: 'POST' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('mfa_required');
  });
});
