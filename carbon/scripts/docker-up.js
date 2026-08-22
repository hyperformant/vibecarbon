#!/usr/bin/env node
/**
 * Start Docker Compose services based on enabled features
 *
 * Usage:
 *   node scripts/docker-up.js           # Start dev services
 *   node scripts/docker-up.js --prod    # Start production services
 *   node scripts/docker-up.js --dry-run # Show command without running
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  buildComposeCommand,
  discoverOptionalServices,
  getEnabledServices,
  loadManifest,
  parseArgs,
} from './lib/manifest.js';

/**
 * Read environment value from .env files
 */
function getEnvValue(key) {
  const envFiles = ['.env.local', '.env'];
  for (const file of envFiles) {
    if (existsSync(file)) {
      const content = readFileSync(file, 'utf-8');
      const match = content.match(new RegExp(`^${key}=["']?([^"'\\n]+)["']?`, 'm'));
      if (match) return match[1];
    }
  }
  return null;
}

/**
 * Calculate port with offset, respecting explicit overrides
 */
function getPort(envKey, defaultPort, offset) {
  const explicit = getEnvValue(envKey);
  if (explicit) return explicit;
  return String(defaultPort + offset);
}

/**
 * Build environment variables for port configuration
 * Applies DEV_PORT_OFFSET to all configurable ports
 */
function getPortEnvVars() {
  const portOffset = Number.parseInt(getEnvValue('DEV_PORT_OFFSET') || '0', 10);

  return {
    DEV_DB_PORT: getPort('DEV_DB_PORT', 5432, portOffset),
    DEV_KONG_PORT: getPort('DEV_KONG_PORT', 8000, portOffset),
    DEV_KONG_SSL_PORT: getPort('DEV_KONG_SSL_PORT', 8443, portOffset),
    DEV_TRAEFIK_PORT: getPort('DEV_TRAEFIK_PORT', 80, portOffset),
    DEV_PROMETHEUS_PORT: getPort('DEV_PROMETHEUS_PORT', 9190, portOffset),
    DEV_GRAFANA_PORT: getPort('DEV_GRAFANA_PORT', 3002, portOffset),
    DEV_LOKI_PORT: getPort('DEV_LOKI_PORT', 3100, portOffset),
  };
}

/**
 * Run DB init scripts for optional services.
 * These scripts are idempotent (IF NOT EXISTS, ALTER ROLE) so they're safe
 * to run on every startup. This handles the case where a service is added
 * after the DB volume already exists — Postgres only runs entrypoint scripts
 * on first volume initialization.
 */
