import { statfsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { adminDb } from '../../db/client';
import { logger } from '../../lib/logger';
import { checkSuperAdmin } from '../../middleware/requireSuperAdmin';
import type { HonoVariables } from '../../types';

const performanceRoutes = new Hono<{ Variables: HonoVariables }>();

// Detect runtime environment (same logic as services-status.ts)
const isKubernetes = !!process.env.KUBERNETES_SERVICE_HOST;
const isDocker =
  !isKubernetes && (process.env.NODE_ENV === 'production' || process.env.DOCKER === 'true');

type Latency = { name: string; latencyMs: number; status: 'healthy' | 'unhealthy' | 'unknown' };

const SERVICE_TIMEOUT_MS = 2000;

// Local dev publishes Traefik on DEV_TRAEFIK_PORT (default 80 plus
// DEV_PORT_OFFSET, the logic of scripts/docker-up.js).
function devTraefikPort(): number {
  const explicit = process.env.DEV_TRAEFIK_PORT;
  if (explicit) return Number.parseInt(explicit, 10);
  return 80 + Number.parseInt(process.env.DEV_PORT_OFFSET || '0', 10);
}

const TRAEFIK_URL =
  isKubernetes || isDocker ? 'http://traefik:80/' : `http://localhost:${devTraefikPort()}/`;

/** Time `fn`, giving up after SERVICE_TIMEOUT_MS. A throw or timeout is unhealthy. */
async function timed(
  name: string,
  fn: (signal: AbortSignal) => Promise<boolean>
): Promise<Latency> {
  const start = performance.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, SERVICE_TIMEOUT_MS);
  });
  try {
    const ok = await Promise.race([fn(controller.signal), timedOut]);
    return {
      name,
      latencyMs: Math.round(performance.now() - start),
      status: ok ? 'healthy' : 'unhealthy',
    };
  } catch {
    return { name, latencyMs: Math.round(performance.now() - start), status: 'unhealthy' };
  } finally {
    clearTimeout(timer);
  }
}

/** Round trip from the app to Postgres over its own connection. */
function checkDatabaseLatency(): Promise<Latency> {
  return timed('Database', async () => {
    await adminDb.execute(sql`select 1`);
    return true;
  });
}

/** Round trip from the app to Traefik. No router matches the bare name, so 404 is an answer. */
function checkTraefikLatency(): Promise<Latency> {
  return timed('Traefik', async (signal) => {
    const res = await fetch(TRAEFIK_URL, { method: 'GET', redirect: 'manual', signal });
    return res.status === 404 || (res.status >= 200 && res.status < 400);
  });
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
  const probed = await Promise.all([checkDatabaseLatency(), checkTraefikLatency()]);
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
