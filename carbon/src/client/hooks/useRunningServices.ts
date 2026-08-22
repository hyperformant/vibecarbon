import { useQuery } from '@tanstack/react-query';
import { adminServices } from '@/lib/admin-services';
import { getAuthHeaders } from '@/lib/api';

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

/**
 * Fetch running services from the API.
 * Maps container names to service IDs for the admin sidebar.
 */
async function fetchRunningServices(): Promise<Set<string>> {
  try {
    const headers = await getAuthHeaders();
    const response = await fetch('/api/_internal/services/status', { headers });
    if (!response.ok) {
      return new Set();
    }
    const data: ServicesStatusResponse = await response.json();

    // Map container names to running status
    const runningContainers = new Set(
      data.services
        .filter((s) => s.status === 'healthy' || s.status === 'unknown')
        .map((s) => s.container)
    );

    return runningContainers;
  } catch {
    return new Set();
  }
}

// Map container names to admin service IDs
const containerToServiceId: Record<string, string> = {
  studio: 'database',
  traefik: 'gateway',
  grafana: 'monitoring',
  n8n: 'automation',
  metabase: 'analytics',
};

/**
 * Hook to get list of enabled admin services based on what's actually running.
 *
 * This combines:
 * 1. Services that are always enabled (core infrastructure)
 * 2. Services enabled via VITE_*_ENABLED env vars
 * 3. Services detected as running via the services-status API
 */
export function useEnabledServices() {
  const { data: runningContainers, isLoading } = useQuery({
    queryKey: ['running-services'],
    queryFn: fetchRunningServices,
    staleTime: 30 * 1000, // 30 seconds
    refetchInterval: 60 * 1000, // Refresh every minute
  });

  const enabledServices = adminServices.filter((service) => {
    // Core services are always shown
    if (service.alwaysEnabled) return true;

    // Check env var first (for production deployments)
    if (service.envFlag && import.meta.env[service.envFlag] === 'true') {
      return true;
    }

    // In development, also check if the service is actually running
    if (runningContainers) {
      // Find the container name that maps to this service ID
      const containerName = Object.entries(containerToServiceId).find(
        ([, id]) => id === service.id
      )?.[0];

      if (containerName && runningContainers.has(containerName)) {
        return true;
      }
    }

    return false;
  });

  return {
    services: enabledServices,
    isLoading,
    runningContainers: runningContainers || new Set(),
  };
}

/**
 * Check if a specific service is running
 */
export function useIsServiceRunning(serviceId: string) {
  const { services, isLoading } = useEnabledServices();
  return {
    isRunning: services.some((s) => s.id === serviceId),
    isLoading,
  };
}
