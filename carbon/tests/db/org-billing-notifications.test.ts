import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '@server/db/client';
import {
  memberships,
  notificationDismissals,
  notifications,
  organizations,
  subscriptions,
} from '@server/db/schema';
import type { HonoVariables } from '@server/types';
import {
  addMembership,
  asUser,
  cleanupTestData,
  connectTestDb,
  createOrgWithOwner,
  createTestUser,
  dbTestsEnabled,
  type TestUser,
} from './_helpers';

const { mfa } = vi.hoisted(() => ({ mfa: { enabled: true } }));

// Billing is "configured" with a provider that needs no network: the
// subscription route then answers from the database alone.
vi.mock('@server/billing', () => ({
  isBillingConfigured: () => true,
  getBillingProvider: () => ({ type: 'paddle', getSubscription: async () => null }),
  getProviderPriceIds: () => ({ starter: 'price_starter', pro: 'price_pro' }),
}));
// The MFA toggle is app_settings state other suites flip; pin it here.
vi.mock('@server/lib/mfa-settings', () => ({
  isMfaGloballyEnabled: async () => mfa.enabled,
  __resetMfaSettingsCache: () => {},
}));
vi.mock('@server/lib/email', () => ({ sendEmail: vi.fn(async () => undefined) }));

/** The JSON form PostgREST used for timestamps, which the API keeps. */
const ISO_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?[+-]\d\d:\d\d$/;

/**
 * Org, membership, notification, and billing paths against a real database:
 * the user-scoped reads run under RLS through withUserDb, the rest through
 * adminDb, exactly as the routes run them.
 */
