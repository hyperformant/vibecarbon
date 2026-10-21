import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { dbErrorForLog, dbErrorMessage } from '../db/errors';
import { redactPath } from '../middleware/access-log';
import { env } from './env';
import { logger } from './logger';

/**
 * Sanitize error messages for API responses.
 * In production, logs the error and returns a generic message.
 * In development, returns the actual error message for debugging, except
 * that a database error gives only the Postgres message: Drizzle's own
 * message carries the SQL and every bound value (emails, tokens).
 */
export function sanitizeError(error: unknown, fallback = 'An unexpected error occurred'): string {
  if (env.NODE_ENV === 'production') {
    logger.error({ err: dbErrorForLog(error) }, 'API error');
    return fallback;
  }
  const dbMessage = dbErrorMessage(error);
  if (dbMessage !== undefined) return dbMessage;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return fallback;
}

/**
 * The app-wide `onError` handler: anything a route throws without catching
 * (an `adminDb` query that failed, say) ends up here. The client gets a
 * generic 500 with no driver text; the log gets the error with database
 * params stripped. An `HTTPException` keeps the response it was built with.
 */
export function handleAppError(err: Error, c: Context): Response {
  if (err instanceof HTTPException) return err.getResponse();
  logger.error(
    { err: dbErrorForLog(err), method: c.req.method, path: redactPath(c.req.path) },
    'Unhandled error in request'
  );
  return c.json({ error: 'Internal server error' }, 500);
}
