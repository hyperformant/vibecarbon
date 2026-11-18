import {
  IconActivity as Activity,
  IconWorld as Globe,
  IconUserPlus as UserPlus,
  IconUsers as Users,
} from '@tabler/icons-react';
import { KpiCard } from '@/components/admin/KpiCard';
import { PerformanceMetrics } from '@/components/admin/PerformanceMetrics';
import { ServicesStatus } from '@/components/admin/ServicesStatus';
import { SetupProgress } from '@/components/admin/SetupProgress';
import { PageHeader } from '@/components/PageHeader';
import { useAdminStats } from '@/hooks/api/useAdminStats';
import { ContentPanel } from '../../components/ContentPanel';

function pctChange(now: number, prev: number): string {
  const pct = ((now - prev) / Math.max(prev, 1)) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

export default function AdminDashboard() {
  const { data: stats, isLoading: statsLoading } = useAdminStats();

  const dash = '—';

  return (
    <>
      <PageHeader title="Overview" description="Platform metrics and infrastructure status" />

      <ContentPanel variant="full" className="space-y-8">
        {/* Setup progress — configure/deploy checklist */}
        <SetupProgress />

        {/* Platform KPIs */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard
            label="Total users"
            value={stats ? stats.users.total.toLocaleString() : dash}
            change={stats ? pctChange(stats.users.newThisMonth, stats.users.newLastMonth) : dash}
            positive={stats ? stats.users.newThisMonth >= stats.users.newLastMonth : true}
            icon={Users}
            sparklineData={stats?.users.weeklySignups}
            loading={statsLoading}
          />
          <KpiCard
            label="New signups"
            value={stats ? stats.users.newThisMonth.toLocaleString() : dash}
            change={
              stats
                ? `${stats.users.newThisMonth - stats.users.newLastMonth >= 0 ? '+' : ''}${stats.users.newThisMonth - stats.users.newLastMonth} vs last month`
                : dash
            }
            positive={stats ? stats.users.newThisMonth >= stats.users.newLastMonth : true}
            icon={UserPlus}
            sparklineData={stats?.users.weeklySignups}
            loading={statsLoading}
          />
          <KpiCard
            label="Active users"
            value={stats ? stats.users.activeThisMonth.toLocaleString() : dash}
            change={
              stats
                ? `${stats.users.activeThisMonth - stats.users.activeLastMonth >= 0 ? '+' : ''}${stats.users.activeThisMonth - stats.users.activeLastMonth} vs last month`
                : dash
            }
            positive={stats ? stats.users.activeThisMonth >= stats.users.activeLastMonth : true}
            icon={Activity}
            loading={statsLoading}
          />
          <KpiCard
            label="Organizations"
            value={stats ? stats.orgs.total.toLocaleString() : dash}
            change={stats ? `${stats.orgs.newThisMonth} new this month` : dash}
            positive={true}
            icon={Globe}
            loading={statsLoading}
          />
        </div>

        {/* Infrastructure */}
        <div className="grid gap-6 lg:grid-cols-2">
          <ServicesStatus />
          <PerformanceMetrics />
        </div>
      </ContentPanel>
    </>
  );
}
