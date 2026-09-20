import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_KEYS,
  clientBuildKeys,
  entriesForScopes,
  featureConfigKeys,
  featureRuntimeKeys,
  featureSecretKeys,
  isOperatorKey,
  isSecretKey,
  operatorSecretKeys,
  registryEntry,
  stripOperatorSecretLines,
} from '../../src/lib/config-registry.js';

describe('config-registry', () => {
  it('every entry has a valid class', () => {
    const valid = new Set(['client-build', 'runtime-config', 'runtime-secret', 'operator-secret']);
    for (const entry of CONFIG_KEYS) {
      expect(valid.has(entry.class), `${entry.key} has class ${entry.class}`).toBe(true);
      expect(typeof entry.key).toBe('string');
      expect(entry.key.length).toBeGreaterThan(0);
      expect(typeof entry.feature).toBe('string');
    }
  });

  it('has no duplicate keys', () => {
    const keys = CONFIG_KEYS.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('client-build keys are all VITE_*', () => {
    for (const key of clientBuildKeys()) {
      expect(key.startsWith('VITE_'), `${key} should start with VITE_`).toBe(true);
    }
  });

  it('runtime keys are never VITE_* (build-time only)', () => {
    for (const key of featureRuntimeKeys()) {
      expect(key.startsWith('VITE_'), `${key} should not be a build-time key`).toBe(false);
    }
  });

  it('includes the known feature secrets', () => {
    const secrets = new Set(featureSecretKeys());
    for (const key of [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'PADDLE_API_KEY',
      'PADDLE_WEBHOOK_SECRET',
      'POLAR_ACCESS_TOKEN',
      'POLAR_WEBHOOK_SECRET',
      'GOOGLE_CLIENT_SECRET',
      'MICROSOFT_CLIENT_SECRET',
      'SMTP_PASS',
    ]) {
      expect(secrets.has(key), `${key} should be a feature secret`).toBe(true);
    }
  });

  it('uses canonical SMTP_PASS, not SMTP_PASSWORD', () => {
    const keys = CONFIG_KEYS.map((k) => k.key);
    expect(keys).toContain('SMTP_PASS');
    expect(keys).not.toContain('SMTP_PASSWORD');
  });

  it('featureRuntimeKeys is the union of config + secret keys with no overlap', () => {
    const config = new Set(featureConfigKeys());
    const secret = new Set(featureSecretKeys());
    for (const key of secret) expect(config.has(key)).toBe(false);
    expect(featureRuntimeKeys().sort()).toEqual(
      [...featureConfigKeys(), ...featureSecretKeys()].sort(),
    );
  });

  it('isSecretKey reflects classification', () => {
    expect(isSecretKey('STRIPE_SECRET_KEY')).toBe(true);
    expect(isSecretKey('BILLING_PROVIDER')).toBe(false);
    expect(isSecretKey('VITE_PLAUSIBLE_DOMAIN')).toBe(false);
    expect(isSecretKey('NONEXISTENT')).toBe(false);
  });

  describe('operator-secret class (provider credentials)', () => {
    const EXPECTED_OPERATOR_KEYS = [
      'HETZNER_API_TOKEN',
      'HETZNER_ACCESS_KEY',
      'HETZNER_SECRET_KEY',
      'DIGITALOCEAN_API_TOKEN',
      'DIGITALOCEAN_ACCESS_KEY',
      'DIGITALOCEAN_SECRET_KEY',
      'DIGITALOCEAN_PROJECT_ID',
      'CLOUDFLARE_API_TOKEN',
      'LINODE_API_TOKEN',
      'LINODE_ACCESS_KEY',
      'LINODE_SECRET_KEY',
      'LINODE_STORAGE_REGION',
      'VULTR_API_TOKEN',
      'VULTR_ACCESS_KEY',
      'VULTR_SECRET_KEY',
      'VULTR_STORAGE_REGION',
      // Scaleway is a credential TRIPLE: the Pulumi provider requires all
      // three (ScalewayProvider.buildIacEnv) and the SAME pair signs S3 —
      // no separate object-storage keys. SCALEWAY_DEFAULT_PROJECT_ID is not a
      // secret as such but rides the class for its two guarantees
      // (.env.local only + bundle-baseline strip), like Vultr's REGION.
      'SCALEWAY_SECRET_KEY',
      'SCALEWAY_ACCESS_KEY',
      'SCALEWAY_DEFAULT_PROJECT_ID',
      'SCALEWAY_STORAGE_REGION',
      // Object-storage REGION overrides for Hetzner/DigitalOcean, added
      // alongside Vultr/Linode/Scaleway's existing rows above (operator
      // config hygiene pass — these are keys deploy reads outside configure).
      'HETZNER_STORAGE_REGION',
      'DIGITALOCEAN_STORAGE_REGION',
      // Docker Hub is now registry-backed (operator-shell-level: `where`
      // is 'operator shell', never written to a file — see the
      // "operator-secret entries live in .env.local or the operator
      // shell" test below and the DOCKER_HUB-specific test further down).
      'DOCKER_HUB_USERNAME',
      'DOCKER_HUB_TOKEN',
      // CLI-local operator overrides that ride the same guarantees
      // (.env.local only, stripped from any bundle baseline).
      'PULUMI_BACKEND_URL',
      'ACME_CA_SERVER',
    ];

    it('operatorSecretKeys returns exactly the provider credential keys', () => {
      expect(operatorSecretKeys().sort()).toEqual([...EXPECTED_OPERATOR_KEYS].sort());
    });

    it('every operator-secret key belongs to the providers feature', () => {
      for (const key of EXPECTED_OPERATOR_KEYS) {
        const entry = CONFIG_KEYS.find((k) => k.key === key);
        expect(entry, `${key} missing from CONFIG_KEYS`).toBeDefined();
        expect(entry.class).toBe('operator-secret');
        expect(entry.feature).toBe('providers');
      }
    });

    it('classifies DOCKER_HUB_* as operator-secret with where: "operator shell" (never written to a file)', () => {
      // Registered (operator config hygiene pass) so deploy's credential
      // resolution (src/lib/deploy/docker-hub.js) and the registry-driven
      // docs generator both derive from this registry — but `configure`'s
      // Docker Hub row stays informational (run() returns {}), so these
      // must never gain a `where` of '.env' or '.env.local'.
      for (const key of ['DOCKER_HUB_USERNAME', 'DOCKER_HUB_TOKEN']) {
        const entry = CONFIG_KEYS.find((k) => k.key === key);
        expect(entry, `${key} missing from CONFIG_KEYS`).toBeDefined();
        expect(entry.class).toBe('operator-secret');
        expect(entry.where).toBe('operator shell');
      }
    });

    it('isSecretKey treats operator-secret keys as secrets', () => {
      for (const key of EXPECTED_OPERATOR_KEYS) {
        expect(isSecretKey(key), `${key} should be a secret`).toBe(true);
      }
    });

    it('featureRuntimeKeys excludes operator-secret keys by construction', () => {
      const runtime = new Set(featureRuntimeKeys());
      for (const key of EXPECTED_OPERATOR_KEYS) {
        expect(runtime.has(key), `${key} must never propagate to a pod/container`).toBe(false);
      }
    });

    it('featureSecretKeys excludes operator-secret keys (separate accessor)', () => {
      const secrets = new Set(featureSecretKeys());
      for (const key of EXPECTED_OPERATOR_KEYS) {
        expect(secrets.has(key)).toBe(false);
      }
    });

    it('clientBuildKeys excludes operator-secret keys', () => {
      const clientBuild = new Set(clientBuildKeys());
      for (const key of EXPECTED_OPERATOR_KEYS) {
        expect(clientBuild.has(key)).toBe(false);
      }
    });

    it('isOperatorKey is true for every operator-secret key, false for everything else', () => {
      for (const key of EXPECTED_OPERATOR_KEYS) {
        expect(isOperatorKey(key), `${key} should be an operator key`).toBe(true);
      }
      expect(isOperatorKey('STRIPE_SECRET_KEY')).toBe(false);
      expect(isOperatorKey('BILLING_PROVIDER')).toBe(false);
      expect(isOperatorKey('NONEXISTENT')).toBe(false);
    });

    describe('stripOperatorSecretLines', () => {
      it('drops every operator-secret KEY=value line, keeps everything else', () => {
        const content = [
          "HETZNER_API_TOKEN='leaked-token'",
          "HETZNER_ACCESS_KEY='leaked-access'",
          "HETZNER_SECRET_KEY='leaked-secret'",
          "DIGITALOCEAN_API_TOKEN='leaked-do'",
          "DIGITALOCEAN_ACCESS_KEY='leaked-spaces-key'",
          "DIGITALOCEAN_SECRET_KEY='leaked-spaces-secret'",
          "CLOUDFLARE_API_TOKEN='leaked-cf'",
          "STRIPE_SECRET_KEY='sk_live_keep_me'",
          "DOMAIN='keep-me.example'",
        ].join('\n');

        const stripped = stripOperatorSecretLines(content);

        for (const key of EXPECTED_OPERATOR_KEYS) {
          expect(stripped).not.toContain(key);
        }
        expect(stripped).toContain('STRIPE_SECRET_KEY');
        expect(stripped).toContain('DOMAIN');
      });

      it('is a no-op when no operator-secret keys are present', () => {
        const content = "FOO='bar'\nBAZ='qux'";
        expect(stripOperatorSecretLines(content)).toBe(content);
      });

      it('handles empty content', () => {
        expect(stripOperatorSecretLines('')).toBe('');
      });
    });
  });

  describe('shape metadata', () => {
    it('every entry has a kind, a where, and a scope', () => {
      for (const e of CONFIG_KEYS) {
        expect(e.kind, e.key).toBeTruthy();
        expect(['.env.local', '.env', 'operator shell', 'tests/.env.e2e'], e.key).toContain(
          e.where,
        );
        expect(e.scope, e.key).toMatch(/^[a-z]+(:[a-z]+)?$/);
      }
    });
    it('every entry with a shape has a sample that satisfies it', () => {
      for (const e of CONFIG_KEYS.filter((e) => e.shape)) {
        expect(e.sample, `${e.key} needs a sample`).toBeTruthy();
        expect(e.shape.describe, `${e.key} shape needs describe`).toBeTruthy();
        if (e.shape.regex) expect(e.sample, e.key).toMatch(e.shape.regex);
        if (e.shape.minLen) expect(e.sample.length, e.key).toBeGreaterThanOrEqual(e.shape.minLen);
        if (e.shape.values) expect(e.shape.values, e.key).toContain(e.sample);
      }
    });
    it('operator-secret entries live in .env.local or the operator shell', () => {
      for (const e of CONFIG_KEYS.filter((e) => e.class === 'operator-secret')) {
        expect(['.env.local', 'operator shell'], e.key).toContain(e.where);
      }
    });
    it('registers the keys deploy reads outside configure', () => {
      for (const k of [
        'DOCKER_HUB_USERNAME',
        'DOCKER_HUB_TOKEN',
        'ALLOWED_SSH_IPS',
        'HETZNER_STORAGE_REGION',
        'DIGITALOCEAN_STORAGE_REGION',
        'SCALEWAY_STORAGE_REGION',
        'PULUMI_BACKEND_URL',
        'ACME_CA_SERVER',
      ]) {
        expect(registryEntry(k), k).toBeDefined();
      }
    });
    it('tight shapes exist only where the vendor documents the format', () => {
      const tight = CONFIG_KEYS.filter((e) => e.shape?.regex)
        .map((e) => e.key)
        .sort();
      expect(tight).toEqual([
        'ACME_CA_SERVER',
        'ALLOWED_SSH_IPS',
        'DIGITALOCEAN_PROJECT_ID',
        'DOCKER_HUB_TOKEN',
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'HETZNER_API_TOKEN',
        'MICROSOFT_TENANT_ID',
        'PULUMI_BACKEND_URL',
        'SMTP_ADMIN_EMAIL',
        'SMTP_PORT',
        'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET',
      ]);
      // POLAR_ACCESS_TOKEN was removed from this list (review 2026-09-19):
      // the `polar_oat_` prefix it used was unverified against Polar's docs.
      // This list IS the decision record for which formats are vendor-backed
      // enough to assert — it stays loose (minLen only) until confirmed.
    });
    it('SMTP_PORT is bounded to the real port range, not just 1-5 digits', () => {
      const { regex } = registryEntry('SMTP_PORT').shape;
      expect('0').not.toMatch(regex);
      expect('70000').not.toMatch(regex);
      expect('99999').not.toMatch(regex);
      expect('587').toMatch(regex);
      expect('65535').toMatch(regex);
    });
    it('entriesForScopes selects by scope', () => {
      const keys = entriesForScopes(['provider:hetzner'])
        .map((e) => e.key)
        .sort();
      expect(keys).toEqual([
        'HETZNER_ACCESS_KEY',
        'HETZNER_API_TOKEN',
        'HETZNER_SECRET_KEY',
        'HETZNER_STORAGE_REGION',
      ]);
    });
    it('existing derived views are unchanged by the metadata', () => {
      expect(featureRuntimeKeys()).not.toContain('HETZNER_API_TOKEN');
      expect(isOperatorKey('DOCKER_HUB_TOKEN')).toBe(true);
      // ALLOWED_SSH_IPS is NOT operator-secret: `vibecarbon access` persists
      // the allowlist to .vibecarbon.json, never via setEnvVar's `localOnly`
      // (checked in src/access.js — it never touches an env file at all), so
      // the flip condition doesn't apply. It ships in plain `.env` like any
      // other runtime-config key (read by the CLI's operator-ip bootstrap and
      // by the Pulumi IaC programs as a firewall-rule input, never a
      // credential).
      expect(isOperatorKey('ALLOWED_SSH_IPS')).toBe(false);
    });
  });
});

/**
 * Census: for every configure-collected key (feature billing/oauth/smtp —
 * the ones `configure`'s prompts write) that appears in
 * `carbon/src/server/lib/env.ts`, the registry's `optional` may never be
 * LOOSER than env.ts's `.optional()`. This is a ONE-DIRECTIONAL rule
 * (env.ts required ⇒ registry required), not equality — the two flags mean
 * different things and conflating them is exactly how this rule's
 * predecessor got it wrong twice:
 *
 *   - env.ts `.optional()`  → "this whole FEATURE may be left disabled"
 *     (no Stripe key at all because billing isn't used; no SMTP host at
 *     all because email isn't set up). Nearly every feature key is
 *     `.optional()` there for exactly this reason.
 *   - registry `optional`   → "blank is a legitimate answer WHILE the
 *     operator is actively configuring this section" — the STRICTER of the
 *     two. A key can be `.optional()` in env.ts (the feature is skippable)
 *     while still `optional: false`/unset in the registry (once you're in
 *     that section, the field is load-bearing) — e.g. STRIPE_SECRET_KEY:
 *     billing-as-a-whole can be skipped, but a configured Stripe section
 *     needs its secret key. That is fine and is the NORMAL case for
 *     section-load-bearing fields. What must never happen is the reverse:
 *     env.ts says a key is REQUIRED (no `.optional()` at all — the app
 *     will refuse to boot without it) while the registry lets the prompt
 *     accept blank — that would silently write a value the app itself
 *     insists on.
 *
 * History: PADDLE_PRICE_STARTER/PRO, POLAR_PRICE_STARTER/PRO and
 * POLAR_ORGANIZATION_ID were first found hard-required at the prompt while
 * the runtime already tolerated blank (billing.ts's per-tier price map,
 * polar.ts's conditional organization_id) — too strict, and the bug this
 * census exists to catch. A follow-up fix then over-corrected by mirroring
 * env.ts's `.optional()` one-to-one (equality, not one-directional), which
 * would have made SMTP_HOST/PORT/USER/PASS/ADMIN_EMAIL and the primary
 * provider secrets (STRIPE_SECRET_KEY, PADDLE_API_KEY, POLAR_ACCESS_TOKEN,
 * their webhook secrets) skippable mid-section — too loose. This
 * one-directional rule is the version that actually holds.
 *
 * A handful of oauth keys (GOOGLE_CLIENT_ID/SECRET, MICROSOFT_CLIENT_ID/
 * SECRET/TENANT_ID) and one smtp key (GOTRUE_MAILER_AUTOCONFIRM) never
 * appear in env.ts at all — they're read by the GoTrue auth service
 * container's own env, not the app's zod schema — so there is no boot-time
 * contract to compare against. They're listed explicitly below rather than
 * silently skipped, so a key that starts appearing in env.ts is noticed.
 */
describe('config-registry ↔ carbon env.ts — registry is never looser than env.ts', () => {
  const ENV_TS_PATH = join(process.cwd(), 'carbon/src/server/lib/env.ts');
  const CONFIGURE_FEATURES = new Set(['billing', 'oauth', 'smtp']);

  const NOT_IN_ENV_SCHEMA: Record<string, string> = {
    GOOGLE_CLIENT_ID: 'read by the GoTrue auth service container env, not the app zod schema',
    GOOGLE_CLIENT_SECRET: 'read by the GoTrue auth service container env, not the app zod schema',
    MICROSOFT_CLIENT_ID: 'read by the GoTrue auth service container env, not the app zod schema',
    MICROSOFT_CLIENT_SECRET:
      'read by the GoTrue auth service container env, not the app zod schema',
    MICROSOFT_TENANT_ID: 'read by the GoTrue auth service container env, not the app zod schema',
    GOTRUE_MAILER_AUTOCONFIRM:
      'read by the GoTrue auth service container env, not the app zod schema',
  };

  /** Maps each envSchema field name to whether its zod chain is `.optional()`. */
  function parseEnvSchemaOptionality(): Record<string, boolean> {
    const src = readFileSync(ENV_TS_PATH, 'utf-8');
    const match = src.match(/envSchema = z\.object\(\{([\s\S]*?)\n\}\);/);
    if (!match) throw new Error('could not find `envSchema = z.object({ ... })` in env.ts');
    const body = match[1];
    const result: Record<string, boolean> = {};
    const lineRe = /^\s*([A-Z][A-Z0-9_]*):\s*(.+),\s*$/gm;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
    while ((m = lineRe.exec(body))) {
      result[m[1]] = /\.optional\(\)/.test(m[2]);
    }
    return result;
  }

  /**
   * The one-directional check itself, factored out so it can be exercised
   * directly against a synthetic fixture (see the negative-fixture test
   * below) as well as against the real registry + env.ts.
   *
   * A violation is: env.ts requires the key (not `.optional()`) AND the
   * registry marks it `optional: true`. Everything else is fine, including
   * a registry-required / env-optional pair (the normal, section-load-
   * bearing case) and a registry-optional / env-optional pair.
   */
  function looserThanEnvViolations(
    entries: Array<{ key: string; optional?: boolean }>,
    envOptionality: Record<string, boolean>,
    notInSchema: Record<string, string>,
  ): string[] {
    const violations: string[] = [];
    for (const entry of entries) {
      if (entry.key in notInSchema) continue;
      if (!(entry.key in envOptionality)) continue;
      const envRequired = envOptionality[entry.key] === false;
      const registryOptional = Boolean(entry.optional);
      if (envRequired && registryOptional) {
        violations.push(
          `${entry.key}: registry optional=true but env.ts requires it (no .optional())`,
        );
      }
    }
    return violations;
  }

  it('every configure-collected key present in env.ts is accounted for (not silently skipped)', () => {
    const envOptionality = parseEnvSchemaOptionality();
    // Guards the parser itself: env.ts must have real optional/required keys
    // to compare against, or this test would pass vacuously.
    expect(Object.keys(envOptionality).length).toBeGreaterThan(20);
    expect(envOptionality.SUPABASE_URL).toBe(false);
    expect(envOptionality.STRIPE_WEBHOOK_SECRET).toBe(true);

    const relevant = CONFIG_KEYS.filter((k) => CONFIGURE_FEATURES.has(k.feature));
    const untracked = relevant
      .filter((e) => !(e.key in NOT_IN_ENV_SCHEMA) && !(e.key in envOptionality))
      .map((e) => e.key);

    expect(
      untracked,
      'not found in env.ts and not explained in NOT_IN_ENV_SCHEMA — add a line there with why',
    ).toEqual([]);
  });

  it('the registry is never looser than env.ts: env.ts required ⇒ registry required', () => {
    const envOptionality = parseEnvSchemaOptionality();
    const relevant = CONFIG_KEYS.filter((k) => CONFIGURE_FEATURES.has(k.feature));

    const violations = looserThanEnvViolations(relevant, envOptionality, NOT_IN_ENV_SCHEMA);

    expect(
      violations,
      `registry is optional for a key env.ts requires:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('negative fixture: the check DOES catch a registry-optional/env-required pair, and does not false-positive on the normal (registry-required/env-optional) or (registry-optional/env-optional) cases', () => {
    const envRequired = { FAKE_REQUIRED_KEY: false };
    const envOptional = { FAKE_OPTIONAL_KEY: true };

    // The bug shape: env.ts requires it, registry lets the prompt skip it.
    expect(
      looserThanEnvViolations([{ key: 'FAKE_REQUIRED_KEY', optional: true }], envRequired, {}),
    ).toEqual([
      'FAKE_REQUIRED_KEY: registry optional=true but env.ts requires it (no .optional())',
    ]);

    // Registry-required while env.ts requires it too — fine.
    expect(
      looserThanEnvViolations([{ key: 'FAKE_REQUIRED_KEY', optional: false }], envRequired, {}),
    ).toEqual([]);

    // The normal, section-load-bearing case: env.ts says the FEATURE is
    // skippable, but the registry still requires the field once you're
    // configuring that section (e.g. STRIPE_SECRET_KEY). Not a violation.
    expect(
      looserThanEnvViolations([{ key: 'FAKE_OPTIONAL_KEY', optional: false }], envOptional, {}),
    ).toEqual([]);

    // Both agree the field can be blank — fine (e.g. SMTP_SENDER_NAME).
    expect(
      looserThanEnvViolations([{ key: 'FAKE_OPTIONAL_KEY', optional: true }], envOptional, {}),
    ).toEqual([]);

    // A key listed in notInSchema (or simply absent from envOptionality) is
    // never checked, regardless of its registry `optional`.
    expect(
      looserThanEnvViolations([{ key: 'FAKE_REQUIRED_KEY', optional: true }], envRequired, {
        FAKE_REQUIRED_KEY: 'excused for this fixture',
      }),
    ).toEqual([]);
  });

  it('NOT_IN_ENV_SCHEMA cannot rot: every listed key is a real registry entry still absent from env.ts', () => {
    const envOptionality = parseEnvSchemaOptionality();
    const stale = Object.keys(NOT_IN_ENV_SCHEMA).filter(
      (key) => !registryEntry(key) || key in envOptionality,
    );
    expect(
      stale,
      'listed as absent from env.ts, but either left the registry or now appears in env.ts',
    ).toEqual([]);
  });
});
