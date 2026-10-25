import { exec } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import { type Pingable, pingDb } from '../../db/client';
import { dbErrorForLog } from '../../db/errors';
import {
  type DockerContainer,
  fetchContainerLogs,
  listProjectContainers,
} from '../../lib/docker-api';
import { logger } from '../../lib/logger';
import { isDocker, isKubernetes } from '../../lib/runtime-env';
import { probeTraefik, TRAEFIK_HEALTH_URL } from '../../lib/traefik-probe';
import { checkSuperAdmin } from '../../middleware/requireSuperAdmin';

const execAsync = promisify(exec);

/**
 * Internal endpoint to get status of infrastructure services.
 * Checks health endpoints of known services running in Docker.
 *
 * Usage:
 *   GET  /api/_internal/services/status              - Get all service statuses
 *   POST /api/_internal/services/restart             - Restart all services
 *   POST /api/_internal/services/restart/:container  - Restart specific service
 *
 * Returns array of service statuses with health information.
 */

interface ServiceStatus {
  name: string;
  container: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  latencyMs?: number;
  error?: string;
  /** The dashboard can restart this container here (see canRestart). */
  restartable?: boolean;
}

interface ServiceConfig {
  name: string;
  container: string;
  healthUrl: string;
  timeout: number;
  acceptCodes?: number[]; // HTTP status codes considered healthy (default: 200-399)
  k8sUnavailable?: boolean; // Service cannot be checked in Kubernetes
}

// The app reaches the Docker API through its own list-and-logs socket proxy
// (app-docker-proxy) in a production compose deployment
// (docker-compose.prod.yml sets this). Local
// dev talks to the host socket and k8s has no Docker API, so neither runs
// the proxy and neither lists it.
const dockerApiProxy = process.env.DOCKER_API_PROXY;

// The per-server stack: the app, its Postgres, Traefik in front, and (in a
// production compose deployment) the two socket proxies: Traefik's, which
// this page cannot reach and so reports from its state in the container
// list, and the app's own, which it pings. Authentication is not a row of its own: Better Auth runs
// inside the app, so its check is folded into the App row (checkApp).
const CORE_SERVICES: ServiceConfig[] = [
  {
    name: 'App',
    container: 'app',
    // This process answering, plus its in-process auth router (checkApp).
    healthUrl: 'self://app',
    timeout: 2000,
  },
  {
    name: 'PostgreSQL',
    container: 'db',
    // Checked with `select 1` over the app's own connection (checkDatabase).
    healthUrl: 'db://db',
    timeout: 2000,
  },
  {
    name: 'Traefik',
    container: 'traefik',
    // Probed by probeTraefik (lib/traefik-probe.ts), which knows where
    // Traefik is on k8s, compose and local dev, and never follows redirects.
    healthUrl: TRAEFIK_HEALTH_URL,
    timeout: 2000,
  },
  ...(dockerApiProxy && !isKubernetes
    ? [
        {
          name: 'Docker Socket Proxy',
          container: 'docker-socket-proxy',
          // Traefik's proxy sits on a network only Traefik joins: reported
          // from its state in the Docker listing, never pinged.
          healthUrl: 'docker://docker-socket-proxy',
          timeout: 0,
        },
        {
          name: 'App Docker Proxy',
          container: 'app-docker-proxy',
          // The list-and-logs proxy this page reads Docker through.
          healthUrl: `${dockerApiProxy.replace(/\/$/, '')}/_ping`,
          timeout: 2000,
        },
      ]
    : []),
];

// Containers listed only when Docker reports them running. Garage is the
// local S3 stand-in from docker-compose.override.yml: dev only, production
// uses the cloud provider's object storage and runs no s3 container.
const DISCOVERED_SERVICES: ServiceConfig[] = [
  {
    name: 'Storage (S3)',
    container: 's3',
    // Reported from the container's state in the Docker listing.
    healthUrl: 'docker://s3',
    timeout: 0,
  },
];

const DB_CHECK_TIMEOUT_MS = 2000;

type AuthHandler = (request: Request) => Promise<Response>;

async function loadAuthHandler(): Promise<AuthHandler> {
  // Imported lazily so this module stays loadable without the auth config.
  const { auth } = await import('../../auth');
  return auth.handler;
}

