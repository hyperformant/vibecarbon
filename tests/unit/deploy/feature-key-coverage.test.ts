import { describe, expect, it } from 'vitest';
import {
  clientBuildKeys,
  featureConfigKeys,
  featureRuntimeKeys,
  featureSecretKeys,
} from '../../../src/lib/config-registry.js';
import { buildPerEnvSecrets } from '../../../src/lib/deploy/k8s/gitops-deploy.js';
import { SECRET_KEYS } from '../../../src/lib/deploy/k8s/k3s.js';

// The guarantee: every configure-managed runtime key the registry declares is
// propagated by every k8s deploy path. If someone adds a feature key to the
// registry but forgets a path, one of these fails — not a silent prod no-op.

describe('k8s local — applyVibecarbonSecrets allowlist', () => {
  it('SECRET_KEYS ⊇ every feature runtime key (secret + non-secret)', () => {
    const allowed = new Set(SECRET_KEYS);
    for (const key of featureRuntimeKeys()) {
      expect(allowed.has(key), `SECRET_KEYS is missing ${key}`).toBe(true);
    }
  });

  it('SECRET_KEYS never carries a client-build (VITE_*) key', () => {
    const allowed = new Set(SECRET_KEYS);
    for (const key of clientBuildKeys()) {
      expect(allowed.has(key), `${key} is build-time and must not be in the Secret`).toBe(false);
    }
  });
});

describe('k8s GitOps — buildPerEnvSecrets', () => {
  // Fixture covers one key of each feature secret + non-secret + infra alias.
  const envLocal: Record<string, string> = {
    DB_PASSWORD: 'pw',
    ANON_KEY: 'anon',
    SERVICE_ROLE_KEY: 'svc',
    STRIPE_SECRET_KEY: 'sk_test_x',
    BILLING_PROVIDER: 'stripe',
    SMTP_PASS: 'smtp-secret',
    SMTP_HOST: 'smtp.example.com',
    GOOGLE_CLIENT_SECRET: 'g-secret',
  };
  const out = buildPerEnvSecrets(envLocal);

  it('emits every feature runtime key present in .env.local', () => {
    for (const key of [...featureSecretKeys(), ...featureConfigKeys()]) {
      if (envLocal[key] !== undefined) {
        expect(out[key], `buildPerEnvSecrets dropped ${key}`).toBe(envLocal[key]);
      }
    }
  });

  it('maps Supabase infra aliases', () => {
    expect(out.SUPABASE_ANON_KEY).toBe('anon');
    expect(out.SUPABASE_SERVICE_ROLE_KEY).toBe('svc');
  });

  it('uses canonical SMTP_PASS, never SMTP_PASSWORD', () => {
    expect(out.SMTP_PASS).toBe('smtp-secret');
    expect(out).not.toHaveProperty('SMTP_PASSWORD');
  });
});
