import { z } from 'zod';
import { resolveDbPort } from '../db/port';

/**
 * Parse a boolean env var strictly: only the literal string "true" is true.
 * `z.coerce.boolean()` is NOT usable here — it treats any non-empty string
 * (including "false") as `true`. Empty strings are stripped to `undefined`
 * before validation (see cleanedEnv below), so they fall back to `def`.
 */
const envBool = (def: boolean) =>
  z.preprocess((v) => (v === undefined ? def : v === 'true'), z.boolean());

const envSchema = z.object({
  // Session signing and encryption key for the in-process auth (cookies,
  // verification tokens). At least 32 characters; `vibecarbon create`
  // generates 64.
  BETTER_AUTH_SECRET: z.string().min(32),

  // Postgres. Discrete vars, never a URL, so a password needs no URL-encoding.
  // DB_USER must be able to bypass RLS (checked at startup, see db/startup.ts)
  // and be a member of app_user (withUserDb switches to it per transaction).
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_USER: z.string().min(1).default('postgres'),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1).default('postgres'),

  // The app's one public origin (http://localhost:5173 in dev). Required:
  // auth builds every emailed link (verification, password reset, magic
  // link) and OAuth callback from it, never from the request's Host header,
  // and it anchors the trusted origins for CORS, CSRF and auth. Also used in
  // the CSP connectSrc.
  SITE_URL: z.string().url(),

  // App storage bucket (provider-native S3, provisioned by `vibecarbon deploy`).
  // All optional: when any is missing, uploads are disabled (503) and the app
  // still boots.
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),

  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  // Port configuration (for running multiple projects)
  DEV_PORT_OFFSET: z.coerce.number().default(0),
  DEV_VITE_PORT: z.coerce.number().optional(),
  DEV_API_PORT: z.coerce.number().optional(),
  DEV_DB_PORT: z.coerce.number().optional(),
  DEV_TRAEFIK_PORT: z.coerce.number().optional(),
  DEV_GRAFANA_PORT: z.coerce.number().optional(),
  DEV_PROMETHEUS_PORT: z.coerce.number().optional(),
  DEV_LOKI_PORT: z.coerce.number().optional(),

  // OAuth (optional, set by `vibecarbon configure`). A provider is offered
  // only when it is enabled AND its client id and secret are set. Redirect
  // URI: <SITE_URL>/api/auth/callback/<google|microsoft>.
  GOOGLE_ENABLED: envBool(false),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_ENABLED: envBool(false),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().optional(),
  MAGIC_LINK_ENABLED: envBool(true),

  // Super admin ensured at startup (see auth/bootstrap-admin.ts). Both unset:
  // no bootstrap. An existing account is promoted, never re-passworded.
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),

  // SMTP (auth emails and transactional emails). Without it, email
  // verification is not required and auth emails are logged, not sent.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_ADMIN_EMAIL: z.string().email().optional(),
  SMTP_SENDER_NAME: z.string().optional(),

  // Billing provider selection (defaults to stripe for backward compatibility)
  BILLING_PROVIDER: z.enum(['stripe', 'paddle', 'polar']).default('stripe'),

  // Stripe (optional)
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_STARTER: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),

  // Paddle (optional - alternative billing provider)
  PADDLE_API_KEY: z.string().optional(),
  PADDLE_WEBHOOK_SECRET: z.string().optional(),
  PADDLE_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  PADDLE_PRICE_STARTER: z.string().optional(),
  PADDLE_PRICE_PRO: z.string().optional(),

  // Polar (optional - alternative billing provider)
  POLAR_ACCESS_TOKEN: z.string().optional(),
  POLAR_WEBHOOK_SECRET: z.string().optional(),
  POLAR_ORGANIZATION_ID: z.string().optional(),
  POLAR_PRICE_STARTER: z.string().optional(),
  POLAR_PRICE_PRO: z.string().optional(),

  // License tier price ID (for one-time license purchases)
  FULLERENE_PRICE_ID: z.string().optional(),

  // Redis (optional - for distributed rate limiting)
  // Format: redis://[:password@]host:port or redis://[:password@]host:port/db
  REDIS_URL: z.string().url().optional(),

  // Number of trusted reverse-proxy hops in front of this server. Used to pick
  // the real client IP out of X-Forwarded-For (see lib/client-ip.ts). The
  // default single hop matches the standard Traefik deployment.
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
});

// Apply port offset to localhost URLs in development
// SITE_URL is hardcoded to the default port in .env but DEV_PORT_OFFSET shifts
// the dev ports (Vite on 5173+offset).
const portOffset = Number.parseInt(process.env.DEV_PORT_OFFSET || '0', 10);
if (process.env.NODE_ENV !== 'production' && portOffset !== 0) {
  for (const key of ['SITE_URL'] as const) {
    const raw = process.env[key];
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        url.port = String(Number.parseInt(url.port || '80', 10) + portOffset);
        process.env[key] = url.toString().replace(/\/$/, '');
      }
    } catch {
      // Leave invalid URLs for Zod to catch
    }
  }
}

// Same idea for the local database (one rule, shared with drizzle.config.ts):
// a localhost DB_HOST outside production dials DEV_DB_PORT, else the base
// DB_PORT + DEV_PORT_OFFSET, the way docker-up.js publishes the dev db.
{
  const dbPort = resolveDbPort(process.env);
  if (dbPort !== undefined) process.env.DB_PORT = dbPort;
}

// Treat empty-string env vars as unset before validating. Docker Compose
// `env_file` (and other env sources) surface an unset optional var as "" rather
// than omitting it; zod's `.optional()` permits `undefined` but NOT "", so an
// empty SMTP_ADMIN_EMAIL / REDIS_URL / SMTP_PORT would fail .email()/.url()/
// .number() and crash boot with "Server configuration error". Stripping blanks
// makes "" mean "not set", matching operator intent (and how the k8s Secret
// path already skips empty values).
const cleanedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== '')
);

// Validate environment variables
const parsed = envSchema.safeParse(cleanedEnv);

if (!parsed.success) {
  // In production, don't expose which specific environment variables failed validation
  // This prevents information disclosure about the application's configuration
  if (process.env.NODE_ENV === 'production') {
    console.error('Server configuration error. Please check environment variables.');
  } else {
    console.error('Invalid environment variables:');
    console.error(parsed.error.flatten().fieldErrors);
  }
  process.exit(1);
}

export const env = parsed.data;