/**
 * The App row. Answering this request proves the process is up; Better Auth
 * runs in the same process, so the row also asks its router for
 * GET /api/auth/ok, in-process with no network hop. The app is healthy only
 * if both answer. Never throws.
 */
export async function checkApp(
  handler?: AuthHandler,
  timeoutMs: number = 2000
): Promise<ServiceStatus> {
  const base = { name: 'App', container: 'app' };
  const origin = process.env.SITE_URL || 'http://localhost';
  let start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Load the module before timing, so the first check measures the auth
    // router, not the one-off import.
    const authHandler = handler ?? (await loadAuthHandler());
    start = Date.now();
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const res = await Promise.race([
      authHandler(new Request(new URL('/api/auth/ok', origin), { method: 'GET' })),
      timeout,
    ]);
    const latencyMs = Date.now() - start;
    if (res === 'timeout')
      return { ...base, status: 'unhealthy', latencyMs, error: 'Auth timeout' };
    if (!res.ok) {
      return { ...base, status: 'unhealthy', latencyMs, error: 'Auth not answering' };
    }
    return { ...base, status: 'healthy', latencyMs };
  } catch (err) {
    logger.warn({ err }, 'Services status: in-process auth check failed');
    return {
      ...base,
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: 'Auth not answering',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** A row read from the Docker listing: running, and its healthcheck verdict. */
function containerStateStatus(
  service: ServiceConfig,
  container: DockerContainer | undefined
): ServiceStatus {
  const base = { name: service.name, container: service.container };
  if (!container) return { ...base, status: 'unhealthy', error: 'Not running' };
  if (container.health === 'unhealthy') {
    return { ...base, status: 'unhealthy', error: 'Container not healthy' };
  }
  if (container.health === 'starting') return { ...base, status: 'unknown', error: 'Starting up' };
  return { ...base, status: 'healthy' };
}

/**
 * The PostgreSQL row: `select 1` over the app's own connection (pingDb),
 * giving up after `timeoutMs`. Never throws. The error text of a failed query
 * never reaches the response (it can carry connection details); it goes to
 * the server log through dbErrorForLog.
 */
export async function checkDatabase(
  target?: Pingable,
  timeoutMs: number = DB_CHECK_TIMEOUT_MS
): Promise<ServiceStatus> {
  const ping = await pingDb(target, { timeoutMs });
  const base = { name: 'PostgreSQL', container: 'db', latencyMs: ping.latencyMs };
  if (ping.ok) return { ...base, status: 'healthy' };
  if (ping.timedOut) return { ...base, status: 'unhealthy', error: 'Timeout' };
  logger.warn({ err: dbErrorForLog(ping.error) }, 'Services status: database check failed');
  return { ...base, status: 'unhealthy', error: 'Not reachable' };
}

/** The Traefik row (see lib/traefik-probe.ts). */
async function checkTraefik(service: ServiceConfig): Promise<ServiceStatus> {
  const probe = await probeTraefik(service.timeout);
  const base = { name: service.name, container: service.container, latencyMs: probe.latencyMs };
  return probe.ok
    ? { ...base, status: 'healthy' }
    : { ...base, status: 'unhealthy', error: probe.error };
}

// Optional services - added based on environment configuration
const OPTIONAL_SERVICES: Record<string, ServiceConfig[]> = {
  redis: [
    {
      name: 'Redis',
      container: 'redis',
      healthUrl: 'tcp://redis:6379', // Special marker for TCP check
      timeout: 2000,
    },
  ],
  n8n: [
    {
      name: 'n8n',
      container: 'n8n',
      // In k8s, use the k8s Service DNS name (same as Docker network name)
      healthUrl:
        isKubernetes || isDocker ? 'http://n8n:5678/healthz' : 'http://localhost:5678/healthz',
      timeout: 3000,
    },
  ],
  metabase: [
    {
      name: 'Metabase',
      container: 'metabase',
      healthUrl:
        isKubernetes || isDocker
          ? 'http://metabase:3000/api/health'
          : 'http://localhost:3001/api/health',
      timeout: 5000,
    },
  ],
  observability: [
    // H-9: on k8s the observability stack lives in its OWN namespace
    // (vibecarbon-observability), so in-cluster health URLs are namespace-qualified
    // (<svc>.vibecarbon-observability). In compose they're plain service names on
    // the shared network; on the host they're checked via `docker inspect`
    // container-health (all three are in DOCKER_HEALTH_CHECK_CONTAINERS), so the
    // non-k8s URL is only actually fetched in-compose.
    {
      name: 'Prometheus',
      container: 'prometheus',
      healthUrl: isKubernetes
        ? 'http://prometheus.vibecarbon-observability:9090/-/healthy'
        : 'http://prometheus:9090/-/healthy',
      timeout: 2000,
    },
    {
      name: 'Grafana',
      container: 'grafana',
      healthUrl: isKubernetes
        ? 'http://grafana.vibecarbon-observability:3000/api/health'
        : 'http://grafana:3000/api/health',
      timeout: 3000,
    },
    {
      name: 'Loki',
      container: 'loki',
      healthUrl: isKubernetes
        ? 'http://loki.vibecarbon-observability:3100/ready'
        : 'http://loki:3100/ready',
      timeout: 2000,
    },
  ],
};

// Cache for running containers (refreshed on each status check)
let runningContainersCache: Map<string, DockerContainer> = new Map();
let containersCacheTime = 0;
const CACHE_TTL_MS = 5000; // 5 seconds

/**
 * This project's running containers by compose service, or null when Docker
 * cannot be asked (k8s, no PROJECT_NAME, API unreachable).
 */
async function getRunningContainers(): Promise<Map<string, DockerContainer> | null> {
  // Docker is not available in Kubernetes
  if (isKubernetes) return null;

  const now = Date.now();
  if (now - containersCacheTime < CACHE_TTL_MS && runningContainersCache.size > 0) {
    return runningContainersCache;
  }

  // Engine API, not the docker CLI: the production app container ships no
  // CLI — it reaches the list-and-logs app-docker-proxy instead (local dev
  // uses the host socket directly). See lib/docker-api.ts.
  const project = process.env.PROJECT_NAME;
  if (!project) return null;

  try {
    const containers = await listProjectContainers(project);
    const services = new Map(containers.map((c) => [c.service, c]));
    runningContainersCache = services;
    containersCacheTime = now;
    return services;
  } catch {
    // Docker could not be asked: fall back to core services + env flags.
    return null;
  }
}

/**
 * Every row to check: the core stack, plus each discovered or optional
 * service whose container is running. A container that is not there is never
 * listed. Env flags stand in only where Docker cannot be asked (k8s, or the
 * Docker API unreachable), since there they are the only signal.
 */
async function getEnabledServices(): Promise<{
  services: ServiceConfig[];
  running: Map<string, DockerContainer> | null;
}> {
  const services = [...CORE_SERVICES];
  const running = await getRunningContainers();

  if (running) {
    services.push(...DISCOVERED_SERVICES.filter((config) => running.has(config.container)));
  }

  // Add optional services if their containers are running
  for (const [, configs] of Object.entries(OPTIONAL_SERVICES)) {
    const isRunning = configs.some((config) => running?.has(config.container));
    if (isRunning) {
      services.push(...configs);
    }
  }

  if (running) return { services, running };

  // Env flags as the fallback where Docker cannot be asked.
  if (process.env.REDIS_ENABLED === 'true' && !services.some((s) => s.container === 'redis')) {
    services.push(...OPTIONAL_SERVICES.redis);
  }
  if (process.env.N8N_ENABLED === 'true' && !services.some((s) => s.container === 'n8n')) {
    services.push(...OPTIONAL_SERVICES.n8n);
  }
  if (
    process.env.METABASE_ENABLED === 'true' &&
    !services.some((s) => s.container === 'metabase')
  ) {
    services.push(...OPTIONAL_SERVICES.metabase);
  }
  if (
    process.env.OBSERVABILITY_ENABLED === 'true' &&
    !services.some((s) => s.container === 'prometheus')
  ) {
    services.push(...OPTIONAL_SERVICES.observability);
  }

  return { services, running };
}

// List of optional service containers that should use Docker health check when not in Docker
const DOCKER_HEALTH_CHECK_CONTAINERS = [
  'redis',
  'n8n',
  'metabase',
  'prometheus',
  'grafana',
  'loki',
];

async function checkServiceHealth(
  service: ServiceConfig,
  running: Map<string, DockerContainer> | null
): Promise<ServiceStatus> {
  const start = Date.now();

  if (service.healthUrl.startsWith('docker://')) {
    return containerStateStatus(service, running?.get(service.container));
  }

  // Services that cannot be reached from the app pod in Kubernetes
  if (isKubernetes && service.k8sUnavailable) {
    return {
      name: service.name,
      container: service.container,
      status: 'unknown',
      error: 'Not accessible in Kubernetes (exposed via Traefik only)',
    };
  }

  // For optional services when running on host (not in Docker or Kubernetes), check via Docker container health status
  // This is needed because the API server can't reach Docker internal network hostnames from the host
  if (!isDocker && !isKubernetes && DOCKER_HEALTH_CHECK_CONTAINERS.includes(service.container)) {
    try {
      const { stdout } = await execAsync(
        `docker inspect --format="{{.State.Health.Status}}" $(docker ps -q -f name=-${service.container}) 2>/dev/null || echo "not_found"`,
        { timeout: service.timeout }
      );
      const status = stdout.trim();
      const isHealthy = status === 'healthy';
      const isUnhealthy = status === 'unhealthy' || status === 'not_found' || status === '';
      const isStarting = status === 'starting';

      return {
        name: service.name,
        container: service.container,
        status: isHealthy ? 'healthy' : isStarting ? 'unknown' : 'unhealthy',
        latencyMs: Date.now() - start,
        error: isUnhealthy ? 'Container not healthy' : isStarting ? 'Starting up' : undefined,
      };
    } catch {
      return {
        name: service.name,
        container: service.container,
        status: 'unknown',
        error: 'Cannot check container status',
      };
    }
  }

  if (service.healthUrl === 'self://app') {
    return checkApp(undefined, service.timeout);
  }

  if (service.healthUrl === 'db://db') {
    return checkDatabase(undefined, service.timeout);
  }

  if (service.container === 'traefik') {
    return checkTraefik(service);
  }

  // Special case: TCP check for services without an HTTP health endpoint (e.g. Redis)
  if (service.healthUrl.startsWith('tcp://')) {
    const url = new URL(service.healthUrl);
    const host = url.hostname;
    const port = Number.parseInt(url.port, 10);
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const latencyStart = Date.now();
      const done = (ok: boolean, err?: string) => {
        socket.destroy();
        resolve({
          name: service.name,
          container: service.container,
          status: ok ? 'healthy' : 'unhealthy',
          latencyMs: Date.now() - latencyStart,
          error: err,
        });
      };
      socket.setTimeout(service.timeout);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false, 'Timeout'));
      socket.once('error', (e) =>
        done(false, e.message.includes('ECONNREFUSED') ? 'Not running' : e.message)
      );
      socket.connect(port, host);
    });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), service.timeout);

    // A redirect is the service answering; following it could chase a
    // public URL the app cannot reach and report a running service as down.
    const response = await fetch(service.healthUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const latencyMs = Date.now() - start;

    // Check if status code is acceptable
    const isHealthy = service.acceptCodes
      ? service.acceptCodes.includes(response.status)
      : response.status >= 200 && response.status < 400;

    return {
      name: service.name,
      container: service.container,
      status: isHealthy ? 'healthy' : 'unhealthy',
      latencyMs,
    };
  } catch (error) {
    const latencyMs = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Check if it's a timeout or connection refused
    const isTimeout = errorMessage.includes('abort');
    const isConnectionRefused =
      errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch failed');

    return {
      name: service.name,
      container: service.container,
      status: 'unhealthy',
      latencyMs,
      error: isTimeout ? 'Timeout' : isConnectionRefused ? 'Not running' : errorMessage,
    };
  }
}

