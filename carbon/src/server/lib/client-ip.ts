import { env } from './env';
import { logger } from './logger';

// Minimal shape so both Hono's full `Context` and lightweight test doubles work.
type HasHeader = { req: { header: (name: string) => string | undefined } };

const ipv4Regex = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const ipv6Regex = /^[a-fA-F0-9:]+$/;

export function isValidIp(ip: string): boolean {
  return ipv4Regex.test(ip) || ipv6Regex.test(ip);
}

// Log the "no trusted IP" warning at most once per process to avoid log spam.
let warnedAboutMissingIP = false;

/**
 * Resolve the client IP from a trusted reverse proxy.
 *
 * SECURITY: `X-Forwarded-For` is an ordered list where each proxy APPENDS the
 * address of the host it received the connection from. With N trusted proxy
 * hops in front of this server (`TRUSTED_PROXY_HOPS`, default 1 = Traefik), the
 * real client IP is the Nth entry counted from the RIGHT. Every entry to the
 * left of that is attacker-supplied and MUST be ignored — trusting the leftmost
 * value (as the previous implementations did) lets a client spoof an arbitrary
 * IP and mint fresh rate-limit / login-lockout buckets at will.
 *
 * We deliberately do NOT fall back to `x-real-ip` / `cf-connecting-ip`: Traefik
 * does not set those, so an attacker could forge them. When a trusted IP can't
 * be derived we return a shared sentinel ('unknown') so those requests share a
 * single, more-restrictive bucket (fail closed).
 */
export function getClientIp(c: HasHeader, hops: number = env.TRUSTED_PROXY_HOPS): string {
  const xff = c.req.header('x-forwarded-for');

  if (xff && hops > 0) {
    const ips = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // Need at least `hops` entries for the depth-from-right index to land on a
    // proxy-written value rather than an attacker-supplied one.
    if (ips.length >= hops) {
      const candidate = ips[ips.length - hops];
      if (isValidIp(candidate)) {
        return candidate;
      }
    }
  }

  // In development there is typically no reverse proxy in front of the server.
  if (env.NODE_ENV === 'development') {
    return 'localhost';
  }

  if (!warnedAboutMissingIP) {
    warnedAboutMissingIP = true;
    logger.warn(
      'Could not determine a trusted client IP from X-Forwarded-For. Ensure the reverse ' +
        'proxy (Traefik) sets X-Forwarded-For and that TRUSTED_PROXY_HOPS matches the number ' +
        'of trusted proxies in front of this server. Requests without a trusted IP share a ' +
        'single rate-limit bucket.'
    );
  }

  return 'unknown';
}
