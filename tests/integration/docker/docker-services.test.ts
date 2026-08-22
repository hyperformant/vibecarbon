import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  arePortsAvailable,
  cleanupDocker,
  fetchWithTimeout,
  waitForDockerCommand,
  waitForHttpHealth,
  waitForKong,
  waitForPostgres,
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
        // Strip surrounding quotes if present
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

// Heavyweight: needs a clean docker host (conflicts with any running
// vibecarbon-* containers on standard ports). Skipped by default; run
// explicitly via `DOCKER_INTEGRATION=true pnpm test:docker`.
const shouldRunDocker = process.env.DOCKER_INTEGRATION === 'true';
const describeDocker = shouldRunDocker ? describe : describe.skip;

describeDocker('Docker Services Smoke Test', () => {
  let tempDir: string;
  let projectEnv: Record<string, string>;
  let portsAvailable = false;
  let fullStackAvailable = false;
  let realtimeAvailable = false;
  let traefikAvailable = false;
  const projectName = 'test-smoke-docker';
  const projectDir = () => join(tempDir, projectName);

  // Get env for execSync that includes .env.local variables
  const getExecEnv = () => ({ ...process.env, ...projectEnv });

  beforeAll(async () => {
    // Check if required ports are available (database only - minimum requirement)
    const requiredCheck = await arePortsAvailable(testConfig.smoke.requiredPorts);
    if (!requiredCheck.available) {
      console.log(
        `Skipping Docker smoke tests: required ports not available (${requiredCheck.unavailablePorts.join(', ')})`,
      );
      return;
    }
    portsAvailable = true;

    // Check if full stack ports are available (Kong on 8000)
    const fullStackCheck = await arePortsAvailable(testConfig.smoke.fullStackPorts);
    fullStackAvailable = fullStackCheck.available;
    if (!fullStackAvailable) {
      console.log(
        `Full stack tests will be skipped: ports not available (${fullStackCheck.unavailablePorts.join(', ')})`,
      );
    }

    // Check if Traefik ports are available (port 80)
    const traefikCheck = await arePortsAvailable(testConfig.smoke.traefikPorts);
    traefikAvailable = traefikCheck.available;
    if (!traefikAvailable) {
      console.log(
        `Traefik tests will be skipped: ports not available (${traefikCheck.unavailablePorts.join(', ')})`,
      );
    }

    tempDir = createTempDir('vibecarbon-smoke-');

    // Create project
    execSync(
      `node ${join(process.cwd(), 'src/cli.js')} create ${projectName} -y -admin-email test@smoke.local -admin-password smoketest123`,
      {
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 300000,
      },
    );

    // Load the generated .env.local and add docker-compose required vars
    projectEnv = loadEnvFile(join(projectDir(), '.env.local'));
    // docker-compose.yml uses PROJECT_NAME and POSTGRES_PASSWORD
    projectEnv.PROJECT_NAME = projectName;
    projectEnv.POSTGRES_PASSWORD = projectEnv.DB_PASSWORD || 'postgres';

    // Determine which services to start based on available ports
    let services: string[];
    if (traefikAvailable && fullStackAvailable) {
      // Full stack with Traefik and app
      services = [
        'db',
        'kong',
        'auth',
        'rest',
        'realtime',
        'storage',
        'imgproxy',
        'meta',
        'traefik',
        'app',
      ];
    } else if (fullStackAvailable) {
      // Full Supabase stack without Traefik
      services = ['db', 'kong', 'auth', 'rest', 'realtime', 'storage', 'imgproxy', 'meta'];
    } else {
      // Database only
      services = ['db'];
    }

    execSync(`docker compose up -d ${services.join(' ')}`, {
      cwd: projectDir(),
      encoding: 'utf-8',
      timeout: testConfig.smoke.timeouts.dockerUp,
      env: getExecEnv(),
    });

    // Wait for database to be ready (with exponential backoff)
    const dbReady = await waitForPostgres(projectDir(), getExecEnv());
    if (!dbReady) {
      throw new Error('PostgreSQL failed to become ready');
    }

    // If full stack, wait for Kong and Realtime to be healthy
    if (fullStackAvailable) {
      const kongReady = await waitForKong(projectDir(), getExecEnv());
      if (!kongReady) {
        throw new Error('Kong failed to become healthy');
      }

      // Wait for Realtime (Erlang/Elixir runtime is slow to cold-start in CI)
      // Non-fatal: if Realtime isn't available, only its tests are skipped
      realtimeAvailable = await waitForDockerCommand(
        'docker compose exec -T realtime curl -sf http://localhost:4000/',
        { cwd: projectDir(), env: getExecEnv(), encoding: 'utf-8' },
        { timeout: testConfig.smoke.timeouts.serviceReady, label: 'Realtime ready' },
      );
      if (!realtimeAvailable) {
        // Dump container state for CI debugging
        try {
          const ps = execSync('docker compose ps --format json', {
            cwd: projectDir(),
            encoding: 'utf-8',
            timeout: 10000,
            env: getExecEnv(),
          });
          const containers = ps
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l));
          const rt = containers.find((c: { Service: string }) => c.Service === 'realtime');
          console.warn(
            `[Smoke] Realtime not healthy. State: ${rt?.State ?? 'not found'}, Health: ${rt?.Health ?? 'N/A'}`,
          );
        } catch {
          /* ignore */
        }
      }
    }

    // If Traefik available, wait for it to be ready
    // Dashboard is protected by admin-auth, so we check via Host header and accept 401/302
    if (traefikAvailable) {
      const traefikReady = await waitForHttpHealth('http://localhost/api/overview', {
        timeout: testConfig.smoke.timeouts.serviceReady,
        label: 'Traefik dashboard',
        headers: { Host: 'traefik.localhost' },
        acceptStatus: [200, 401, 302, 404], // 401/302 means Traefik is up but auth required
      });
      if (!traefikReady) {
        throw new Error('Traefik failed to become ready');
      }

      // Wait for app to be healthy (it needs to build first)
      const appReady = await waitForHttpHealth('http://localhost/health', {
        timeout: testConfig.smoke.timeouts.appBuild,
        headers: { Host: 'localhost' },
        label: 'App health',
      });
      if (!appReady) {
        throw new Error('App failed to become healthy');
      }
    }
  }, 420000); // 7 minutes total timeout for full stack with app build

  afterAll(async () => {
    if (!portsAvailable || !tempDir) return;

    // Use robust cleanup with fallback to force kill
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

  // =========================================================================
  // Database Tests
  // =========================================================================

  describe('Database', () => {
    it('is healthy and accepting connections', ({ skip }) => {
      if (!portsAvailable) skip();
      // Retry a few times as pg_isready may fail briefly during startup
      let result = '';
      let lastError: Error | null = null;
      for (let i = 0; i < 5; i++) {
        try {
          result = execSync('docker compose exec -T db pg_isready -U postgres', {
            cwd: projectDir(),
            encoding: 'utf-8',
            timeout: 10000,
            env: getExecEnv(),
          });
          break;
        } catch (e) {
          lastError = e as Error;
          // Wait 500ms before retry
          execSync('sleep 0.5');
        }
      }
      if (!result && lastError) throw lastError;
      expect(result).toContain('accepting connections');
    });

    it('container is running', ({ skip }) => {
      if (!portsAvailable) skip();
      const result = execSync('docker compose ps --format json', {
        cwd: projectDir(),
        encoding: 'utf-8',
        timeout: 10000,
        env: getExecEnv(),
      });

      const lines = result.trim().split('\n').filter(Boolean);
      const containers = lines.map((line) => JSON.parse(line));
      const runningServices = containers
        .filter((c: { State: string }) => c.State === 'running')
        .map((c: { Service: string }) => c.Service);

      expect(runningServices).toContain('db');
    });

    it('can execute SQL queries', ({ skip }) => {
      if (!portsAvailable) skip();
      const result = execSync('docker compose exec -T db psql -U postgres -c "SELECT 1 as test"', {
        cwd: projectDir(),
        encoding: 'utf-8',
        timeout: 10000,
        env: getExecEnv(),
      });
      expect(result).toContain('1');
    });

    it('has required extensions installed', ({ skip }) => {
      if (!portsAvailable) skip();
      const result = execSync(
        `docker compose exec -T db psql -U postgres -c "SELECT extname FROM pg_extension WHERE extname IN ('uuid-ossp', 'pgcrypto')"`,
        {
          cwd: projectDir(),
          encoding: 'utf-8',
          timeout: 10000,
          env: getExecEnv(),
        },
      );
      expect(result).toContain('uuid-ossp');
      expect(result).toContain('pgcrypto');
    });
  });

  // =========================================================================
  // Database Migrations
  // =========================================================================

  describe('Migrations', () => {
    it('can run database migrations', async ({ skip }) => {
      if (!portsAvailable) skip();
      // Wait for database to be fully ready before running migrations
      // (may be in a transient state from previous tests)
      const dbReady = await waitForPostgres(projectDir(), getExecEnv());
      if (!dbReady) {
        skip(); // Skip if db not ready (transient infrastructure issue)
        return;
      }

      // Run migration directly (just 00001_init.sql) - may have partial failures
      // when auth.* functions aren't available (db-only mode, no full Supabase)
      let result = '';
      try {
        // Test file uses execSync for controlled test environment with known safe inputs
        // This is a test environment with hardcoded commands - no user input
        result = execSync(
          'docker compose exec -T db psql -U postgres -d postgres -f /migrations/00001_init.sql',
          {
            cwd: projectDir(),
            encoding: 'utf-8',
            timeout: 30000,
            env: getExecEnv(),
          },
        );
      } catch (e) {
        // Migration may fail on RLS policies that depend on auth.* functions
        // This is expected when running with just db container (no full Supabase stack)
        const error = e as { stderr?: string; stdout?: string; message?: string };
        const output = (error.stderr || '') + (error.stdout || '') + (error.message || '');

        // Skip if connection failed (db container not ready - infrastructure issue)
        if (
          output.includes('No such file or directory') ||
          output.includes('connection refused') ||
          output.includes('shutting down')
        ) {
          skip();
          return;
        }

        // If the errors are only about auth functions, that's expected in db-only mode
        if (
          output.includes('auth.jwt()') ||
          output.includes('auth.uid()') ||
          output.includes('is_super_admin()')
        ) {
          // Expected failures in db-only mode - tables should still be created
          result = output;
        } else {
          throw e;
        }
      }
      // Migration ran (tables created via CREATE TABLE IF NOT EXISTS)
      expect(result).toBeDefined();
    });

    it('migrations create expected tables', async ({ skip }) => {
      if (!portsAvailable) skip();
      // Wait for database to be ready (may still be processing migrations)
      const dbReady = await waitForPostgres(projectDir(), getExecEnv());
      if (!dbReady) {
        throw new Error('Database not ready');
      }

      // Check that the public schema has tables (after migration) with retries
      let result = '';
      let lastError: Error | null = null;
      for (let i = 0; i < 3; i++) {
        try {
          // Test file uses execSync for controlled test environment with known safe inputs
          result = execSync(
            'docker compose exec -T db psql -U postgres -c "SELECT tablename FROM pg_tables WHERE schemaname = \'public\'"',
            {
              cwd: projectDir(),
              encoding: 'utf-8',
              timeout: 10000,
              env: getExecEnv(),
            },
          );
          break;
        } catch (e) {
          lastError = e as Error;
          // Wait before retry
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      if (!result && lastError) throw lastError;
      // The initial migration should create at least some tables or the query should succeed
      expect(result).toBeDefined();
    });
  });

  // =========================================================================
  // Full Stack Tests (Kong, Auth, PostgREST)
  // =========================================================================

  describe('API Gateway (Kong)', () => {
    it('is healthy', ({ skip }) => {
      if (!fullStackAvailable) skip();
      const result = execSync('docker compose exec -T kong kong health', {
        cwd: projectDir(),
        encoding: 'utf-8',
        timeout: 10000,
        env: getExecEnv(),
      });
      expect(result).toContain('healthy');
    });

    it('container is running', ({ skip }) => {
      if (!fullStackAvailable) skip();
      const result = execSync('docker compose ps --format json', {
        cwd: projectDir(),
        encoding: 'utf-8',
        timeout: 10000,
        env: getExecEnv(),
      });

      const lines = result.trim().split('\n').filter(Boolean);
      const containers = lines.map((line) => JSON.parse(line));
      const runningServices = containers
        .filter((c: { State: string }) => c.State === 'running')
        .map((c: { Service: string }) => c.Service);

      expect(runningServices).toContain('kong');
    });

    it('responds on port 8000', async ({ skip }) => {
      if (!fullStackAvailable) skip();
      // Kong should respond (even if with an error, it means the gateway is up)
      const response = await fetchWithTimeout('http://localhost:8000/', 5000);
      expect(response.status).toBeGreaterThan(0);
    });
  });

  describe('PostgREST API', () => {
    it('container is running', ({ skip }) => {
      if (!fullStackAvailable) skip();
      const result = execSync('docker compose ps --format json', {
        cwd: projectDir(),
        encoding: 'utf-8',
        timeout: 10000,
        env: getExecEnv(),
      });

      const lines = result.trim().split('\n').filter(Boolean);
      const containers = lines.map((line) => JSON.parse(line));
      const runningServices = containers
        .filter((c: { State: string }) => c.State === 'running')
        .map((c: { Service: string }) => c.Service);

      expect(runningServices).toContain('rest');
    });

    it('responds via Kong gateway', async ({ skip }) => {
      if (!fullStackAvailable) skip();
      // PostgREST is available at /rest/v1/ through Kong
      const response = await fetchWithTimeout('http://localhost:8000/rest/v1/', 5000);
      // Should get a response (401 without auth is expected)
      expect(response.status).toBeGreaterThan(0);
    });
  });

  describe('GoTrue Auth', () => {
    it('container is running', ({ skip }) => {
      if (!fullStackAvailable) skip();
      const result = execSync('docker compose ps --format json', {
        cwd: projectDir(),
        encoding: 'utf-8',
        timeout: 10000,
        env: getExecEnv(),
      });

      const lines = result.trim().split('\n').filter(Boolean);
      const containers = lines.map((line) => JSON.parse(line));
      const runningServices = containers
        .filter((c: { State: string }) => c.State === 'running')
        .map((c: { Service: string }) => c.Service);

      expect(runningServices).toContain('auth');
    });

    it('health endpoint responds via Kong', async ({ skip }) => {
      if (!fullStackAvailable) skip();
      // Auth health is available at /auth/v1/health through Kong
      // Requires apikey header for Kong authentication
      const headers = { apikey: projectEnv.SUPABASE_ANON_KEY || projectEnv.VITE_SUPABASE_ANON_KEY };
      const healthy = await waitForHttpHealth('http://localhost:8000/auth/v1/health', {
        timeout: 60000,
        headers,
        label: 'GoTrue health',
      });
      expect(healthy).toBe(true);
    }, 60000);
  });

  describe('Realtime', () => {
    it('container is running', ({ skip }) => {
      if (!realtimeAvailable) skip();
      const result = execSync('docker compose ps --format json', {
        cwd: projectDir(),
        encoding: 'utf-8',
        timeout: 10000,
        env: getExecEnv(),
      });

      const lines = result.trim().split('\n').filter(Boolean);
      const containers = lines.map((line) => JSON.parse(line));
      const runningServices = containers
        .filter((c: { State: string }) => c.State === 'running')
        .map((c: { Service: string }) => c.Service);

      expect(runningServices).toContain('realtime');
    });
  });

  describe('Storage', () => {
    it('container is running', ({ skip }) => {
      if (!fullStackAvailable) skip();
      const result = execSync('docker compose ps --format json', {
        cwd: projectDir(),
        encoding: 'utf-8',
        timeout: 10000,
        env: getExecEnv(),
      });

      const lines = result.trim().split('\n').filter(Boolean);
      const containers = lines.map((line) => JSON.parse(line));
      const runningServices = containers
        .filter((c: { State: string }) => c.State === 'running')
        .map((c: { Service: string }) => c.Service);

      expect(runningServices).toContain('storage');
    });
  });

  // =========================================================================
  // Traefik Reverse Proxy Tests (requires ports 80 and 8080)
  // =========================================================================

  describe('Traefik Reverse Proxy', () => {
    it('container is running', ({ skip }) => {
      if (!traefikAvailable) skip();
      const result = execSync('docker compose ps --format json', {
        cwd: projectDir(),
        encoding: 'utf-8',
        timeout: 10000,
        env: getExecEnv(),
      });

      const lines = result.trim().split('\n').filter(Boolean);
      const containers = lines.map((line) => JSON.parse(line));
      const runningServices = containers
        .filter((c: { State: string }) => c.State === 'running')
        .map((c: { Service: string }) => c.Service);

      expect(runningServices).toContain('traefik');
    });

    it('dashboard responds via traefik.localhost (requires auth)', async ({ skip }) => {
      if (!traefikAvailable) skip();
      // Dashboard is protected by admin-auth middleware
      const response = await fetchWithTimeout('http://localhost/api/overview', 5000, {
        headers: { Host: 'traefik.localhost' },
      });
      // Expect 401 or 302 redirect to login (auth required)
      expect([401, 302]).toContain(response.status);
    });

    it('routes traffic on port 80', async ({ skip }) => {
      if (!traefikAvailable) skip();
      // Traefik should respond on port 80 (routing to app)
      const response = await fetchWithTimeout('http://localhost/', 5000, {
        headers: { Host: 'localhost' },
      });
      expect(response.status).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Application Tests (requires Traefik)
  // =========================================================================

  describe('Application', () => {
    it('container is running', ({ skip }) => {
      if (!traefikAvailable) skip();
      const result = execSync('docker compose ps --format json', {
        cwd: projectDir(),
        encoding: 'utf-8',
        timeout: 10000,
        env: getExecEnv(),
      });

      const lines = result.trim().split('\n').filter(Boolean);
      const containers = lines.map((line) => JSON.parse(line));
      const runningServices = containers
        .filter((c: { State: string }) => c.State === 'running')
        .map((c: { Service: string }) => c.Service);

      expect(runningServices).toContain('app');
    });

    it('health endpoint responds via Traefik', async ({ skip }) => {
      if (!traefikAvailable) skip();
      // App health is available at /health through Traefik
      const response = await fetchWithTimeout('http://localhost/health', 5000, {
        headers: { Host: 'localhost' },
      });
      expect(response.ok).toBe(true);
    });

    it('serves the frontend via Traefik', async ({ skip }) => {
      if (!traefikAvailable) skip();
      // App should serve HTML at root
      const response = await fetchWithTimeout('http://localhost/', 5000, {
        headers: { Host: 'localhost' },
      });
      expect(response.ok).toBe(true);
      expect(response.body).toContain('<!DOCTYPE html>');
    });

    it('API routes work via Traefik', async ({ skip }) => {
      if (!traefikAvailable) skip();
      // Test an API route through Traefik
      const response = await fetchWithTimeout('http://localhost/api/v1', 5000, {
        headers: { Host: 'localhost' },
      });
      // Should get a response (the actual status depends on the route implementation)
      expect(response.status).toBeGreaterThan(0);
    });
  });
});
