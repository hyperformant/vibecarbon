import {
  IconActivity as Activity,
  IconAlertCircle as AlertCircle,
  IconCircleCheck as CheckCircle2,
  IconLoader2 as Loader2,
  IconPower as Power,
  IconRefresh as RefreshCw,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { getAuthHeaders } from '@/lib/api';
import { cn } from '@/lib/utils';

const APP_VERSION = import.meta.env.VITE_APP_VERSION || '0.1.0';
// VITE_ENVIRONMENT is set during deployment (qa, staging, prod, etc.)
// Falls back to Vite's MODE for local development
const ENVIRONMENT = import.meta.env.VITE_ENVIRONMENT || import.meta.env.MODE || 'development';

interface ServiceStatus {
  name: string;
  container: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  latencyMs?: number;
  error?: string;
}

interface ServicesStatusResponse {
  summary: {
    healthy: number;
    unhealthy: number;
    total: number;
  };
  services: ServiceStatus[];
  timestamp: string;
}

async function fetchServicesStatus(): Promise<ServicesStatusResponse> {
  const headers = await getAuthHeaders();
  const response = await fetch('/api/_internal/services/status', { headers });
  if (!response.ok) {
    throw new Error('Failed to fetch services status');
  }
  return response.json();
}

async function restartService(container: string): Promise<{ success: boolean; error?: string }> {
  const headers = await getAuthHeaders();
  const response = await fetch(`/api/_internal/services/status/restart/${container}`, {
    method: 'POST',
    headers,
  });
  return response.json();
}

async function restartAllServices(): Promise<{ success: boolean }> {
  const headers = await getAuthHeaders();
  const response = await fetch('/api/_internal/services/status/restart', {
    method: 'POST',
    headers,
  });
  return response.json();
}

function StatusIcon({ status }: { status: ServiceStatus['status'] }) {
  switch (status) {
    case 'healthy':
      return <CheckCircle2 className="size-4 text-success" />;
    case 'unhealthy':
      return <AlertCircle className="size-4 text-destructive" />;
    default:
      return <Activity className="size-4 text-warning" />;
  }
}

function StatusBadge({ status }: { status: ServiceStatus['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        status === 'healthy' && 'bg-success/10 text-success',
        status === 'unhealthy' && 'bg-destructive/10 text-destructive',
        status === 'unknown' && 'bg-warning/10 text-warning'
      )}
    >
      {status}
    </span>
  );
}

export function ServicesStatus() {
  const queryClient = useQueryClient();
  const [restartingContainers, setRestartingContainers] = useState<Set<string>>(new Set());

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['services-status'],
    queryFn: fetchServicesStatus,
    refetchInterval: 30000, // Refresh every 30 seconds
    staleTime: 10000,
  });

  // Track if we're refreshing with a minimum display time
  // This ensures the spinner is visible even for very fast responses
  const [showRefreshing, setShowRefreshing] = useState(false);
  const isActuallyRefreshing = isFetching && !isLoading;

  useEffect(() => {
    if (isActuallyRefreshing) {
      setShowRefreshing(true);
    } else if (showRefreshing) {
      // Keep showing for minimum 500ms after fetch completes
      const timer = setTimeout(() => setShowRefreshing(false), 500);
      return () => clearTimeout(timer);
    }
  }, [isActuallyRefreshing, showRefreshing]);

  const isRefreshing = showRefreshing;

  const restartMutation = useMutation({
    mutationFn: restartService,
    onMutate: (container) => {
      setRestartingContainers((prev) => new Set(prev).add(container));
    },
    onSettled: (_, __, container) => {
      setRestartingContainers((prev) => {
        const next = new Set(prev);
        next.delete(container);
        return next;
      });
      // Refetch status after restart
      queryClient.invalidateQueries({ queryKey: ['services-status'] });
    },
  });

  const restartAllMutation = useMutation({
    mutationFn: restartAllServices,
    onMutate: () => {
      if (data?.services) {
        setRestartingContainers(new Set(data.services.map((s) => s.container)));
      }
    },
    onSettled: () => {
      setRestartingContainers(new Set());
      // Refetch status after restart
      queryClient.invalidateQueries({ queryKey: ['services-status'] });
    },
  });

  const handleRestart = (container: string) => {
    restartMutation.mutate(container);
  };

  const handleRestartAll = () => {
    restartAllMutation.mutate();
  };

  const isAnyRestarting = restartingContainers.size > 0 || restartAllMutation.isPending;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-5" />
            Services Status
          </CardTitle>
          <CardDescription>Loading service status...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="size-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-5" />
            Services Status
          </CardTitle>
          <CardDescription>Unable to fetch service status</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <AlertCircle className="size-8 text-destructive" />
            <p className="text-sm text-muted-foreground">
              Could not connect to the services status endpoint.
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="mr-2 size-4" />
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const { summary, services } = data;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-5" />
              Services Status
            </CardTitle>
            <CardDescription className="flex items-center gap-2">
              {summary.healthy} of {summary.total} services healthy
              {isRefreshing && (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Refreshing...
                </span>
              )}
            </CardDescription>
          </div>
          <div className="text-right text-sm">
            <p className="font-medium">{ENVIRONMENT}</p>
            <p className="text-muted-foreground">v{APP_VERSION}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {services.map((service) => {
            const isRestarting = restartingContainers.has(service.container);
            return (
              <div
                key={service.container}
                className="flex items-center justify-between rounded-lg border px-3 py-2"
              >
                <div className="flex items-center gap-3">
                  {isRestarting ? (
                    <RefreshCw className="size-4 animate-spin text-muted-foreground" />
                  ) : (
                    <StatusIcon status={service.status} />
                  )}
                  <div>
                    <p className="text-sm font-medium">{service.name}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {isRestarting ? (
                    <span className="text-xs text-muted-foreground">Restarting...</span>
                  ) : isRefreshing ? (
                    <Loader2 className="size-3 animate-spin text-muted-foreground" />
                  ) : service.latencyMs !== undefined && service.status === 'healthy' ? (
                    <span className="text-xs text-muted-foreground">{service.latencyMs}ms</span>
                  ) : service.error ? (
                    <span className="text-xs text-destructive">{service.error}</span>
                  ) : null}
                  {isRestarting ? null : <StatusBadge status={service.status} />}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={() => handleRestart(service.container)}
                    disabled={isAnyRestarting}
                    title={`Restart ${service.name}`}
                  >
                    <Power className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
      <CardFooter className="border-t pt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={handleRestartAll}
          disabled={isAnyRestarting}
          className="w-full"
        >
          {restartAllMutation.isPending ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <Power className="mr-2 size-4" />
          )}
          {restartAllMutation.isPending ? 'Restarting All Services...' : 'Restart All Services'}
        </Button>
      </CardFooter>
    </Card>
  );
}
