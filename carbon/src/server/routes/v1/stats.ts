import { and, count, gte, lt, type SQL, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { adminDb } from '../../db/client';
import { dbErrorForLog } from '../../db/errors';
import { organizations, user as userTable } from '../../db/schema';
import { isSuperAdmin } from '../../lib/auth';
import { logger } from '../../lib/logger';
import type { HonoVariables } from '../../types';

const statsRoutes = new Hono<{ Variables: HonoVariables }>();

type UserStats = {
  total: number;
  newThisMonth: number;
  newLastMonth: number;
  activeThisMonth: number;
  activeLastMonth: number;
  /** Sign-up times of the last six weeks, for the weekly buckets. */
  recentSignups: Date[];
};

/**
 * User counts in one aggregate query (plus the last six weeks of sign-up
 * times). "Active" reads user.last_sign_in_at: signed in within the last
 * 30 days (this month) or between 60 and 30 days ago (last month).
 * Zeros on any error, like countOrgs.
 */
async function userStats(at: {
  startOfThisMonth: Date;
  startOfLastMonth: Date;
  thirtyDaysAgo: Date;
  sixtyDaysAgo: Date;
  fortyTwoDaysAgo: Date;
}): Promise<UserStats> {
  const created = userTable.createdAt;
  const lastSignIn = userTable.lastSignInAt;
  const n = (cond: SQL) => sql<number>`(count(*) filter (where ${cond}))::int`;
  try {
    const [[counts], recent] = await Promise.all([
      adminDb
        .select({
          total: count(),
          newThisMonth: n(sql`${created} >= ${at.startOfThisMonth}`),
          newLastMonth: n(
            sql`${created} >= ${at.startOfLastMonth} and ${created} < ${at.startOfThisMonth}`
          ),
          activeThisMonth: n(sql`${lastSignIn} >= ${at.thirtyDaysAgo}`),
          activeLastMonth: n(
            sql`${lastSignIn} >= ${at.sixtyDaysAgo} and ${lastSignIn} < ${at.thirtyDaysAgo}`
          ),
        })
        .from(userTable),
      adminDb
        .select({ createdAt: created })
        .from(userTable)
        .where(gte(created, at.fortyTwoDaysAgo)),
    ]);
    return { ...counts, recentSignups: recent.map((r) => r.createdAt) };
  } catch (err) {
    logger.warn({ err: dbErrorForLog(err) }, 'Admin stats: user counts failed');
    return {
      total: 0,
      newThisMonth: 0,
      newLastMonth: 0,
      activeThisMonth: 0,
      activeLastMonth: 0,
      recentSignups: [],
    };
  }
}

/**
 * Count organizations matching an optional condition.
 * Returns 0 on any error for resilience.
 */
async function countOrgs(where?: SQL): Promise<number> {
  try {
    const [row] = await adminDb.select({ total: count() }).from(organizations).where(where);
    return row?.total ?? 0;
  } catch {
    return 0;
  }
}

// ============================================================================
// ADMIN STATS ENDPOINT (Super Admin only)
// ============================================================================

statsRoutes.get('/', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }

  const now = new Date();

  // Start of current month (UTC)
  const startOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  // Start of previous month (UTC)
  const startOfLastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  // 30 days ago and 60 days ago for active user calculations
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  // 42 days ago for weekly signups (6 weeks)
  const fortyTwoDaysAgo = new Date(now.getTime() - 42 * 24 * 60 * 60 * 1000);

  const [usersResult, totalOrgsResult, orgsNewThisMonthResult, orgsNewLastMonthResult] =
    await Promise.all([
      userStats({
        startOfThisMonth,
        startOfLastMonth,
        thirtyDaysAgo,
        sixtyDaysAgo,
        fortyTwoDaysAgo,
      }),

      // Total organizations
      countOrgs(),

      // Organizations created this month
      countOrgs(gte(organizations.createdAt, startOfThisMonth.toISOString())),

      // Organizations created last month
      countOrgs(
        and(
          gte(organizations.createdAt, startOfLastMonth.toISOString()),
          lt(organizations.createdAt, startOfThisMonth.toISOString())
        )
      ),
    ]);

  const {
    total: totalUsersResult,
    newThisMonth: newThisMonthResult,
    newLastMonth: newLastMonthResult,
    activeThisMonth: activeThisMonthResult,
    activeLastMonth: activeLastMonthResult,
    recentSignups,
  } = usersResult;

  const weeklySignupsResult = bucketIntoWeeks(recentSignups, fortyTwoDaysAgo);

  logger.debug({ userId: user.id }, 'Admin stats fetched');

  return c.json({
    users: {
      total: totalUsersResult,
      newThisMonth: newThisMonthResult,
      newLastMonth: newLastMonthResult,
      activeThisMonth: activeThisMonthResult,
      activeLastMonth: activeLastMonthResult,
      weeklySignups: weeklySignupsResult,
    },
    orgs: {
      total: totalOrgsResult,
      newThisMonth: orgsNewThisMonthResult,
      newLastMonth: orgsNewLastMonthResult,
    },
  });
});

/**
 * Bucket an array of dates into 6 weekly buckets.
 * Week 1 = oldest (starts at `from`), Week 6 = most recent.
 */
function bucketIntoWeeks(dates: Date[], from: Date): Array<{ week: string; count: number }> {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const buckets = [0, 0, 0, 0, 0, 0];

  for (const date of dates) {
    const weekIndex = Math.min(Math.floor((date.getTime() - from.getTime()) / msPerWeek), 5);
    if (weekIndex >= 0 && weekIndex <= 5) {
      buckets[weekIndex]++;
    }
  }

  return buckets.map((count, i) => ({
    week: `W${i + 1}`,
    count,
  }));
}

export { statsRoutes };
