import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';
import { logger } from '../lib/logger';

const REDACTED = '[redacted]';
const TOKEN_PREFIXES = new Set(['reset-password', 'verify-email']);
const LONG_URL_SAFE = /^[A-Za-z0-9_-]{32,}$/;

/**
 * Replaces path segments that carry a secret: the one after /reset-password/
 * or /verify-email/, and any segment of 32 or more URL-safe characters.
 */
export function redactPath(pathname: string): string {
  const segments = pathname.split('/');
  return segments
    .map((seg, i) =>
      LONG_URL_SAFE.test(seg) || (i > 0 && seg !== '' && TOKEN_PREFIXES.has(segments[i - 1]))
        ? REDACTED
        : seg
    )
    .join('/');
}

/**
 * Request logger. Unlike hono/logger it never records the query string
 * (reset, magic-link and OAuth tokens travel there) and redacts token path
 * segments, so request logs, Loki and diagnose reports hold no auth tokens.
 */
export function accessLog(log: Logger = logger): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    await next();
    log.info(
      {
        method: c.req.method,
        path: redactPath(new URL(c.req.url).pathname),
        status: c.res.status,
        ms: Date.now() - start,
      },
      'request'
    );
  };
}