function runServiceDbInit(manifest, { all, verbose }) {
  let serviceNames;
  if (all) {
    // Extract service names from compose file names: docker-compose.metabase.yml → metabase
    serviceNames = discoverOptionalServices().map((f) => f.replace('docker-compose.', '').replace('.yml', ''));
  } else {
    serviceNames = getEnabledServices(manifest);
  }

  const scripts = serviceNames
    .map((name) => ({ name, path: `volumes/db/${name}-init.sh` }))
    .filter(({ path }) => existsSync(path));

  if (scripts.length === 0) return;

  if (verbose) console.log('Phase 1.5 — running DB init scripts for services:', scripts.map((s) => s.name).join(', '));

  for (const { name, path } of scripts) {
    if (verbose) console.log(`  Running DB init for ${name}...`);
    try {
      execSync(`docker compose -f docker-compose.yml exec -T db bash < ${path}`, {
        stdio: verbose ? 'inherit' : 'pipe',
        env: { ...process.env, ...getPortEnvVars() },
      });
    } catch (error) {
      console.warn(`Warning: DB init for ${name} failed (${error.message}). The service may not connect.`);
    }
  }
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
Usage: node scripts/docker-up.js [options]

Options:
  --all       Include all optional services (ignores .vibecarbon.json)
  --prod      Include production overlay (docker-compose.prod.yml)
  --dry-run   Print the command without executing it
  -v          Verbose output
  -h, --help  Show this help message

Examples:
  node scripts/docker-up.js              # Start services from .vibecarbon.json
  node scripts/docker-up.js --all        # Start ALL optional services
  node scripts/docker-up.js --prod       # Start with production config
  npm run docker:up                      # Via package.json script
  npm run docker:up -- --all             # Start all services via npm
`);
  process.exit(0);
}

const manifest = loadManifest();

// Get port configuration with offset applied
const portEnv = getPortEnvVars();

// Pin local builds to the `default` (docker-driver) BuildKit builder.
// `docker compose up` delegates image builds to `buildx bake`, which uses the
// globally-selected builder. A long-lived `docker-container` builder (e.g. a
// `vc-multiarch` builder left active via `buildx create --use` after a
// multi-arch release build) freezes its /etc/resolv.conf at creation time — so
// after a laptop changes network/subnet it keeps querying a dead DNS server and
// builds fail with "i/o timeout" resolving registry-1.docker.io. The default
// builder builds through the daemon's live DNS on every build, sidestepping
// that whole class. Local dev/test never needs multi-arch; an explicit
// BUILDX_BUILDER in the environment still wins, for anyone who wants otherwise.
const buildEnv = { BUILDX_BUILDER: process.env.BUILDX_BUILDER || 'default' };
const execOpts = { stdio: 'inherit', env: { ...process.env, ...portEnv, ...buildEnv } };

// Check if any optional services (metabase, n8n, observability, etc.) are enabled.
// These can have slow health checks (e.g. Metabase JVM takes 2-4 min), so we start
// core Supabase services first with --wait, then launch optional services in the
// background without blocking.
const hasOptionalServices = args.all || getEnabledServices(manifest).length > 0;

if (hasOptionalServices) {
  const coreCmd = buildComposeCommand('up -d --wait', { services: {} }, { prod: args.prod });
  const fullCmd = buildComposeCommand('up -d', manifest, { prod: args.prod, all: args.all });

  if (args.dryRun) {
    console.log('Phase 1 (core, blocking):', coreCmd);
    console.log('Phase 1.5 (service DB init): run idempotent init scripts via exec -T db bash');
    console.log('Phase 2 (optional, background):', fullCmd);
    console.log('With port env:', portEnv);
    process.exit(0);
  }

  // Phase 1: Start core services and wait until healthy (~17s)
  if (args.verbose) console.log('Phase 1 — core services:', coreCmd);
  try {
    execSync(coreCmd, execOpts);
  } catch (error) {
    diagnoseFailure();
    process.exit(error.status || 1);
  }

  // Phase 1.5: Run idempotent DB init scripts for services that need their own database/user.
  // Postgres skips /docker-entrypoint-initdb.d/ when the data volume already exists,
  // so we pipe the scripts into the running container to ensure roles/databases exist.
  runServiceDbInit(manifest, { all: args.all, verbose: args.verbose });

  // Phase 2: Start optional services in background (no --wait)
  // Core services are already running so Docker skips them (idempotent up -d)
  if (args.verbose) console.log('Phase 2 — optional services:', fullCmd);
  console.log('Starting optional services in background...');
  try {
    execSync(fullCmd, execOpts);
  } catch (error) {
    // Non-fatal: optional services failing to launch shouldn't block dev
    console.warn('Warning: some optional services may have failed to start.');
  }

} else {
  const cmd = buildComposeCommand('up -d --wait', manifest, { prod: args.prod, all: args.all });

  if (args.dryRun) {
    console.log('Would run:', cmd);
    console.log('With port env:', portEnv);
    process.exit(0);
  }

  if (args.verbose) console.log('Running:', cmd);

  try {
    execSync(cmd, execOpts);
  } catch (error) {
    diagnoseFailure();
    process.exit(error.status || 1);
  }
}

/**
 * Check unhealthy containers for common issues and print helpful messages.
 */
function diagnoseFailure() {
  try {
    const logs = execSync('docker compose logs --tail 20 auth rest storage 2>&1', {
      encoding: 'utf-8',
      env: { ...process.env, ...getPortEnvVars() },
    });

    if (logs.includes('password authentication failed')) {
      console.error(`
\x1b[33m┌──────────────────────────────────────────────────────────┐
│  Database credentials mismatch detected                  │
│                                                          │
│  The database volume was initialized with different      │
│  credentials than your current .env.local.               │
│                                                          │
│  This happens when you recreate a project without        │
│  removing the old Docker volumes.                        │
│                                                          │
│  Fix:  vibecarbon reset                                 │
│                                                          │
│  This will remove volumes and reinitialize the database. │
│  ⚠  All local database data will be lost.                │
└──────────────────────────────────────────────────────────┘\x1b[0m
`);
    }
  } catch {
    // Diagnostic check failed, don't block the error exit
  }
}
