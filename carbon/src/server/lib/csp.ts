/** Origin of a URL, or null when it is missing or unparseable. */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Production CSP `connect-src` list.
 *
 * Production serves ONE origin: the SPA and the Hono API (auth included) both
 * live on SITE_URL, so 'self' + SITE_URL covers every first-party call.
 *
 * The S3 endpoint origin is needed because the browser PUTs uploads straight to
 * the presigned URL. The S3 client uses `forcePathStyle: true`, so presigned
 * URLs are `<endpoint>/<bucket>/<key>`, on the endpoint's own origin (never the
 * virtual-hosted `<bucket>.<host>` form).
 */
export function buildConnectSrc(opts: {
  siteUrl: string;
  s3Endpoint: string | undefined;
  plausibleOrigin: string | null;
}): string[] {
  return [
    "'self'",
    opts.siteUrl,
    'https://cloudflareinsights.com',
    'https://api.github.com',
    opts.plausibleOrigin,
    originOf(opts.s3Endpoint),
  ].filter(Boolean) as string[];
}
