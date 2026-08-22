import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Tests for environment variable validation.
 * Re-implements the schema from carbon/src/server/lib/env.ts.
 *
 * Boolean env vars use `envBool`, NOT `z.coerce.boolean()`. Only the literal
 * string "true" is truthy; "false" (and every other string) is false. This is
 * deliberate: `z.coerce.boolean()` calls Boolean("false"), which is `true`, so
 * env.ts avoids it. The `drift guards` block at the bottom pins that contract.
 */

// ============================================================================
// SCHEMA (mirror env.ts)
// ============================================================================

/**
 * Parse a boolean env var strictly: only the literal string "true" is true.
 * Empty strings are stripped to undefined before validation (see cleanedEnv in
 * env.ts), so they fall back to `def`.
 */
const envBool = (def: boolean) =>
  z.preprocess((v) => (v === undefined ? def : v === 'true'), z.boolean());

const envSchema = z.object({
  // Supabase (required)
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  // Port configuration
  DEV_PORT_OFFSET: z.coerce.number().default(0),
  DEV_VITE_PORT: z.coerce.number().optional(),
  DEV_API_PORT: z.coerce.number().optional(),
  DEV_KONG_PORT: z.coerce.number().optional(),
  DEV_TRAEFIK_PORT: z.coerce.number().optional(),
  DEV_GRAFANA_PORT: z.coerce.number().optional(),
  DEV_PROMETHEUS_PORT: z.coerce.number().optional(),
  DEV_LOKI_PORT: z.coerce.number().optional(),

  // OAuth (optional) — strict "true"-only booleans.
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

  // Billing provider selection (defaults to stripe)
  BILLING_PROVIDER: z.enum(['stripe', 'paddle', 'polar']).default('stripe'),

  // Stripe (optional) — monthly-only price IDs; yearly variants were deferred.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_STARTER: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),

  // Redis (optional)
  REDIS_URL: z.string().url().optional(),
});

// ============================================================================
// TESTS
// ============================================================================

const validEnv = {
  SUPABASE_URL: 'http://localhost:8000',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiJ9.test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.test-service-role',
};

