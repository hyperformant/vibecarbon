import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Single-origin routing contract (2026-07-23): production serves ONE public
 * origin, and on compose the app owns all of it — auth (/api/auth), the API
 * and the SPA's /auth/callback landing page, which any /auth prefix rule
 * would swallow and break every login. No database gateway path is routed.
 * The retired api.<domain> host must never come back: the app server treats
 * SITE_URL as the site origin (billing return URLs, newsletter links, CSP),
 * and a split-origin regression re-breaks all of those at once.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');

describe('single-origin routing: compose prod', () => {
  const compose = read('carbon/docker-compose.prod.yml');

  it('routes no database gateway prefix, versioned or bare', () => {
    // Auth runs in the app, data goes through the app's /api, and uploads go
    // browser -> S3 via app-issued presigned URLs.
    for (const prefix of ['/rest', '/realtime', '/auth', '/storage']) {
      expect(compose).not.toContain(`${prefix}/v1`);
      expect(compose).not.toMatch(new RegExp(`PathPrefix\\(\`${prefix}\`\\)`));
    }
  });

  it('has no api.<domain> host router', () => {
    expect(compose).not.toContain('Host(`api.');
  });

  it('the app catch-all keeps an explicit lowest priority', () => {
    expect(compose).toContain('traefik.http.routers.app.priority=1');
    expect(compose).toContain('traefik.http.routers.app-http.priority=1');
  });

  it('never exposes a database-admin path (/pg) publicly', () => {
    expect(compose).not.toMatch(/PathPrefix\(`\/pg/);
  });
});

describe('single-origin routing: k8s ingress', () => {
  const ingress = read('carbon/k8s/base/traefik/ingressroute.yaml');

  it('routes only the VERSIONED Supabase prefixes to kong, on both entrypoints', () => {
    const rule = 'PathPrefix(`/rest/v1`) || PathPrefix(`/realtime/v1`)';
    const count = ingress.split(rule).length - 1;
    expect(count).toBe(2); // websecure + web(redirect)
    expect(ingress).not.toContain('/storage/v1');
    expect(ingress).not.toContain('/auth/v1');
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

describe('single-origin routing: server CSP', () => {
  it('the server never derives an api. origin from SITE_URL', () => {
    const server = read('carbon/src/server/index.ts');
    expect(server).not.toContain("https://api.'");
    expect(server).not.toContain('https://api.`');
  });
});
