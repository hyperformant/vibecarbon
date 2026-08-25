import {
  IconRobot as Bot,
  IconBrain as Brain,
  IconFileText as FileText,
  IconSearch as Search,
  IconSparkles as Sparkles,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiJson } from '@/lib/api';
import { ContentPanel } from '../../components/ContentPanel';

/** Crawler classification, mirrored from the server's shared crawler registry. */
type CrawlerCategory = 'ai-training' | 'ai-search' | 'search';

interface CrawlerTotal {
  crawler: string;
  operator: string;
  category: CrawlerCategory;
  hits: number;
}

interface CrawlerDay {
  day: string;
  hits: number;
  byCategory: Record<CrawlerCategory, number>;
}

interface CrawlerTopPath {
  path: string;
  hits: number;
  crawlers: string[];
}

/** Response of `GET /api/v1/admin/crawlers`. */
export interface CrawlerStatsResponse {
  windowDays: number;
  totals: CrawlerTotal[];
  daily: CrawlerDay[];
  topPaths: CrawlerTopPath[];
}

/** Days of history requested. No sibling admin page ships a window selector yet. */
const WINDOW_DAYS = 30;

export const crawlerStatsKey = ['admin', 'crawlers', WINDOW_DAYS];

export function fetchCrawlerStats(days: number = WINDOW_DAYS): Promise<CrawlerStatsResponse> {
  return apiJson<CrawlerStatsResponse>(
    `/api/v1/admin/crawlers?days=${days}`,
    {},
    'Failed to fetch crawler activity'
  );
}

const CATEGORY_LABELS: Record<CrawlerCategory, string> = {
  'ai-search': 'AI search',
  'ai-training': 'AI training',
  search: 'Search engine',
};

const CATEGORY_BADGE: Record<CrawlerCategory, 'default' | 'secondary' | 'outline'> = {
  'ai-search': 'default',
  'ai-training': 'secondary',
  search: 'outline',
};

const dailyConfig = {
  'ai-search': { label: CATEGORY_LABELS['ai-search'], color: 'var(--chart-1)' },
  'ai-training': { label: CATEGORY_LABELS['ai-training'], color: 'var(--chart-2)' },
  search: { label: CATEGORY_LABELS.search, color: 'var(--chart-3)' },
} satisfies ChartConfig;

const CATEGORY_ORDER: CrawlerCategory[] = ['ai-search', 'ai-training', 'search'];

function CategoryBadge({ category }: { category: CrawlerCategory }) {
  return <Badge variant={CATEGORY_BADGE[category] ?? 'outline'}>{CATEGORY_LABELS[category]}</Badge>;
}

function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
  loading,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
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
            <span className="text-muted-foreground text-xs font-medium">{hint}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Short day label for the x-axis: `2026-08-24` → `Aug 24`. */
function formatDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return day;
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export default function AdminCrawlers() {
  const { data, isLoading } = useQuery<CrawlerStatsResponse>({
    queryKey: crawlerStatsKey,
    queryFn: () => fetchCrawlerStats(),
  });

  const totals = data?.totals ?? [];
  const daily = data?.daily ?? [];
  const topPaths = data?.topPaths ?? [];
  const windowDays = data?.windowDays ?? WINDOW_DAYS;

  const byCategory = CATEGORY_ORDER.reduce(
    (acc, category) => {
      acc[category] = totals
        .filter((t) => t.category === category)
        .reduce((sum, t) => sum + t.hits, 0);
      return acc;
    },
    { 'ai-search': 0, 'ai-training': 0, search: 0 } as Record<CrawlerCategory, number>
  );
  const totalHits = totals.reduce((sum, t) => sum + t.hits, 0);
  const aiHits = byCategory['ai-search'] + byCategory['ai-training'];
  const hasData = totalHits > 0;

  const chartData = daily.map((d) => ({
    day: formatDay(d.day),
    'ai-search': d.byCategory['ai-search'],
    'ai-training': d.byCategory['ai-training'],
    search: d.byCategory.search,
  }));

  const num = (n: number) => n.toLocaleString();
  const windowLabel = `Last ${windowDays} days`;

  return (
    <>
      <PageHeader
        title="AI Visibility"
        description={`AI and search crawler activity over the last ${windowDays} days`}
      />

      <ContentPanel variant="full" className="space-y-8">
        {!isLoading && !hasData ? (
          <Card>
            <CardContent className="p-0">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Bot />
                  </EmptyMedia>
                  <EmptyTitle>No crawler visits yet</EmptyTitle>
                  <EmptyDescription>
                    Visits from AI crawlers such as GPTBot, ClaudeBot, and PerplexityBot — plus
                    search engines like Googlebot and Bingbot — will appear here once they fetch a
                    page. If this stays empty, check that the site is deployed on a public domain
                    and that <code className="font-mono">robots.txt</code> still allows crawlers.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Crawler KPIs */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <KpiCard
                label="AI crawler hits"
                value={num(aiHits)}
                hint={`${windowLabel} · AI search + training`}
                icon={Bot}
                loading={isLoading}
              />
              <KpiCard
                label="AI search"
                value={num(byCategory['ai-search'])}
                hint="Answer-engine fetches (ChatGPT, Perplexity)"
                icon={Sparkles}
                loading={isLoading}
              />
              <KpiCard
                label="AI training"
                value={num(byCategory['ai-training'])}
                hint="Model-training crawlers (GPTBot, CCBot)"
                icon={Brain}
                loading={isLoading}
              />
              <KpiCard
                label="Search engines"
                value={num(byCategory.search)}
                hint="Googlebot, Bingbot, and friends"
                icon={Search}
                loading={isLoading}
              />
            </div>

            {/* Daily trend */}
            <Card>
              <CardHeader>
                <CardTitle>Crawler hits over time</CardTitle>
                <CardDescription>Document fetches per day, stacked by crawler type</CardDescription>
              </CardHeader>
              <CardContent className="px-2 pb-2">
                {isLoading ? (
                  <Skeleton className="h-[240px] w-full" />
                ) : (
                  <ChartContainer config={dailyConfig} className="h-[240px] w-full">
                    <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="day" tickLine={false} axisLine={false} minTickGap={24} />
                      <YAxis tickLine={false} axisLine={false} allowDecimals={false} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <ChartLegend content={<ChartLegendContent />} />
                      {CATEGORY_ORDER.map((category) => (
                        <Area
                          key={category}
                          dataKey={category}
                          type="monotone"
                          stackId="hits"
                          stroke={`var(--color-${category})`}
                          fill={`var(--color-${category})`}
                          fillOpacity={0.15}
                          strokeWidth={2}
                        />
                      ))}
                    </AreaChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>

            <div className="grid gap-6 lg:grid-cols-2">
              {/* Per-crawler totals */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Bot className="size-5" />
                    Crawlers
                  </CardTitle>
                  <CardDescription>Who visited, and how often</CardDescription>
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <Skeleton className="h-[200px] w-full" />
                  ) : totals.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No crawler visits in this window.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Crawler</TableHead>
                            <TableHead>Operator</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead className="text-right">Hits</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {totals.map((row) => (
                            <TableRow key={row.crawler}>
                              <TableCell className="font-medium">{row.crawler}</TableCell>
                              <TableCell className="text-muted-foreground text-sm">
                                {row.operator}
                              </TableCell>
                              <TableCell>
                                <CategoryBadge category={row.category} />
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {num(row.hits)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Most-crawled paths */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="size-5" />
                    Most-crawled pages
                  </CardTitle>
                  <CardDescription>What crawlers actually fetch from your site</CardDescription>
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <Skeleton className="h-[200px] w-full" />
                  ) : topPaths.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No crawled pages in this window.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Path</TableHead>
                            <TableHead>Crawlers</TableHead>
                            <TableHead className="text-right">Hits</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {topPaths.map((row) => (
                            <TableRow key={row.path}>
                              <TableCell className="font-mono text-xs break-all">
                                {row.path}
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-wrap gap-1">
                                  {row.crawlers.map((crawler) => (
                                    <Badge key={crawler} variant="outline" className="text-xs">
                                      {crawler}
                                    </Badge>
                                  ))}
                                </div>
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {num(row.hits)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </ContentPanel>
    </>
  );
}
