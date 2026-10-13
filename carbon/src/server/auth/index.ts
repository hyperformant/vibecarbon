import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, magicLink } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements, userAc } from 'better-auth/plugins/admin/access';
import { adminDb } from '../db/client';
import * as schema from '../db/schema';
import { isEmailConfigured } from '../lib/email';
import { env } from '../lib/env';
import { sendAuthEmail } from './email';
import { lockoutAfter, lockoutBefore } from './lockout';
import { socialProviders } from './providers';
import { stripSessionToken } from './strip-session-token';

/**
 * The app's one auth instance, mounted at /api/auth/* (server/index.ts).
 *
 * - Postgres through Drizzle on `adminDb`: the auth tables have no app_user
 *   privileges, so Better Auth must bypass RLS. Ids are uuids the database
 *   generates (`generateId: false`), so every `uuid` foreign key to "user"
 *   keeps working.
 * - Sessions are HttpOnly cookies (SameSite=Lax, Secure on https). The
 *   session middleware reads them with `auth.api.getSession`.
 * - Super admin is `user.role = 'super_admin'` (admin plugin). There is no
 *   platform `admin` role, and no endpoint assigns roles: the super_admin
 *   role lacks `set-role` and the set-role path is disabled. The only way to
 *   a super admin is the startup bootstrap (auth/bootstrap-admin.ts).
 * - Email + password sign-in goes through the account lockout hooks.
 */

const ac = createAccessControl(defaultStatements);

/**
 * Everything the stock admin role may do except assign roles. Impersonating
 * another admin (`impersonate-admins`) is not granted either.
 */
const superAdminRole = ac.newRole({
  user: adminAc.statements.user.filter((action) => action !== 'set-role'),
  session: [...adminAc.statements.session],
});

/** Verification emails are required only when they can actually be sent. */
const emailConfigured = isEmailConfigured();

export const auth = betterAuth({
  appName: '{{PROJECT_DISPLAY_NAME}}',
  basePath: '/api/auth',
  baseURL: env.SITE_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: env.SITE_URL ? [env.SITE_URL] : [],
  database: drizzleAdapter(adminDb, { provider: 'pg', schema }),
  advanced: {
    database: { generateId: false },
    // Explicit, so the origin and CSRF checks also run under NODE_ENV=test
    // (Better Auth skips them there by default) and tests see production.
    disableOriginCheck: false,
    disableCSRFCheck: false,
  },
  // Our own limiter covers /api/auth (server/index.ts) and reads the client
  // IP the trusted-proxy way; Better Auth's reads X-Forwarded-For as given.
  rateLimit: { enabled: false },
  session: {
    // Short: the app's API session middleware never reads it (it always reads
    // the database), and Better Auth's admin endpoints bypass it, so a revoked
    // session lingers for at most a minute in its own get-session answers.
    cookieCache: { enabled: true, maxAge: 60 },
    additionalFields: {
      // Set only by the second-factor verify hook (MFA). Never client input.
      twoFactorVerified: { type: 'boolean', defaultValue: false, required: false, input: false },
    },
  },
  user: {
    additionalFields: {
      onboardingCompleted: {
        type: 'boolean',
        defaultValue: false,
        required: false,
        input: true,
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    requireEmailVerification: emailConfigured,
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: async ({ user, url }) => {
      await sendAuthEmail('password reset', user.email, url);
    },
  },
  emailVerification: {
    sendOnSignUp: emailConfigured,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendAuthEmail('verification', user.email, url);
    },
  },
  socialProviders: {
    ...(socialProviders.google
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID as string,
            clientSecret: env.GOOGLE_CLIENT_SECRET as string,
          },
        }
      : {}),
    ...(socialProviders.microsoft
      ? {
          microsoft: {
            clientId: env.MICROSOFT_CLIENT_ID as string,
            clientSecret: env.MICROSOFT_CLIENT_SECRET as string,
            tenantId: env.MICROSOFT_TENANT_ID || 'common',
          },
        }
      : {}),
  },
  disabledPaths: [
    '/admin/set-role',
    ...(env.MAGIC_LINK_ENABLED ? [] : ['/sign-in/magic-link', '/magic-link/verify']),
  ],
  hooks: { before: lockoutBefore, after: lockoutAfter },
  plugins: [
    admin({
      ac,
      roles: { super_admin: superAdminRole, user: userAc },
      adminRoles: ['super_admin'],
      defaultRole: 'user',
    }),
    // Always registered so the API types stay fixed; MAGIC_LINK_ENABLED=false
    // disables its paths above.
    magicLink({
      expiresIn: 5 * 60,
      sendMagicLink: async ({ email, url }) => {
        await sendAuthEmail('magic link', email, url);
      },
    }),
    // Last, so it sees every other plugin's response: no session token in
    // any JSON body; the HttpOnly cookie is its only carrier.
    stripSessionToken(),
  ],
});

export type AuthSessionData = typeof auth.$Infer.Session;
export type AuthUser = AuthSessionData['user'];
export type AuthSession = AuthSessionData['session'];
