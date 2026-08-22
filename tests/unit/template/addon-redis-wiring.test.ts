import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Redis addon wiring contract (2026-07-23): `vibecarbon add redis` must wire
 * the APP to the Redis container, not just provision it. The app's only Redis
 * consumer (the distributed rate-limit store) reads REDIS_URL and silently
 * falls back to in-memory when it is absent — which shipped for months as an
 * idle Redis container next to non-distributed rate limiting. The overlay
 * extends the app service with a password-bearing connection URL.
 */
describe('redis addon: app wiring', () => {
  const overlay = readFileSync(
    join(process.cwd(), 'services/redis/compose/docker-compose.yml'),
    'utf-8',
  );

  it('extends the app service with a password-bearing REDIS_URL', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose interpolation, not a JS template
    expect(overlay).toContain('REDIS_URL: "redis://:${REDIS_PASSWORD}@redis:6379"');
  });

  it('redis still requires auth (requirepass)', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose interpolation, not a JS template
    expect(overlay).toContain('--requirepass ${REDIS_PASSWORD}');
  });
});

describe('redis addon: k8s wiring', () => {
  it('applyVibecarbonSecrets injects REDIS_PASSWORD + REDIS_URL when the addon is on', () => {
    // The redis Deployment's secretKeyRef REQUIRES REDIS_PASSWORD in
    // vibecarbon-secrets (pod cannot start without it), and the app receives
    // REDIS_URL via envFrom on the same Secret. Both shipped missing for
    // months — the k8s redis addon was DOA. Source-contract guard.
    const k3s = readFileSync(join(process.cwd(), 'src/lib/deploy/k8s/k3s.js'), 'utf-8');
    expect(k3s).toContain("envLocal.REDIS_ENABLED === 'true' && envLocal.REDIS_PASSWORD");
    expect(k3s).toContain('stringData.REDIS_PASSWORD = envLocal.REDIS_PASSWORD;');
    expect(k3s).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserted source is a JS template literal
      'stringData.REDIS_URL = `redis://:${envLocal.REDIS_PASSWORD}@redis:6379`;',
    );
  });
});
