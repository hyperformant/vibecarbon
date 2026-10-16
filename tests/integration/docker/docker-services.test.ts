import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDotenv } from '../../../src/lib/dotenv.js';
import {
  arePortsAvailable,
  cleanupDocker,
  devComposeFileEnv,
  fetchWithTimeout,
  waitForHttpHealth,
  waitForPostgres,
} from '../../_shared/docker-utils.js';
import { cleanupTempDir, createTempDir } from '../../_shared/temp-dir.js';
import { testConfig } from '../../config.js';

// Heavyweight: needs a clean docker host (conflicts with any running
// vibecarbon-* containers on standard ports). Skipped by default; run
// explicitly via `DOCKER_INTEGRATION=true pnpm test:docker`.
const shouldRunDocker = process.env.DOCKER_INTEGRATION === 'true';
const describeDocker = shouldRunDocker ? describe : describe.skip;

describeDocker('Docker Services Smoke Test', () => {
  let tempDir: string;
  let projectEnv: Record<string, string>;
  let portsAvailable = false;
  let s3Available = false;
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

    // Check if the local S3 port is available (SeaweedFS on 8333, dev-only)
    const s3Check = await arePortsAvailable(testConfig.smoke.s3Ports);
    s3Available = s3Check.available;
    if (!s3Available) {
      console.log(
        `Local S3 tests will be skipped: ports not available (${s3Check.unavailablePorts.join(', ')})`,
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
      `node ${join(process.cwd(), 'src/cli.js')} create ${projectName} -y -install -admin-email test@smoke.local -admin-password smoketest123`,
      {
        // -install: the Migrations cases run the project's own
        // `npm run db:migrate`, which needs its dependencies.
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 300000,
      },
    );

    // Load the generated .env.local and add docker-compose required vars
    projectEnv = parseDotenv(readFileSync(join(projectDir(), '.env.local'), 'utf-8'));
    // docker-compose.yml uses PROJECT_NAME and POSTGRES_PASSWORD
    projectEnv.PROJECT_NAME = projectName;
    projectEnv.POSTGRES_PASSWORD = projectEnv.DB_PASSWORD || 'postgres';
    // The file set `vibecarbon up` runs in dev, dev override included, so
    // the smoke boots the stack users boot. It also reaches cleanupDocker.
    projectEnv.COMPOSE_FILE = devComposeFileEnv(projectDir());
    expect(projectEnv.COMPOSE_FILE.split(delimiter)).toContain('docker-compose.override.yml');

    // The local stack is db, app and traefik, plus the dev-only s3
    // (SeaweedFS) from docker-compose.override.yml. Start what the free ports
    // allow; the database is the minimum.
    const services = ['db'];
    if (s3Available) services.push('s3');
    if (traefikAvailable) services.push('traefik', 'app');

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
  });

  // =========================================================================
  // Database Migrations
  // =========================================================================

  describe('Migrations', () => {
    // The generated project applies its migrations with drizzle-orm's
    // migrator (carbon/src/server/db/migrate.ts): `npm run db:migrate` runs
    // the same runMigrations() the app runs at startup. The first run applies
    // the baseline, the second finds the ledger complete.
    it('db:migrate applies the baseline once, then nothing', async ({ skip }) => {
      if (!portsAvailable) skip();
      const dbReady = await waitForPostgres(projectDir(), getExecEnv());
      if (!dbReady) throw new Error('Database not ready');
      const migrate = () =>
        execSync('npm run --silent db:migrate', {
          cwd: projectDir(),
          encoding: 'utf-8',
          timeout: 120000,
          env: getExecEnv(),
        });
      // A previous run against this volume may have applied it already.
      const first = migrate();
      expect(first).toMatch(/Applied \d+ database migration|Database migrations are up to date/);
      expect(migrate()).toContain('Database migrations are up to date');
    });

    it('migrations create the schema and the ledger', async ({ skip }) => {
      if (!portsAvailable) skip();
      const result = execSync(
        `docker compose exec -T db psql -U postgres -tA -c "select (select count(*) from pg_tables where schemaname = 'public'), (select count(*) from drizzle.__drizzle_migrations)"`,
        { cwd: projectDir(), encoding: 'utf-8', timeout: 10000, env: getExecEnv() },
      );
      const [tables, applied] = result.trim().split('|').map(Number);
      expect(tables).toBeGreaterThan(10);
      expect(applied).toBeGreaterThanOrEqual(3);
    });

    // The baseline (db/migrations/0000) creates the one extension the lean
    // stack uses, pg_cron, so this runs after db:migrate: with port 80 taken
    // no app container starts, and its startup migration never ran. (UUIDs
    // come from core gen_random_uuid(); uuid-ossp and pgcrypto were the
    // Supabase image's and nothing uses them.)
    it('the baseline installs pg_cron', ({ skip }) => {
      if (!portsAvailable) skip();
      const result = execSync(
        `docker compose exec -T db psql -U postgres -tA -c "SELECT extname FROM pg_extension WHERE extname = 'pg_cron'"`,
        {
          cwd: projectDir(),
          encoding: 'utf-8',
          timeout: 10000,
          env: getExecEnv(),
        },
      );
      expect(result.trim()).toBe('pg_cron');
    });
  });

  // =========================================================================
  // Local S3 (dev-only SeaweedFS for uploads)
  // =========================================================================

  describe('Local S3', () => {
    it('container is running', ({ skip }) => {
      if (!s3Available) skip();
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

      expect(runningServices).toContain('s3');
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

    // Auth runs inside the app: there is no auth container. The app creates
    // the super admin from ADMIN_EMAIL / ADMIN_PASSWORD once the schema exists
    // (the Migrations block above applied it) and reports it on /api/health,
    // the same flag every `vibecarbon deploy` waits for.
    it('creates the super admin from ADMIN_EMAIL/ADMIN_PASSWORD (adminReady)', async ({ skip }) => {
      if (!traefikAvailable) skip();
      const deadline = Date.now() + 90_000;
      let last = '';
      while (Date.now() < deadline) {
        try {
          const response = await fetchWithTimeout('http://localhost/api/health', 5000, {
            headers: { Host: 'localhost' },
          });
          last = response.body;
          if (response.ok && JSON.parse(response.body).adminReady === true) break;
        } catch {
          // app still starting
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      expect(JSON.parse(last || '{}').adminReady, `last /api/health: ${last}`).toBe(true);
    }, 120_000);

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
