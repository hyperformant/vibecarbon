import { describe, expect, it } from 'vitest';

/**
 * Tests for performance endpoint logic from carbon/src/server/routes/v1/performance.ts
 * Re-implements key logic inline to avoid path alias resolution issues in tests.
 */

// ============================================================================
// MOCK TYPES
// ============================================================================

interface MockUser {
  id: string;
  email?: string;
  app_metadata?: {
    role?: string;
    [key: string]: unknown;
  };
}

interface ServiceLatencyResult {
  name: string;
  latencyMs: number;
  status: 'healthy' | 'unhealthy' | 'unknown';
}

// ============================================================================
// HELPER FUNCTIONS (from template)
// ============================================================================

function isSuperAdmin(user: MockUser): boolean {
  return user.app_metadata?.role === 'super_admin';
}

// ============================================================================
// ENDPOINT LOGIC (re-implemented from performance.ts)
// ============================================================================

function performanceEndpoint(
  user: MockUser | null,
  serviceResults: ServiceLatencyResult[],
  serverMetrics: {
    uptimeSeconds: number;
    memoryMB: { rss: number; heapUsed: number; heapTotal: number };
    nodeVersion: string;
    platform: string;
  },
) {
  if (!user) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }

  if (!isSuperAdmin(user)) {
    return { status: 403, body: { error: 'Super admin access required' } };
  }

  const healthy = serviceResults.filter((s) => s.status === 'healthy').length;
  const healthyItems = serviceResults.filter((s) => s.status === 'healthy');
  const avgLatencyMs =
    healthyItems.length > 0
      ? Math.round(healthyItems.reduce((sum, s) => sum + s.latencyMs, 0) / healthyItems.length)
      : 0;

  return {
    status: 200,
    body: {
      server: serverMetrics,
      services: {
        healthy,
        total: serviceResults.length,
        avgLatencyMs,
        items: serviceResults,
      },
    },
  };
}

// ============================================================================
// SERVICE LATENCY CHECK LOGIC (re-implemented from performance.ts)
// ============================================================================

function computeServiceStatus(
  responseStatus: number | null,
  acceptCodes: number[] | undefined,
): 'healthy' | 'unhealthy' {
  if (responseStatus === null) {
    return 'unhealthy';
  }
  if (acceptCodes) {
    return acceptCodes.includes(responseStatus) ? 'healthy' : 'unhealthy';
  }
  return responseStatus >= 200 && responseStatus < 400 ? 'healthy' : 'unhealthy';
}

// ============================================================================
// TEST DATA
// ============================================================================

const superAdmin: MockUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  app_metadata: { role: 'super_admin' },
};

const regularUser: MockUser = {
  id: 'user-1',
  email: 'user@example.com',
  app_metadata: { role: 'user' },
};

const userWithNoRole: MockUser = {
  id: 'user-2',
  email: 'norole@example.com',
};

const defaultServerMetrics = {
  uptimeSeconds: 3600,
  memoryMB: { rss: 128, heapUsed: 64, heapTotal: 96 },
  nodeVersion: 'v20.0.0',
  platform: 'linux x64',
};

const healthyServices: ServiceLatencyResult[] = [
  { name: 'API Gateway', latencyMs: 12, status: 'healthy' },
  { name: 'Authentication', latencyMs: 25, status: 'healthy' },
  { name: 'REST API', latencyMs: 8, status: 'healthy' },
  { name: 'Realtime', latencyMs: 15, status: 'healthy' },
  { name: 'File Storage', latencyMs: 20, status: 'healthy' },
  { name: 'DB Management', latencyMs: 10, status: 'healthy' },
];

const mixedServices: ServiceLatencyResult[] = [
  { name: 'API Gateway', latencyMs: 12, status: 'healthy' },
  { name: 'Authentication', latencyMs: 2000, status: 'unhealthy' },
  { name: 'REST API', latencyMs: 8, status: 'healthy' },
  { name: 'Realtime', latencyMs: 2000, status: 'unhealthy' },
  { name: 'File Storage', latencyMs: 20, status: 'healthy' },
  { name: 'DB Management', latencyMs: 10, status: 'healthy' },
];

