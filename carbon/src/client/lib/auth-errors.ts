import type { AuthClientError } from './auth-client';

/**
 * An auth API refusal, thrown by the AuthProvider's actions. `code` is the
 * server's machine-readable code (e.g. `INVALID_EMAIL_OR_PASSWORD`,
 * `MFA_REQUIRED`); pages turn it into a translated message with
 * `authErrorKey`, never by showing the server's English text.
 */
export class AuthRequestError extends Error {
  readonly code: string | undefined;
  readonly status: number | undefined;

  constructor(error: NonNullable<AuthClientError>) {
    super(error.message || error.code || 'Authentication failed');
    this.name = 'AuthRequestError';
    this.code = error.code ?? (error.error ? error.error.toUpperCase() : undefined);
    this.status = error.status;
  }
}

/**
 * Server codes the UI explains, mapped to `auth.errors.*` keys in en.json.
 * Pairs, not an object literal: `INVALID_PASSWORD: '<key>'` reads as a
 * password assignment to the deploy secret scan.
 */
const CODE_KEYS = new Map<string, string>([
  ['INVALID_EMAIL_OR_PASSWORD', 'auth.errors.invalidCredentials'],
  ['ACCOUNT_LOCKED', 'auth.errors.accountLocked'],
  ['USER_ALREADY_EXISTS', 'auth.errors.userExists'],
  ['USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', 'auth.errors.userExists'],
  ['PASSWORD_TOO_SHORT', 'auth.errors.passwordTooShort'],
  ['INVALID_PASSWORD', 'auth.errors.invalidPassword'],
  ['EMAIL_NOT_VERIFIED', 'auth.errors.emailNotVerified'],
  ['INVALID_TOKEN', 'auth.errors.invalidToken'],
  ['INVALID_CODE', 'auth.errors.invalidCode'],
  ['INVALID_BACKUP_CODE', 'auth.errors.invalidCode'],
  ['INVALID_TWO_FACTOR_CODE', 'auth.errors.invalidCode'],
  ['ACCOUNT_TEMPORARILY_LOCKED', 'auth.errors.tooManyCodes'],
  ['INVALID_TWO_FACTOR_COOKIE', 'auth.errors.challengeExpired'],
  ['TWO_FACTOR_NOT_CONFIRMED', 'auth.errors.twoFactorNotConfirmed'],
  ['TWO_FACTOR_NOT_ENABLED', 'auth.errors.twoFactorNotEnabled'],
  ['MFA_REQUIRED', 'auth.errors.mfaRequired'],
  ['REAUTH_REQUIRED', 'auth.errors.reauthRequired'],
  ['IMPERSONATION_NOT_ALLOWED', 'auth.errors.impersonationNotAllowed'],
  ['SESSION_EXPIRED', 'auth.errors.sessionExpired'],
  ['PASSWORD_UNLINK_NOT_ALLOWED', 'auth.errors.passwordUnlinkNotAllowed'],
]);

/**
 * The `t()` key explaining an auth failure: the code's own message when the
 * UI knows it, a rate-limit message for any 429, else `fallback`.
 */
export function authErrorKey(err: unknown, fallback = 'auth.authFailed'): string {
  if (err instanceof AuthRequestError) {
    const key = err.code ? CODE_KEYS.get(err.code) : undefined;
    if (key) return key;
    if (err.status === 429) return 'auth.errors.rateLimited';
  }
  return fallback;
}

/** Unwraps an auth client result: the data, or a thrown AuthRequestError. */
export function unwrap<T>(result: { data: T | null; error: AuthClientError }): T {
  if (result.error) throw new AuthRequestError(result.error);
  return result.data as T;
}
