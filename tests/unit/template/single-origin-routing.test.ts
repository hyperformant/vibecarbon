import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Single-origin routing contract (2026-07-23): production serves ONE public
 * origin. Traefik routes the versioned Supabase prefixes (/auth/v1, /rest/v1,
 * /realtime/v1, /storage/v1) on the apex to Kong; the app owns everything
 * else — including the SPA's /auth/callback OAuth landing page, which a bare
 * /auth prefix rule would swallow (Kong 404s it, breaking every OAuth login).
 * The retired api.<domain> host must never come back: the app server treats
 * SITE_URL as the site origin (billing return URLs, newsletter links, CSP),
 * and a split-origin regression re-breaks all of those at once.
 */

const KONG_PREFIXES = ['/auth/v1', '/rest/v1', '/realtime/v1', '/storage/v1'];

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');

describe('single-origin routing: compose prod', () => {
  const compose = read('carbon/docker-compose.prod.yml');

  it('routes the versioned Supabase prefixes on the apex to kong', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose ${DOMAIN} interpolation, not a JS template
    const kongRule = 'traefik.http.routers.kong.rule=Host(`${DOMAIN:-localhost}`) && ';
    expect(compose).toContain(
      kongRule +
        '(PathPrefix(`/auth/v1`) || PathPrefix(`/rest/v1`) || ' +
        'PathPrefix(`/realtime/v1`) || PathPrefix(`/storage/v1`))',
    );
    expect(compose).toContain('traefik.http.routers.kong.priority=10');
  });

  it('has no api.<domain> host router', () => {
    expect(compose).not.toContain('Host(`api.');
  });

  it('the app catch-all keeps an explicit lower priority than kong', () => {
    expect(compose).toContain('traefik.http.routers.app.priority=1');
    expect(compose).toContain('traefik.http.routers.app-http.priority=1');
  });

  it('never exposes postgres-meta (/pg) publicly', () => {
    expect(compose).not.toMatch(/PathPrefix\(`\/pg/);
  });
});

describe('single-origin routing: k8s ingress', () => {
  const ingress = read('carbon/k8s/base/traefik/ingressroute.yaml');

  it('routes only the VERSIONED Supabase prefixes to kong, on both entrypoints', () => {
    const rule =
      'PathPrefix(`/auth/v1`) || PathPrefix(`/rest/v1`) || ' +
      'PathPrefix(`/realtime/v1`) || PathPrefix(`/storage/v1`)';
    const count = ingress.split(rule).length - 1;
    expect(count).toBe(2); // websecure + web(redirect)
  });

  it('never uses bare (unversioned) Supabase prefixes — the SPA owns /auth/callback', () => {
    for (const bare of ['/auth', '/rest', '/realtime', '/storage']) {
      expect(ingress).not.toMatch(new RegExp(`PathPrefix\\(\`${bare}\`\\)`));
    }
  });

  it('never exposes postgres-meta (/pg) publicly', () => {
    expect(ingress).not.toMatch(/PathPrefix\(`\/pg/);
  });
});

describe('single-origin routing: kong parity + server CSP', () => {
  it('every Traefik-routed prefix exists as a Kong route path', () => {
    const kong = read('carbon/volumes/kong/kong.yml');
    for (const prefix of KONG_PREFIXES) {
      expect(kong).toContain(prefix);
    }
  });

  it('the server never derives an api. origin from SITE_URL', () => {
    const server = read('carbon/src/server/index.ts');
    expect(server).not.toContain("https://api.'");
    expect(server).not.toContain('https://api.`');
  });
});
