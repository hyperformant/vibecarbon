import { useQuery } from '@tanstack/react-query';
import { apiJson } from '@/lib/api';

export interface ServiceStatus {
  name: string;
  container: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  latencyMs?: number;
  error?: string;
  /** The dashboard can restart this container in this deployment. */
  restartable?: boolean;
}

export interface ServicesStatusResponse {
  summary: {
    healthy: number;
    unhealthy: number;
    total: number;
  };
  services: ServiceStatus[];
  timestamp: string;
}

export const servicesStatusQueryKey = ['services-status'] as const;

export function fetchServicesStatus(): Promise<ServicesStatusResponse> {
  return apiJson<ServicesStatusResponse>(
    '/api/_internal/services/status',
    {},
    'Failed to fetch services status'
  );
}

/**
 * Health of every container, refreshed every 30 seconds. The admin Overview,
 * the Infrastructure page and the services panel on both read this one cache
 * entry.
 */
export function useServicesStatus() {
  return useQuery({
    queryKey: servicesStatusQueryKey,
    queryFn: fetchServicesStatus,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}