describe('Environment variable validation', () => {
  describe('required variables', () => {
    it('passes with valid required vars', () => {
      const result = envSchema.safeParse(validEnv);
      expect(result.success).toBe(true);
    });

    it('fails when SUPABASE_URL is missing', () => {
      const { SUPABASE_URL, ...env } = validEnv;
      const result = envSchema.safeParse(env);
      expect(result.success).toBe(false);
    });

    it('fails when SUPABASE_URL is not a valid URL', () => {
      const result = envSchema.safeParse({ ...validEnv, SUPABASE_URL: 'not-a-url' });
      expect(result.success).toBe(false);
    });

    it('fails when SUPABASE_ANON_KEY is missing', () => {
      const { SUPABASE_ANON_KEY, ...env } = validEnv;
      const result = envSchema.safeParse(env);
      expect(result.success).toBe(false);
    });

    it('fails when SUPABASE_ANON_KEY is empty', () => {
      const result = envSchema.safeParse({ ...validEnv, SUPABASE_ANON_KEY: '' });
      expect(result.success).toBe(false);
    });

    it('fails when SUPABASE_SERVICE_ROLE_KEY is missing', () => {
      const { SUPABASE_SERVICE_ROLE_KEY, ...env } = validEnv;
      const result = envSchema.safeParse(env);
      expect(result.success).toBe(false);
    });
  });

  describe('default values', () => {
    it('defaults NODE_ENV to development', () => {
      const result = envSchema.parse(validEnv);
      expect(result.NODE_ENV).toBe('development');
    });

    it('defaults PORT to 3000', () => {
      const result = envSchema.parse(validEnv);
      expect(result.PORT).toBe(3000);
    });

    it('defaults DEV_PORT_OFFSET to 0', () => {
      const result = envSchema.parse(validEnv);
      expect(result.DEV_PORT_OFFSET).toBe(0);
    });

    it('defaults BILLING_PROVIDER to stripe', () => {
      const result = envSchema.parse(validEnv);
      expect(result.BILLING_PROVIDER).toBe('stripe');
    });

    it('defaults MAGIC_LINK_ENABLED to true', () => {
      const result = envSchema.parse(validEnv);
      expect(result.MAGIC_LINK_ENABLED).toBe(true);
    });

    it('defaults OAuth providers to false', () => {
      const result = envSchema.parse(validEnv);
      expect(result.GOOGLE_ENABLED).toBe(false);
      expect(result.MICROSOFT_ENABLED).toBe(false);
      expect(result.GITHUB_ENABLED).toBe(false);
      expect(result.APPLE_ENABLED).toBe(false);
      expect(result.DISCORD_ENABLED).toBe(false);
    });
  });

  describe('NODE_ENV validation', () => {
    it('accepts development', () => {
      const result = envSchema.safeParse({ ...validEnv, NODE_ENV: 'development' });
      expect(result.success).toBe(true);
    });

    it('accepts production', () => {
      const result = envSchema.safeParse({ ...validEnv, NODE_ENV: 'production' });
      expect(result.success).toBe(true);
    });

    it('accepts test', () => {
      const result = envSchema.safeParse({ ...validEnv, NODE_ENV: 'test' });
      expect(result.success).toBe(true);
    });

    it('rejects invalid environment', () => {
      const result = envSchema.safeParse({ ...validEnv, NODE_ENV: 'staging' });
      expect(result.success).toBe(false);
    });
  });

  describe('PORT coercion', () => {
    it('coerces string to number', () => {
      const result = envSchema.parse({ ...validEnv, PORT: '8080' });
      expect(result.PORT).toBe(8080);
    });

    it('accepts number directly', () => {
      const result = envSchema.parse({ ...validEnv, PORT: 4000 });
      expect(result.PORT).toBe(4000);
    });
  });

  describe('boolean env vars (envBool semantics — only "true" is true)', () => {
    it('parses the literal "true" as true', () => {
      const result = envSchema.parse({ ...validEnv, GOOGLE_ENABLED: 'true' });
      expect(result.GOOGLE_ENABLED).toBe(true);
    });

    it('parses "false" as false', () => {
      // This is the key contract: env.ts must NOT use z.coerce.boolean(), whose
      // Boolean("false") is true. envBool treats only the exact string "true"
      // as true, so "false" correctly disables the flag.
      const result = envSchema.parse({ ...validEnv, MAGIC_LINK_ENABLED: 'false' });
      expect(result.MAGIC_LINK_ENABLED).toBe(false);
    });

    it('parses any other non-"true" string as false', () => {
      const result = envSchema.parse({ ...validEnv, GITHUB_ENABLED: '1', DISCORD_ENABLED: 'yes' });
      expect(result.GITHUB_ENABLED).toBe(false);
      expect(result.DISCORD_ENABLED).toBe(false);
    });

    it('falls back to the declared default when unset', () => {
      const result = envSchema.parse(validEnv);
      expect(result.MAGIC_LINK_ENABLED).toBe(true);
      expect(result.GOOGLE_ENABLED).toBe(false);
    });
  });

  describe('optional variables', () => {
    it('allows all optional vars to be omitted', () => {
      const result = envSchema.safeParse(validEnv);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.STRIPE_SECRET_KEY).toBeUndefined();
        expect(result.data.SMTP_ADMIN_EMAIL).toBeUndefined();
        expect(result.data.REDIS_URL).toBeUndefined();
      }
    });

    it('accepts valid Stripe keys', () => {
      const result = envSchema.safeParse({
        ...validEnv,
        STRIPE_SECRET_KEY: 'sk_test_abc123',
        STRIPE_WEBHOOK_SECRET: 'whsec_abc123',
        STRIPE_PRICE_STARTER: 'price_starter_123',
        STRIPE_PRICE_PRO: 'price_pro_123',
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid SMTP_ADMIN_EMAIL', () => {
      const result = envSchema.safeParse({
        ...validEnv,
        SMTP_HOST: 'smtp.resend.com',
        SMTP_USER: 'resend',
        SMTP_ADMIN_EMAIL: 'noreply@example.com',
        SMTP_SENDER_NAME: 'MyApp',
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid SMTP_ADMIN_EMAIL', () => {
      const result = envSchema.safeParse({
        ...validEnv,
        SMTP_ADMIN_EMAIL: 'not-an-email',
      });
      expect(result.success).toBe(false);
    });

    it('accepts valid REDIS_URL', () => {
      const result = envSchema.safeParse({
        ...validEnv,
        REDIS_URL: 'redis://localhost:6379',
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid REDIS_URL', () => {
      const result = envSchema.safeParse({
        ...validEnv,
        REDIS_URL: 'not-a-url',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('port offset configuration', () => {
    it('accepts numeric port offset', () => {
      const result = envSchema.parse({ ...validEnv, DEV_PORT_OFFSET: '100' });
      expect(result.DEV_PORT_OFFSET).toBe(100);
    });

    it('accepts individual port overrides', () => {
      const result = envSchema.parse({
        ...validEnv,
        DEV_VITE_PORT: '5273',
        DEV_API_PORT: '3100',
        DEV_KONG_PORT: '8100',
      });
      expect(result.DEV_VITE_PORT).toBe(5273);
      expect(result.DEV_API_PORT).toBe(3100);
      expect(result.DEV_KONG_PORT).toBe(8100);
    });
  });

  // Regression: docker-compose `env_file: .env` (added so billing/SMTP keys
  // reach the app) surfaces unset optional vars as "" rather than omitting
  // them. zod's `.optional()` permits `undefined` but NOT "", so a blank
  // SMTP_ADMIN_EMAIL crash-looped the app with "Server configuration error".
  // env.ts now strips empty strings before parsing — these pin that contract.
  describe('empty-string env vars (env_file unset values)', () => {
    // Mirror of env.ts's cleanedEnv preprocessing.
    const stripEmpty = (env: Record<string, string>) =>
      Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));

    it('a raw empty SMTP_ADMIN_EMAIL fails (documents the original crash)', () => {
      const result = envSchema.safeParse({ ...validEnv, SMTP_ADMIN_EMAIL: '' });
      expect(result.success).toBe(false);
    });

    it('stripping empties lets blank optionals validate as unset', () => {
      const result = envSchema.safeParse(
        stripEmpty({ ...validEnv, SMTP_ADMIN_EMAIL: '', REDIS_URL: '', SMTP_PORT: '' }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SMTP_ADMIN_EMAIL).toBeUndefined();
        expect(result.data.REDIS_URL).toBeUndefined();
      }
    });
  });

  // ==========================================================================
  // DRIFT GUARDS — pin the real carbon/ source this mirror models.
  // ==========================================================================
  describe('drift guards (carbon/src/server/lib/env.ts)', () => {
    const src = readFileSync(join(process.cwd(), 'carbon/src/server/lib/env.ts'), 'utf-8');

    it('strips empty strings into a cleaned object before validating', () => {
      // Must filter empties into a cleaned object and parse THAT, not raw process.env.
      expect(src).toMatch(/filter\(\(\[, value\]\) => value !== ''\)/);
      expect(src).toMatch(/safeParse\(cleanedEnv\)/);
    });

    it('defines envBool with the literal-"true" contract, not z.coerce.boolean()', () => {
      expect(src).toMatch(/const envBool =/);
      expect(src).toMatch(/v === 'true'/);
      // Boolean flags must go through envBool...
      expect(src).toMatch(/MAGIC_LINK_ENABLED: envBool\(true\)/);
      expect(src).toMatch(/GOOGLE_ENABLED: envBool\(false\)/);
      // ...and no ENABLED field may use z.coerce.boolean() (the old 'false' bug).
      // (A bare z.coerce.boolean() reference survives only in the explanatory
      // comment, so match the field-assignment form specifically.)
      expect(src).not.toMatch(/_ENABLED: z\.coerce\.boolean/);
    });

    it('has no yearly Stripe price env vars', () => {
      expect(src).not.toMatch(/STRIPE_PRICE_STARTER_YEARLY/);
      expect(src).not.toMatch(/STRIPE_PRICE_PRO_YEARLY/);
    });
  });
});
