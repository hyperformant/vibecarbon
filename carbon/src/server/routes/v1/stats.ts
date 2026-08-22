import { Hono } from 'hono';
import { isSuperAdmin } from '../../lib/auth';
import { logger } from '../../lib/logger';
import { supabaseAdmin } from '../../lib/supabase';
import type { HonoVariables } from '../../types';

const statsRoutes = new Hono<{ Variables: HonoVariables }>();

/**
 * Count organizations with an optional filter applied to the query builder.
 * Returns 0 on any error for resilience.
 */
async function countOrgs(
  // biome-ignore lint/suspicious/noExplicitAny: Supabase query builder generics are too complex to type the filter callback
  filter?: (q: any) => PromiseLike<{ count: number | null; error: unknown }>
): Promise<number> {
  try {
    const base = supabaseAdmin.from('organizations').select('*', { count: 'exact', head: true });
    const result = filter ? await filter(base) : await base;
    return result.error ? 0 : (result.count ?? 0);
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

  // Fetch all user data with a single listUsers call, then derive all counts in-memory.
  // Previously this made 5 separate listUsers calls with perPage: 1000 each.
  // Now we make one call to get the total count (perPage: 1) and one call to fetch
  // all users for segmentation. For apps with many users, pagination fetches all pages.
  const [usersResult, totalOrgsResult, orgsNewThisMonthResult, orgsNewLastMonthResult] =
    await Promise.all([
      // Single listUsers call — fetch all users for date-based segmentation
      (async () => {
        try {
          // First get the total count with a lightweight call
          const countResult = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 });
          if (countResult.error) return { total: 0, users: [] };
          const total = countResult.data.total;

          // Fetch all users (paginated if needed) for segmentation
          const allUsers: typeof countResult.data.users = [];
          const pageSize = 1000;
          const totalPages = Math.ceil(total / pageSize);
          for (let page = 1; page <= totalPages; page++) {
            const pageResult = await supabaseAdmin.auth.admin.listUsers({
              page,
              perPage: pageSize,
            });
            if (pageResult.error) break;
            allUsers.push(...pageResult.data.users);
          }
          return { total, users: allUsers };
        } catch {
          return { total: 0, users: [] };
        }
      })(),

      // Total organizations
      countOrgs(),

      // Organizations created this month
      countOrgs((q) => q.gte('created_at', startOfThisMonth.toISOString())),

      // Organizations created last month
      countOrgs((q) =>
        q
          .gte('created_at', startOfLastMonth.toISOString())
          .lt('created_at', startOfThisMonth.toISOString())
      ),
    ]);

  // Derive all user stats from the single fetched dataset
  const { total: totalUsersResult, users: allUsers } = usersResult;

  const newThisMonthResult = allUsers.filter(
    (u) => new Date(u.created_at) >= startOfThisMonth
  ).length;

  const newLastMonthResult = allUsers.filter(
    (u) => new Date(u.created_at) >= startOfLastMonth && new Date(u.created_at) < startOfThisMonth
  ).length;

  const activeThisMonthResult = allUsers.filter(
    (u) => u.last_sign_in_at && new Date(u.last_sign_in_at) >= thirtyDaysAgo
  ).length;

  const activeLastMonthResult = allUsers.filter(
    (u) =>
      u.last_sign_in_at &&
      new Date(u.last_sign_in_at) >= sixtyDaysAgo &&
      new Date(u.last_sign_in_at) < thirtyDaysAgo
  ).length;

  const weeklySignupsResult = bucketIntoWeeks(
    allUsers
      .filter((u) => new Date(u.created_at) >= fortyTwoDaysAgo)
      .map((u) => new Date(u.created_at)),
    fortyTwoDaysAgo
  );

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
