/**
 * Parent-domain scope for the ForwardAuth cookie, derived from SITE_URL.
 * Mirrors the client's getCookieDomain(): last two labels, so the cookie
 * rides to admin subdomains (grafana.example.com) in compose mode. Shares
 * that helper's two-label limitation on multi-part TLDs (example.co.uk
 * scopes to .co.uk) — acceptable because SITE_URL is operator-controlled.
 * localhost (and any single-label or unparseable host) is host-only.
 */
export function parentCookieDomain(siteUrl: string): string | undefined {
  try {
    const { hostname } = new URL(siteUrl);
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return undefined;
    const parts = hostname.split('.');
    if (parts.length >= 2) return `.${parts.slice(-2).join('.')}`;
    return undefined;
  } catch {
    return undefined;
  }
}
