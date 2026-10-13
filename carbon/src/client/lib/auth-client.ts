import {
  adminClient,
  inferAdditionalFields,
  magicLinkClient,
  twoFactorClient,
} from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * The browser side of the in-process auth API (`/api/auth/*`, server/auth/).
 *
 * Sessions are HttpOnly cookies on this origin: page JS never sees a session
 * token, and every call here (and every `/api/*` fetch) carries the cookie
 * on its own. The plugins mirror the server's: two-factor (TOTP + backup
 * codes), admin (impersonation) and magic link.
 *
 * The extra fields are declared here rather than inferred from the server
 * instance, so the client bundle never imports server code.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  fetchOptions: { credentials: 'same-origin' },
  plugins: [
    // No twoFactorPage: the sign-in call reports `twoFactorRedirect` and the
    // AuthProvider routes to /mfa-verify itself (keeping ?redirect=).
    twoFactorClient(),
    adminClient(),
    magicLinkClient(),
    inferAdditionalFields({
      user: { onboardingCompleted: { type: 'boolean', required: false } },
      session: { twoFactorVerified: { type: 'boolean', required: false, input: false } },
    }),
  ],
});

export type AuthClientSession = typeof authClient.$Infer.Session;
export type AuthUser = AuthClientSession['user'];
export type AuthSession = AuthClientSession['session'];

/** The error shape every auth client call returns instead of throwing. */
export type AuthClientError = {
  status?: number;
  code?: string;
  message?: string;
  error?: string;
} | null;