import type { HonoVariables } from '../../types';

const servicesStatusRoutes = new Hono<{ Variables: HonoVariables }>();

servicesStatusRoutes.get('/', async (c) => {
  const blocked = await checkSuperAdmin(c);
  if (blocked) return blocked;

  logger.debug('Checking services status');

  // Get enabled services (auto-detects running containers)
  const { services, running } = await getEnabledServices();

  // Check all services in parallel
  const results = (
    await Promise.all(services.map((service) => checkServiceHealth(service, running)))
  ).map((row) => ({ ...row, restartable: isRestartable(row.container) }));

  // Sort by name for consistent ordering
  results.sort((a, b) => a.name.localeCompare(b.name));

  const healthy = results.filter((r) => r.status === 'healthy').length;
  const total = results.length;

  logger.debug({ healthy, total }, 'Services status check complete');

  return c.json({
    summary: {
      healthy,
      unhealthy: total - healthy,
      total,
    },
    services: results,
    timestamp: new Date().toISOString(),
  });
});

// The Docker API paths this page and Traefik see Docker through. Never
// restarted from the dashboard.
const SOCKET_PROXIES = ['docker-socket-proxy', 'app-docker-proxy'];

// Every container this page knows by name: the log viewer's allowlist.
const ALL_KNOWN_CONTAINERS = [
  ...CORE_SERVICES.map((s) => s.container),
  ...SOCKET_PROXIES,
  ...DISCOVERED_SERVICES.map((s) => s.container),
  ...Object.values(OPTIONAL_SERVICES).flatMap((configs) => configs.map((c) => c.container)),
];

