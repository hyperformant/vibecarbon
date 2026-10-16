import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { adminDb } from '@server/db/client';
import { appSettings, crawlerHits, crawlerHitsDaily } from '@server/db/schema';
import type { HonoVariables } from '@server/types';
import {
  cleanupTestData,
  connectTestDb,
  createOrgWithOwner,
  createTestUser,
  dbTestsEnabled,
} from './_helpers';

/**
 * The Drizzle-backed settings, theme, setup, crawler, and stats paths against
 * a real database: the queries the unit tests can only mock.
 */
describe.skipIf(!dbTestsEnabled)('settings, theme, setup, crawlers, stats on Postgres', () => {
  let seed: pg.Client;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  /** app_settings keys this suite touched, restored in afterAll. */
  const originals = new Map<string, { value: unknown } | null>();

  async function snapshotSetting(key: string) {
    if (originals.has(key)) return;
    const [row] = await adminDb
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key));
    originals.set(key, row ?? null);
  }

  function superAdminApp(mount: (app: Hono<{ Variables: HonoVariables }>) => void) {
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use('*', async (c, next) => {
      // biome-ignore lint/suspicious/noExplicitAny: minimal injected super admin
      c.set('user', { id: userIds[0], role: 'super_admin' } as any);
      // An aal2 session: super-admin routes need a verified second factor
      // while MFA is globally on (middleware/requireSuperAdmin.ts).
      // biome-ignore lint/suspicious/noExplicitAny: minimal injected session
      c.set('session', { id: 's1', twoFactorVerified: true } as any);
      await next();
    });
    mount(app);
    return app;
  }

  beforeAll(async () => {
    seed = await connectTestDb();
    userIds.push((await createTestUser(seed)).id);
  });

  afterAll(async () => {
    if (!seed) return;
    for (const [key, original] of originals) {
      if (original) {
        await adminDb
          .insert(appSettings)
          .values({ key, value: original.value })
          .onConflictDoUpdate({ target: appSettings.key, set: { value: original.value } });
      } else {
        await adminDb.delete(appSettings).where(eq(appSettings.key, key));
      }
    }
    await cleanupTestData(seed, { userIds, orgIds });
    await seed.end();
  });

  afterEach(async () => {
    const { __resetDocsSettingsCache } = await import('@server/lib/docs-settings');
    const { __resetMfaSettingsCache } = await import('@server/lib/mfa-settings');
    __resetDocsSettingsCache();
    __resetMfaSettingsCache();
  });

  it('isApiDocsEnabled and isMfaGloballyEnabled follow the stored flags', async () => {
    const { isApiDocsEnabled, __resetDocsSettingsCache } = await import('@server/lib/docs-settings');
    const { isMfaGloballyEnabled, __resetMfaSettingsCache } = await import('@server/lib/mfa-settings');
    await snapshotSetting('api_docs_enabled');
    await snapshotSetting('mfa_enabled');
    // Rows are flipped, never deleted: the rls suite reads these keys in parallel.

    for (const [key, enabled] of [
      ['api_docs_enabled', false],
      ['mfa_enabled', true],
    ] as const) {
      await adminDb
        .insert(appSettings)
        .values({ key, value: { enabled } })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: { enabled } } });
    }
    __resetDocsSettingsCache();
    __resetMfaSettingsCache();
    expect(await isApiDocsEnabled()).toBe(false);
    expect(await isMfaGloballyEnabled()).toBe(true);
  });

  it('theme: PATCH upserts the row, GET serves it back', async () => {
    const { themeRoutes } = await import('@server/routes/v1/theme');
    await snapshotSetting('app_theme');
    const app = superAdminApp((a) => a.route('/theme', themeRoutes));

    for (const primary of ['#112233', '#445566']) {
      const res = await app.request('/theme', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ light: { primary } }),
      });
      expect(res.status).toBe(200);
      expect(await (await app.request('/theme')).json()).toEqual({ theme: { light: { primary } } });
    }

    const [row] = await adminDb.select().from(appSettings).where(eq(appSettings.key, 'app_theme'));
    expect(row.updatedBy).toBe(userIds[0]);
  });

  it('setup: PATCH persists the billing opt-out and GET reports it', async () => {
    const { setupRoutes } = await import('@server/routes/v1/setup');
    await snapshotSetting('billing_opt_out');
    const app = superAdminApp((a) => a.route('/setup', setupRoutes));
    await adminDb.delete(appSettings).where(eq(appSettings.key, 'billing_opt_out'));

    expect((await (await app.request('/setup')).json()).billingOptOut).toBe(false);
    for (const billingOptOut of [true, false, true]) {
      const res = await app.request('/setup', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ billingOptOut }),
      });
      expect(await res.json()).toEqual({ success: true, billingOptOut });
      expect((await (await app.request('/setup')).json()).billingOptOut).toBe(billingOptOut);
    }
  });

  it('crawler middleware stores a hit; the admin route reports raw and rolled-up traffic', async () => {
    const { crawlerTracking } = await import('@server/middleware/crawler-tracking');
    const { crawlerRoutes } = await import('@server/routes/v1/admin/crawlers');
    const marker = `vibecarbon-db-test-${randomUUID()}`;
    const userAgent = `Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot) ${marker}`;
    const rollupPath = `/db-test-${randomUUID()}`;
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);

    try {
      // The middleware's insert is fire-and-forget, so poll for the row.
      const ctx = {
        req: {
          method: 'GET',
          path: '/pricing',
          header: (n: string) => (n.toLowerCase() === 'user-agent' ? userAgent : undefined),
        },
        res: { status: 503 },
      };
      // biome-ignore lint/suspicious/noExplicitAny: minimal context double
      await crawlerTracking(ctx as any, async () => {});
      let stored: (typeof crawlerHits.$inferSelect)[] = [];
      for (let i = 0; i < 50 && stored.length === 0; i++) {
        stored = await adminDb.select().from(crawlerHits).where(eq(crawlerHits.userAgent, userAgent));
        if (stored.length === 0) await new Promise((r) => setTimeout(r, 50));
      }
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ crawler: 'GPTBot', status: 503 });

      await adminDb
        .insert(crawlerHitsDaily)
        .values({ day: tenDaysAgo, crawler: 'GPTBot', path: rollupPath, hits: 7, errors: 2 });

      const app = superAdminApp((a) => a.route('/crawlers', crawlerRoutes));
      const res = await app.request('/crawlers?days=30');
      expect(res.status).toBe(200);
      const body = await res.json();
      const rolled = body.topPaths.find((p: { path: string }) => p.path === rollupPath);
      // Other test data may crowd the top 10; when present it must be exact.
      if (rolled) expect(rolled).toMatchObject({ hits: 7, errors: 2, crawlers: ['GPTBot'] });
      const gpt = body.totals.find((t: { crawler: string }) => t.crawler === 'GPTBot');
      expect(gpt.hits).toBeGreaterThanOrEqual(8);
      expect(gpt.errors).toBeGreaterThanOrEqual(3);
      expect(body.daily).toHaveLength(30);
      expect(body.daily.find((d: { day: string }) => d.day === tenDaysAgo).hits).toBeGreaterThanOrEqual(7);
    } finally {
      await adminDb.delete(crawlerHits).where(eq(crawlerHits.userAgent, userAgent));
      await adminDb.delete(crawlerHitsDaily).where(eq(crawlerHitsDaily.path, rollupPath));
    }
  });

  it('stats: organization counts come from Postgres', async () => {
    const { statsRoutes } = await import('@server/routes/v1/stats');
    const app = superAdminApp((a) => a.route('/stats', statsRoutes));
    const before = (await (await app.request('/stats')).json()).orgs;

    const owner = await createTestUser(seed);
    userIds.push(owner.id);
    orgIds.push(await createOrgWithOwner(seed, owner));

    const after = (await (await app.request('/stats')).json()).orgs;
    expect(after.total).toBe(before.total + 1);
    expect(after.newThisMonth).toBe(before.newThisMonth + 1);
    expect(after.newLastMonth).toBe(before.newLastMonth);
  });
});
