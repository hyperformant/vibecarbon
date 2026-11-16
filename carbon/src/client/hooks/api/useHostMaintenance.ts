import type { HostMaintenance } from '@shared/host-maintenance';
import { useQuery } from '@tanstack/react-query';
import { apiJson } from '@/lib/api';

export const hostMaintenanceQueryKey = ['admin', 'host-maintenance'] as const;

/** Restart state of the servers this app runs on (super admins only). */
export function useHostMaintenance() {
  return useQuery({
    queryKey: hostMaintenanceQueryKey,
    queryFn: () => apiJson<HostMaintenance>('/api/v1/admin/host-maintenance'),
    staleTime: 60_000,
    retry: false,
  });
}
