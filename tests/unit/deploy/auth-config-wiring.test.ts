/**
 * Auth config wiring: OAuth, SMTP and the session secret must reach the app
 * on every deploy mode. Auth runs inside the app (carbon/src/server/auth/),
 * so the app container itself reads every configure-managed key; there is no
 * separate auth service to map them onto.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { buildPerEnvSecrets } from '../../../src/lib/deploy/k8s/gitops-deploy.js';
import { SECRET_KEYS } from '../../../src/lib/deploy/k8s/k3s.js';
import { COMPOSE_REQUIRED_ENV_FALLBACK } from '../../../src/lib/project.js';

const ROOT = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

type ComposeService = { env_file?: string[]; environment?: string[] };
// Compose's merge tags (`!reset`, `!override`) are not YAML core; drop them.
const services = (rel: string) =>
  (
    loadYaml(read(rel).replace(/!(reset|override)\b/g, '')) as {
      services: Record<string, ComposeService>;
    }
  ).services;

describe('compose: the app reads auth config from its own environment', () => {
  const base = services('carbon/docker-compose.yml');
  const prod = services('carbon/docker-compose.prod.yml');

  it('runs no separate auth service', () => {
    expect(base.auth).toBeUndefined();
    expect(prod.auth).toBeUndefined();
  });

  it('gets the configure-managed keys (OAuth, SMTP, admin) through env_file .env', () => {
    expect(base.app.env_file).toContain('.env');
  });

  it('passes the session secret and pins the auth URL to SITE_URL', () => {
    const env = base.app.environment ?? [];
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose interpolation
    expect(env).toContain('BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-}');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose interpolation
    expect(env).toContain('BETTER_AUTH_URL=${SITE_URL:-http://localhost:5173}');
  });

  it('refuses to start in production without the session secret', () => {
    const env = prod.app.environment ?? [];
    expect(env.some((e) => /^BETTER_AUTH_SECRET=\$\{BETTER_AUTH_SECRET:\?/.test(e))).toBe(true);
  });

  // The app bootstraps the super admin from these, and every deploy waits for
  // it (wait-admin-ready). `:?` makes deploy's required-env preflight
  // (findMissingRequiredEnv) refuse a .env without them before anything is
  // provisioned, instead of a deploy that times out waiting for an admin.
  it('requires the admin credentials in production, so the preflight catches a missing one', () => {
    const env = prod.app.environment ?? [];
    for (const key of ['ADMIN_EMAIL', 'ADMIN_PASSWORD']) {
      const required = `${key}=\${${key}:?`;
      expect(
        env.some((e) => e.startsWith(required)),
        key,
      ).toBe(true);
    }
  });

  it('the preflight fallback list (no docker-compose.prod.yml) carries the auth keys too', () => {
    for (const key of ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'BETTER_AUTH_SECRET']) {
      expect(COMPOSE_REQUIRED_ENV_FALLBACK).toContain(key);
    }
  });

  it('no longer hands the app the gateway keys', () => {
    for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
      expect((base.app.environment ?? []).some((e) => e.startsWith(`${key}=`))).toBe(false);
    }
  });
});

describe('k8s: the app pod reads auth config from vibecarbon-secrets', () => {
  const deployment = read('carbon/k8s/base/app/deployment.yaml');

  it('takes every secret key (OAuth, SMTP, BETTER_AUTH_SECRET) via envFrom', () => {
    expect(deployment).toMatch(/envFrom:[\s\S]*?- secretRef:\s+name: vibecarbon-secrets/);
  });

  it('pins BETTER_AUTH_URL to the SITE_URL config key', () => {
    expect(deployment).toMatch(
      /- name: BETTER_AUTH_URL\s+valueFrom:\s+configMapKeyRef:\s+name: vibecarbon-config\s+key: SITE_URL/,
    );
  });

  // vibecarbon-secrets is built from SECRET_KEYS (dev-push) and from the
  // GitHub Environment secrets buildPerEnvSecrets seeds (GitOps). Both must
  // carry what the app's auth reads, or the pod boots without a session key
  // or the deploy waits forever for an admin that cannot be created.
  it('vibecarbon-secrets carries the session secret and the admin credentials', () => {
    for (const key of ['BETTER_AUTH_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']) {
      expect(SECRET_KEYS, key).toContain(key);
    }
    expect(SECRET_KEYS).not.toContain('ADMIN_PASSWORD_HASH');
    const perEnv = buildPerEnvSecrets({
      BETTER_AUTH_SECRET: 's'.repeat(64),
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'test-password',
    });
    expect(perEnv.BETTER_AUTH_SECRET).toBe('s'.repeat(64));
    expect(perEnv.ADMIN_EMAIL).toBe('admin@example.com');
    expect(perEnv.ADMIN_PASSWORD).toBe('test-password');
  });

  it('no GoTrue-only keys are rendered or shipped', () => {
    expect(SECRET_KEYS).not.toContain('GOTRUE_MAILER_AUTOCONFIRM');
    const k3s = read('src/lib/deploy/k8s/k3s.js');
    expect(k3s).not.toMatch(/AZURE_TENANT_URL|GOTRUE_MAILER_AUTOCONFIRM/);
  });
});