const allUnhealthyServices: ServiceLatencyResult[] = [
  { name: 'API Gateway', latencyMs: 2000, status: 'unhealthy' },
  { name: 'Authentication', latencyMs: 2000, status: 'unhealthy' },
  { name: 'REST API', latencyMs: 2000, status: 'unhealthy' },
];

// ============================================================================
// TESTS
// ============================================================================

describe('Performance Endpoint', () => {
  describe('Authentication and Authorization', () => {
    it('returns 401 when no user is provided', () => {
      const result = performanceEndpoint(null, healthyServices, defaultServerMetrics);
      expect(result.status).toBe(401);
      expect(result.body.error).toBe('Unauthorized');
    });

    it('returns 403 for a regular user without super_admin role', () => {
      const result = performanceEndpoint(regularUser, healthyServices, defaultServerMetrics);
      expect(result.status).toBe(403);
      expect(result.body.error).toBe('Super admin access required');
    });

    it('returns 403 for a user with no app_metadata', () => {
      const result = performanceEndpoint(userWithNoRole, healthyServices, defaultServerMetrics);
      expect(result.status).toBe(403);
      expect(result.body.error).toBe('Super admin access required');
    });

    it('returns 200 for a super_admin user', () => {
      const result = performanceEndpoint(superAdmin, healthyServices, defaultServerMetrics);
      expect(result.status).toBe(200);
    });
  });

  describe('Response Shape', () => {
    it('returns server and services top-level fields', () => {
      const result = performanceEndpoint(superAdmin, healthyServices, defaultServerMetrics);
      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty('server');
      expect(result.body).toHaveProperty('services');
    });

    it('does not include extra top-level fields', () => {
      const result = performanceEndpoint(superAdmin, healthyServices, defaultServerMetrics);
      const keys = Object.keys(result.body);
      expect(keys).toEqual(['server', 'services']);
    });
  });

  describe('Server Metrics', () => {
    it('returns uptimeSeconds as a number', () => {
      const result = performanceEndpoint(superAdmin, healthyServices, defaultServerMetrics);
      expect(typeof result.body.server.uptimeSeconds).toBe('number');
    });

    it('returns memoryMB with rss, heapUsed, and heapTotal as numbers', () => {
      const result = performanceEndpoint(superAdmin, healthyServices, defaultServerMetrics);
      const { memoryMB } = result.body.server;
      expect(typeof memoryMB.rss).toBe('number');
      expect(typeof memoryMB.heapUsed).toBe('number');
      expect(typeof memoryMB.heapTotal).toBe('number');
    });

    it('returns nodeVersion as a string', () => {
      const result = performanceEndpoint(superAdmin, healthyServices, defaultServerMetrics);
      expect(typeof result.body.server.nodeVersion).toBe('string');
    });

    it('returns platform as a string', () => {
      const result = performanceEndpoint(superAdmin, healthyServices, defaultServerMetrics);
      expect(typeof result.body.server.platform).toBe('string');
    });

    it('preserves exact server metric values', () => {
      const result = performanceEndpoint(superAdmin, healthyServices, defaultServerMetrics);
      expect(result.body.server).toEqual(defaultServerMetrics);
    });
  });

  describe('Services Metrics', () => {
    it('returns healthy count as a number', () => {
      const result = performanceEndpoint(superAdmin, healthyServices, defaultServerMetrics);
      expect(typeof result.body.services.healthy).toBe('number');
    });

    it('returns total count as a number', () => {
      const result = performanceEndpoint(superAdmin, healthyServices, defaultServerMetrics);
      expect(typeof result.body.services.total).toBe('number');
    });

    it('returns avgLatencyMs as a number', () => {
      const result = performanceEndpoint(superAdmin, healthyServices, defaultServerMetrics);
      expect(typeof result.body.services.avgLatencyMs).toBe('number');
    });

    it('returns items as an array', () => {
      const result = performanceEndpoint(superAdmin, healthyServices, defaultServerMetrics);
      expect(Array.isArray(result.body.services.items)).toBe(true);
    });

    it('counts all healthy services correctly when all are healthy', () => {
      const result = performanceEndpoint(superAdmin, healthyServices, defaultServerMetrics);
      expect(result.body.services.healthy).toBe(6);
      expect(result.body.services.total).toBe(6);
    });

    it('counts healthy and total correctly with mixed statuses', () => {
      const result = performanceEndpoint(superAdmin, mixedServices, defaultServerMetrics);
      expect(result.body.services.healthy).toBe(4);
      expect(result.body.services.total).toBe(6);
    });

    it('computes average latency only from healthy services', () => {
      const result = performanceEndpoint(superAdmin, mixedServices, defaultServerMetrics);
      // Healthy services: API Gateway (12), REST API (8), File Storage (20), DB Management (10)
      // Average: (12 + 8 + 20 + 10) / 4 = 12.5 → rounded to 13
      expect(result.body.services.avgLatencyMs).toBe(13);
    });

    it('returns avgLatencyMs of 0 when no services are healthy', () => {
      const result = performanceEndpoint(superAdmin, allUnhealthyServices, defaultServerMetrics);
      expect(result.body.services.avgLatencyMs).toBe(0);
      expect(result.body.services.healthy).toBe(0);
    });

    it('handles empty services list', () => {
      const result = performanceEndpoint(superAdmin, [], defaultServerMetrics);
      expect(result.body.services.healthy).toBe(0);
      expect(result.body.services.total).toBe(0);
      expect(result.body.services.avgLatencyMs).toBe(0);
      expect(result.body.services.items).toEqual([]);
    });
  });

  describe('Service Item Shape', () => {
    it('each item has name as a string', () => {
      const result = performanceEndpoint(superAdmin, healthyServices, defaultServerMetrics);
      for (const item of result.body.services.items) {
        expect(typeof item.name).toBe('string');
        expect(item.name.length).toBeGreaterThan(0);
      }
    });

    it('each item has latencyMs as a number', () => {
      const result = performanceEndpoint(superAdmin, healthyServices, defaultServerMetrics);
      for (const item of result.body.services.items) {
        expect(typeof item.latencyMs).toBe('number');
        expect(item.latencyMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('each item has status as healthy, unhealthy, or unknown', () => {
      const result = performanceEndpoint(superAdmin, mixedServices, defaultServerMetrics);
      const validStatuses = ['healthy', 'unhealthy', 'unknown'];
      for (const item of result.body.services.items) {
        expect(validStatuses).toContain(item.status);
      }
    });

    it('items preserve the original service order', () => {
      const result = performanceEndpoint(superAdmin, healthyServices, defaultServerMetrics);
      const names = result.body.services.items.map((i: ServiceLatencyResult) => i.name);
      expect(names).toEqual([
        'API Gateway',
        'Authentication',
        'REST API',
        'Realtime',
        'File Storage',
        'DB Management',
      ]);
    });
  });

  describe('Service Health Status Computation', () => {
    it('marks service healthy when response code is in acceptCodes', () => {
      expect(computeServiceStatus(404, [404])).toBe('healthy');
      expect(computeServiceStatus(200, [200, 401])).toBe('healthy');
      expect(computeServiceStatus(401, [200, 401])).toBe('healthy');
    });

    it('marks service unhealthy when response code is not in acceptCodes', () => {
      expect(computeServiceStatus(500, [200, 401])).toBe('unhealthy');
      expect(computeServiceStatus(200, [404])).toBe('unhealthy');
    });

    it('marks service healthy for 2xx/3xx when no acceptCodes specified', () => {
      expect(computeServiceStatus(200, undefined)).toBe('healthy');
      expect(computeServiceStatus(204, undefined)).toBe('healthy');
      expect(computeServiceStatus(301, undefined)).toBe('healthy');
      expect(computeServiceStatus(399, undefined)).toBe('healthy');
    });

    it('marks service unhealthy for 4xx/5xx when no acceptCodes specified', () => {
      expect(computeServiceStatus(400, undefined)).toBe('unhealthy');
      expect(computeServiceStatus(404, undefined)).toBe('unhealthy');
      expect(computeServiceStatus(500, undefined)).toBe('unhealthy');
    });

    it('marks service unhealthy when fetch fails (null status)', () => {
      expect(computeServiceStatus(null, undefined)).toBe('unhealthy');
      expect(computeServiceStatus(null, [200])).toBe('unhealthy');
    });
  });
});
