import { useQuery } from '@tanstack/react-query';
import { apiJson } from '@/lib/api';

export interface AdminStats {
  users: {
    total: number;
    newThisMonth: number;
    newLastMonth: number;
    activeThisMonth: number;
    activeLastMonth: number;
    weeklySignups: Array<{ week: string; count: number }>;
  };
  orgs: {
    total: number;
    newThisMonth: number;
    newLastMonth: number;
  };
}

export const adminStatsQueryKey = ['admin', 'stats'] as const;

export function fetchAdminStats(): Promise<AdminStats> {
  return apiJson<AdminStats>('/api/v1/admin/stats', {}, 'Failed to fetch stats');
}

/**
 * Platform user and organization counts for the admin Overview. The KPI cards
 * and the signups chart share this one cache entry.
 *
 * @param options.refetchInterval poll while mounted (the signups chart polls
 *   every 30 seconds; the KPI cards do not poll on their own)
 */
export function useAdminStats(options?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: adminStatsQueryKey,
    queryFn: fetchAdminStats,
    refetchInterval: options?.refetchInterval,
  });
}
