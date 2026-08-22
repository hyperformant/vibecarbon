import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../shared/types';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  const missing = [
    !supabaseUrl ? 'VITE_SUPABASE_URL' : null,
    !supabaseAnonKey ? 'VITE_SUPABASE_ANON_KEY' : null,
  ].filter((name): name is string => name !== null);
  renderConfigError(missing);
  throw new Error('Missing Supabase environment variables');
}

// This module is evaluated before React mounts, so a bare throw leaves #root
// empty — a black page with the only clue in the console. Paint a readable
// error with plain DOM APIs first, then let the throw halt the app.
function renderConfigError(missing: string[]): void {
  if (typeof document === 'undefined') return;

  const screen = document.createElement('div');
  screen.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'background:#0a0f14;color:#e6edf3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;' +
    'padding:2rem;z-index:2147483647;text-align:left';

  const box = document.createElement('div');
  box.style.cssText = 'max-width:40rem';

  const heading = document.createElement('h1');
  heading.textContent = 'Configuration error';
  heading.style.cssText = 'font-size:1.25rem;margin:0 0 0.75rem;color:#f47067';

  const detail = document.createElement('p');
  detail.textContent =
    `This build is missing required environment variables: ${missing.join(', ')}. ` +
    'The frontend cannot start without them.';
  detail.style.cssText = 'margin:0 0 0.75rem;line-height:1.5';

  const hint = document.createElement('p');
  hint.textContent =
    'Rebuild with the variables set. Deploys inject them automatically; ' +
    'for local development, check your .env file.';
  hint.style.cssText = 'margin:0;line-height:1.5;opacity:0.7';

  box.append(heading, detail, hint);
  screen.append(box);
  document.body.append(screen);
}

/**
 * Cookie-based storage adapter for Supabase auth.
 * The session cookie is HOST-ONLY (apex): it is the SPA's session store and
 * nothing else. ForwardAuth on admin subdomains uses the separate HttpOnly
 * vc-admin-token cookie minted server-side — the session cookie is not a
 * ForwardAuth credential (spec 2026-07-24-session-cookie-split).
 */

// LEGACY CLEANUP ONLY: pre-split installs wrote the session cookie with this
// parent-domain scope (subdomain sharing for ForwardAuth). We keep computing
// it solely to expire that old cookie on every write.
function getCookieDomain(): string | null {
  const hostname = window.location.hostname;

  // For *.localhost subdomains (app.localhost, n8n.localhost, etc.)
  // Set domain to localhost for cross-subdomain cookie sharing
  if (hostname.endsWith('.localhost')) {
    return 'localhost';
  }

  // Plain localhost — set domain for subdomain sharing (grafana.localhost, n8n.localhost, etc.)
  if (hostname === 'localhost') {
    return 'localhost';
  }

  // For production domains like app.example.com, use .example.com
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    return `.${parts.slice(-2).join('.')}`;
  }

  return null;
}

const legacyCookieDomain = getCookieDomain();

/** Expire the pre-split parent-domain cookie so live installs don't keep a
 *  shadow copy of the session on every subdomain. */
function expireLegacyCookie(key: string): void {
  if (!legacyCookieDomain) return;
  document.cookie = `${key}=; path=/; domain=${legacyCookieDomain}; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

const cookieStorage = {
  getItem: (key: string): string | null => {
    const match = document.cookie.match(new RegExp(`(^| )${key}=([^;]+)`));
    return match ? decodeURIComponent(match[2]) : null;
  },
  setItem: (key: string, value: string): void => {
    // HOST-ONLY on purpose (no domain attribute): the session — refresh token
    // included — must not ride to admin subdomains where any bundled tool's
    // XSS could read it. ForwardAuth uses the HttpOnly vc-admin-token cookie
    // instead (see spec 2026-07-24-session-cookie-split).
    // Max age 7 days (Supabase handles token refresh).
    expireLegacyCookie(key);
    const secureAttr = window.location.protocol === 'https:' ? 'Secure; ' : '';
    document.cookie = `${key}=${encodeURIComponent(value)}; path=/; ${secureAttr}max-age=${60 * 60 * 24 * 7}; SameSite=Lax`;
  },
  removeItem: (key: string): void => {
    expireLegacyCookie(key);
    document.cookie = `${key}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  },
};

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    storage: cookieStorage,
    storageKey: 'sb-auth-token',
  },
});
