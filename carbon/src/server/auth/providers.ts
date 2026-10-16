import { env } from '../lib/env';

/**
 * OAuth providers that are both enabled and fully configured. The auth
 * instance registers exactly these, and GET /api/v1/auth/settings advertises
 * exactly these, so the login page never offers a button that cannot work.
 */
export const socialProviders = {
  google: Boolean(env.GOOGLE_ENABLED && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  microsoft: Boolean(
    env.MICROSOFT_ENABLED && env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
  ),
};
