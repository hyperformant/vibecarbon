import { eq } from 'drizzle-orm';
import { adminDb } from '../db/client';
import { dbErrorForLog } from '../db/errors';
import { appSettings } from '../db/schema';
import { logger } from './logger';

const TTL_MS = 60_000;
let cache: { value: boolean; expiresAt: number } | null = null;

/** Test-only: clear the cached global-MFA flag. */
export function __resetMfaSettingsCache(): void {
  cache = null;
}

/**
 * Whether MFA is enabled application-wide (app_settings.mfa_enabled.enabled),
 * or null when it cannot be known.
 *
 * Cached for 60s to keep the aal2 gate off the per-request DB hot path. On a
 * read failure this returns the last value it read, and null when it has
 * never read one (a fresh process). Callers treat null as enabled: a gate
 * that cannot tell whether MFA is on must deny, not wave a session through.
 * A held aal2 session is always honored by the gate regardless of this value.
 */
export async function isMfaGloballyEnabled(): Promise<boolean | null> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.value;
  }
  try {
    const [row] = await adminDb
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, 'mfa_enabled'))
      .limit(1);
    const value = (row?.value ?? null) as { enabled?: boolean } | null;
    const enabled = value?.enabled === true;
    cache = { value: enabled, expiresAt: Date.now() + TTL_MS };
    return enabled;
  } catch (err) {
    logger.warn(
      { err: dbErrorForLog(err) },
      'mfa-settings: failed to read app_settings.mfa_enabled; the MFA gate treats it as enabled'
    );
    return cache?.value ?? null;
  }
}
