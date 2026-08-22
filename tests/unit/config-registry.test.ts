import { describe, expect, it } from 'vitest';
import {
  CONFIG_KEYS,
  clientBuildKeys,
  featureConfigKeys,
  featureRuntimeKeys,
  featureSecretKeys,
  isOperatorKey,
  isSecretKey,
  operatorSecretKeys,
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

    it('does NOT classify DOCKER_HUB_* as operator-secret (operator-shell-level, outside the project store)', () => {
      const keys = CONFIG_KEYS.map((k) => k.key);
      expect(keys).not.toContain('DOCKER_HUB_USERNAME');
      expect(keys).not.toContain('DOCKER_HUB_TOKEN');
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
});
