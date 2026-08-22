import { useTranslation } from 'react-i18next';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  XAxis,
  YAxis,
} from 'recharts';
import { ContentPanel } from '../components/ContentPanel';
import { PageHeader } from '../components/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '../components/ui/chart';

// --- Data ---

const revenueData = [
  { month: 'Jan', revenue: 18400 },
  { month: 'Feb', revenue: 22100 },
  { month: 'Mar', revenue: 19800 },
  { month: 'Apr', revenue: 27500 },
  { month: 'May', revenue: 31200 },
  { month: 'Jun', revenue: 29800 },
];

const revenueConfig = {
  revenue: { label: 'Revenue', color: 'var(--chart-1)' },
} satisfies ChartConfig;

const usersData = [
  { week: 'W1', new: 120, returning: 340 },
  { week: 'W2', new: 180, returning: 390 },
  { week: 'W3', new: 150, returning: 420 },
  { week: 'W4', new: 210, returning: 460 },
  { week: 'W5', new: 190, returning: 510 },
  { week: 'W6', new: 260, returning: 530 },
];

const usersConfig = {
  new: { label: 'New Users', color: 'var(--chart-1)' },
  returning: { label: 'Returning', color: 'var(--chart-2)' },
} satisfies ChartConfig;

const mrrData = [
  { month: 'Jan', mrr: 8200 },
  { month: 'Feb', mrr: 11400 },
  { month: 'Mar', mrr: 14800 },
  { month: 'Apr', mrr: 19200 },
  { month: 'May', mrr: 24600 },
  { month: 'Jun', mrr: 31000 },
];

const mrrConfig = {
  mrr: { label: 'MRR', color: 'var(--chart-2)' },
} satisfies ChartConfig;

const planData = [
  { name: 'Free', value: 58 },
  { name: 'Startup', value: 31 },
  { name: 'Pro', value: 11 },
];

const planConfig = {
  Free: { label: 'Free', color: 'var(--chart-1)' },
  Startup: { label: 'Startup', color: 'var(--chart-2)' },
  Pro: { label: 'Pro', color: 'var(--chart-3)' },
} satisfies ChartConfig;

const featureData = [
  { feature: 'API', usage: 88 },
  { feature: 'Auth', usage: 72 },
  { feature: 'Storage', usage: 54 },
  { feature: 'Realtime', usage: 40 },
  { feature: 'Edge Fn', usage: 65 },
  { feature: 'Analytics', usage: 30 },
];

const featureConfig = {
  usage: { label: 'Usage %', color: 'var(--chart-3)' },
} satisfies ChartConfig;

const composedData = [
  { month: 'Jan', revenue: 18400, margin: 42 },
  { month: 'Feb', revenue: 22100, margin: 45 },
  { month: 'Mar', revenue: 19800, margin: 38 },
  { month: 'Apr', revenue: 27500, margin: 51 },
  { month: 'May', revenue: 31200, margin: 55 },
  { month: 'Jun', revenue: 29800, margin: 53 },
];

const composedConfig = {
  revenue: { label: 'Revenue', color: 'var(--chart-1)' },
  margin: { label: 'Margin %', color: 'var(--chart-4)' },
} satisfies ChartConfig;

// --- Sparkline configs ---

const sparkRevenueConfig = {
  revenue: { label: 'Revenue', color: 'var(--chart-1)' },
} satisfies ChartConfig;

const sparkUsersConfig = {
  new: { label: 'New Users', color: 'var(--chart-2)' },
} satisfies ChartConfig;

const sparkMrrConfig = {
  mrr: { label: 'MRR', color: 'var(--chart-3)' },
} satisfies ChartConfig;

const sparkMarginConfig = {
  margin: { label: 'Gross Margin', color: 'var(--chart-4)' },
} satisfies ChartConfig;