/**
 * The restart allowlist: known containers minus the socket proxies, the
 * paths Traefik and this page see Docker through, which no dashboard action
 * should cycle.
 */
const RESTARTABLE_CONTAINERS = new Set(
  ALL_KNOWN_CONTAINERS.filter((name) => !SOCKET_PROXIES.includes(name))
);

/**
 * Restarts run `docker compose restart` and so need the docker CLI and the
 * compose files next to this process: local dev, the API on the host. The
 * production app container has neither (and its socket proxy refuses POST),
 * and k8s has no compose, so the dashboard offers no restart there.
 */
const canRestart = !isKubernetes && !isDocker;

const RESTART_UNAVAILABLE =
  'Restart is not available from the dashboard in this deployment. Run `docker compose restart <service>` on the server.';

function isRestartable(container: string): boolean {
  return canRestart && RESTARTABLE_CONTAINERS.has(container);
}

/**
 * Restart a Docker container using docker compose
 */
async function restartContainer(container: string): Promise<{ success: boolean; error?: string }> {
  // Only allow restarting known, restartable containers
  if (!RESTARTABLE_CONTAINERS.has(container)) {
    return { success: false, error: `Invalid container: ${container}` };
  }

  try {
    logger.info({ container }, 'Restarting container');
    await execAsync(`docker compose restart ${container}`, {
      timeout: 60000, // 60 second timeout
    });
    logger.info({ container }, 'Container restarted successfully');
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ container, error: errorMessage }, 'Failed to restart container');
    // The production app container ships no docker CLI (and the socket proxy
    // is read-only by design) — restarts must run on the host. Say so
    // instead of surfacing a bare "Command failed".
    if (/not found|ENOENT/i.test(errorMessage)) {
      return { success: false, error: RESTART_UNAVAILABLE };
    }
    return { success: false, error: errorMessage };
  }
}

