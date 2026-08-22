import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminServices, getServiceUrl } from '@/lib/admin-services';

function service(id: string) {
  const found = adminServices.find((s) => s.id === id);
  if (!found) throw new Error(`unknown admin service id: ${id}`);
  return found;
}

function setLocation(href: string) {
  Object.defineProperty(window, 'location', {
    value: new URL(href),
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getServiceUrl', () => {
  it('compose: panels are subdomains of the domain the app is served at', () => {
    // docker-compose.prod.yml routes the app at Host(`${DOMAIN}`) and the
    // panels at studio./traefik./grafana.${DOMAIN}, so the current hostname
    // IS the base domain. Regression guard: stripping the first label off an
    // apex hostname produced studio.com / traefik.com / grafana.com.
    setLocation('https://example.com/admin');
    expect(getServiceUrl(service('database'))).toBe('https://studio.example.com');
    expect(getServiceUrl(service('gateway'))).toBe('https://traefik.example.com');
    expect(getServiceUrl(service('monitoring'))).toBe('https://grafana.example.com');
  });

  it('compose: multi-label DOMAIN keeps every label', () => {
    setLocation('https://app.example.co.uk/');
    expect(getServiceUrl(service('database'))).toBe('https://studio.app.example.co.uk');
  });

  it('dev: localhost uses subdomain routing without the port', () => {
    setLocation('http://localhost:5173/admin');
    expect(getServiceUrl(service('database'))).toBe('http://studio.localhost');
  });

  it('k8s: path routing mode appends adminPath to the origin', () => {
    vi.stubEnv('VITE_ROUTING_MODE', 'path');
    setLocation('https://example.com/admin');
    expect(getServiceUrl(service('database'))).toBe('https://example.com/admin/studio');
    expect(getServiceUrl(service('gateway'))).toBe(
      'https://example.com/admin/traefik/dashboard/',
    );
  });
});
