/**
 * Human-facing project display name, derived from (or recorded alongside) the
 * machine slug. The slug (PROJECT_NAME) stays DNS-safe for container names,
 * pooler tenant IDs, and k8s resources; the display name is what users see in
 * browser titles, the PWA manifest, legal copy, and email sender names.
 */

import { validateDisplayName } from './validators.js';

/**
 * Derive a display name from a lowercase-hyphen slug: "my-cool-app" → "My Cool App".
 */
export function titleizeSlug(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Recover the display name from a project's env vars, for projects created
 * before PROJECT_DISPLAY_NAME existed (upgrade path). Falls back to
 * titleizing the slug.
 *
 * The recorded value is re-validated even though create wrote it validated:
 * .env.local is hand-editable, and upgrade substitutes this value raw into
 * JS/JSON/HTML template sinks. An unsafe value is discarded in favor of the
 * titleized slug, whose charset is inert in every sink.
 */
export function resolveDisplayName(env) {
  const recorded = env.PROJECT_DISPLAY_NAME || env.VITE_PROJECT_DISPLAY_NAME;
  if (recorded && !validateDisplayName(recorded)) return recorded;
  return titleizeSlug(env.PROJECT_NAME || env.VITE_PROJECT_NAME || '');
}
