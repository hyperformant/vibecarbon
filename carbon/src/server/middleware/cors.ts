import { cors } from 'hono/cors';
import { allowedOrigins } from '../lib/origins';

/**
 * CORS for /api/*: credentialed requests only from our own origins
 * (lib/origins.ts, the list the CSRF check and auth share). A foreign
 * origin's preflight gets no Access-Control-Allow-Origin, so the browser
 * never sends its JSON, PUT or DELETE request with our cookie.
 */
export function apiCors() {
  return cors({
    origin: (origin) => (allowedOrigins().includes(origin) ? origin : null),
    allowHeaders: ['Content-Type', 'Authorization', 'apikey'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    maxAge: 3600, // 1 hour
  });
}
