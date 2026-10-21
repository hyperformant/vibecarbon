import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAppSecretData, buildInfraSecretData } from '../../../src/lib/deploy/k8s/k3s.js';

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
  it('the redis pod gets REDIS_PASSWORD from the infra Secret, the app REDIS_URL from its own', () => {
    // The redis Deployment's secretKeyRef REQUIRES REDIS_PASSWORD (pod cannot
    // start without it), and the app receives REDIS_URL via envFrom on its
    // Secret. Both shipped missing for months — the k8s redis addon was DOA.
    const envLocal = { REDIS_ENABLED: 'true', REDIS_PASSWORD: 'SENTINEL_REDIS_PASSWORD' };
    expect(buildInfraSecretData({ envLocal }).REDIS_PASSWORD).toBe('SENTINEL_REDIS_PASSWORD');
    const app = buildAppSecretData({ envLocal });
    expect(app.REDIS_URL).toBe('redis://:SENTINEL_REDIS_PASSWORD@redis:6379');
    expect(app).not.toHaveProperty('REDIS_PASSWORD');
    const redis = readFileSync(join(process.cwd(), 'services/redis/k8s/deployment.yaml'), 'utf-8');
    expect(redis).toMatch(/secretKeyRef:\s+name: vibecarbon-infra-secrets\s+key: REDIS_PASSWORD/);
  });

  it('neither Secret wires redis when the addon is off', () => {
    const envLocal = { REDIS_PASSWORD: 'SENTINEL_REDIS_PASSWORD' };
    expect(buildInfraSecretData({ envLocal })).not.toHaveProperty('REDIS_PASSWORD');
    expect(buildAppSecretData({ envLocal })).not.toHaveProperty('REDIS_URL');
  });
});
