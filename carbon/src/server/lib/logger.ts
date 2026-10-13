import pino from 'pino';
import { dbErrorForLog } from '../db/errors';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Serializer for the `err` and `error` fields. A database error (or anything
 * wrapping one) becomes its log-safe form from db/errors.ts, so the SQL and
 * the bound values Drizzle puts in its message never reach the log, even at
 * a call site that logs the raw error. Other errors get pino's standard
 * error serializer; non-errors (a message string, a plain object) pass
 * through unchanged.
 */
export function serializeLoggedError(value: unknown): unknown {
  const safe = dbErrorForLog(value);
  if (safe !== value) return safe;
  return value instanceof Error ? pino.stdSerializers.err(value) : value;
}

export const loggerOptions: pino.LoggerOptions = {
  level: isProduction ? 'info' : 'debug',
  serializers: { err: serializeLoggedError, error: serializeLoggedError },
};

export const logger = pino({
  ...loggerOptions,
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
          },
        },
      }),
});
