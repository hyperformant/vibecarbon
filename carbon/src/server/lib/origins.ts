/**
 * Browser origins the API answers credentialed requests from: SITE_URL, any
 * CORS_ORIGINS, and (outside production) the local Vite and API ports. CORS
 * and the CSRF origin check share this one list so they cannot disagree.
 *
 * Read per call from process.env, as the CORS middleware always has, so a
 * test can vary it.
 */
export function allowedOrigins(): string[] {
  const origins: string[] = [];
  if (process.env.SITE_URL) origins.push(process.env.SITE_URL);
  if (process.env.CORS_ORIGINS) {
    origins.push(
      ...process.env.CORS_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean)
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
