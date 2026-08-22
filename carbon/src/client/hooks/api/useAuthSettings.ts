/**
 * useAuthSettings - Shared hook for fetching auth/app settings
 *
 * This hook demonstrates the recommended pattern for API data fetching:
 * - Uses TanStack Query for caching and request deduplication
 * - Provides consistent loading/error states
 * - Automatically shares data across components using the same hook
 *
 * Usage:
 *   const { data, isLoading, error } = useAuthSettings();
 *   const mfaEnabled = data?.settings?.mfaEnabled ?? false;
 */

import { useQuery } from '@tanstack/react-query';

export interface AuthSettings {
  settings: {
    mfaEnabled: boolean;
    userDocsEnabled: boolean;
    apiDocsEnabled: boolean;
    providers?: {
      google: boolean;
      microsoft: boolean;
      github: boolean;
      apple: boolean;
      discord: boolean;
    };
    magicLinkEnabled?: boolean;
  } | null;
}

async function fetchAuthSettings(): Promise<AuthSettings> {
  const response = await fetch('/api/v1/auth/settings');

  if (!response.ok) {
    throw new Error('Failed to fetch auth settings');
  }

  return response.json();
}

/**
 * Query key for auth settings - use this for cache invalidation
 * Example: queryClient.invalidateQueries({ queryKey: authSettingsQueryKey })
 */
export const authSettingsQueryKey = ['auth', 'settings'] as const;

/**
 * Fetch and cache auth/app settings
 *
 * Features:
 * - Caches for 5 minutes (staleTime)
 * - Dedupes concurrent requests automatically
 * - Shared across all components using this hook
 * - Refetches on window focus (can be disabled)
 *
 * @param options.enabled - Set to false to disable the query
 * @returns TanStack Query result with auth settings
 */
export function useAuthSettings(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: authSettingsQueryKey,
    queryFn: fetchAuthSettings,
    staleTime: 5 * 60 * 1000, // 5 minutes - settings don't change often
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    retry: 1, // Only retry once on failure
    enabled: options?.enabled ?? true,
  });
}

/**
 * Whether each documentation surface is enabled, with the loading flag.
 *
 * Both default to true so a slow or failed settings fetch never hides
 * documentation that is actually turned on. Consumers that render a whole
 * page (rather than a link) should branch on `isLoading` first, so a
 * disabled docs page does not flash its content before the setting lands.
 */
export function useDocsVisibility() {
  const { data, isLoading } = useAuthSettings();
  return {
    userDocsEnabled: data?.settings?.userDocsEnabled ?? true,
    apiDocsEnabled: data?.settings?.apiDocsEnabled ?? true,
    isLoading,
  };
}

/**
 * Helper to extract MFA enabled status with a default value
 */
export function useMfaRequired() {
  const { data, isLoading } = useAuthSettings();
  return {
    mfaRequired: data?.settings?.mfaEnabled ?? false,
    isLoading,
  };
}
