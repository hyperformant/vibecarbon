import { logger } from './logger';
import { supabaseAdmin } from './supabase';

const TTL_MS = 60_000;
let cache: { value: boolean; expiresAt: number } | null = null;

/** Test-only: clear the cached global-MFA flag. */
export function __resetMfaSettingsCache(): void {
  cache = null;
}

/**
 * Whether MFA is enabled application-wide (app_settings.mfa_enabled.enabled).
 *
 * Cached for 60s to keep the aal2 gate off the per-request DB hot path. On a
 * read failure this FAILS OPEN — returns the last-known value, or false (gate
 * inert) if none — because this control is opt-in and defaults off, so failing
 * open only restores pre-feature behavior. A held aal2 session is always
 * honored by the gate regardless of this value.
 */
export async function isMfaGloballyEnabled(): Promise<boolean> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.value;
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'mfa_enabled')
      .maybeSingle();
    if (error) throw error;
    const value = (data?.value ?? null) as { enabled?: boolean } | null;
    const enabled = value?.enabled === true;
    cache = { value: enabled, expiresAt: Date.now() + TTL_MS };
    return enabled;
  } catch (err) {
    logger.warn({ err }, 'mfa-settings: failed to read app_settings.mfa_enabled; failing open');
    return cache?.value ?? false;
  }
}
