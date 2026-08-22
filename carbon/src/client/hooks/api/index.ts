/**
 * API Hooks
 *
 * This directory contains TanStack Query hooks for API data fetching.
 * Use these hooks instead of raw fetch() for data that:
 * - Is displayed in the UI
 * - May be shared across multiple components
 * - Benefits from caching
 *
 * See CLAUDE.md for detailed guidance on when to use each approach.
 */

export {
  authSettingsQueryKey,
  useAuthSettings,
  useDocsVisibility,
  useMfaRequired,
} from './useAuthSettings';
export { subscriptionQueryKey, useSubscription } from './useSubscription';
