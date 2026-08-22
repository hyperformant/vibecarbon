import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from '@/lib/api';
import { buildSetupProgress, type SetupFlags } from '@/lib/setup-progress';

const SETUP_KEY = ['admin', 'setup-status'] as const;

/**
 * Super-admin setup progress. Fetches the runtime-detected configure/deploy
 * flags and derives the ordered checklist + completion percentage. The
 * `setBillingOptOut` mutation persists the "launching without charging" choice.
 */
export function useSetupStatus(options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: SETUP_KEY,
    queryFn: () => apiJson<SetupFlags>('/api/v1/admin/setup', {}, 'Failed to load setup status'),
    staleTime: 60_000,
    enabled: options?.enabled ?? true,
  });

  const setBillingOptOut = useMutation({
    mutationFn: (billingOptOut: boolean) =>
      apiJson(
        '/api/v1/admin/setup',
        { method: 'PATCH', body: { billingOptOut } },
        'Failed to update billing opt-out'
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SETUP_KEY }),
  });

  return {
    ...query,
    progress: query.data ? buildSetupProgress(query.data) : null,
    setBillingOptOut,
  };
}