describe.skipIf(!dbTestsEnabled)('org, billing, and notification paths on Postgres', () => {
  let seed: pg.Client;
  const userIds: string[] = [];
  const orgIds: string[] = [];
  const notificationIds: string[] = [];

  async function user(): Promise<TestUser> {
    const u = await createTestUser(seed);
    userIds.push(u.id);
    return u;
  }

  async function org(owner: TestUser): Promise<string> {
    const id = await createOrgWithOwner(seed, owner);
    orgIds.push(id);
    return id;
  }

  /** A Hono app that serves the v1 routes as `u` with assurance level `aal`. */
  async function appAs(u: TestUser | null, aal: 'aal1' | 'aal2' = 'aal2') {
    const { v1Routes } = await import('@server/routes/v1/index');
    const { billingRoutes } = await import('@server/routes/v1/billing');
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use('*', async (c, next) => {
      // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
      c.set('user', u ? ({ id: u.id, email: u.email, name: 'DB Test', role: 'user' } as any) : null);
      // What the session middleware sets: requireAal2 reads the session row.
      // biome-ignore lint/suspicious/noExplicitAny: minimal injected session
      c.set('session', u ? ({ id: 's1', twoFactorVerified: aal === 'aal2' } as any) : null);
      await next();
    });
    app.route('/api/v1/billing', billingRoutes);
    app.route('/api/v1', v1Routes);
    return app;
  }

  function send(method: string, body?: unknown): RequestInit {
    return {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
  }

  /** An org customer with one active subscription. Returns the subscription id. */
  async function subscribeOrg(orgId: string, priceId: string): Promise<string> {
    const { rows } = await seed.query<{ id: string }>(
      `insert into public.customers (organization_id, stripe_customer_id, email)
       values ($1, $2, 'billing@example.test') returning id`,
      [orgId, `cus_${randomUUID()}`],
    );
    const sub = await seed.query<{ id: string }>(
      `insert into public.subscriptions
         (customer_id, stripe_subscription_id, stripe_price_id, status, current_period_end)
       values ($1, $2, $3, 'active', now() + interval '30 days') returning id`,
      [rows[0].id, `sub_${randomUUID()}`, priceId],
    );
    return sub.rows[0].id;
  }

  async function roleOf(orgId: string, u: TestUser): Promise<string | null> {
    const [row] = await adminDb
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, u.id)));
    return row?.role ?? null;
  }

  beforeAll(async () => {
    seed = await connectTestDb();
  });

  beforeEach(() => {
    mfa.enabled = true;
  });

  afterAll(async () => {
    if (!seed) return;
    if (notificationIds.length) {
      await adminDb.delete(notifications).where(inArray(notifications.id, notificationIds));
    }
    // Customers (and their subscriptions) cascade from their organization.
    await cleanupTestData(seed, { userIds, orgIds });
    await seed.end();
  });

  describe('billing subscription (the billing-subscription-idor scenario)', () => {
    let ownerA: TestUser;
    let orgA: string;
    let orgB: string;
    let subA: string;
    let subB: string;

    beforeAll(async () => {
      ownerA = await user();
      orgA = await org(ownerA);
      orgB = await org(await user());
      subA = await subscribeOrg(orgA, 'price_pro');
      subB = await subscribeOrg(orgB, 'price_starter');
    });

    it('an owner reads their own org subscription', async () => {
      const app = await appAs(ownerA);
      const res = await app.request(`/api/v1/billing/subscription?type=organization&organizationId=${orgA}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('active');
      expect(body.subscription.id).toBe(subA);
      expect(body.subscription.planId).toBe('pro');
      expect(body.subscription.currentPeriodEnd).toMatch(ISO_TIMESTAMP);
    });

    it('a member of org A cannot read org B subscription through the route', async () => {
      const app = await appAs(ownerA);
      const res = await app.request(`/api/v1/billing/subscription?type=organization&organizationId=${orgB}`);
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain(subB);

      // Nor by naming a type the org gate does not recognise
      const sneaky = await app.request(`/api/v1/billing/subscription?type=team&organizationId=${orgB}`);
      expect(sneaky.status).toBe(400);
    });

    it('RLS shows a member only their own org subscription and customer', async () => {
      const visible = await asUser(seed, ownerA.id, async (db) => {
        const subs = await db.query<{ id: string }>('select id from public.subscriptions');
        const custs = await db.query<{ organization_id: string }>(
          'select organization_id from public.customers',
        );
        return { subs: subs.rows.map((r) => r.id), orgs: custs.rows.map((r) => r.organization_id) };
      });
      expect(visible.subs).toContain(subA);
      expect(visible.subs).not.toContain(subB);
      expect(visible.orgs).toEqual([orgA]);
    });

    it('requirePlan counts the subscription of an org the user belongs to, not others', async () => {
      const { requirePlan } = await import('@server/middleware/requirePlan');
      const gate = (u: TestUser) => {
        const app = new Hono<{ Variables: HonoVariables }>();
        app.use('*', async (c, next) => {
          // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
          c.set('user', { id: u.id } as any);
          await next();
        });
        app.get('/pro', requirePlan('pro'), (c) => c.text('ok'));
        return app;
      };
      expect((await gate(ownerA).request('/pro')).status).toBe(200);
      const outsider = await user();
      const res = await gate(outsider).request('/pro');
      expect(res.status).toBe(403);
      expect((await res.json()).currentPlan).toBe('free');
    });

    it('the webhook upsert inserts once, then updates only the columns it is given', async () => {
      const { upsertSubscriptionRow } = await import('@server/billing/records');
      const [{ customerId }] = await adminDb
        .select({ customerId: subscriptions.customerId })
        .from(subscriptions)
        .where(eq(subscriptions.id, subA));
      const stripeSubscriptionId = `sub_${randomUUID()}`;
      await upsertSubscriptionRow({
        customerId,
        stripeSubscriptionId,
        stripePriceId: 'price_starter',
        status: 'trialing',
        currentPeriodStart: '2026-01-01T00:00:00.000Z',
      });
      await upsertSubscriptionRow({
        customerId,
        stripeSubscriptionId,
        stripePriceId: 'price_pro',
        status: 'active',
        cancelAtPeriodEnd: true,
      });
      const rows = await adminDb
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ stripePriceId: 'price_pro', status: 'active', cancelAtPeriodEnd: true });
      // Not in the second write, so left as the first one set it
      expect(Date.parse(rows[0].currentPeriodStart ?? '')).toBe(Date.parse('2026-01-01T00:00:00Z'));
    });
  });

  describe('notifications', () => {
    let alice: TestUser;
    let bob: TestUser;
    let shared: string;
    let sticky: string;
    let membersOnly: string;

    async function notify(values: Partial<typeof notifications.$inferInsert>): Promise<string> {
      const [row] = await adminDb
        .insert(notifications)
        .values({ title: `db-test ${randomUUID()}`, ...values })
        .returning({ id: notifications.id });
      notificationIds.push(row.id);
      return row.id;
    }

    async function visibleTo(u: TestUser | null): Promise<string[]> {
      const res = await (await appAs(u)).request('/api/v1/notifications');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { notifications: Array<{ id: string; createdAt: string }> };
      for (const n of body.notifications) expect(n.createdAt).toMatch(ISO_TIMESTAMP);
      return body.notifications.map((n) => n.id);
    }

    beforeAll(async () => {
      alice = await user();
      bob = await user();
      shared = await notify({ visibility: 'all', dismissible: true });
      sticky = await notify({ visibility: 'all', dismissible: false });
      membersOnly = await notify({ visibility: 'authenticated', dismissible: true });
    });

    it('dismissals are per-user', async () => {
      const app = await appAs(alice);
      const first = await app.request(`/api/v1/notifications/${shared}/dismiss`, send('POST'));
      expect(first.status).toBe(200);
      // Dismissing again is still a success (the existing row is kept)
      const again = await app.request(`/api/v1/notifications/${shared}/dismiss`, send('POST'));
      expect(await again.json()).toEqual({ success: true });

      expect(await visibleTo(alice)).not.toContain(shared);
      expect(await visibleTo(bob)).toContain(shared);

      // Bob cannot see Alice's dismissal, and Alice has exactly one
      const bobSees = await asUser(seed, bob.id, async (db) =>
        (await db.query('select 1 from public.notification_dismissals where notification_id = $1', [shared])).rowCount,
      );
      expect(bobSees).toBe(0);
      const aliceRows = await adminDb
        .select()
        .from(notificationDismissals)
        .where(eq(notificationDismissals.notificationId, shared));
      expect(aliceRows.map((r) => r.userId)).toEqual([alice.id]);
    });

    it('a signed-in user sees members-only notifications; an anonymous visitor does not', async () => {
      expect(await visibleTo(bob)).toEqual(expect.arrayContaining([shared, sticky, membersOnly]));
      const anonymous = await visibleTo(null);
      expect(anonymous).toEqual(expect.arrayContaining([shared, sticky]));
      expect(anonymous).not.toContain(membersOnly);
    });

    it('refuses to dismiss a non-dismissible notification, and 404s an unknown or malformed id', async () => {
      const app = await appAs(bob);
      expect((await app.request(`/api/v1/notifications/${sticky}/dismiss`, send('POST'))).status).toBe(400);
      expect((await app.request(`/api/v1/notifications/${randomUUID()}/dismiss`, send('POST'))).status).toBe(404);
      expect((await app.request('/api/v1/notifications/not-a-uuid/dismiss', send('POST'))).status).toBe(404);
      expect(await visibleTo(bob)).toContain(sticky);
    });
  });

  describe('organizations and memberships', () => {
    let owner: TestUser;
    let admin: TestUser;
    let member: TestUser;
    let member2: TestUser;
    let outsider: TestUser;
    let orgId: string;

    beforeAll(async () => {
      owner = await user();
      admin = await user();
      member = await user();
      member2 = await user();
      outsider = await user();
      orgId = await org(owner);
      await addMembership(seed, orgId, admin, 'ADMIN');
      await addMembership(seed, orgId, member, 'MEMBER');
      await addMembership(seed, orgId, member2, 'MEMBER');
    });

    it('a non-admin member cannot change another member role', async () => {
      const res = await (await appAs(member)).request(
        `/api/v1/organizations/${orgId}/members/${member2.id}`,
        send('PATCH', { role: 'ADMIN' }),
      );
      expect(res.status).toBe(403);
      expect(await roleOf(orgId, member2)).toBe('MEMBER');

      // RLS refuses the same write even if the route check were skipped
      const updated = await asUser(seed, member.id, async (db) =>
        (
          await db.query(
            "update public.memberships set role = 'ADMIN' where organization_id = $1 and user_id = $2",
            [orgId, member2.id],
          )
        ).rowCount,
      );
      expect(updated).toBe(0);
    });

    it('an admin can promote a member to admin; an outsider gets 404', async () => {
      const outside = await (await appAs(outsider)).request(
        `/api/v1/organizations/${orgId}/members/${member2.id}`,
        send('PATCH', { role: 'ADMIN' }),
      );
      expect(outside.status).toBe(404);

      const res = await (await appAs(admin)).request(
        `/api/v1/organizations/${orgId}/members/${member2.id}`,
        send('PATCH', { role: 'ADMIN' }),
      );
      expect(res.status).toBe(200);
      expect(await roleOf(orgId, member2)).toBe('ADMIN');
    });

    it('owner promotion still requires aal2, then transfers ownership in one step', async () => {
      const path = `/api/v1/organizations/${orgId}/members/${member.id}`;
      const blocked = await (await appAs(owner, 'aal1')).request(path, send('PATCH', { role: 'OWNER' }));
      expect(blocked.status).toBe(403);
      expect((await blocked.json()).error).toBe('mfa_required');
      expect(await roleOf(orgId, member)).toBe('MEMBER');

      const res = await (await appAs(owner, 'aal2')).request(path, send('PATCH', { role: 'OWNER' }));
      expect(res.status).toBe(200);
      expect(await roleOf(orgId, member)).toBe('OWNER');
      expect(await roleOf(orgId, owner)).toBe('ADMIN');
    });

    it('members list is visible to members only', async () => {
      const res = await (await appAs(admin)).request(`/api/v1/organizations/${orgId}/members`);
      expect(res.status).toBe(200);
      const { members } = (await res.json()) as { members: Array<{ createdAt: string }> };
      expect(members).toHaveLength(4);
      for (const m of members) expect(m.createdAt).toMatch(ISO_TIMESTAMP);

      const outside = await (await appAs(outsider)).request(`/api/v1/organizations/${orgId}/members`);
      expect(outside.status).toBe(404);
    });

    it('creating an org makes the creator its owner; the new org lists for them only', async () => {
      const creator = await user();
      const slug = `db-test-${randomUUID()}`;
      const app = await appAs(creator);
      const res = await app.request('/api/v1/organizations', send('POST', { name: 'Created', slug }));
      expect(res.status).toBe(201);
      const { organization } = await res.json();
      orgIds.push(organization.id);
      expect(organization).toMatchObject({ name: 'Created', slug, plan: 'FREE' });
      expect(organization.created_at).toMatch(ISO_TIMESTAMP);
      expect(await roleOf(organization.id, creator)).toBe('OWNER');

      const listed = await (await app.request('/api/v1/organizations')).json();
      expect(listed.organizations.map((o: { id: string }) => o.id)).toEqual([organization.id]);
      const other = await (await (await appAs(outsider)).request('/api/v1/organizations')).json();
      expect(other.organizations.map((o: { id: string }) => o.id)).not.toContain(organization.id);

      // A taken slug is a 400 and leaves no ownerless org behind
      const dup = await app.request('/api/v1/organizations', send('POST', { name: 'Dup', slug }));
      expect(dup.status).toBe(400);
      expect((await dup.json()).error).toBe('An organization with this slug already exists');
      const sameSlug = await adminDb.select().from(organizations).where(eq(organizations.slug, slug));
      expect(sameSlug).toHaveLength(1);
    });

    it('GET /me lists only the caller memberships, not the other members of their orgs', async () => {
      const res = await (await appAs(admin)).request('/api/v1/me');
      expect(res.status).toBe(200);
      const { memberships: mine } = (await res.json()) as {
        memberships: Array<{ role: string; organization: { id: string; created_at: string } }>;
      };
      expect(mine).toHaveLength(1);
      expect(mine[0].role).toBe('ADMIN');
      expect(mine[0].organization.id).toBe(orgId);
      expect(mine[0].organization.created_at).toMatch(ISO_TIMESTAMP);
    });
  });
});
