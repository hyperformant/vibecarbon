import { logger } from './logger';
import { supabaseAdmin } from './supabase';

// Shorter TTL than the MFA gate (60s): flipping docs visibility is an
// interactive admin action, and an operator who turns the API surface off
// expects to see it gone rather than to wait out a cache.
const TTL_MS = 30_000;
let cache: { value: boolean; expiresAt: number } | null = null;

/** Test-only: clear the cached api-docs flag. */
export function __resetDocsSettingsCache(): void {
  cache = null;
}

/**
 * Whether the API documentation surface is enabled application-wide
 * (app_settings.api_docs_enabled.enabled).
 *
 * Governs the Scalar reference (/api/docs), the raw spec
 * (/api/openapi.json), and the dev-only Swagger UI (/api/swagger) as one
 * unit — the spec is what the other two render, so serving it while hiding
 * the viewers would not actually take the documentation down.
 *
 * Cached for 30s to keep the DB off these request paths. On a read failure
 * this FAILS OPEN — returns the last-known value, or true if none — because
 * the setting defaults to enabled, so failing open only restores pre-feature
 * behavior. The spec documents route shapes, never secrets, and every
 * privileged path it lists carries its own bearer-auth requirement that this
 * flag does not affect.
 */
export async function isApiDocsEnabled(): Promise<boolean> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.value;
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'api_docs_enabled')
      .maybeSingle();
    if (error) throw error;
    const value = (data?.value ?? null) as { enabled?: boolean } | null;
    // Absent row means the migration has not run yet — treat as enabled.
    const enabled = value?.enabled !== false;
    cache = { value: enabled, expiresAt: Date.now() + TTL_MS };
    return enabled;
  } catch (err) {
    logger.warn(
      { err },
      'docs-settings: failed to read app_settings.api_docs_enabled; failing open'
    );
    return cache?.value ?? true;
  }
}
