import { describe, expect, it, vi } from 'vitest';

/**
 * Tests for error sanitization logic used in API responses.
 * Re-implements the pattern from carbon/src/server/lib/errors.ts
 */

// Mock the env and logger dependencies
const mockLogger = { error: vi.fn() };

function sanitizeError(
  error: unknown,
  fallback = 'An unexpected error occurred',
  nodeEnv = 'development',
): string {
  if (nodeEnv === 'production') {
    mockLogger.error({ error }, 'API error');
    return fallback;
  }
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return fallback;
}

describe('sanitizeError', () => {
  describe('in production mode', () => {
    it('returns the fallback message', () => {
      const result = sanitizeError(
        new Error('Database connection failed'),
        undefined,
        'production',
      );
      expect(result).toBe('An unexpected error occurred');
    });

    it('returns a custom fallback message', () => {
      const result = sanitizeError(new Error('secret info'), 'Something went wrong', 'production');
      expect(result).toBe('Something went wrong');
    });

    it('logs the full error', () => {
      const err = new Error('internal details');
      sanitizeError(err, undefined, 'production');
      expect(mockLogger.error).toHaveBeenCalledWith({ error: err }, 'API error');
    });

    it('never leaks error details', () => {
      const sensitiveError = new Error('password=abc123&secret=xyz');
      const result = sanitizeError(sensitiveError, undefined, 'production');
      expect(result).not.toContain('password');
      expect(result).not.toContain('secret');
    });
  });

  describe('in development mode', () => {
    it('returns the error message for Error instances', () => {
      const result = sanitizeError(new Error('Something broke'));
      expect(result).toBe('Something broke');
    });

    it('returns the message from objects with message property', () => {
      const result = sanitizeError({ message: 'custom error object' });
      expect(result).toBe('custom error object');
    });

    it('converts non-string message to string', () => {
      const result = sanitizeError({ message: 42 });
      expect(result).toBe('42');
    });

    it('returns fallback for plain strings', () => {
      const result = sanitizeError('just a string');
      expect(result).toBe('An unexpected error occurred');
    });

    it('returns fallback for null', () => {
      expect(sanitizeError(null)).toBe('An unexpected error occurred');
    });

    it('returns fallback for undefined', () => {
      expect(sanitizeError(undefined)).toBe('An unexpected error occurred');
    });

    it('returns fallback for numbers', () => {
      expect(sanitizeError(404)).toBe('An unexpected error occurred');
    });

    it('returns fallback for objects without message', () => {
      expect(sanitizeError({ code: 'ERR_FAILED' })).toBe('An unexpected error occurred');
    });

    it('returns custom fallback for unrecognized types', () => {
      expect(sanitizeError(true, 'Custom fallback')).toBe('Custom fallback');
    });
  });
});
