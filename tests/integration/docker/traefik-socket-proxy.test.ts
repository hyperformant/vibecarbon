/**
 * Traefik finds a container through the docker-socket-proxy and routes to it.
 *
 * Servers float on Docker, and this handshake is the part of the stack a new
 * Docker can break without touching our code: Traefik negotiates an API version
 * with `/version` through a proxy that forwards only some paths, then lists
 * containers and follows events. If that fails, a deploy finishes and every
 * request answers 404. `.github/workflows/docker-newest.yml` runs this on the
 * newest docker-ce and Compose; it also runs under `pnpm test:docker`.
 *
 * The prod compose files are resolved by the Compose under test, and the proxy
 * and Traefik's provider flags are taken from the result, so what runs is what
 * the deploy renders. The backend and the probe are this test's own. Nothing
 * publishes a port. Traefik's constraint keeps it to this compose project, and
 * the proxy refuses every write, so it sees nothing else on the daemon.
 *
 * Every container and network here is named vctest-* and removed in afterAll.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatDotenvLine } from '../../../src/lib/dotenv.js';
import { dockerSocketProxyImageRef, traefikImageRef } from '../../../src/lib/images.js';

const describeDocker = process.env.DOCKER_INTEGRATION === 'true' ? describe : describe.skip;

const ROOT = process.cwd();
const PROJECT = `vctest-traefik-${process.pid}`;
const HOST = 'vctest.example.com';
const ANSWER = 'reached-through-the-socket-proxy';
// Pinned by digest like every image the project runs.
const BUSYBOX =
  'busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662';

describeDocker('Traefik through the docker-socket-proxy, on the Docker under test', () => {
  let dir: string;
  const env = { PATH: process.env.PATH, HOME: process.env.HOME } as NodeJS.ProcessEnv;
  const run = (args: string[]) =>
    execFileSync('docker', args, {
      cwd: dir,
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    });
  const compose = (args: string[]) => run(['compose', '-p', PROJECT, '-f', 'live.json', ...args]);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vctest-traefik-'));
    const fill = (text: string) =>
      text.replace(/\{\{([A-Z_]+)\}\}/g, (_m, k: string) =>
        k === 'PROJECT_NAME' ? PROJECT : k === 'ADMIN_EMAIL' ? 'admin@example.com' : 'x',
      );
    for (const file of ['docker-compose.yml', 'docker-compose.prod.yml']) {
      writeFileSync(join(dir, file), fill(readFileSync(join(ROOT, 'carbon', file), 'utf-8')));
    }
    const dummy: Record<string, string> = {
      PROJECT_NAME: PROJECT,
      DOMAIN: 'example.com',
      SITE_URL: 'https://example.com',
      DB_IMAGE: 'postgres',
      DB_IMAGE_TAG: '17',
      TRAEFIK_IMAGE: process.env.VC_TRAEFIK_IMAGE || traefikImageRef(),
      DOCKER_SOCKET_PROXY_IMAGE:
        process.env.VC_DOCKER_SOCKET_PROXY_IMAGE || dockerSocketProxyImageRef(),
      APP_IMAGE: 'ghcr.io/example/app:test',
      BETTER_AUTH_SECRET: 'x',
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'x',
      POSTGRES_PASSWORD: 'x',
      APP_DB_PASSWORD: 'x',
      VC_ENV: 'prod',
    };
    const dotenv = Object.entries(dummy)
      .map(([k, v]) => formatDotenvLine(k, v))
      .join('\n');
    writeFileSync(join(dir, '.env'), `${dotenv}\n`);
    writeFileSync(join(dir, 'app.env'), '');

    const { services } = JSON.parse(
      run([
        'compose',
        '-f',
        'docker-compose.yml',
        '-f',
        'docker-compose.prod.yml',
        'config',
        '--format',
        'json',
      ]),
    );
    const proxy = services['docker-socket-proxy'];
    const traefik = services.traefik;
    const live = {
      services: {
        'docker-socket-proxy': {
          image: proxy.image,
          environment: proxy.environment,
          security_opt: proxy.security_opt,
          cap_drop: proxy.cap_drop,
          volumes: proxy.volumes,
          networks: ['socket-proxy'],
        },
        traefik: {
          image: traefik.image,
          command: [
            ...traefik.command.filter((flag: string) => flag.startsWith('--providers.docker')),
            '--entrypoints.web.address=:80',
          ],
          networks: ['vibecarbon-network', 'socket-proxy'],
          depends_on: ['docker-socket-proxy'],
        },
        backend: {
          image: BUSYBOX,
          command: ['sh', '-c', `echo ${ANSWER} > /tmp/index.html; exec httpd -f -p 8080 -h /tmp`],
          labels: {
            'traefik.enable': 'true',
            'traefik.http.routers.backend.rule': `Host(\`${HOST}\`)`,
            'traefik.http.routers.backend.entrypoints': 'web',
            'traefik.http.services.backend.loadbalancer.server.port': '8080',
          },
          networks: ['vibecarbon-network'],
        },
        probe: { image: BUSYBOX, networks: ['vibecarbon-network'] },
      },
      networks: { 'socket-proxy': { internal: true }, 'vibecarbon-network': {} },
    };
    writeFileSync(join(dir, 'live.json'), JSON.stringify(live, null, 2));
    compose(['up', '-d', '--quiet-pull', 'docker-socket-proxy', 'traefik', 'backend']);
  });

  afterAll(() => {
    if (!dir) return;
    try {
      compose(['down', '-v', '--remove-orphans']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the shipped provider flags', () => {
    const live = JSON.parse(readFileSync(join(dir, 'live.json'), 'utf-8'));
    expect(live.services.traefik.command).toContain(
      '--providers.docker.endpoint=tcp://docker-socket-proxy:2375',
    );
    expect(live.services.traefik.command).toContain('--providers.docker.exposedbydefault=false');
  });

  it('finds a labelled container and routes a request to it', () => {
    const script =
      'i=0; while [ $i -lt 45 ]; do ' +
      `out=$(wget -qO- -T 2 --header 'Host: ${HOST}' http://traefik/ 2>/dev/null) && ` +
      '{ echo "$out"; exit 0; }; i=$((i+1)); sleep 1; done; exit 1';
    let answered = '';
    try {
      answered = compose(['run', '--rm', '-T', '--no-deps', 'probe', 'sh', '-c', script]);
    } catch {
      const logs = compose([
        'logs',
        '--no-color',
        '--tail',
        '40',
        'traefik',
        'docker-socket-proxy',
      ]);
      expect.fail(`Traefik never routed to the backend.\n${run(['version'])}\n${logs}`);
    }
    expect(answered).toContain(ANSWER);
  });
});
