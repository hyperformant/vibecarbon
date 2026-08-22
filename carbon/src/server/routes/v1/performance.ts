import { statfsSync } from 'node:fs';
import { Hono } from 'hono';
import { isSuperAdmin } from '../../lib/auth';
import { logger } from '../../lib/logger';
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
    name: 'Authentication',
    url: isKubernetes
      ? 'http://kong:8000/auth/v1/health'
      : isDocker
        ? 'http://auth:9999/health'
        : 'http://localhost:8000/auth/v1/health',
    acceptCodes: isDocker ? undefined : [200, 401],
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
    name: 'File Storage',
    url: isKubernetes
      ? 'http://kong:8000/storage/v1/status'
      : isDocker
        ? 'http://storage:5000/status'
        : 'http://localhost:8000/storage/v1/status',
    acceptCodes: isDocker ? undefined : [200, 401],
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

  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }

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
  const items = await Promise.all(HEALTH_CHECK_SERVICES.map(checkServiceLatency));

  const healthy = items.filter((s) => s.status === 'healthy').length;
  const healthyItems = items.filter((s) => s.status === 'healthy');
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
