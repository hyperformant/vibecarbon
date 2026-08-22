import { env } from './env';
import { logger } from './logger';

/**
 * Sanitize error messages for API responses.
 * In production, logs the full error and returns a generic message.
 * In development, returns the actual error message for debugging.
 */
export function sanitizeError(error: unknown, fallback = 'An unexpected error occurred'): string {
  if (env.NODE_ENV === 'production') {
    // Log the full error for debugging
    logger.error({ error }, 'API error');
    return fallback;
  }
  // In development, return the actual error message
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return fallback;
}
