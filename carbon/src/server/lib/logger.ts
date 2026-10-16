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

/** The message pino gets when a call logs an error without one. */
export const ERROR_WITHOUT_MESSAGE = 'Error (no log message given)';

/**
 * pino fills `msg` from the error's own `message` when a call passes an
 * Error (or `{ err }`) with no message string, and that copy skips the
 * serializers: `logger.error(drizzleErr)` would write the SQL and params as
 * the message. This hook puts a bare Error under `err` (so the serializer
 * sees it) and supplies a fixed message whenever none was given.
 */
function logMethod(this: pino.Logger, args: unknown[], method: pino.LogFn): void {
  let [first, ...rest] = args;
  if (first instanceof Error) first = { err: first };
  const hasError =
    typeof first === 'object' && first !== null && ('err' in first || 'error' in first);
  if (hasError && typeof rest[0] !== 'string') rest = [ERROR_WITHOUT_MESSAGE, ...rest];
  (method as (...a: unknown[]) => void).apply(this, [first, ...rest]);
}

export const loggerOptions: pino.LoggerOptions = {
  level: isProduction ? 'info' : 'debug',
  serializers: { err: serializeLoggedError, error: serializeLoggedError },
  hooks: { logMethod },
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
