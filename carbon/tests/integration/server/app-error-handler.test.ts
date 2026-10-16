import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Errors a route does not catch (an `adminDb` query that throws) must never
 * hand driver text to the client, and the log must not get the query params.
 */

const mode = vi.hoisted(() => ({ NODE_ENV: 'production' as string }));
vi.mock('@server/lib/env', () => ({
  env: new Proxy({}, { get: (_t, key) => (key === 'NODE_ENV' ? mode.NODE_ENV : undefined) }),
}));

const { handleAppError, sanitizeError } = await import('@server/lib/errors');
const { logger } = await import('@server/lib/logger');

const EMAIL = 'onerror-check@example.test';

function queryError() {
  const cause = Object.assign(new Error('relation "customers" does not exist'), {
    severity: 'ERROR',
    code: '42P01',
    detail: undefined,
  });
  return new DrizzleQueryError('select * from customers where email = $1', [EMAIL], cause);
}

function appThrowing(err: Error) {
  const app = new Hono();
  app.onError(handleAppError);
  const v1 = new Hono();
  v1.get('/boom', () => {
    throw err;
  });
  app.route('/api/v1', v1);
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
  mode.NODE_ENV = 'production';
});

describe('app onError', () => {
  it('an unwrapped database error from a sub-router is a generic 500, params kept out of the log', async () => {
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const res = await appThrowing(queryError()).request('/api/v1/boom');
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: 'Internal server error' });
    expect(body).not.toContain(EMAIL);
    expect(body).not.toContain('customers');
    expect(JSON.stringify(logged.mock.calls)).not.toContain(EMAIL);
    expect(logged.mock.calls[0][0]).toMatchObject({ err: { code: '42P01' }, path: '/api/v1/boom' });
  });

  it('an HTTPException keeps its own response', async () => {
    const res = await appThrowing(new HTTPException(418, { message: 'teapot' })).request(
      '/api/v1/boom'
    );
    expect(res.status).toBe(418);
  });

  it('the server registers it', () => {
    const index = readFileSync(join(__dirname, '../../../src/server/index.ts'), 'utf8');
    expect(index).toMatch(/app\.onError\(handleAppError\)/);
  });
});

describe('sanitizeError with a database error', () => {
  it('production: the fallback to the client, no params in the log', () => {
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    expect(sanitizeError(queryError(), 'Failed to subscribe')).toBe('Failed to subscribe');
    expect(JSON.stringify(logged.mock.calls)).not.toContain(EMAIL);
  });

  it('development: the Postgres message only, never the SQL or params', () => {
    mode.NODE_ENV = 'development';
    const message = sanitizeError(queryError(), 'Failed');
    expect(message).toBe('relation "customers" does not exist');
    expect(message).not.toContain(EMAIL);
  });
});
