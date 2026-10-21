/**
 * The app never holds the database owner's password (security plan
 * 2026-10-20, Task 2, ruling R8). The app connects as `app_service` with
 * APP_DB_PASSWORD; migrations run as `postgres` outside the app process, in
 * the compose `app-migrate` one-shot and the k8s `migrate` init container,
 * and only those steps get the owner password.
 *
 * Compose is read from the template files (base + prod) and interpolated
 * against a sentinel `.env`, the way compose resolves `${VAR}`; the docker
 * tier's compose-secret-reach test checks the same against a real
 * `docker compose config`. Every value is a SENTINEL_<NAME> stand-in.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { APP_RUNTIME_KEYS } from '../../../src/lib/deploy/app-runtime-env.js';
import { buildPerEnvSecrets } from '../../../src/lib/deploy/k8s/gitops-deploy.js';
import {
  buildAppSecretData,
  buildInfraSecretData,
  INFRA_SECRET_KEYS,
} from '../../../src/lib/deploy/k8s/k3s.js';
import { COMPOSE_REQUIRED_ENV_FALLBACK } from '../../../src/lib/project.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

type ComposeService = {
  environment?: string[] | Record<string, string>;
  depends_on?: Record<string, { condition?: string }>;
  restart?: string;
  command?: string[] | string;
  image?: string;
};

// Compose's merge tags (`!reset`, `!override`) are not YAML core; drop them.
const services = (rel: string) =>
  (
    loadYaml(read(rel).replace(/!(reset|override)\b/g, '')) as {
      services: Record<string, ComposeService>;
    }
  ).services;

const SERVER_ENV: Record<string, string> = {
  POSTGRES_PASSWORD: 'SENTINEL_POSTGRES_PASSWORD',
  APP_DB_PASSWORD: 'SENTINEL_APP_DB_PASSWORD',
  BETTER_AUTH_SECRET: 'SENTINEL_BETTER_AUTH_SECRET',
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'SENTINEL_ADMIN_PASSWORD',
  SITE_URL: 'https://example.com',
};

/** `${VAR}`, `${VAR:-x}` and `${VAR:?msg}` resolved against SERVER_ENV. */
function interpolate(value: string): string {
  return value.replace(/\$\{([A-Z][A-Z0-9_]*)(?:(:-|:\?)([^}]*))?\}/g, (_m, key, op, rest) => {
    const v = SERVER_ENV[key];
    if (v) return v;
    return op === ':-' ? rest : '';
  });
}

/** A service's environment as KEY -> resolved value, the prod overlay winning. */
function renderedEnv(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ['carbon/docker-compose.yml', 'carbon/docker-compose.prod.yml']) {
    const env = services(file)[name]?.environment ?? [];
    const entries = Array.isArray(env)
      ? env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)])
      : Object.entries(env);
    for (const [k, v] of entries) out[k] = interpolate(String(v));
  }
  return out;
}

describe('compose: the app connects as app_service, app-migrate as the owner', () => {
  const app = renderedEnv('app');
  const migrate = renderedEnv('app-migrate');

  it('the app env has DB_USER=app_service and the app password', () => {
    expect(app.DB_USER).toBe('app_service');
    expect(app.DB_PASSWORD).toBe('SENTINEL_APP_DB_PASSWORD');
  });

  it('no app env value is the owner password', () => {
    const holding = Object.entries(app)
      .filter(([, v]) => v.includes('SENTINEL_POSTGRES_PASSWORD'))
      .map(([k]) => k);
    expect(holding).toEqual([]);
  });

  it('app-migrate holds the owner password and the app password, as postgres', () => {
    expect(migrate.DB_USER).toBe('postgres');
    expect(migrate.DB_PASSWORD).toBe('SENTINEL_POSTGRES_PASSWORD');
    expect(migrate.APP_DB_PASSWORD).toBe('SENTINEL_APP_DB_PASSWORD');
  });

  it('app-migrate is a one-shot of the app image, and the app waits for it to finish', () => {
    const base = services('carbon/docker-compose.yml');
    const prod = services('carbon/docker-compose.prod.yml');
    expect(base['app-migrate']?.restart).toBe('no');
    expect(base['app-migrate']?.command).toEqual(['node', 'dist/server/migrate-cli.js']);
    expect(base.app.depends_on?.['app-migrate']?.condition).toBe('service_completed_successfully');
    // On a server both run the one pulled image.
    expect(prod['app-migrate']?.image).toBe(prod.app.image);
  });

  it('the prod overlay requires APP_DB_PASSWORD, and so does the preflight fallback', () => {
    expect(read('carbon/docker-compose.prod.yml')).toMatch(/\$\{APP_DB_PASSWORD:\?/);
    expect(COMPOSE_REQUIRED_ENV_FALLBACK).toContain('APP_DB_PASSWORD');
  });
});

type K8sEnv = {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string } };
};
type K8sContainer = {
  name: string;
  image?: string;
  command?: string[];
  env?: K8sEnv[];
  envFrom?: Array<{ secretRef?: { name: string }; configMapRef?: { name: string } }>;
};

