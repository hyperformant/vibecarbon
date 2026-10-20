/**
 * Which compose service can see which secret, read off `docker compose config`
 * (security plan 2026-10-20, Task 1). The deployed `-f` set (base + prod,
 * + the DNS-01 override, + every add-on overlay) is rendered against a
 * sentinel `.env` (the substitution source the bundle ships) and an `app.env`
 * built by buildAppRuntimeEnv, the way renderBundle builds it. Only Traefik
 * may hold a DNS token; the app and the add-ons hold no provider token; the
 * redis overlay's REDIS_URL still reaches the app after `env_file: !override`.
 *
 * No container runs: `config` only resolves the files. Values are sentinels.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAppRuntimeEnv } from '../../../src/lib/deploy/app-runtime-env.js';
import { DNS_PROVIDERS, DNS01_PROVIDERS } from '../../../src/lib/dns-provider.js';
import { formatDotenvLine } from '../../../src/lib/dotenv.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';

// Skipped by default like the other docker tests; run explicitly via
// `DOCKER_INTEGRATION=true pnpm test:docker` (the script sets the variable).
const describeDocker = process.env.DOCKER_INTEGRATION === 'true' ? describe : describe.skip;

const ROOT = process.cwd();
// Every add-on that ships a compose overlay, found on disk so a new one is
// covered with no edit here.
const ADDONS = readdirSync(join(ROOT, 'services'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => existsSync(join(ROOT, 'services', name, 'compose', 'docker-compose.yml')))
  .sort();
// Each add-on's base overlay, then its prod overlay when it has one, in the
// same order the bundle's -f set uses (base before prod).
const ADDON_FILES = ADDONS.flatMap((name) =>
  ['docker-compose.yml', 'docker-compose.prod.yml']
    .filter((f) => existsSync(join(ROOT, 'services', name, 'compose', f)))
    .map((f) => ({
      from: `services/${name}/compose/${f}`,
      to:
        f === 'docker-compose.yml'
          ? `docker-compose.${name}.yml`
          : `docker-compose.${name}.prod.yml`,
    })),
);

const dnsTokenNames = [...new Set(Object.values(DNS01_PROVIDERS).map((r) => r.tokenEnvVar))];
const providerTokenNames = [
  ...new Set([
    ...dnsTokenNames,
    ...Object.values(DNS_PROVIDERS).map((r) => r.tokenEnv),
    ...Object.values(PROVIDERS).flatMap((P) => [P.TOKEN_ENV, P.CLI_TOKEN_ENV].filter(Boolean)),
  ]),
];
const sentinel = (k: string) => `SENTINEL_${k}`;

type Service = Record<string, unknown>;

describeDocker('compose: secrets reach only the services that use them', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'compose-secret-reach-'));
    // The template's `{{…}}` placeholders, filled the way `create` and `add` fill them.
    const fill: Record<string, string> = {
      PROJECT_NAME: 'reach',
      GITHUB_OWNER: 'example',
      ADMIN_EMAIL: 'admin@example.com',
    };
    const stage = (from: string, to: string) =>
      writeFileSync(
        join(dir, to),
        readFileSync(join(ROOT, from), 'utf-8').replace(
          /\{\{([A-Z_]+)\}\}/g,
          (_m, k: string) => fill[k] ?? 'x',
        ),
      );
    stage('carbon/docker-compose.yml', 'docker-compose.yml');
    stage('carbon/docker-compose.prod.yml', 'docker-compose.prod.yml');
    stage('carbon/docker-compose.dns01.prod.yml', 'docker-compose.dns01.prod.yml');
    for (const file of ADDON_FILES) stage(file.from, file.to);
    const serverEnv: Record<string, string> = {
      PROJECT_NAME: 'reach',
      DOMAIN: 'example.com',
      SITE_URL: 'https://example.com',
      DB_IMAGE: 'postgres',
      DB_IMAGE_TAG: '17',
      APP_IMAGE: 'ghcr.io/example/reach:test',
      ACME_DNS_PROVIDER: 'hetzner',
      BETTER_AUTH_SECRET: sentinel('BETTER_AUTH_SECRET'),
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: sentinel('ADMIN_PASSWORD'),
      POSTGRES_PASSWORD: sentinel('POSTGRES_PASSWORD'),
      APP_DB_PASSWORD: sentinel('APP_DB_PASSWORD'),
      STRIPE_SECRET_KEY: sentinel('STRIPE_SECRET_KEY'),
      REDIS_ENABLED: 'true',
      REDIS_PASSWORD: sentinel('REDIS_PASSWORD'),
      N8N_DB_PASSWORD: sentinel('N8N_DB_PASSWORD'),
      METABASE_DB_PASSWORD: sentinel('METABASE_DB_PASSWORD'),
      OBSERVABILITY_DB_PASSWORD: sentinel('OBSERVABILITY_DB_PASSWORD'),
      VC_ENV: 'prod',
    };
    for (const k of providerTokenNames) serverEnv[k] = sentinel(k);
    const dotenv = (env: Record<string, string>) =>
      `${Object.entries(env)
        .map(([k, v]) => formatDotenvLine(k, v))
        .join('\n')}\n`;
    writeFileSync(join(dir, '.env'), dotenv(serverEnv));
    writeFileSync(join(dir, 'app.env'), dotenv(buildAppRuntimeEnv(serverEnv, {})));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const render = (files: string[]): Record<string, Service> => {
    const out = execFileSync(
      'docker',
      ['compose', ...files.flatMap((f) => ['-f', f]), 'config', '--format', 'json'],
      {
        cwd: dir,
        encoding: 'utf-8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME } as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      },
    );
    return JSON.parse(out).services as Record<string, Service>;
  };

  /** Services whose rendered config contains `value` anywhere. */
  const holders = (services: Record<string, Service>, value: string) =>
    Object.entries(services)
      .filter(([, svc]) => JSON.stringify(svc).includes(value))
      .map(([name]) => name);

  const full = () =>
    render([
      'docker-compose.yml',
      'docker-compose.prod.yml',
      'docker-compose.dns01.prod.yml',
      ...ADDON_FILES.map((f) => f.to),
    ]);

  it('found the add-on overlays', () => {
    expect(ADDONS).toEqual(expect.arrayContaining(['metabase', 'n8n', 'observability', 'redis']));
  });

  it('base + prod: the app holds no provider token', () => {
    const services = render(['docker-compose.yml', 'docker-compose.prod.yml']);
    for (const k of providerTokenNames) {
      expect(holders(services, sentinel(k)), k).not.toContain('app');
    }
    // Positive control: the app still gets its own keys.
    expect(holders(services, sentinel('BETTER_AUTH_SECRET'))).toContain('app');
    expect(holders(services, sentinel('STRIPE_SECRET_KEY'))).toContain('app');
  });

  it('full deploy set: every DNS token sentinel appears only in traefik', () => {
    const services = full();
    for (const k of dnsTokenNames) {
      expect(holders(services, sentinel(k)), k).toEqual(['traefik']);
    }
  });

  it('full deploy set: no provider token reaches app, n8n, metabase or grafana', () => {
    const services = full();
    for (const name of ['app', 'n8n', 'metabase', 'grafana']) {
      expect(services, `${name} missing from the render`).toHaveProperty(name);
    }
    for (const k of providerTokenNames) {
      const reached = holders(services, sentinel(k)).filter((s) =>
        ['app', 'n8n', 'metabase', 'grafana'].includes(s),
      );
      expect(reached, k).toEqual([]);
    }
  });

  // Task 2 (R8): the app connects as app_service; only the db and the
  // one-shot migrate step hold the owner password.
  it('full deploy set: the owner password reaches only db and app-migrate', () => {
    const services = full();
    const holders_ = holders(services, sentinel('POSTGRES_PASSWORD'));
    expect(holders_).toContain('app-migrate');
    expect(holders_).not.toContain('app');
    const appEnv = services.app.environment as Record<string, string>;
    expect(appEnv.DB_USER).toBe('app_service');
    expect(appEnv.DB_PASSWORD).toBe(sentinel('APP_DB_PASSWORD'));
    const migrateEnv = services['app-migrate'].environment as Record<string, string>;
    expect(migrateEnv.DB_USER).toBe('postgres');
    expect(migrateEnv.DB_PASSWORD).toBe(sentinel('POSTGRES_PASSWORD'));
    expect((services['app-migrate'] as { image?: string }).image).toBe(
      (services.app as { image?: string }).image,
    );
  });

  it('full deploy set: the app gets no infra password, and REDIS_URL still reaches it', () => {
    const services = full();
    for (const k of ['N8N_DB_PASSWORD', 'METABASE_DB_PASSWORD', 'OBSERVABILITY_DB_PASSWORD']) {
      expect(holders(services, sentinel(k)), k).not.toContain('app');
    }
    const appEnv = services.app.environment as Record<string, string>;
    expect(appEnv.REDIS_URL).toBe(`redis://:${sentinel('REDIS_PASSWORD')}@redis:6379`);
    expect(appEnv.BETTER_AUTH_SECRET).toBe(sentinel('BETTER_AUTH_SECRET'));
  });
});
