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

  it('the chart runs no auth service', () => {
    expect(read('carbon/k8s/values/supabase.values.yaml')).toMatch(
      /^deployment:\n {2}auth:\n(?: {4}#.*\n)* {4}enabled: false$/m,
    );
  });
});
