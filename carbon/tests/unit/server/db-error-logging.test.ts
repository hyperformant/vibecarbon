import { Writable } from 'node:stream';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { dbErrorForLog, dbErrorMessage } from '@server/db/errors';
import { loggerOptions } from '@server/lib/logger';

/**
 * Drizzle's query error carries the SQL and every bound value in its message
 * and on `.params`. Those values are emails and tokens; they must never be
 * written to the log, whichever way a call site hands the error to pino.
 */

const EMAIL = 'leak-check@example.test';
const TOKEN = 'unsubscribe-token-3f9c1a';

/** A pg server error shaped like pg-protocol's DatabaseError. */
function pgError(): Error {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "newsletter_email_key"'),
    {
      severity: 'ERROR',
      code: '23505',
      detail: `Key (email)=(${EMAIL}) already exists.`,
      where: `SQL statement with ${TOKEN}`,
      schema: 'public',
      table: 'newsletter_subscribers',
      constraint: 'newsletter_email_key',
      column: undefined,
    }
  );
}

function queryError(): DrizzleQueryError {
  return new DrizzleQueryError(
    'insert into "newsletter_subscribers" ("email", "token") values ($1, $2)',
    [EMAIL, TOKEN],
    pgError()
  );
}

/** Log one record through `options` and return the raw JSON line. */
function logLine(options: pino.LoggerOptions, obj: object): string {
  let out = '';
  const sink = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  pino(options, sink).error(obj, 'Failed to create newsletter subscriber');
  return out;
}

describe('db error logging', () => {
  it('the fixture really leaks through a plain pino logger (control)', () => {
    const line = logLine({}, { err: queryError() });
    expect(line).toContain(EMAIL);
  });

  for (const key of ['err', 'error'] as const) {
    it(`a DrizzleQueryError under "${key}" never puts params in the record`, () => {
      const line = logLine(loggerOptions, { [key]: queryError() });
      expect(line).not.toContain(EMAIL);
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain('Failed query');
      // ...and still says what went wrong.
      const record = JSON.parse(line)[key];
      expect(record).toMatchObject({
        type: 'DatabaseError',
        code: '23505',
        constraint: 'newsletter_email_key',
        table: 'newsletter_subscribers',
        message: 'duplicate key value violates unique constraint "newsletter_email_key"',
      });
    });
  }

  it('a database error wrapped as the cause of another error is sanitized too', () => {
    const wrapped = new Error('Failed to fetch customer', { cause: queryError() });
    const line = logLine(loggerOptions, { err: wrapped });
    expect(line).not.toContain(EMAIL);
    expect(line).not.toContain(TOKEN);
  });

  it('a bare pg error drops detail and where', () => {
    const line = logLine(loggerOptions, { err: pgError() });
    expect(line).not.toContain(EMAIL);
    expect(line).not.toContain(TOKEN);
    expect(JSON.parse(line).err.code).toBe('23505');
  });

  it('a connection failure inside a query error keeps its message and code', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const err = new DrizzleQueryError('select 1 where email = $1', [EMAIL], cause);
    expect(dbErrorForLog(err)).toEqual({
      type: 'DatabaseError',
      message: 'connect ECONNREFUSED 127.0.0.1:5432',
      code: 'ECONNREFUSED',
    });
  });

  it('other errors pass through unchanged and keep the standard serializer', () => {
    const plain = new Error('smtp down');
    expect(dbErrorForLog(plain)).toBe(plain);
    const record = JSON.parse(logLine(loggerOptions, { err: plain })).err;
    expect(record.message).toBe('smtp down');
    expect(record.stack).toContain('smtp down');
    // A message string under "error" is left alone.
    expect(JSON.parse(logLine(loggerOptions, { error: 'Invalid signature' })).error).toBe(
      'Invalid signature'
    );
  });

  it('dbErrorMessage gives the Postgres message, undefined for other errors', () => {
    expect(dbErrorMessage(queryError())).toBe(
      'duplicate key value violates unique constraint "newsletter_email_key"'
    );
    expect(dbErrorMessage(new Error('x'))).toBeUndefined();
  });
});
