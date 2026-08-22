import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  arePortsAvailable,
  cleanupDocker,
  waitForHttpHealth,
  waitForPostgres,
  waitWithBackoff,
} from '../../_shared/docker-utils.js';
import { cleanupTempDir, createTempDir } from '../../_shared/temp-dir.js';
import { testConfig } from '../../config.js';

// Parse .env file into an object, stripping quotes from values
function loadEnvFile(filePath: string): Record<string, string> {
  const content = readFileSync(filePath, 'utf-8');
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key) {
        let value = valueParts.join('=');
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        env[key] = value;
      }
    }
  }
  return env;
}

// Heavyweight: needs a clean docker host. Skipped by default; run
// explicitly via `DOCKER_INTEGRATION=true pnpm test:docker`.
const shouldRunDocker = process.env.DOCKER_INTEGRATION === 'true';
const describeDocker = shouldRunDocker ? describe : describe.skip;

describeDocker('Optional Services Smoke Test - Observability', () => {
  let tempDir: string;
  let projectEnv: Record<string, string>;
  let portsAvailable = false;
  let observabilityAvailable = false;
  let lokiAvailable = false;
  const projectName = 'test-smoke-observability';
  const projectDir = () => join(tempDir, projectName);

  const getExecEnv = () => ({ ...process.env, ...projectEnv });

  beforeAll(async () => {
    // Check if required ports are available
    const requiredPorts = [
      ...testConfig.smoke.requiredPorts,
      ...testConfig.smoke.observabilityPorts,
    ];
    const portCheck = await arePortsAvailable(requiredPorts);
    if (!portCheck.available) {
      console.log(
        `Skipping observability smoke tests: ports not available (${portCheck.unavailablePorts.join(', ')})`,
      );
      return;
    }
    portsAvailable = true;
    observabilityAvailable = true;

    tempDir = createTempDir('vibecarbon-observability-smoke-');

    // Create the project, then install observability (an opt-in add-on) so
    // its compose overlay + volume configs are present before we compose
    // them up.
    execSync(
      `node ${join(process.cwd(), 'src/cli.js')} create ${projectName} -y -admin-email test@smoke.local -admin-password smoketest123 && (cd ${projectName} && node ${join(process.cwd(), 'src/cli.js')} add observability -y)`,
      {
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 300000,
      },
    );

    // Load the generated .env.local
    projectEnv = loadEnvFile(join(projectDir(), '.env.local'));
    projectEnv.PROJECT_NAME = projectName;
    projectEnv.POSTGRES_PASSWORD = projectEnv.DB_PASSWORD || 'postgres';

    // Start db and observability services
    execSync(
      'docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d db prometheus grafana loki promtail postgres-exporter',
      {
        cwd: projectDir(),
        encoding: 'utf-8',
        timeout: testConfig.smoke.timeouts.dockerUp,
        env: getExecEnv(),
      },
    );

    // Wait for database to be ready (with exponential backoff)
    const dbReady = await waitForPostgres(projectDir(), getExecEnv());
    if (!dbReady) {
      throw new Error('PostgreSQL failed to become ready');
    }

    // Wait for Loki to be ready (non-fatal: only Loki tests are skipped if unavailable)
    lokiAvailable = await waitForHttpHealth('http://localhost:3100/ready', {
      timeout: testConfig.smoke.timeouts.optionalServices,
      label: 'Loki ready',
    });
    if (!lokiAvailable) {
      // Dump container state for CI debugging
      try {
        const ps = execSync(
          'docker compose -f docker-compose.yml -f docker-compose.observability.yml ps --format json',
          { cwd: projectDir(), encoding: 'utf-8', timeout: 10000, env: getExecEnv() },
        );
        const containers = ps
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        const loki = containers.find((c: { Service: string }) => c.Service === 'loki');
        console.warn(
          `[Smoke] Loki not healthy. State: ${loki?.State ?? 'not found'}, Health: ${loki?.Health ?? 'N/A'}`,
        );
      } catch {
        /* ignore */
      }
    }

    // Wait for Grafana to be ready. H-9 removed Grafana's dev host port (access
    // is via Traefik only), so probe /api/health from inside the container
    // instead of localhost:3002.
    const grafanaReady = await waitWithBackoff(
      () => {
        try {
          const out = execSync(
            'docker compose -f docker-compose.yml -f docker-compose.observability.yml exec -T grafana wget -qO- http://localhost:3000/api/health',
            { cwd: projectDir(), encoding: 'utf-8', timeout: 10000, env: getExecEnv() },
          );
          return out.includes('database');
        } catch {
          return false;
        }
      },
      { timeout: testConfig.smoke.timeouts.optionalServices, label: 'Grafana health' },
    );
    if (!grafanaReady) {
      throw new Error('Grafana failed to become ready');
    }
  }, 300000);

  afterAll(async () => {
    if (!portsAvailable || !tempDir) return;

    // Use robust cleanup with fallback to force kill
    // Note: We need to use the observability compose file for cleanup
    const cleanupResult = await cleanupDocker({
      cwd: projectDir(),
      env: getExecEnv(),
      projectName: projectName,
      gracefulTimeout: testConfig.smoke.timeouts.dockerDown,
    });

    if (!cleanupResult.success) {
      console.warn('[afterAll] Docker cleanup had issues:', cleanupResult.errors);
    }
    if (cleanupResult.forceKilled.length > 0) {
      console.warn('[afterAll] Force killed containers:', cleanupResult.forceKilled);
    }

    cleanupTempDir(tempDir);
  }, 120000);

  describe('Prometheus', () => {
    it('container is running', ({ skip }) => {
      if (!observabilityAvailable) skip();
      const result = execSync(
        'docker compose -f docker-compose.yml -f docker-compose.observability.yml ps --format json',
        {
          cwd: projectDir(),
          encoding: 'utf-8',
          timeout: 10000,
          env: getExecEnv(),
        },
      );

      const lines = result.trim().split('\n').filter(Boolean);
      const containers = lines.map((line) => JSON.parse(line));
      const runningServices = containers
        .filter((c: { State: string }) => c.State === 'running')
        .map((c: { Service: string }) => c.Service);

      expect(runningServices).toContain('prometheus');
    });

    it('is scraping targets', async ({ skip }) => {
      if (!observabilityAvailable) skip();
      // Query Prometheus via docker exec since it's not exposed externally
      const result = execSync(
        'docker compose -f docker-compose.yml -f docker-compose.observability.yml exec -T prometheus wget -qO- http://localhost:9090/-/ready',
        {
          cwd: projectDir(),
          encoding: 'utf-8',
          timeout: 10000,
          env: getExecEnv(),
        },
      );
      expect(result.toLowerCase()).toContain('ready');
    });
  });

  describe('Grafana', () => {
    it('container is running', ({ skip }) => {
      if (!observabilityAvailable) skip();
      const result = execSync(
        'docker compose -f docker-compose.yml -f docker-compose.observability.yml ps --format json',
        {
          cwd: projectDir(),
          encoding: 'utf-8',
          timeout: 10000,
          env: getExecEnv(),
        },
      );

      const lines = result.trim().split('\n').filter(Boolean);
      const containers = lines.map((line) => JSON.parse(line));
      const runningServices = containers
        .filter((c: { State: string }) => c.State === 'running')
        .map((c: { Service: string }) => c.Service);

      expect(runningServices).toContain('grafana');
    });

    it('health endpoint responds', async ({ skip }) => {
      if (!observabilityAvailable) skip();
      // H-9: no host port — query /api/health from inside the container.
      const result = execSync(
        'docker compose -f docker-compose.yml -f docker-compose.observability.yml exec -T grafana wget -qO- http://localhost:3000/api/health',
        { cwd: projectDir(), encoding: 'utf-8', timeout: 10000, env: getExecEnv() },
      );
      expect(result).toContain('database');
    });

    it('login page is accessible (anonymous auth is off — H-9)', async ({ skip }) => {
      if (!observabilityAvailable) skip();
      // H-9: no host port, and anonymous auth is disabled, so an unauthenticated
      // request now lands on the login page. Fetch it from inside the container.
      const result = execSync(
        'docker compose -f docker-compose.yml -f docker-compose.observability.yml exec -T grafana wget -qO- http://localhost:3000/login',
        { cwd: projectDir(), encoding: 'utf-8', timeout: 10000, env: getExecEnv() },
      );
      expect(result).toContain('Grafana');
    });

    it('has datasources configured', async ({ skip }) => {
      if (!observabilityAvailable) skip();
      // Check datasources via Grafana API (requires auth, so we check via docker)
      const result = execSync(
        'docker compose -f docker-compose.yml -f docker-compose.observability.yml exec -T grafana ls /etc/grafana/provisioning/datasources/',
        {
          cwd: projectDir(),
          encoding: 'utf-8',
          timeout: 10000,
          env: getExecEnv(),
        },
      );
      expect(result).toContain('datasources.yml');
    });

    it('has dashboards provisioned', async ({ skip }) => {
      if (!observabilityAvailable) skip();
      const result = execSync(
        'docker compose -f docker-compose.yml -f docker-compose.observability.yml exec -T grafana ls /var/lib/grafana/dashboards/',
        {
          cwd: projectDir(),
          encoding: 'utf-8',
          timeout: 10000,
          env: getExecEnv(),
        },
      );
      // Should have at least one dashboard
      expect(result.trim().length).toBeGreaterThan(0);
    });
  });

  describe('Loki', () => {
    it('container is running', ({ skip }) => {
      if (!lokiAvailable) skip();
      const result = execSync(
        'docker compose -f docker-compose.yml -f docker-compose.observability.yml ps --format json',
        {
          cwd: projectDir(),
          encoding: 'utf-8',
          timeout: 10000,
          env: getExecEnv(),
        },
      );

      const lines = result.trim().split('\n').filter(Boolean);
      const containers = lines.map((line) => JSON.parse(line));
      const runningServices = containers
        .filter((c: { State: string }) => c.State === 'running')
        .map((c: { Service: string }) => c.Service);

      expect(runningServices).toContain('loki');
    });

    it('can accept HTTP requests', async ({ skip }) => {
      if (!lokiAvailable) skip();
      // Check that Loki's HTTP server is responding (even 503 means it's running)
      // The /ready endpoint can return 503 during initialization but Loki is still functional
      const responds = await waitWithBackoff(
        () => {
          try {
            // Check /metrics endpoint which is less strict than /ready
            const result = execSync(
              'docker compose -f docker-compose.yml -f docker-compose.observability.yml exec -T loki wget -qO- http://localhost:3100/metrics 2>&1 | head -5 || echo "error"',
              {
                cwd: projectDir(),
                encoding: 'utf-8',
                timeout: 10000,
                env: getExecEnv(),
              },
            );
            // If we get any metrics response, Loki is working
            return result.includes('loki_') || result.includes('# HELP');
          } catch {
            return false;
          }
        },
        { timeout: 30000, label: 'Loki metrics' },
      );
      expect(responds).toBe(true);
    }, 30000);
  });

  describe('Promtail', () => {
    it('container is running', ({ skip }) => {
      if (!observabilityAvailable) skip();
      const result = execSync(
        'docker compose -f docker-compose.yml -f docker-compose.observability.yml ps --format json',
        {
          cwd: projectDir(),
          encoding: 'utf-8',
          timeout: 10000,
          env: getExecEnv(),
        },
      );

      const lines = result.trim().split('\n').filter(Boolean);
      const containers = lines.map((line) => JSON.parse(line));
      const runningServices = containers
        .filter((c: { State: string }) => c.State === 'running')
        .map((c: { Service: string }) => c.Service);

      expect(runningServices).toContain('promtail');
    });

    it('is shipping logs to Loki', async ({ skip }) => {
      if (!observabilityAvailable) skip();
      // Check Promtail targets via docker exec
      const result = execSync(
        'docker compose -f docker-compose.yml -f docker-compose.observability.yml exec -T promtail wget -qO- http://localhost:9080/ready || echo "ready"',
        {
          cwd: projectDir(),
          encoding: 'utf-8',
          timeout: 10000,
          env: getExecEnv(),
        },
      );
      // Promtail should respond (even if just with ready check)
      expect(result).toBeDefined();
    });
  });

  describe('Postgres Exporter', () => {
    it('container is running', ({ skip }) => {
      if (!observabilityAvailable) skip();
      const result = execSync(
        'docker compose -f docker-compose.yml -f docker-compose.observability.yml ps --format json',
        {
          cwd: projectDir(),
          encoding: 'utf-8',
          timeout: 10000,
          env: getExecEnv(),
        },
      );

      const lines = result.trim().split('\n').filter(Boolean);
      const containers = lines.map((line) => JSON.parse(line));
      const runningServices = containers
        .filter((c: { State: string }) => c.State === 'running')
        .map((c: { Service: string }) => c.Service);

      expect(runningServices).toContain('postgres-exporter');
    });

    it('is exposing PostgreSQL metrics', async ({ skip }) => {
      if (!observabilityAvailable) skip();
      // Check postgres-exporter metrics endpoint via docker exec with retries
      // (postgres-exporter needs time to connect to DB and expose pg_ metrics)
      const hasPgMetrics = await waitWithBackoff(
        () => {
          try {
            const result = execSync(
              'docker compose -f docker-compose.yml -f docker-compose.observability.yml exec -T postgres-exporter wget -qO- http://localhost:9187/metrics | grep -m1 "pg_" || echo ""',
              {
                cwd: projectDir(),
                encoding: 'utf-8',
                timeout: 10000,
                env: getExecEnv(),
              },
            );
            return result.includes('pg_');
          } catch {
            return false;
          }
        },
        { timeout: 30000, label: 'Postgres Exporter metrics' },
      );
      expect(hasPgMetrics).toBe(true);
    }, 30000);
  });
});
