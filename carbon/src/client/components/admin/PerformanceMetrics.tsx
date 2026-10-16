import {
  IconActivity as Activity,
  IconClock as Clock,
  IconCpu as Cpu,
  IconDatabase as HardDrive,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, Bar, BarChart, Cell, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api';

interface PerformanceData {
  server: {
    uptimeSeconds: number;
    memoryMB: { rss: number; heapUsed: number; heapTotal: number };
    disk: { usedGB: number; totalGB: number; usedPercent: number } | null;
    nodeVersion: string;
    platform: string;
  };
  services: {
    healthy: number;
    total: number;
    avgLatencyMs: number;
    items: Array<{
      name: string;
      latencyMs: number;
      status: 'healthy' | 'unhealthy' | 'unknown';
    }>;
  };
}

interface StatsResponse {
  users: {
    weeklySignups: Array<{ week: string; count: number }>;
  };
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

function getLatencyColor(ms: number): string {
  if (ms < 50) return 'var(--chart-4)';
  if (ms < 200) return 'var(--chart-2)';
  return 'var(--chart-5)';
}

const latencyConfig = {
  latencyMs: { label: 'Latency', color: 'var(--chart-1)' },
} satisfies ChartConfig;

const signupsConfig = {
  count: { label: 'Signups', color: 'var(--chart-1)' },
} satisfies ChartConfig;

export function PerformanceMetrics() {
  const { data: perfData, isLoading: perfLoading } = useQuery<PerformanceData>({
    queryKey: ['admin', 'performance'],
    queryFn: async () => {
      const res = await apiFetch('/api/v1/admin/performance');
      if (!res.ok) throw new Error('Failed to fetch performance data');
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const { data: statsData, isLoading: statsLoading } = useQuery<StatsResponse>({
    queryKey: ['admin', 'stats'],
    queryFn: async () => {
      const res = await apiFetch('/api/v1/admin/stats');
      if (!res.ok) throw new Error('Failed to fetch stats');
      return res.json();
    },
    refetchInterval: 30_000,
  });

  // Only services with a measured round trip: an unhealthy probe's number is
  // its timeout, not a latency.
  const sortedServices = perfData
    ? perfData.services.items
        .filter((s) => s.status === 'healthy')
        .sort((a, b) => b.latencyMs - a.latencyMs)
    : [];
  // Fit the y-axis to the longest label (12px text, about 7px a character).
  const yAxisWidth = Math.max(48, ...sortedServices.map((s) => s.name.length * 7 + 12));

  const weeklySignups = statsData?.users?.weeklySignups ?? [];

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Clock className="size-4" />
              Uptime
            </CardTitle>
          </CardHeader>
          <CardContent>
            {perfLoading ? (
              <Skeleton className="h-7 w-24" />
            ) : (
              <p className="text-2xl font-bold">
                {perfData ? formatUptime(perfData.server.uptimeSeconds) : '--'}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Activity className="size-4" />
              Avg service latency
            </CardTitle>
          </CardHeader>
          <CardContent>
            {perfLoading ? (
              <Skeleton className="h-7 w-16" />
            ) : (
              <p className="text-2xl font-bold">
                {perfData ? `${Math.round(perfData.services.avgLatencyMs)}ms` : '--'}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Cpu className="size-4" />
              App memory
            </CardTitle>
          </CardHeader>
          <CardContent>
            {perfLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              // The app process's resident memory (RSS), not the whole stack:
              // Postgres and Traefik are separate processes.
              <p className="text-2xl font-bold" title="Resident memory of the app process">
                {perfData ? (
                  <>
                    {`${perfData.server.memoryMB.rss} MB`}
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      {`${perfData.server.memoryMB.heapUsed} MB heap`}
                    </span>
                  </>
                ) : (
                  '--'
                )}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <HardDrive className="size-4" />
              Disk Used
            </CardTitle>
          </CardHeader>
          <CardContent>
            {perfLoading ? (
              <Skeleton className="h-7 w-16" />
            ) : (
              <p className="text-2xl font-bold">
                {perfData?.server.disk ? (
                  <>
                    {perfData.server.disk.usedPercent}%
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      {perfData.server.disk.usedGB} / {perfData.server.disk.totalGB} GB
                    </span>
                  </>
                ) : (
                  '--'
                )}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Service Latency Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Service Latency</CardTitle>
        </CardHeader>
        <CardContent>
          {perfLoading ? (
            <Skeleton className="h-[200px] w-full" />
          ) : sortedServices.length > 0 ? (
            <ChartContainer config={latencyConfig} className="h-[200px] w-full">
              <BarChart data={sortedServices} layout="vertical">
                <XAxis type="number" tickLine={false} axisLine={false} unit="ms" />
                <YAxis
                  type="category"
                  dataKey="name"
                  tickLine={false}
                  axisLine={false}
                  width={yAxisWidth}
                  tick={{ fontSize: 12 }}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="latencyMs" radius={4}>
                  {sortedServices.map((entry) => (
                    <Cell key={entry.name} fill={getLatencyColor(entry.latencyMs)} />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>
          ) : (
            <p className="text-sm text-muted-foreground">No service data available.</p>
          )}
        </CardContent>
      </Card>

      {/* User Growth Chart */}
      <Card>
        <CardHeader>
          <CardTitle>User Growth</CardTitle>
        </CardHeader>
        <CardContent>
          {statsLoading ? (
            <Skeleton className="h-[200px] w-full" />
          ) : weeklySignups.length > 0 ? (
            <ChartContainer config={signupsConfig} className="h-[200px] w-full">
              <AreaChart data={weeklySignups}>
                <XAxis dataKey="week" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  dataKey="count"
                  stroke="var(--color-count)"
                  fill="var(--color-count)"
                  fillOpacity={0.15}
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartContainer>
          ) : (
            <p className="text-sm text-muted-foreground">No signup data available.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
