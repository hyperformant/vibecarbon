import { statfsSync } from 'node:fs';
import { Hono } from 'hono';
import { logger } from '../../lib/logger';
import { checkSuperAdmin } from '../../middleware/requireSuperAdmin';
import type { HonoVariables } from '../../types';

const performanceRoutes = new Hono<{ Variables: HonoVariables }>();

// Detect runtime environment (same logic as services-status.ts)
const isKubernetes = !!process.env.KUBERNETES_SERVICE_HOST;
const isDocker =
  !isKubernetes && (process.env.NODE_ENV === 'production' || process.env.DOCKER === 'true');

interface ServiceHealthCheck {
  name: string;
  url: string;
  acceptCodes?: number[];
}

// Core services to check latency against (subset of services-status.ts)
const HEALTH_CHECK_SERVICES: ServiceHealthCheck[] = [
  {
    name: 'API Gateway',
    url: isKubernetes
      ? 'http://kong:8000/'
      : isDocker
        ? 'http://kong:8000/'
        : 'http://localhost:8000/',
    acceptCodes: [404],
  },
  {
    name: 'REST API',
    url: isKubernetes
      ? 'http://kong:8000/rest/v1/'
      : isDocker
        ? 'http://rest:3000/'
        : 'http://localhost:8000/rest/v1/',
    acceptCodes: [200, 401],
  },
  {
    name: 'Realtime',
    url: isKubernetes
      ? 'http://kong:8000/realtime/v1/'
      : isDocker
        ? 'http://realtime:4000/api/tenants'
        : 'http://localhost:8000/realtime/v1/',
    acceptCodes: [200, 401, 403, 426],
  },
  {
    name: 'DB Management',
    url: isKubernetes
      ? 'http://kong:8000/pg/'
      : isDocker
        ? 'http://meta:8080/health'
        : 'http://localhost:8000/pg/',
    acceptCodes: [200, 401],
  },
];

const SERVICE_TIMEOUT_MS = 2000;

async function checkServiceLatency(
  service: ServiceHealthCheck
): Promise<{ name: string; latencyMs: number; status: 'healthy' | 'unhealthy' | 'unknown' }> {
  const start = performance.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SERVICE_TIMEOUT_MS);

    const response = await fetch(service.url, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const latencyMs = Math.round(performance.now() - start);

    const isHealthy = service.acceptCodes
      ? service.acceptCodes.includes(response.status)
      : response.status >= 200 && response.status < 400;

    return { name: service.name, latencyMs, status: isHealthy ? 'healthy' : 'unhealthy' };
  } catch {
    const latencyMs = Math.round(performance.now() - start);
    return { name: service.name, latencyMs, status: 'unhealthy' };
  }
}

// ============================================================================
// ADMIN PERFORMANCE ENDPOINT (Super Admin only)
// ============================================================================

performanceRoutes.get('/', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const blocked = await checkSuperAdmin(c);
  if (blocked) return blocked;

  // Gather server metrics
  const mem = process.memoryUsage();

  // Disk usage of the container root — on overlayfs this reflects the host
  // volume backing it, which is the disk that silently fills on small VPSes
  // (docker images, WAL archives, logs). Best-effort: null when statfs is
  // unavailable so the card renders "--" instead of failing the endpoint.
  let disk: { usedGB: number; totalGB: number; usedPercent: number } | null = null;
  try {
    const s = statfsSync('/');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const used = total - free;
    disk = {
      usedGB: Math.round((used / 1024 ** 3) * 10) / 10,
      totalGB: Math.round((total / 1024 ** 3) * 10) / 10,
      usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
    };
  } catch {
    // statfs unsupported on this platform — omit the metric.
  }

  const server = {
    uptimeSeconds: Math.round(process.uptime()),
    memoryMB: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    disk,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
  };

  // Check all service latencies in parallel
  const probed = await Promise.all(HEALTH_CHECK_SERVICES.map(checkServiceLatency));
  // Authentication runs in this process (/api/auth), so it is up whenever
  // this handler runs. Counted, but kept out of the latency average.
  const items = [...probed, { name: 'Authentication', latencyMs: 0, status: 'healthy' as const }];

  const healthy = items.filter((s) => s.status === 'healthy').length;
  const healthyItems = probed.filter((s) => s.status === 'healthy');
  const avgLatencyMs =
    healthyItems.length > 0
      ? Math.round(healthyItems.reduce((sum, s) => sum + s.latencyMs, 0) / healthyItems.length)
      : 0;

  logger.debug({ userId: user.id }, 'Admin performance metrics fetched');

  return c.json({
    server,
    services: {
      healthy,
      total: items.length,
      avgLatencyMs,
      items,
    },
  });
});

export { performanceRoutes };
