import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Where the app looks for Traefik. On k8s that is the `traefik-dashboard`
 * Service in the app's namespace (carbon/k8s/base/traefik/service.yaml), which
 * publishes the `--ping` entrypoint on 8080.
 */
async function urlWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return (await import('@server/lib/traefik-probe')).TRAEFIK_HEALTH_URL;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('TRAEFIK_HEALTH_URL', () => {
  it('k8s: the ping entrypoint on the traefik-dashboard Service', async () => {
    expect(await urlWith({ KUBERNETES_SERVICE_HOST: '10.43.0.1' })).toBe(
      'http://traefik-dashboard:8080/ping',
    );
  });

  it('compose: the traefik service on the shared network', async () => {
    expect(await urlWith({ KUBERNETES_SERVICE_HOST: '', NODE_ENV: 'production' })).toBe(
      'http://traefik:80/',
    );
  });

  it('local dev: the published Traefik port, shifted by DEV_PORT_OFFSET', async () => {
    expect(
      await urlWith({
        KUBERNETES_SERVICE_HOST: '',
        NODE_ENV: 'development',
        DOCKER: '',
        DEV_TRAEFIK_PORT: '',
        DEV_PORT_OFFSET: '100',
      }),
    ).toBe('http://localhost:180/');
  });
});
