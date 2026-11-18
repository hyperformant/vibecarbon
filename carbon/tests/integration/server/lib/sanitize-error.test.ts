import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * sanitizeError (src/server/lib/errors.ts) for errors that are not database
 * errors: production hands the client only the fallback and logs the error;
 * anywhere else the client gets the message, when there is one. The database
 * case is in tests/integration/server/app-error-handler.test.ts.
 */

const mode = vi.hoisted(() => ({ NODE_ENV: 'production' as string }));
vi.mock('@server/lib/env', () => ({
  env: new Proxy({}, { get: (_t, key) => (key === 'NODE_ENV' ? mode.NODE_ENV : undefined) }),
}));
const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@server/lib/logger', () => ({ logger }));

const { sanitizeError } = await import('@server/lib/errors');

const FALLBACK = 'An unexpected error occurred';

beforeEach(() => {
  logger.error.mockClear();
});

afterEach(() => {
  mode.NODE_ENV = 'production';
});

describe('sanitizeError in production', () => {
  it('returns the default fallback, not the message', () => {
    expect(sanitizeError(new Error('Database connection failed'))).toBe(FALLBACK);
  });

  it('returns the caller’s fallback when given one', () => {
    expect(sanitizeError(new Error('secret info'), 'Something went wrong')).toBe(
      'Something went wrong'
    );
  });

  it('logs the error itself under "API error"', () => {
    const err = new Error('internal details');
    sanitizeError(err);
    expect(logger.error).toHaveBeenCalledWith({ err }, 'API error');
  });

  it('never puts the error’s text in what the client gets', () => {
    const result = sanitizeError(new Error('password=abc123&secret=xyz'));
    expect(result).not.toContain('password');
    expect(result).not.toContain('secret');
  });
});

describe('sanitizeError outside production', () => {
  beforeEach(() => {
    mode.NODE_ENV = 'development';
  });

  it('returns an Error’s message', () => {
    expect(sanitizeError(new Error('Something broke'))).toBe('Something broke');
  });

  it('returns the message of an object that has one', () => {
    expect(sanitizeError({ message: 'custom error object' })).toBe('custom error object');
  });

  it('turns a message that is not a string into one', () => {
    expect(sanitizeError({ message: 42 })).toBe('42');
  });

  it.each([
    ['a plain string', 'just a string'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 404],
    ['an object without a message', { code: 'ERR_FAILED' }],
  ])('returns the fallback for %s', (_what, value) => {
    expect(sanitizeError(value)).toBe(FALLBACK);
  });

  it('returns the caller’s fallback for a value it cannot read', () => {
    expect(sanitizeError(true, 'Custom fallback')).toBe('Custom fallback');
  });

  it('logs nothing', () => {
    sanitizeError(new Error('Something broke'));
    expect(logger.error).not.toHaveBeenCalled();
  });
});
