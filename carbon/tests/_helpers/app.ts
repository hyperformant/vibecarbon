import { Hono } from 'hono';
import type { HonoVariables } from '../../src/server/types';

/**
 * Mount a route module onto a fresh Hono instance at a given prefix.
 *
 * Integration tests get a clean app per test — no global middleware
 * (CORS, rate-limit, security-headers) so assertions stay focused on the
 * route under test. If you need those, mount them on the returned app
 * before issuing requests.
 *
 * Example:
 *   import { healthRoutes } from '@server/routes/health';
 *   const app = mountRoute('/api/health', healthRoutes);
 *   const res = await app.request('/api/health/');
 *   expect(res.status).toBe(200);
 */
export function mountRoute(prefix: string, routes: Hono<{ Variables: HonoVariables }>): Hono {
  const app = new Hono();
  app.route(prefix, routes);
  return app;
}

/**
 * Build a JSON POST Request for app.request(...). Saves the boilerplate of
 * setting `method`, `headers`, and JSON-encoding the body in every test.
 *
 * Example:
 *   const res = await app.request('/api/v1/contact/submit', jsonPost({
 *     name: 'Ada', email: 'ada@example.com', subject: 'Hi', message: 'Hello there.',
 *   }));
 */
export function jsonPost(body: unknown, init: RequestInit = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    body: JSON.stringify(body),
    ...init,
    // Re-apply method/headers/body after the spread so callers can't
    // accidentally clobber them with an empty init.
  };
}
