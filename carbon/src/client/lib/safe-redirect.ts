import type { useNavigate } from 'react-router';

/**
 * Validate a redirect URL is safe (not an open redirect).
 * Allows relative paths and absolute URLs to sibling subdomains
 * (e.g., n8n.localhost when the app is on localhost).
 */
export function getSafeRedirect(redirectParam: string | null): string {
  const fallback = '/dashboard';
  if (!redirectParam) return fallback;

  // Relative paths: must start with / and not // (protocol-relative)
  if (redirectParam.startsWith('/') && !redirectParam.startsWith('//')) {
    return redirectParam;
  }

  // Absolute URLs: allow ONLY the current host or a subdomain of it. The login
  // page is served on the app's own origin, so anchoring on
  // window.location.hostname is exact — this preserves the admin-tool
  // ForwardAuth flow (login on the apex, redirect back to the grafana./n8n.
  // subdomains) while rejecting look-alikes. The previous "last two DNS
  // labels" heuristic was an OPEN REDIRECT on multi-part public suffixes:
  // on app.example.co.uk it treated `co.uk` as the base domain, so
  // `https://evil.co.uk` matched and post-login users could be sent there.
  try {
    const url = new URL(redirectParam);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;

    const host = window.location.hostname;
    const target = url.hostname;
    if (target === host || target.endsWith(`.${host}`)) {
      return redirectParam; // same origin or a subdomain of it
    }
  } catch {
    // Invalid URL
  }

  return fallback;
}

/**
 * Navigate to redirect target — uses window.location for absolute URLs
 * (cross-subdomain) and react-router navigate for relative paths.
 */
export function performRedirect(redirect: string, navigate: ReturnType<typeof useNavigate>) {
  if (redirect.startsWith('http://') || redirect.startsWith('https://')) {
    window.location.href = redirect;
  } else {
    navigate(redirect, { replace: true });
  }
}

/**
 * True when `redirect` (already through getSafeRedirect) leaves this host:
 * a sibling admin subdomain behind ForwardAuth. Only a super admin holding
 * the ForwardAuth cookie gets through there; sending anyone else back would
 * bounce them to /login again, in a loop.
 */
export function leavesThisHost(redirect: string): boolean {
  if (!redirect.startsWith('http://') && !redirect.startsWith('https://')) return false;
  try {
    return new URL(redirect).hostname !== window.location.hostname;
  } catch {
    return false;
  }
}