// POST /restart - Restart all running services
servicesStatusRoutes.post('/restart', async (c) => {
  const blocked = await checkSuperAdmin(c);
  if (blocked) return blocked;

  if (isKubernetes) {
    return c.json({ success: false, error: 'Not supported in Kubernetes' }, 501);
  }
  if (!canRestart) return c.json({ success: false, error: RESTART_UNAVAILABLE }, 501);

  logger.info('Restarting all services');

  const { services } = await getEnabledServices();
  // Not the app itself: restarting the process answering this request would
  // drop the reply. Restart it on its own (POST /restart/app).
  const containers = services
    .map((s) => s.container)
    .filter((name) => name !== 'app' && RESTARTABLE_CONTAINERS.has(name));

  const results = await Promise.all(
    containers.map(async (container) => {
      const result = await restartContainer(container);
      return { container, ...result };
    })
  );

  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success);

  logger.info({ successful, failed: failed.length }, 'Restart all complete');

  return c.json({
    success: failed.length === 0,
    summary: {
      successful,
      failed: failed.length,
      total: containers.length,
    },
    results,
  });
});

// POST /restart/:container - Restart a specific service
servicesStatusRoutes.post('/restart/:container', async (c) => {
  const blocked = await checkSuperAdmin(c);
  if (blocked) return blocked;

  if (isKubernetes) {
    return c.json({ success: false, error: 'Not supported in Kubernetes' }, 501);
  }

  const container = c.req.param('container');

  if (!RESTARTABLE_CONTAINERS.has(container)) {
    return c.json({ success: false, error: `Invalid container: ${container}` }, 400);
  }
  if (!canRestart) return c.json({ success: false, error: RESTART_UNAVAILABLE }, 501);

  const result = await restartContainer(container);

  if (!result.success) {
    return c.json(result, 500);
  }

  return c.json(result);
});