describe('k8s: only the migrate init container reads the owner password', () => {
  const deployment = loadYaml(read('carbon/k8s/base/app/deployment.yaml')) as {
    spec: { template: { spec: { containers: K8sContainer[]; initContainers?: K8sContainer[] } } };
  };
  const pod = deployment.spec.template.spec;
  const app = pod.containers.find((c) => c.name === 'app') as K8sContainer;
  const migrate = (pod.initContainers ?? []).find((c) => c.name === 'migrate');

  const refs = (c: K8sContainer) =>
    (c.env ?? []).flatMap((e) =>
      e.valueFrom?.secretKeyRef ? [{ env: e.name, ...e.valueFrom.secretKeyRef }] : [],
    );

  it('the app container never reads vibecarbon-infra-secrets', () => {
    expect(refs(app).filter((r) => r.name === 'vibecarbon-infra-secrets')).toEqual([]);
    expect(
      (app.envFrom ?? []).filter((e) => e.secretRef?.name === 'vibecarbon-infra-secrets'),
    ).toEqual([]);
  });

  it('the app container connects as app_service with APP_DB_PASSWORD', () => {
    expect(app.env?.find((e) => e.name === 'DB_USER')?.value).toBe('app_service');
    expect(refs(app).find((r) => r.env === 'DB_PASSWORD')).toEqual({
      env: 'DB_PASSWORD',
      name: 'vibecarbon-app-secrets',
      key: 'APP_DB_PASSWORD',
    });
  });

  it('the migrate init container runs migrate-cli as postgres with the owner password', () => {
    expect(migrate).toBeDefined();
    expect(migrate?.image).toBe(app.image);
    expect(migrate?.command).toEqual(['node', 'dist/server/migrate-cli.js']);
    expect(migrate?.env?.find((e) => e.name === 'DB_USER')?.value).toBe('postgres');
    expect(refs(migrate as K8sContainer)).toEqual(
      expect.arrayContaining([
        { env: 'DB_PASSWORD', name: 'vibecarbon-infra-secrets', key: 'DB_PASSWORD' },
        { env: 'APP_DB_PASSWORD', name: 'vibecarbon-app-secrets', key: 'APP_DB_PASSWORD' },
      ]),
    );
    // Nothing whole: the init container reads the two keys it needs.
    expect(migrate?.envFrom ?? []).toEqual([]);
  });

  it('the deploy points both containers at the deployed image', () => {
    // The one image change to deployment/app in the deploy is the template
    // patch (it also stamps the secrets sha), and it names both containers.
    const src = read('src/lib/deploy/k8s/k3s.js').replace(/\s+/g, ' ');
    expect(src.match(/'set', 'image', 'deployment\/app'/g)).toBeNull();
    const patch = src.slice(src.indexOf('const appTemplatePatch = {'));
    const body = patch.slice(0, patch.indexOf('await runKubectlWithRetry('));
    expect(body).toContain("containers: [{ name: 'app', image: imageTag }]");
    expect(body).toContain("initContainers: [{ name: 'migrate', image: imageTag }]");
  });
});

describe('the app password rides the app allowlist; the owner password never does', () => {
  it('APP_RUNTIME_KEYS has APP_DB_PASSWORD, and neither owner password key', () => {
    expect(APP_RUNTIME_KEYS).toContain('APP_DB_PASSWORD');
    expect(APP_RUNTIME_KEYS).not.toContain('POSTGRES_PASSWORD');
    expect(APP_RUNTIME_KEYS).not.toContain('DB_PASSWORD');
  });

  it('the app Secret carries APP_DB_PASSWORD and not DB_PASSWORD; the infra Secret the reverse', () => {
    const envLocal = {
      DB_PASSWORD: 'SENTINEL_DB_PASSWORD',
      POSTGRES_PASSWORD: 'SENTINEL_DB_PASSWORD',
      APP_DB_PASSWORD: 'SENTINEL_APP_DB_PASSWORD',
      BETTER_AUTH_SECRET: 'SENTINEL_BETTER_AUTH_SECRET',
    };
    const app = buildAppSecretData({ envLocal });
    expect(app.APP_DB_PASSWORD).toBe('SENTINEL_APP_DB_PASSWORD');
    expect(Object.values(app)).not.toContain('SENTINEL_DB_PASSWORD');
    const infra = buildInfraSecretData({ envLocal });
    expect(infra.DB_PASSWORD).toBe('SENTINEL_DB_PASSWORD');
    expect(infra).not.toHaveProperty('APP_DB_PASSWORD');
    expect(INFRA_SECRET_KEYS).not.toContain('APP_DB_PASSWORD');
  });

  it('GitOps seeds APP_DB_PASSWORD into the environment secrets', () => {
    expect(buildPerEnvSecrets({ APP_DB_PASSWORD: 'SENTINEL_APP_DB_PASSWORD' })).toMatchObject({
      APP_DB_PASSWORD: 'SENTINEL_APP_DB_PASSWORD',
    });
  });
});
