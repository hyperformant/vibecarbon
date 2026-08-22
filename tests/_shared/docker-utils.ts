import { type ExecSyncOptions, execSync } from 'node:child_process';
import { createServer } from 'node:net';
import { testConfig } from '../config.js';

/**
 * Docker Testing Utilities
 *
 * Shared utilities for Docker-based smoke tests with:
 * - Exponential backoff retry logic
 * - Robust cleanup with fallback to force kill
 * - Structured logging for debugging
 */

// =============================================================================
// TYPES
// =============================================================================

export interface WaitOptions {
  /** Maximum time to wait in ms (default: 60000) */
  timeout?: number;
  /** Initial interval between retries in ms (default: 1000) */
  initialInterval?: number;
  /** Maximum interval between retries in ms (default: 10000) */
  maxInterval?: number;
  /** Multiplier for exponential backoff (default: 1.5) */
  backoffMultiplier?: number;
  /** Optional label for logging */
  label?: string;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
}

export interface DockerCleanupOptions {
  /** Working directory for docker compose commands */
  cwd: string;
  /** Environment variables for docker compose */
  env?: NodeJS.ProcessEnv;
  /** Timeout for graceful shutdown in ms (default: 60000) */
  gracefulTimeout?: number;
  /** Whether to remove volumes (default: true) */
  removeVolumes?: boolean;
  /** Project name for container identification */
  projectName?: string;
}

export interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
}

// =============================================================================
// PORT UTILITIES
// =============================================================================

/**
 * Check if a port is available for binding
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '0.0.0.0');
  });
}

/**
 * Check if all ports in array are available
 * Returns details about which ports are unavailable
 */
export async function arePortsAvailable(
  ports: readonly number[],
): Promise<{ available: boolean; unavailablePorts: number[] }> {
  const unavailablePorts: number[] = [];

  for (const port of ports) {
    if (!(await isPortAvailable(port))) {
      unavailablePorts.push(port);
    }
  }

  return {
    available: unavailablePorts.length === 0,
    unavailablePorts,
  };
}

// =============================================================================
// HTTP UTILITIES
// =============================================================================

/**
 * HTTP fetch with timeout and error handling
 */
export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  options?: RequestInit,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: '' };
  } finally {
    clearTimeout(timeout);
  }
}

// =============================================================================
// WAIT UTILITIES WITH EXPONENTIAL BACKOFF
// =============================================================================

/**
 * Wait for a condition with exponential backoff
 *
 * @param condition - Function that returns true when condition is met
 * @param options - Wait options with backoff configuration
 * @returns true if condition was met, false if timeout
 */
export async function waitWithBackoff(
  condition: () => boolean | Promise<boolean>,
  options: WaitOptions = {},
): Promise<boolean> {
  const {
    timeout = 60000,
    initialInterval = 1000,
    maxInterval = 10000,
    backoffMultiplier = 1.5,
    label = 'condition',
  } = options;

  const startTime = Date.now();
  let interval = initialInterval;
  let attempt = 1;

  while (Date.now() - startTime < timeout) {
    try {
      if (await condition()) {
        return true;
      }
    } catch {
      // Condition threw an error, continue retrying
    }

    // Calculate remaining time
    const elapsed = Date.now() - startTime;
    const remaining = timeout - elapsed;

    if (remaining <= 0) break;

    // Wait with exponential backoff, but don't exceed remaining time
    const waitTime = Math.min(interval, remaining, maxInterval);

    if (process.env.DEBUG_TESTS) {
      console.log(
        `[waitWithBackoff] ${label}: attempt ${attempt} failed, waiting ${waitTime}ms (elapsed: ${elapsed}ms)`,
      );
    }

    await new Promise((r) => setTimeout(r, waitTime));

    // Increase interval for next iteration
    interval = Math.min(interval * backoffMultiplier, maxInterval);
    attempt++;
  }

  console.warn(`[waitWithBackoff] ${label}: timed out after ${timeout}ms (${attempt} attempts)`);
  return false;
}

/**
 * Wait for an HTTP endpoint to respond successfully
 */
export async function waitForHttpHealth(
  url: string,
  options: WaitOptions & { headers?: Record<string, string>; acceptStatus?: number[] } = {},
): Promise<boolean> {
  const { headers, acceptStatus = [200], ...waitOptions } = options;

  return waitWithBackoff(
    async () => {
      const response = await fetchWithTimeout(url, 5000, { headers });
      return (
        acceptStatus.includes(response.status) || (response.status >= 200 && response.status < 300)
      );
    },
    { label: `HTTP ${url}`, ...waitOptions },
  );
}

/**
 * Wait for a Docker command to succeed
 */
