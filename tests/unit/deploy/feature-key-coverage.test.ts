import { describe, expect, it } from 'vitest';
import { clientBuildKeys, featureRuntimeKeys } from '../../../src/lib/config-registry.js';
import { SECRET_KEYS } from '../../../src/lib/deploy/k8s/k3s.js';

// The guarantee: every configure-managed runtime key the registry declares is
// propagated by the k8s deploy (a GitOps cluster gets its Secrets from it
// too). If someone adds a feature key to the registry but forgets a path, one
// of these fails — not a silent prod no-op.

describe('k8s local — applyVibecarbonSecrets allowlist', () => {
  it('SECRET_KEYS ⊇ every feature runtime key (secret + non-secret)', () => {
    const allowed = new Set(SECRET_KEYS);
    for (const key of featureRuntimeKeys()) {
      expect(allowed.has(key), `SECRET_KEYS is missing ${key}`).toBe(true);
    }
  });

  it('SECRET_KEYS never carries a client-build (VITE_*) key the server does not read', () => {
    const allowed = new Set(SECRET_KEYS);
    // The app server reads the Plausible pair at runtime too (its CSP and
    // setup status, carbon/src/server/index.ts and routes/v1/setup.ts), so
    // the app allowlist carries it; every other VITE_* key is build-time only.
    const serverRead = new Set(['VITE_PLAUSIBLE_DOMAIN', 'VITE_PLAUSIBLE_SCRIPT_URL']);
    for (const key of clientBuildKeys().filter((k) => !serverRead.has(k))) {
      expect(allowed.has(key), `${key} is build-time and must not be in the Secret`).toBe(false);
    }
  });

  it("never carries the removed services' secrets, and SMTP's password is SMTP_PASS", () => {
    for (const key of ['JWT_SECRET', 'VAULT_ENC_KEY', 'SMTP_PASSWORD']) {
      expect(SECRET_KEYS, key).not.toContain(key);
    }
    expect(SECRET_KEYS).toContain('SMTP_PASS');
  });
});
