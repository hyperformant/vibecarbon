import { z } from 'zod';

/**
 * Parse a boolean env var strictly: only the literal string "true" is true.
 * `z.coerce.boolean()` is NOT usable here — it treats any non-empty string
 * (including "false") as `true`. Empty strings are stripped to `undefined`
 * before validation (see cleanedEnv below), so they fall back to `def`.
 */
const envBool = (def: boolean) =>
  z.preprocess((v) => (v === undefined ? def : v === 'true'), z.boolean());

const envSchema = z.object({
  // Supabase (required)
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Public site URL — used in CSP connectSrc so the client can reach Supabase
  // via the public domain (Traefik → Kong). Defaults to empty string in dev
  // (CSP is disabled in development).
  SITE_URL: z.string().url().optional(),

  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  // Port configuration (for running multiple projects)
  DEV_PORT_OFFSET: z.coerce.number().default(0),
  DEV_VITE_PORT: z.coerce.number().optional(),
  DEV_API_PORT: z.coerce.number().optional(),
  DEV_DB_PORT: z.coerce.number().optional(),
  DEV_KONG_PORT: z.coerce.number().optional(),
  DEV_TRAEFIK_PORT: z.coerce.number().optional(),
  DEV_GRAFANA_PORT: z.coerce.number().optional(),
  DEV_PROMETHEUS_PORT: z.coerce.number().optional(),
  DEV_LOKI_PORT: z.coerce.number().optional(),

  // OAuth (optional - configure in Supabase dashboard)
  GOOGLE_ENABLED: envBool(false),
  MICROSOFT_ENABLED: envBool(false),
  GITHUB_ENABLED: envBool(false),
  APPLE_ENABLED: envBool(false),
  DISCORD_ENABLED: envBool(false),
  MAGIC_LINK_ENABLED: envBool(true),

  // SMTP (shared with Supabase Auth)
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
// SUPABASE_URL and SITE_URL are hardcoded to default ports in .env but
// DEV_PORT_OFFSET shifts Docker ports (Kong on 8000+offset, Vite on 5173+offset).
const portOffset = Number.parseInt(process.env.DEV_PORT_OFFSET || '0', 10);
if (process.env.NODE_ENV !== 'production' && portOffset !== 0) {
  for (const key of ['SUPABASE_URL', 'SITE_URL'] as const) {
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
