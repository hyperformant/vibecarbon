import {
  IconActivity as Activity,
  IconWorld as Globe,
  IconTrendingDown as TrendingDown,
  IconTrendingUp as TrendingUp,
  IconUserPlus as UserPlus,
  IconUsers as Users,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Area, AreaChart } from 'recharts';
import { PerformanceMetrics } from '@/components/admin/PerformanceMetrics';
import { ServicesStatus } from '@/components/admin/ServicesStatus';
import { SetupProgress } from '@/components/admin/SetupProgress';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { ChartContainer } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ContentPanel } from '../../components/ContentPanel';

interface StatsResponse {
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

function MiniSparkline({ data }: { data: Array<{ week: string; count: number }> }) {
  const gradientId = useId();
  return (
    <ChartContainer
      config={{ count: { label: 'Signups', color: 'var(--chart-1)' } }}
      className="h-16 w-full aspect-auto [&_.recharts-area-curve]:[filter:drop-shadow(0_0_5px_var(--glow-primary))]"
    >
      <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-count)" stopOpacity={0.25} />
            <stop offset="100%" stopColor="var(--color-count)" stopOpacity={0.03} />
          </linearGradient>
        </defs>
        <Area
          dataKey="count"
          type="monotone"
          stroke="var(--color-count)"
          strokeWidth={2}
          fill={`url(#${gradientId})`}
        />
      </AreaChart>
    </ChartContainer>
  );
}

function KpiCard({
  label,
  value,
  change,
  positive,
  icon: Icon,
  sparklineData,
  loading,
}: {
  label: string;
  value: string;
  change: string;
  positive: boolean;
  icon: React.ComponentType<{ className?: string }>;
  sparklineData?: Array<{ week: string; count: number }>;
  loading: boolean;
}) {
  return (
    <Card className="glass relative overflow-hidden">
      <CardHeader className="relative z-10 pb-1">
        <div className="flex items-center justify-between">
          <CardDescription className="text-sm font-medium tracking-wide uppercase">
            {label}
          </CardDescription>
          <div className="text-muted-foreground flex size-8 items-center justify-center rounded-md bg-muted">
            <Icon className="size-4" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="relative z-10 pb-3">
        {loading ? (
          <Skeleton className="h-9 w-24 rounded-md" />
        ) : (
          <p className="text-card-foreground font-sans text-5xl font-bold tracking-tight tabular-nums">
            {value}
          </p>
        )}
        <div className="mt-1.5">
          {loading ? (
            <Skeleton className="h-5 w-32 rounded-md" />
          ) : (
            <span
              className={cn(
                'inline-flex items-center gap-1 text-xs font-medium',
                positive ? 'text-success' : 'text-destructive'
              )}
            >
              {positive ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
              {change}
            </span>
          )}
        </div>
      </CardContent>
      {sparklineData && !loading && (
        <div className="absolute inset-x-0 bottom-0">
          <MiniSparkline data={sparklineData} />
        </div>
      )}
    </Card>
  );
}

function pctChange(now: number, prev: number): string {
  const pct = ((now - prev) / Math.max(prev, 1)) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

export default function AdminDashboard() {
  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: async () => {
      const res = await apiFetch('/api/v1/admin/stats');
      if (!res.ok) return null;
      return res.json() as Promise<StatsResponse>;
    },
  });

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
