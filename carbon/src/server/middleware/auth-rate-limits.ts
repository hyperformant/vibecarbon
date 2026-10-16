import type { Hono } from 'hono';
import { createRateLimiter } from '../lib/rate-limiter';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * Per-IP caps on the auth endpoints, applied in server/index.ts.
 *
 * Better Auth's own limiter is off (it reads the leftmost X-Forwarded-For,
 * which a client can forge), so these replace it, at least as strict as its
 * defaults, keyed by the trusted-proxy client IP (lib/client-ip.ts). Each
 * limiter is its own bucket (the key includes its window and cap), so the
 * general budget and a strict cap on the same path do not share a count.
 *
 * Password sign-in also has the per-(email, IP) account lockout; its strict
 * cap here stops credential stuffing across many emails, which the lockout
 * (one bucket per email) does not. Social sign-in only starts a redirect to
 * the provider, so it gets a looser cap.
 */
export const AUTH_RATE_LIMITS: ReadonlyArray<{ path: string; windowMs: number; max: number }> = [
  { path: '/api/auth/*', windowMs: MINUTE, max: 100 },
  { path: '/api/auth/sign-in/email', windowMs: 15 * MINUTE, max: 10 },
  { path: '/api/auth/sign-in/social', windowMs: MINUTE, max: 10 },
  { path: '/api/auth/sign-in/magic-link', windowMs: MINUTE, max: 5 },
  { path: '/api/auth/sign-up/*', windowMs: 10 * SECOND, max: 3 },
  { path: '/api/auth/change-password', windowMs: 10 * SECOND, max: 3 },
  { path: '/api/auth/change-email', windowMs: 10 * SECOND, max: 3 },
  { path: '/api/auth/request-password-reset', windowMs: MINUTE, max: 3 },
  { path: '/api/auth/send-verification-email', windowMs: MINUTE, max: 3 },
  { path: '/api/auth/two-factor/*', windowMs: 10 * SECOND, max: 3 },
];

// biome-ignore lint/suspicious/noExplicitAny: works for any app's Variables
export function applyAuthRateLimits(app: Hono<any>): void {
  for (const { path, windowMs, max } of AUTH_RATE_LIMITS) {
    app.use(path, createRateLimiter({ windowMs, max }));
  }
}
