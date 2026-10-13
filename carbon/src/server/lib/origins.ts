/**
 * Browser origins the API answers credentialed requests from: SITE_URL, any
 * CORS_ORIGINS, and (outside production) the local Vite and API ports. CORS,
 * the CSRF origin check and Better Auth's trustedOrigins (auth/index.ts)
 * share this one list so they cannot disagree.
 *
 * Entries are exact origins, normalized with `new URL(x).origin` so a
 * trailing slash, a default port or upper-case host still matches the
 * browser's Origin header. An entry that is not an http(s) URL is refused.
 * A `*` or `?` is refused: Better Auth would read
 * it as a glob (`https://*.example.com` trusts every subdomain for auth
 * redirects) while CORS compares it literally, so the two would silently
 * disagree. The auth instance calls this at startup, so a bad value stops
 * the server with this message rather than half-working.
 *
 * Read per call from process.env, as the CORS middleware always has, so a
 * test can vary it.
 */
export function allowedOrigins(): string[] {
  const origins: string[] = [];
  if (process.env.SITE_URL) origins.push(exact('SITE_URL', process.env.SITE_URL));
  if (process.env.CORS_ORIGINS) {
    origins.push(
      ...process.env.CORS_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean)
        .map((o) => exact('CORS_ORIGINS', o))
    );
  }
  if (process.env.NODE_ENV !== 'production') {
    const portOffset = Number.parseInt(process.env.DEV_PORT_OFFSET || '0', 10);
    const vitePort = process.env.DEV_VITE_PORT || String(5173 + portOffset);
    const apiPort = process.env.DEV_API_PORT || String(3000 + portOffset);
    origins.push(`http://localhost:${vitePort}`, `http://localhost:${apiPort}`);
  }
  return origins;
}

function exact(source: string, origin: string): string {
  if (/[*?]/.test(origin)) {
    throw new Error(
      `${source} contains a wildcard origin (${origin}). List each origin exactly, ` +
        'comma-separated (for example https://app.example.com,https://admin.example.com).'
    );
  }
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    normalized = 'null';
  }
  if (normalized === 'null') {
    throw new Error(
      `${source} contains ${origin}, which is not a full origin. Write it with its scheme ` +
        '(for example https://app.example.com).'
    );
  }
  return normalized;
}
