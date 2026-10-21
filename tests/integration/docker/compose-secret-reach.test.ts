/**
 * Which compose service can see which secret, read off `docker compose config`
 * (security plan 2026-10-20, Task 1). The deployed `-f` set (base + prod,
 * + the DNS-01 override, + every add-on overlay) is rendered against a
 * sentinel `.env` (the substitution source the bundle ships) and an `app.env`
 * built by buildAppRuntimeEnv, the way renderBundle builds it. Only Traefik
 * may hold a DNS token; the app and the add-ons hold no provider token; the
 * redis overlay's REDIS_URL still reaches the app after `env_file: !override`.
 *
 * Task 3 adds who reaches the Docker API: only traefik reaches its socket
 * proxy, only the app reaches app-docker-proxy, and that proxy, run live from
 * its rendered config, answers list and logs and refuses inspect.
 *
 * Only that last block runs containers (its own, removed after); the rest
 * only resolves the files with `config`. Values are sentinels.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

  // biome-ignore lint/suspicious/noExplicitAny: the whole rendered compose model
  const renderConfig = (files: string[]): any => {
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
    return JSON.parse(out);
  };
  const render = (files: string[]): Record<string, Service> =>
    renderConfig(files).services as Record<string, Service>;

  /** Services whose rendered config contains `value` anywhere. */
  const holders = (services: Record<string, Service>, value: string) =>
    Object.entries(services)
      .filter(([, svc]) => JSON.stringify(svc).includes(value))
      .map(([name]) => name);

  const FULL_FILES = () => [
    'docker-compose.yml',
    'docker-compose.prod.yml',
    'docker-compose.dns01.prod.yml',
    ...ADDON_FILES.map((f) => f.to),
  ];
  const full = () => render(FULL_FILES());

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

  // Local dev runs the base file alone, whose app reads the whole .env
  // (env_file), owner password included. The base blanks every owner
  // credential on the app, so local dev holds the app to app_service too.
  it('base alone (local dev): the app holds no owner or infra database password', () => {
    const services = render(['docker-compose.yml']);
    for (const k of [
      'POSTGRES_PASSWORD',
      'N8N_DB_PASSWORD',
      'METABASE_DB_PASSWORD',
      'OBSERVABILITY_DB_PASSWORD',
    ]) {
      expect(holders(services, sentinel(k)), k).not.toContain('app');
    }
    expect(holders(services, sentinel('POSTGRES_PASSWORD'))).toContain('app-migrate');
    const appEnv = services.app.environment as Record<string, string>;
    expect(appEnv.DB_USER).toBe('app_service');
    expect(appEnv.DB_PASSWORD).toBe(sentinel('APP_DB_PASSWORD'));
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
  // ---------------------------------------------------------------------------
  // Task 3 (R11): who reaches the Docker API, and what it serves them.
  //
  // Every service that binds the Docker socket, with what it may do with it. A
  // new one fails the census below until it is added here with its paths.
  const SOCKET_HOLDERS: Record<string, string> = {
    // Traefik's provider: the GET sections it discovers routers from. Only
    // traefik shares its network.
    'docker-socket-proxy': 'GET containers, services, tasks, networks (Traefik provider)',
    // The app's admin Infrastructure page: list and logs, nothing else.
    'app-docker-proxy': 'GET /containers/json, GET /containers/{id}/logs, GET /_ping',
    // The observability add-on's log shipper reads container logs from the
    // socket itself; it serves no Docker API to anyone.
    promtail: 'reads container logs (observability add-on)',
  };
  const PROXIES = ['docker-socket-proxy', 'app-docker-proxy'];

  const bindsSocket = (svc: Service) =>
    ((svc.volumes as Array<{ source?: string }> | undefined) ?? []).some(
      (v) => v.source === '/var/run/docker.sock',
    );
  const networksOf = (svc: Service) => Object.keys((svc.networks as object | undefined) ?? {});
  /** The socket proxies `name` shares a network with. */
  const proxiesReachedBy = (services: Record<string, Service>, name: string) =>
    PROXIES.filter(
      (p) =>
        p !== name &&
        services[p] &&
        networksOf(services[name]).some((n) => networksOf(services[p]).includes(n)),
    );

  for (const [label, files] of [
    ['base + prod', () => ['docker-compose.yml', 'docker-compose.prod.yml']],
    ['full deploy set', FULL_FILES],
  ] as const) {
    it(`${label}: only the socket holders in the table bind the Docker socket`, () => {
      const services = render(files());
      const binders = Object.keys(services).filter((name) => bindsSocket(services[name]));
      for (const name of binders) expect(Object.keys(SOCKET_HOLDERS), name).toContain(name);
      expect(binders).not.toContain('traefik');
      expect(binders).toEqual(expect.arrayContaining(PROXIES));
    });

    it(`${label}: Traefik reads Docker through its proxy, scoped to this project`, () => {
      const command = render(files()).traefik.command as string[];
      expect(command).toContain('--providers.docker.endpoint=tcp://docker-socket-proxy:2375');
      expect(command).toContain(
        '--providers.docker.constraints=Label(`com.docker.compose.project`,`reach`)',
      );
      // The app sits on two networks; Traefik must dial it on the shared one.
      expect(command).toContain('--providers.docker.network=reach_vibecarbon-network');
    });

    it(`${label}: only traefik reaches docker-socket-proxy, only the app reaches app-docker-proxy`, () => {
      const services = render(files());
      for (const name of Object.keys(services)) {
        expect(services[name].network_mode, `${name} network_mode`).toBeUndefined();
        if (PROXIES.includes(name)) continue;
        const expected =
          name === 'traefik' ? ['docker-socket-proxy'] : name === 'app' ? ['app-docker-proxy'] : [];
        expect(proxiesReachedBy(services, name), name).toEqual(expected);
      }
      const appEnv = services.app.environment as Record<string, string>;
      expect(appEnv.DOCKER_API_PROXY).toBe('http://app-docker-proxy:2375');
    });
  }

  it('full deploy set: the proxies sit on internal networks of their own', () => {
    const config = renderConfig(FULL_FILES());
    for (const p of PROXIES) {
      const nets = networksOf(config.services[p]);
      expect(nets, p).not.toContain('vibecarbon-network');
      for (const n of nets) expect(config.networks[n]?.internal, `${p} on ${n}`).toBe(true);
      // An internal network means nothing if the proxy publishes a host port.
      expect(config.services[p].ports, `${p} ports`).toBeUndefined();
      expect(config.services[p].expose, `${p} expose`).toBeUndefined();
    }
  });

  // The container list the app may read carries each container's Command and
  // Labels (never its Env), so no secret the app does not already hold may
  // ride in either. (redis's `--requirepass` is one the app holds: it is in
  // the app's REDIS_URL.)
  it('full deploy set: no command, entrypoint or label carries a secret the app lacks', () => {
    const services = full();
    const appHolds = new Set(JSON.stringify(services.app).match(/SENTINEL_[A-Z0-9_]+/g) ?? []);
    for (const [name, svc] of Object.entries(services)) {
      const exposed = JSON.stringify([svc.command, svc.entrypoint, svc.labels]);
      const foreign = (exposed.match(/SENTINEL_[A-Z0-9_]+/g) ?? []).filter((s) => !appHolds.has(s));
      expect(foreign, name).toEqual([]);
    }
  });

  // The shipped app-docker-proxy, run against the real daemon: list and logs
  // answer, every other path is refused, and a neighbour's env never shows.
  describe('app-docker-proxy against a live daemon', () => {
    const project = `vc-socket-reach-${process.pid}`;
    const SECRET = sentinel('NEIGHBOUR_ENV');
    // Pinned by digest like every image the project runs.
    const BUSYBOX =
      'busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662';
    let liveDir: string;
    let victimId: string;
    const compose = (args: string[]) =>
      execFileSync('docker', ['compose', '-p', project, ...args], {
        cwd: liveDir,
        encoding: 'utf-8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME } as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180_000,
      });

    beforeAll(() => {
      const config = renderConfig(FULL_FILES());
      const proxy = config.services['app-docker-proxy'];
      liveDir = join(dir, 'live');
      mkdirSync(liveDir);
      // The proxy exactly as the deploy renders it: image, haproxy config,
      // socket mount. Only the network is this test's own.
      const live = {
        services: {
          'app-docker-proxy': {
            image: proxy.image,
            configs: proxy.configs,
            volumes: proxy.volumes,
            networks: ['probe'],
          },
          // A neighbour holding a secret in its env, the way db holds the
          // owner password. Its command never names the secret.
          victim: {
            image: BUSYBOX,
            command: ['sh', '-c', 'echo neighbour-started; sleep 600'],
            environment: { NEIGHBOUR_ENV: SECRET },
            networks: ['probe'],
          },
          probe: { image: BUSYBOX, networks: ['probe'] },
        },
        configs: config.configs,
        networks: { probe: { internal: true } },
      };
      writeFileSync(join(liveDir, 'docker-compose.yml'), JSON.stringify(live, null, 2));
      compose(['up', '-d', '--quiet-pull', 'app-docker-proxy', 'victim']);
      victimId = compose(['ps', '-q', 'victim']).trim();
    });

    afterAll(() => {
      if (liveDir) compose(['down', '-v', '--remove-orphans']);
    });

    /** Raw HTTP/1.0 from a container on the proxy's network: status code and body. */
    const ask = (method: string, path: string) => {
      const out = compose([
        'run',
        '--rm',
        '-T',
        '--no-deps',
        'probe',
        'sh',
        '-c',
        // Retry the connect while haproxy binds (a fresh container); one
        // request per call, the response printed raw.
        'for i in 1 2 3 4 5 6 7 8 9 10; do ' +
          `printf '%s %s HTTP/1.0\\r\\nHost: docker\\r\\n\\r\\n' "$0" "$1" | nc app-docker-proxy 2375 && exit 0; sleep 1; done; exit 1`,
        method,
        path,
      ]);
      const status = Number(out.match(/^HTTP\/1\.[01] (\d{3})/)?.[1]);
      return { status, body: out };
    };

    it('lists containers without their env, versioned or not', () => {
      for (const path of ['/containers/json', '/v1.43/containers/json?all=1']) {
        const res = ask('GET', path);
        expect(res.status, path).toBe(200);
        expect(res.body, path).toContain(victimId);
        expect(res.body.includes(SECRET), path).toBe(false);
      }
    });

    it('answers the health ping', () => {
      const res = ask('GET', '/_ping');
      expect(res.status).toBe(200);
      expect(res.body).toMatch(/OK$/);
    });

    it('serves logs, versioned or not', () => {
      for (const prefix of ['', '/v1.43']) {
        const res = ask('GET', `${prefix}/containers/${victimId}/logs?stdout=1&stderr=1`);
        expect(res.status, prefix).toBe(200);
        expect(res.body).toContain('neighbour-started');
      }
    });

    it('refuses inspect and every other path or method', () => {
      for (const [method, path] of [
        ['GET', `/containers/${victimId}/json`],
        ['GET', `/v1.43/containers/${victimId}/json`],
        ['HEAD', `/containers/${victimId}/json`],
        ['GET', `/containers/${victimId}/top`],
        ['GET', `/containers/${victimId}/stats?stream=0`],
        ['GET', `/containers/${victimId}/export`],
        ['GET', `/containers/${victimId}/archive?path=/`],
        ['GET', `/containers/${victimId}/logs/../json`],
        ['GET', `/containers/${victimId}%2Fjson/logs`],
        ['POST', `/containers/${victimId}/restart`],
        ['POST', `/containers/${victimId}/logs`],
        ['GET', '/info'],
        ['GET', '/images/json'],
      ]) {
        const res = ask(method, path);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body.includes(SECRET), `${method} ${path}`).toBe(false);
      }
    });
  });
});