export async function waitForDockerCommand(
  command: string,
  execOptions: ExecSyncOptions,
  options: WaitOptions = {},
): Promise<boolean> {
  return waitWithBackoff(
    () => {
      try {
        execSync(command, { ...execOptions, timeout: 5000, stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    },
    { label: `Docker: ${command.slice(0, 50)}...`, ...options },
  );
}

/**
 * Wait for PostgreSQL to be ready
 */
export async function waitForPostgres(
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: WaitOptions = {},
): Promise<boolean> {
  return waitForDockerCommand(
    'docker compose exec -T db pg_isready -U postgres',
    { cwd, env, encoding: 'utf-8' },
    { label: 'PostgreSQL ready', timeout: testConfig.smoke.timeouts.serviceReady, ...options },
  );
}

/**
 * Wait for Kong to be healthy
 */
export async function waitForKong(
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: WaitOptions = {},
): Promise<boolean> {
  return waitForDockerCommand(
    'docker compose exec -T kong kong health',
    { cwd, env, encoding: 'utf-8' },
    { label: 'Kong healthy', timeout: testConfig.smoke.timeouts.serviceReady, ...options },
  );
}

// =============================================================================
// DOCKER CLEANUP WITH FALLBACK
// =============================================================================

/**
 * Execute a command and capture output, returning success status
 */
function execWithCapture(command: string, options: ExecSyncOptions): ExecResult {
  try {
    const output = execSync(command, { ...options, encoding: 'utf-8', stdio: 'pipe' });
    return { success: true, output: output || '' };
  } catch (e) {
    const error = e as Error & { stderr?: string; stdout?: string };
    return {
      success: false,
      output: error.stdout || '',
      error: error.stderr || error.message,
    };
  }
}

/**
 * Get list of running container IDs for a project
 */
function getProjectContainerIds(
  _projectName: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): string[] {
  const result = execWithCapture(`docker compose ps -q`, { cwd, env, timeout: 10000 });

  if (!result.success || !result.output.trim()) {
    return [];
  }

  return result.output.trim().split('\n').filter(Boolean);
}

/**
 * Force kill containers by ID
 */
function forceKillContainers(containerIds: string[]): { killed: string[]; failed: string[] } {
  const killed: string[] = [];
  const failed: string[] = [];

  for (const id of containerIds) {
    const result = execWithCapture(`docker kill ${id}`, { timeout: 10000 });
    if (result.success) {
      killed.push(id);
    } else {
      failed.push(id);
    }
  }

  return { killed, failed };
}

/**
 * Force remove containers by ID
 */
function forceRemoveContainers(containerIds: string[]): { removed: string[]; failed: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];

  for (const id of containerIds) {
    const result = execWithCapture(`docker rm -f ${id}`, { timeout: 10000 });
    if (result.success) {
      removed.push(id);
    } else {
      failed.push(id);
    }
  }

  return { removed, failed };
}

/**
 * Clean up Docker resources with graceful shutdown and force fallback
 *
 * 1. Tries `docker compose down -v` for graceful shutdown
 * 2. If that fails, identifies remaining containers
 * 3. Force kills and removes any remaining containers
 * 4. Logs all operations for debugging
 */
export async function cleanupDocker(options: DockerCleanupOptions): Promise<{
  success: boolean;
  gracefulShutdown: boolean;
  forceKilled: string[];
  errors: string[];
}> {
  const {
    cwd,
    env,
    gracefulTimeout = testConfig.smoke.timeouts.dockerDown,
    removeVolumes = true,
    projectName,
  } = options;

  const errors: string[] = [];
  let gracefulShutdown = false;
  let forceKilled: string[] = [];

  // Step 1: Get container IDs before cleanup (for fallback)
  const containerIdsBefore = projectName ? getProjectContainerIds(projectName, cwd, env) : [];

  // Step 2: Try graceful shutdown with docker compose down
  const downCommand = removeVolumes
    ? 'docker compose down -v --remove-orphans'
    : 'docker compose down --remove-orphans';
  const downResult = execWithCapture(downCommand, { cwd, env, timeout: gracefulTimeout });

  if (downResult.success) {
    gracefulShutdown = true;

    // Verify containers are actually stopped
    const containerIdsAfter = projectName ? getProjectContainerIds(projectName, cwd, env) : [];
    if (containerIdsAfter.length === 0) {
      return { success: true, gracefulShutdown: true, forceKilled: [], errors: [] };
    }

    // Some containers still running, fall through to force kill
    console.warn(
      `[cleanupDocker] docker compose down succeeded but ${containerIdsAfter.length} containers still running`,
    );
  } else {
    errors.push(`docker compose down failed: ${downResult.error}`);
    console.warn(`[cleanupDocker] Graceful shutdown failed: ${downResult.error}`);
  }

  // Step 3: Force kill remaining containers
  const remainingContainers = projectName
    ? getProjectContainerIds(projectName, cwd, env)
    : containerIdsBefore;

  if (remainingContainers.length > 0) {
    console.warn(
      `[cleanupDocker] Force killing ${remainingContainers.length} remaining containers`,
    );

    // Kill first
    const killResult = forceKillContainers(remainingContainers);
    if (killResult.failed.length > 0) {
      errors.push(`Failed to kill containers: ${killResult.failed.join(', ')}`);
    }

    // Then remove
    const removeResult = forceRemoveContainers(remainingContainers);
    if (removeResult.failed.length > 0) {
      errors.push(`Failed to remove containers: ${removeResult.failed.join(', ')}`);
    }

    forceKilled = killResult.killed;
  }

  // Step 4: Try to remove volumes if they weren't removed
  if (removeVolumes && !gracefulShutdown) {
    execWithCapture('docker compose down -v', { cwd, env, timeout: 30000 });
  }

  const success = errors.length === 0 || forceKilled.length > 0;
  return { success, gracefulShutdown, forceKilled, errors };
}