// ============================================================================
// KUBERNETES LOG HELPERS
// ============================================================================

// Load k8s service account credentials once at startup
const k8sCredentials = (() => {
  if (!isKubernetes) return null;
  try {
    return {
      token: fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim(),
      ca: fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'),
      namespace: fs
        .readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8')
        .trim(),
    };
  } catch {
    return null;
  }
})();

/** Read the pod's default gateway from /proc/net/route (little-endian hex) */
function getPodDefaultGateway(): string | null {
  try {
    const routes = fs.readFileSync('/proc/net/route', 'utf8');
    for (const line of routes.split('\n').slice(1)) {
      const parts = line.split('\t');
      if (parts[1] === '00000000' && parts[2] && parts[2] !== '00000000') {
        const h = parts[2];
        return [
          parseInt(h.slice(6, 8), 16),
          parseInt(h.slice(4, 6), 16),
          parseInt(h.slice(2, 4), 16),
          parseInt(h.slice(0, 2), 16),
        ].join('.');
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function testTcpConnection(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.connect(port, host, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => {
      sock.destroy();
      resolve(false);
    });
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

// Lazily detected API server endpoint (ClusterIP or pod gateway fallback)
let k8sApiEndpoint: { host: string; port: number } | null | undefined;

async function getK8sApiEndpoint(): Promise<{ host: string; port: number } | null> {
  if (k8sApiEndpoint !== undefined) return k8sApiEndpoint;

  const clusterIpHost = process.env.KUBERNETES_SERVICE_HOST ?? '';
  const clusterIpPort =
    Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS || process.env.KUBERNETES_SERVICE_PORT) || 443;

  // Try ClusterIP first (works on worker nodes via kube-proxy DNAT)
  if (clusterIpHost && (await testTcpConnection(clusterIpHost, clusterIpPort))) {
    k8sApiEndpoint = { host: clusterIpHost, port: clusterIpPort };
    return k8sApiEndpoint;
  }

  // Fall back to pod gateway on port 6443 (k3s master: kube-proxy doesn't install
  // KUBE-SERVICES rules for the kubernetes ClusterIP on the master node itself)
  const gateway = getPodDefaultGateway();
  if (gateway && (await testTcpConnection(gateway, 6443))) {
    logger.info({ gateway }, 'K8s API: using pod gateway fallback (k3s master node)');
    k8sApiEndpoint = { host: gateway, port: 6443 };
    return k8sApiEndpoint;
  }

  k8sApiEndpoint = null;
  return null;
}

/** Human-readable names for k8s app labels */
const K8S_LABEL_NAMES: Record<string, string> = {
  'vibecarbon-app': 'App',
  // The db StatefulSet that replaces the Helm chart labels its pod
  // `app: vibecarbon-db` (PR B); until then the chart's pod has no `app` label.
  'vibecarbon-db': 'PostgreSQL',
  'vibecarbon-traefik': 'Traefik',
  n8n: 'n8n',
  metabase: 'Metabase',
  prometheus: 'Prometheus',
  grafana: 'Grafana',
  loki: 'Loki',
};

function sinceToSeconds(since: string): number {
  const match = since.match(/^(\d+)([smhd])$/);
  if (!match) return 600;
  const value = Number(match[1]);
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * (multipliers[match[2]] ?? 60);
}

async function k8sRequest(path: string, acceptText = false): Promise<string> {
  const creds = k8sCredentials;
  if (!creds) throw new Error('K8s credentials not available');

  const endpoint = await getK8sApiEndpoint();
  if (!endpoint) throw new Error('K8s API server not reachable');

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: endpoint.host,
        port: endpoint.port,
        path,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${creds.token}`,
          Accept: acceptText ? 'text/plain' : 'application/json',
        },
        ca: creds.ca,
        // Verification stays ON for every endpoint. It used to be
        //   rejectUnauthorized: endpoint.host === (process.env.KUBERNETES_SERVICE_HOST ?? '')
        // which disabled it entirely on the gateway:6443 fallback — and, when
        // KUBERNETES_SERVICE_HOST was unset, compared against '' and so
        // disabled it for EVERY request. This call carries the pod's
        // ServiceAccount token in an Authorization header, so anything able to
        // intercept pod->node:6443 could harvest cluster credentials.
        //
        // The real problem was never the CA — `creds.ca` is the cluster CA and
        // is already loaded here. It is only that the apiserver cert is issued
        // for the ClusterIP/master hostname, not for the gateway IP we dial on
        // the fallback. So keep the chain check and relax ONLY the hostname
        // match, by verifying against the in-cluster name instead of the dialed
        // address. Same shape as the CLI's staging-CA fix: pin the trust
        // anchor, never turn verification off.
        rejectUnauthorized: true,
        servername: process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc',
        checkServerIdentity: (_host: string, cert: Parameters<typeof tls.checkServerIdentity>[1]) =>
          tls.checkServerIdentity('kubernetes.default.svc', cert),
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => resolve(data));
      }
    );
    req.setTimeout(30000, () => req.destroy(new Error('K8s API timeout')));
    req.on('error', reject);
    req.end();
  });
}

interface K8sPod {
  metadata: { name: string; labels?: Record<string, string> };
  status?: { phase?: string };
}

async function listK8sPods(labelSelector?: string): Promise<K8sPod[]> {
  const ns = k8sCredentials?.namespace;
  if (!ns) return [];
  const qs = labelSelector ? `?labelSelector=${encodeURIComponent(labelSelector)}` : '';
  const body = await k8sRequest(`/api/v1/namespaces/${ns}/pods${qs}`);
  const parsed = JSON.parse(body) as { items?: K8sPod[] };
  return parsed.items ?? [];
}

async function getK8sPodLogs(
  podName: string,
  tail: number,
  sinceSeconds: number
): Promise<string[]> {
  const ns = k8sCredentials?.namespace;
  if (!ns) return [];
  const qs = new URLSearchParams({
    tailLines: String(tail),
    sinceSeconds: String(sinceSeconds),
    timestamps: 'true',
  });
  const text = await k8sRequest(`/api/v1/namespaces/${ns}/pods/${podName}/log?${qs}`, true);
  return text.split('\n').filter((l) => l.trim());
}

// ============================================================================
// DOCKER LOGS
// ============================================================================

/**
 * Fetch logs from Docker containers
 * Query params:
 *   - tail: number of lines (default 200)
 *   - since: time filter (e.g., "5m", "1h", "30s")
 *   - container: specific container (optional, defaults to all)
 */
servicesStatusRoutes.get('/logs', async (c) => {
  const blocked = await checkSuperAdmin(c);
  if (blocked) return blocked;

  const tail = Math.min(Math.max(Number(c.req.query('tail')) || 200, 1), 1000); // 1..1000 lines
  const since = c.req.query('since') || '10m';
  const container = c.req.query('container');

  // Validate since format (should be like "5m", "1h", "30s")
  if (!/^\d+[smhd]$/.test(since)) {
    return c.json(
      { success: false, error: 'Invalid since format. Use format like "5m", "1h", "30s"' },
      400
    );
  }

  // --- Kubernetes: fetch logs via K8s API ---
  if (isKubernetes) {
    // Validate container param (must be a safe label value)
    if (container && !/^[a-z0-9-]+$/.test(container)) {
      return c.json({ success: false, error: 'Invalid container', logs: [] }, 400);
    }

    if (!k8sCredentials) {
      return c.json(
        {
          success: false,
          error: 'K8s service account credentials not available. Check RBAC configuration.',
          logs: [],
        },
        503
      );
    }

    try {
      const sinceSeconds = sinceToSeconds(since);
      const labelSelector = container ? `app=${container}` : undefined;
      const pods = await listK8sPods(labelSelector);
      const runningPods = pods.filter((p) => p.status?.phase === 'Running');

      if (runningPods.length === 0) {
        return c.json({
          success: true,
          logs: [],
          meta: {
            tail,
            since,
            container: container || 'all',
            lineCount: 0,
            timestamp: new Date().toISOString(),
          },
        });
      }

      const allLogs = await Promise.all(
        runningPods.map(async (pod) => {
          const appLabel = pod.metadata.labels?.app ?? pod.metadata.name;
          const displayName = appLabel.replace(/^vibecarbon-/, '');
          try {
            const lines = await getK8sPodLogs(pod.metadata.name, tail, sinceSeconds);
            return lines.map((line) => `${displayName} | ${line}`);
          } catch {
            return [];
          }
        })
      );

      const logs = allLogs.flat().sort();

      logger.debug({ tail, since, container, podCount: runningPods.length }, 'Fetched K8s logs');

      return c.json({
        success: true,
        logs,
        meta: {
          tail,
          since,
          container: container || 'all',
          lineCount: logs.length,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: errorMessage }, 'Failed to fetch K8s logs');
      return c.json({ success: false, error: errorMessage, logs: [] }, 500);
    }
  }

  // --- Docker: fetch logs via the Engine API ---
  // Never the docker CLI: the production app container ships no CLI, no
  // compose files, and no socket — only the list-and-logs app-docker-proxy
  // (DOCKER_API_PROXY, set in docker-compose.prod.yml). Local dev talks to
  // /var/run/docker.sock directly. Same shape as the k8s branch above:
  // per-container fetch over HTTP, lines prefixed with the service name.
  if (container && !ALL_KNOWN_CONTAINERS.includes(container)) {
    return c.json({ success: false, error: `Invalid container: ${container}` }, 400);
  }

  const project = process.env.PROJECT_NAME;
  if (!project) {
    return c.json({ success: false, error: 'PROJECT_NAME is not set', logs: [] }, 503);
  }

  try {
    const sinceSeconds = sinceToSeconds(since);
    const containers = await listProjectContainers(project);
    const targets = container
      ? containers.filter((entry) => entry.service === container)
      : containers;

    const allLogs = await Promise.all(
      targets.map(async (entry) => {
        try {
          const lines = await fetchContainerLogs(entry.id, { tail, sinceSeconds });
          return lines.map((line) => `${entry.service}  | ${line}`);
        } catch {
          return [];
        }
      })
    );

    const logs = allLogs.flat().sort();

    logger.debug({ tail, since, container, containerCount: targets.length }, 'Fetched Docker logs');

    return c.json({
      success: true,
      logs,
      meta: {
        tail,
        since,
        container: container || 'all',
        lineCount: logs.length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: errorMessage }, 'Failed to fetch Docker logs');

    if (errorMessage.includes('not reachable')) {
      return c.json(
        {
          success: false,
          error:
            'Docker API is not reachable: no /var/run/docker.sock and DOCKER_API_PROXY is unset',
          logs: [],
        },
        503
      );
    }

    // Detail (incl. Docker API response text) stays in the server log above —
    // don't echo internal Docker state to the browser.
    return c.json(
      {
        success: false,
        error: 'Failed to fetch logs from the Docker API. Check the server logs.',
        logs: [],
      },
      500
    );
  }
});

// GET /logs/containers - List available containers for log filtering
servicesStatusRoutes.get('/logs/containers', async (c) => {
  const blocked = await checkSuperAdmin(c);
  if (blocked) return blocked;

  if (isKubernetes) {
    try {
      const pods = await listK8sPods();
      const seen = new Set<string>();
      const containers: Array<{ name: string; container: string }> = [];
      for (const pod of pods) {
        if (pod.status?.phase !== 'Running') continue;
        const appLabel = pod.metadata.labels?.app;
        if (appLabel && !seen.has(appLabel)) {
          seen.add(appLabel);
          containers.push({
            name: K8S_LABEL_NAMES[appLabel] ?? appLabel,
            container: appLabel,
          });
        }
      }
      containers.sort((a, b) => a.name.localeCompare(b.name));
      return c.json({ containers });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: errorMessage }, 'Failed to list K8s pods');
      return c.json({ containers: [] });
    }
  }

  const { services } = await getEnabledServices();
  return c.json({
    containers: services.map((s) => ({
      name: s.name,
      container: s.container,
    })),
  });
});

export { servicesStatusRoutes };
