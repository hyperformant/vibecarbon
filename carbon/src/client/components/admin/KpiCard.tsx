import {
  IconTrendingDown as TrendingDown,
  IconTrendingUp as TrendingUp,
} from '@tabler/icons-react';
import { type ComponentType, useId } from 'react';
import { Area, AreaChart } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { ChartContainer } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type WeeklyCount = { week: string; count: number };

function MiniSparkline({ data }: { data: WeeklyCount[] }) {
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

export interface KpiCardProps {
  label: string;
  value: string;
  icon: ComponentType<{ className?: string }>;
  loading: boolean;
  /** A change against an earlier period, shown with a trend arrow coloured by `positive`. */
  change?: string;
  positive?: boolean;
  /** A plain muted line under the value, for a card with no `change`. */
  hint?: string;
  /** Weekly counts drawn along the card's bottom edge once loaded. */
  sparklineData?: WeeklyCount[];
}

/** One headline number on an admin page: the Overview's platform KPIs and AI Visibility's crawler counts. */
export function KpiCard({
  label,
  value,
  icon: Icon,
  loading,
  change,
  positive = true,
  hint,
  sparklineData,
}: KpiCardProps) {
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
          ) : change !== undefined ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 text-xs font-medium',
                positive ? 'text-success' : 'text-destructive'
              )}
            >
              {positive ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
              {change}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs font-medium">{hint}</span>
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
