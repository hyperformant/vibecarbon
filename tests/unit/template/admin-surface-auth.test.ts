import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Admin-surface auth contract (2026-07-23 security audit). The platform has
 * exactly ONE elevated role: super_admin (app_metadata.role). There is NO
 * platform `admin` role — `admin` belongs to the org-membership axis
 * (OWNER/ADMIN/MEMBER), enforced by RLS, never by ForwardAuth. So EVERY
 * privileged dashboard is super_admin-gated, and the `admin-auth` ForwardAuth
 * middleware itself requires super_admin (parity across compose + k8s); a
 * `?role=admin` / `?roles=admin,...` gate would reference a role nothing
 * assigns and create a compose-vs-k8s asymmetry trap.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');

describe('compose prod: admin surfaces are super_admin-gated', () => {
  const compose = read('carbon/docker-compose.prod.yml');

  it('studio uses super-admin-auth (full DB access — highest privilege)', () => {
    expect(compose).toContain('traefik.http.routers.studio.middlewares=super-admin-auth@file');
  });

  it('the traefik dashboard uses super-admin-auth', () => {
    expect(compose).toContain('traefik.http.routers.dashboard.middlewares=super-admin-auth@file');
  });

  it('no shipped router uses the bare admin-auth chain', () => {
    expect(compose).not.toContain('=admin-auth@file');
  });
});

describe('ForwardAuth gates require super_admin on every edge (no phantom admin role)', () => {
  it.each([
    'carbon/volumes/traefik/middlewares.yml',
    'carbon/volumes/traefik/middlewares.dev.yml',
    'carbon/k8s/base/traefik/middleware.yaml',
  ])('%s admin-auth gate requires role=super_admin', (rel) => {
    const mw = read(rel);
    expect(mw).toMatch(/verify-role\?role=super_admin/);
    // The phantom-admin forms must never come back.
    expect(mw).not.toContain('verify-role?role=admin');
    expect(mw).not.toContain('roles=admin,super_admin');
  });
});

describe('verify-role (ForwardAuth trust anchor) is not publicly reachable', () => {
  it('compose denies the public /api/_internal/verify-role route (internal-only)', () => {
    const compose = read('carbon/docker-compose.prod.yml');
    expect(compose).toContain('PathPrefix(`/api/_internal/verify-role`)');
    expect(compose).toContain('app-internal-deny.middlewares=internal-only@file');
  });

  it('k8s denies the public verify-role route via the internal-only middleware', () => {
    const ingress = read('carbon/k8s/base/traefik/ingressroute.yaml');
    expect(ingress).toMatch(/PathPrefix\(`\/api\/_internal\/verify-role`\)[\s\S]*?internal-only/);
  });

  it('the browser-facing /api/_internal/services path is NOT blanket-blocked', () => {
    // services/status + restart + logs are called by the admin panel and stay
    // public (super_admin-gated in-handler); only verify-role is denied.
    const compose = read('carbon/docker-compose.prod.yml');
    expect(compose).not.toContain('PathPrefix(`/api/_internal`)');
  });
});