export default function Charts() {
  const { t } = useTranslation();

  return (
    <>
      <PageHeader title={t('charts.title')} />

      <ContentPanel variant="full">
        {/* Sparkline summary cards */}
        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          {/* Revenue Sparkline */}
          <Card className="pb-0">
            <CardHeader className="pb-2">
              <CardDescription>{t('charts.revenue')}</CardDescription>
              <CardTitle className="text-2xl font-bold">{t('charts.revenueSparkline')}</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <ChartContainer config={sparkRevenueConfig} className="h-[80px] w-full">
                <BarChart data={revenueData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                  <Bar dataKey="revenue" fill="var(--color-revenue)" radius={2} />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* New Users Sparkline */}
          <Card className="pb-0">
            <CardHeader className="pb-2">
              <CardDescription>{t('charts.newUsers')}</CardDescription>
              <CardTitle className="text-2xl font-bold">1,110</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <ChartContainer config={sparkUsersConfig} className="h-[80px] w-full">
                <LineChart data={usersData} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  <Line dataKey="new" stroke="var(--color-new)" strokeWidth={2} dot={false} />
                </LineChart>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* MRR Sparkline */}
          <Card className="pb-0">
            <CardHeader className="pb-2">
              <CardDescription>{t('charts.mrr')}</CardDescription>
              <CardTitle className="text-2xl font-bold">{t('charts.mrrSparkline')}</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <ChartContainer config={sparkMrrConfig} className="h-[80px] w-full">
                <AreaChart data={mrrData} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  <Area
                    dataKey="mrr"
                    stroke="var(--color-mrr)"
                    fill="var(--color-mrr)"
                    fillOpacity={0.15}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* Gross Margin Sparkline */}
          <Card className="pb-0">
            <CardHeader className="pb-2">
              <CardDescription>{t('charts.grossMargin')}</CardDescription>
              <CardTitle className="text-2xl font-bold">
                {t('charts.grossMarginSparkline')}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <ChartContainer config={sparkMarginConfig} className="h-[80px] w-full">
                <LineChart data={composedData} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  <Line dataKey="margin" stroke="var(--color-margin)" strokeWidth={2} dot={false} />
                </LineChart>
              </ChartContainer>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* 1. Revenue — BarChart */}
          <Card>
            <CardHeader>
              <CardTitle>{t('charts.revenue')}</CardTitle>
              <CardDescription>{t('charts.revenueDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="px-2 pb-2">
              <ChartContainer config={revenueConfig}>
                <BarChart data={revenueData} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="revenue" fill="var(--color-revenue)" radius={4} />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* 2. Active Users — LineChart */}
          <Card>
            <CardHeader>
              <CardTitle>{t('charts.activeUsers')}</CardTitle>
              <CardDescription>{t('charts.activeUsersDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="px-2 pb-2">
              <ChartContainer config={usersConfig}>
                <LineChart data={usersData} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="week" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Line dataKey="new" stroke="var(--color-new)" strokeWidth={2} dot={false} />
                  <Line
                    dataKey="returning"
                    stroke="var(--color-returning)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* 3. MRR Growth — AreaChart */}
          <Card>
            <CardHeader>
              <CardTitle>{t('charts.mrrGrowth')}</CardTitle>
              <CardDescription>{t('charts.mrrGrowthDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="px-2 pb-2">
              <ChartContainer config={mrrConfig}>
                <AreaChart data={mrrData} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Area
                    dataKey="mrr"
                    stroke="var(--color-mrr)"
                    fill="var(--color-mrr)"
                    fillOpacity={0.15}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* 4. Plan Distribution — PieChart */}
          <Card>
            <CardHeader>
              <CardTitle>{t('charts.planDistribution')}</CardTitle>
              <CardDescription>{t('charts.planDistributionDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="flex items-center justify-center px-2 pb-2">
              <ChartContainer config={planConfig} className="aspect-square max-h-[240px] w-full">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent nameKey="name" hideLabel />} />
                  <Legend content={<ChartLegendContent nameKey="name" />} />
                  <Pie
                    data={planData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                  >
                    {planData.map((entry) => (
                      <Cell key={entry.name} fill={`var(--color-${entry.name})`} />
                    ))}
                  </Pie>
                </PieChart>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* 5. Feature Usage — RadarChart */}
          <Card>
            <CardHeader>
              <CardTitle>{t('charts.featureUsage')}</CardTitle>
              <CardDescription>{t('charts.featureUsageDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="px-2 pb-2">
              <ChartContainer config={featureConfig}>
                <RadarChart data={featureData} cx="50%" cy="50%" outerRadius="70%">
                  <PolarGrid />
                  <PolarAngleAxis dataKey="feature" tick={{ fontSize: 12 }} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Radar
                    dataKey="usage"
                    stroke="var(--color-usage)"
                    fill="var(--color-usage)"
                    fillOpacity={0.25}
                    strokeWidth={2}
                  />
                </RadarChart>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* 6. Revenue & Margin — ComposedChart */}
          <Card>
            <CardHeader>
              <CardTitle>{t('charts.revenueAndMargin')}</CardTitle>
              <CardDescription>{t('charts.revenueAndMarginDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="px-2 pb-2">
              <ChartContainer config={composedConfig}>
                <ComposedChart
                  data={composedData}
                  margin={{ top: 8, right: -12, bottom: 0, left: -12 }}
                >
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} />
                  <YAxis
                    yAxisId="left"
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v}%`}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar yAxisId="left" dataKey="revenue" fill="var(--color-revenue)" radius={4} />
                  <Line
                    yAxisId="right"
                    dataKey="margin"
                    stroke="var(--color-margin)"
                    strokeWidth={2}
                    dot={false}
                  />
                </ComposedChart>
              </ChartContainer>
            </CardContent>
          </Card>
        </div>
      </ContentPanel>
    </>
  );
}
