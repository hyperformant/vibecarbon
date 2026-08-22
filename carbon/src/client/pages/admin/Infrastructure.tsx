import {
  IconActivity as Activity,
  IconAlertCircle as AlertCircle,
  IconCircleCheck as CheckCircle2,
  IconCloud as Cloud,
  IconContainer as Container,
  IconDatabase as Database,
  IconWorld as Globe,
  IconDeviceSdCard as HardDrive,
  IconLoader2 as Loader2,
  IconNetwork as Network,
  IconServer as Server,
  IconShield as Shield,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { ServicesStatus } from '@/components/admin/ServicesStatus';
import { ContentPanel } from '@/components/ContentPanel';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiJson } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ServiceStatus {
  name: string;
  container: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  latencyMs?: number;
  error?: string;
}

interface ServicesStatusResponse {
  summary: { healthy: number; unhealthy: number; total: number };
  services: ServiceStatus[];
  timestamp: string;
}

export async function fetchServicesStatus(): Promise<ServicesStatusResponse> {
  return apiJson<ServicesStatusResponse>('/api/_internal/services/status', {}, 'Failed to fetch');
}

// Service topology: layers from top (user-facing) to bottom (data)
const TOPOLOGY_LAYERS = [
  {
    name: 'Edge',
    icon: Globe,
    services: ['traefik'],
    description: 'Load balancer & reverse proxy',
  },
  {
    name: 'API Gateway',
    icon: Shield,
    services: ['kong'],
    description: 'Authentication & rate limiting',
  },
  {
    name: 'Application',
    icon: Server,
    services: ['auth', 'rest', 'realtime', 'storage', 'meta', 'studio'],
    description: 'Core Supabase services',
  },
  {
    name: 'Data',
    icon: Database,
    services: ['db', 'redis'],
    description: 'PostgreSQL & caching',
  },
  {
    name: 'Observability',
    icon: Activity,
    services: ['prometheus', 'grafana', 'loki'],
    description: 'Monitoring & logging',
  },
  {
    name: 'Tooling',
    icon: Container,
    services: ['n8n', 'metabase', 'imgproxy'],
    description: 'Automation, analytics & media',
  },
] as const;

function StatusDot({ status }: { status: 'healthy' | 'unhealthy' | 'unknown' | 'not_running' }) {
  return (
    <span
      className={cn(
        'inline-block size-2.5 rounded-full',
        status === 'healthy' && 'bg-success',
        status === 'unhealthy' && 'bg-destructive',
        status === 'unknown' && 'bg-warning',
        status === 'not_running' && 'bg-muted-foreground/30'
      )}
    />
  );
}

export default function Infrastructure() {
  const { data, isLoading } = useQuery({
    queryKey: ['services-status'],
    queryFn: fetchServicesStatus,
    refetchInterval: 30000,
    staleTime: 10000,
  });

  const serviceMap = new Map(data?.services.map((s) => [s.container, s]) ?? []);

  return (
    <>
      <PageHeader title="Infrastructure" description="Service topology and system health" />

      <ContentPanel>
        {/* Summary badges */}
        {data && (
          <div className="flex flex-wrap gap-3">
            <Badge variant="outline" className="gap-1.5 px-3 py-1.5">
              <CheckCircle2 className="size-3.5 text-success" />
              {data.summary.healthy} healthy
            </Badge>
            {data.summary.unhealthy > 0 && (
              <Badge variant="outline" className="gap-1.5 px-3 py-1.5">
                <AlertCircle className="size-3.5 text-destructive" />
                {data.summary.unhealthy} unhealthy
              </Badge>
            )}
            <Badge variant="outline" className="gap-1.5 px-3 py-1.5">
              <HardDrive className="size-3.5" />
              {data.summary.total} services
            </Badge>
          </div>
        )}

        {/* Topology */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Network className="size-5" />
              Service Topology
            </CardTitle>
            <CardDescription>Visual map of your infrastructure stack</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-3">
                {TOPOLOGY_LAYERS.map((layer, i) => {
                  const layerServices = layer.services
                    .map((name) => ({
                      name,
                      status: serviceMap.get(name),
                    }))
                    .filter((s) => s.status || layer.services.length <= 3);

                  if (layerServices.length === 0) return null;

                  return (
                    <div key={layer.name}>
                      {/* Layer */}
                      <div className="rounded-lg border p-4">
                        <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
                          <layer.icon className="size-4" />
                          <span className="font-medium">{layer.name}</span>
                          <span className="text-xs">({layer.description})</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {layerServices.map((svc) => (
                            <div
                              key={svc.name}
                              className={cn(
                                'flex items-center gap-2 rounded-md border px-3 py-2 text-sm',
                                svc.status?.status === 'healthy' &&
                                  'border-success/20 bg-success/5',
                                svc.status?.status === 'unhealthy' &&
                                  'border-destructive/20 bg-destructive/5',
                                svc.status?.status === 'unknown' &&
                                  'border-warning/20 bg-warning/5',
                                !svc.status && 'border-border/50 opacity-40'
                              )}
                            >
                              <StatusDot status={svc.status?.status ?? 'not_running'} />
                              <span className="font-medium">{svc.status?.name ?? svc.name}</span>
                              {svc.status?.latencyMs !== undefined &&
                                svc.status.status === 'healthy' && (
                                  <span className="text-xs text-muted-foreground">
                                    {svc.status.latencyMs}ms
                                  </span>
                                )}
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Connector */}
                      {i < TOPOLOGY_LAYERS.length - 1 && layerServices.length > 0 && (
                        <div className="flex justify-center py-1">
                          <div className="h-3 w-px bg-border" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Deployment info */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cloud className="size-5" />
              Deployment
            </CardTitle>
            <CardDescription>Configuration and deployment details</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              <InfoRow
                label="Environment"
                value={import.meta.env.VITE_ENVIRONMENT || import.meta.env.MODE || 'development'}
              />
              <InfoRow label="Version" value={import.meta.env.VITE_APP_VERSION || '0.1.0'} />
              <InfoRow
                label="Supabase URL"
                value={import.meta.env.VITE_SUPABASE_URL || 'Not configured'}
              />
              <InfoRow
                label="HA Mode"
                value={
                  data?.services.some((s) => s.container.includes('standby'))
                    ? 'Multi-region'
                    : 'Single region'
                }
              />
            </div>
          </CardContent>
        </Card>

        {/* Full services status (existing component) */}
        <ServicesStatus />
      </ContentPanel>
    </>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-medium truncate">{value}</p>
    </div>
  );
}
