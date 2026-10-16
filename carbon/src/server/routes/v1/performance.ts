import { statfsSync } from 'node:fs';
import { Hono } from 'hono';
import { pingDb } from '../../db/client';
import { logger } from '../../lib/logger';
import { probeTraefik } from '../../lib/traefik-probe';
import { checkSuperAdmin } from '../../middleware/requireSuperAdmin';
import type { HonoVariables } from '../../types';

const performanceRoutes = new Hono<{ Variables: HonoVariables }>();

type Latency = { name: string; latencyMs: number; status: 'healthy' | 'unhealthy' | 'unknown' };

const SERVICE_TIMEOUT_MS = 2000;

/** Round trip from the app to Postgres over its own connection. */
async function checkDatabaseLatency(): Promise<Latency> {
  const ping = await pingDb(undefined, { timeoutMs: SERVICE_TIMEOUT_MS });
  return {
    name: 'PostgreSQL',
    latencyMs: ping.latencyMs,
    status: ping.ok ? 'healthy' : 'unhealthy',
  };
}

/** Round trip from the app to Traefik (lib/traefik-probe.ts). */
async function checkTraefikLatency(): Promise<Latency> {
  const probe = await probeTraefik(SERVICE_TIMEOUT_MS);
  return {
    name: 'Traefik',
    latencyMs: probe.latencyMs,
    status: probe.ok ? 'healthy' : 'unhealthy',
  };
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

  // The services one network hop from the app, each with a measured round
  // trip. Authentication runs inside this process, so it has no hop of its
  // own to time and is not an item (the Services panel folds it into App).
  const items = await Promise.all([checkDatabaseLatency(), checkTraefikLatency()]);

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
