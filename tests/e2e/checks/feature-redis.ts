/**
 * Redis feature verification checks.
 *
 * Validates Redis connectivity via SSH (preferred) or the application's
 * health endpoint. All checks are fault-tolerant and never throw.
 *
 * SECURITY: This module uses execSync with shell expansion intentionally,
 * matching the pattern established in cli-runner.ts. All command arguments
 * originate from trusted test fixtures (scenario configs with server IPs
 * and SSH key paths), never from external user input. SSH is required for
 * remote container inspection during e2e tests.
 */

import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { VerificationResult } from '../scenarios/types.js';
import { e2eSshOpts } from '../utils/ssh.js';
import { dnsSafeFetch } from './health.js';

const FETCH_TIMEOUT_MS = 10_000;
const SSH_TIMEOUT_MS = 10_000;

// argv form — used with execFileSync (no shell). `runSSH` joins the
// remote command into ssh's last argv element, which OpenSSH itself
// re-joins on the remote side; the local side never invokes a shell.
const SSH_OPTIONS = e2eSshOpts(5);

/**
 * Run Redis feature checks.
 */
export async function runRedisChecks(
  domain: string,
  serverIp?: string,
  sshKeyPath?: string,
  projectDir?: string,
  isCompose = true,
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  const hasSSH = Boolean(serverIp && sshKeyPath);

  // Read Redis password from the local project's .env file
  let redisPassword = '';
  if (projectDir) {
    try {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      for (const envFile of ['.env', '.env.local']) {
        try {
          const content = readFileSync(join(projectDir, envFile), 'utf-8');
          const match = content.match(/^REDIS_PASSWORD=["']?([^"'\n]+)["']?/m);
          if (match?.[1]) {
            redisPassword = match[1];
            break;
          }
        } catch {
          // Try next file
        }
      }
    } catch {
      // Fall through — redis-cli will fail with NOAUTH if password is required
    }
  }
  const authFlag = redisPassword ? `-a '${redisPassword}' --no-auth-warning` : '';

  // Build the redis-cli command based on deploy mode.
  // Compose: docker exec into the Redis container
  // K8s: kubectl exec into the Redis pod
  let redisCliPrefix: string;
  if (isCompose) {
    const containerCmd = 'docker ps -qf "name=redis"';
    redisCliPrefix = `docker exec \\$(${containerCmd}) redis-cli`;
  } else {
    const podCmd =
      'kubectl get pod -n vibecarbon -l app=redis -o jsonpath="{.items[0].metadata.name}" 2>/dev/null';
    redisCliPrefix = `kubectl exec -n vibecarbon \\$(${podCmd}) -- redis-cli`;
  }

  results.push(
    await checkRedisPing(
      domain,
      hasSSH ? serverIp : undefined,
      hasSSH ? sshKeyPath : undefined,
      authFlag,
      redisCliPrefix,
    ),
  );
  results.push(
    await checkRedisSetGet(
      hasSSH ? serverIp : undefined,
      hasSSH ? sshKeyPath : undefined,
      authFlag,
      redisCliPrefix,
    ),
  );

  return results;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * Verify Redis is responding to PING.
 *
 * Primary (SSH): docker exec into the Redis container and run `redis-cli PING`.
 * Fallback (HTTP): check the app's health endpoint for Redis status.
 */
async function checkRedisPing(
  domain: string,
  serverIp?: string,
  sshKeyPath?: string,
  authFlag = '',
  redisCliPrefix = 'redis-cli',
): Promise<VerificationResult> {
  const start = performance.now();

  // Primary: SSH-based PING (with retries — Redis may still be starting)
  if (serverIp && sshKeyPath) {
    const MAX_ATTEMPTS = 4;
    const RETRY_DELAY_MS = 5_000;
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const pingCmd = `${redisCliPrefix} ${authFlag} PING`;
        const stdout = runSSH(serverIp, sshKeyPath, pingCmd);

        if (stdout.trim() === 'PONG') {
          return {
            checkName: 'redis_ping',
            status: 'pass',
            responseTimeMs: Math.round(performance.now() - start),
            details: { method: 'ssh', response: 'PONG', attempts: attempt },
          };
        }
        lastError = `Expected PONG, got: ${stdout.trim()}`;
      } catch (err) {
        lastError = `SSH PING failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }

    return {
      checkName: 'redis_ping',
      status: 'fail',
      responseTimeMs: Math.round(performance.now() - start),
      errorMessage: lastError,
      details: { method: 'ssh', attempts: MAX_ATTEMPTS },
    };
  }

  // Fallback: check health endpoint for Redis status
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await dnsSafeFetch(`https://${domain}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    const responseTimeMs = Math.round(performance.now() - start);
    const body = await res.json();

    // Health endpoint may include a redis field with status info
    if (res.status === 200 && body?.redis) {
      return {
        checkName: 'redis_ping',
        status: 'pass',
        responseTimeMs,
        details: { method: 'health_endpoint', redis: body.redis },
      };
    }

    return {
      checkName: 'redis_ping',
      status: 'fail',
      responseTimeMs,
      errorMessage: 'Health endpoint returned 200 but no Redis status found',
      details: { method: 'health_endpoint', statusCode: res.status, body },
    };
  } catch (err) {
    return {
      checkName: 'redis_ping',
      status: 'fail',
      responseTimeMs: Math.round(performance.now() - start),
      errorMessage: `No SSH access and health endpoint failed: ${err instanceof Error ? err.message : String(err)}`,
      details: { method: 'health_endpoint' },
    };
  }
}

/**
 * Verify Redis SET/GET/DEL cycle works correctly.
 *
 * Only runs when SSH access is available. Writes a test key, reads it back,
 * and cleans up. Self-skips (status 'skip', NOT fail) without SSH — a missing
 * SSH handle is a precondition gap, not a Redis defect, so it must not redden
 * the run (and must not read as a green pass either).
 */
async function checkRedisSetGet(
  serverIp?: string,
  sshKeyPath?: string,
  authFlag = '',
  redisCliPrefix = 'redis-cli',
): Promise<VerificationResult> {
  const start = performance.now();

  if (!serverIp || !sshKeyPath) {
    return {
      checkName: 'redis_set_get',
      status: 'skip',
      responseTimeMs: Math.round(performance.now() - start),
      details: { skipped: true, reason: 'no SSH access available for SET/GET test' },
    };
  }

  try {
    // SET
    const setResult = runSSH(
      serverIp,
      sshKeyPath,
      `${redisCliPrefix} ${authFlag} SET e2e_test "hello"`,
    );

    if (setResult.trim() !== 'OK') {
      return {
        checkName: 'redis_set_get',
        status: 'fail',
        responseTimeMs: Math.round(performance.now() - start),
        errorMessage: `SET returned unexpected result: ${setResult.trim()}`,
        details: { step: 'set', response: setResult.trim() },
      };
    }

    // GET
    const getResult = runSSH(serverIp, sshKeyPath, `${redisCliPrefix} ${authFlag} GET e2e_test`);

    if (getResult.trim() !== 'hello') {
      // Clean up even on failure
      trySSH(serverIp, sshKeyPath, `${redisCliPrefix} ${authFlag} DEL e2e_test`);

      return {
        checkName: 'redis_set_get',
        status: 'fail',
        responseTimeMs: Math.round(performance.now() - start),
        errorMessage: `GET returned unexpected result: ${getResult.trim()}`,
        details: { step: 'get', expected: 'hello', actual: getResult.trim() },
      };
    }

    // DEL (cleanup)
    runSSH(serverIp, sshKeyPath, `${redisCliPrefix} ${authFlag} DEL e2e_test`);

    return {
      checkName: 'redis_set_get',
      status: 'pass',
      responseTimeMs: Math.round(performance.now() - start),
      details: { method: 'ssh', set: 'OK', get: 'hello', deleted: true },
    };
  } catch (err) {
    return {
      checkName: 'redis_set_get',
      status: 'fail',
      responseTimeMs: Math.round(performance.now() - start),
      errorMessage: `SET/GET cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      details: { method: 'ssh' },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Execute a command on a remote server via SSH. Throws on failure.
 *
 * Uses execFileSync (no local shell). The remote command is passed as
 * ssh's last argv element; ssh re-joins post-hostname argv elements
 * with spaces and forwards the result to the remote shell as a single
 * command string. Multi-token commands (e.g. `docker exec ... redis-cli`)
 * are passed as a single string in `remoteCmd` because the remote side
 * needs them word-split as one shell command, not pre-quoted.
 */
function runSSH(serverIp: string, sshKeyPath: string, remoteCmd: string): string {
  return execFileSync('ssh', [...SSH_OPTIONS, '-i', sshKeyPath, `root@${serverIp}`, remoteCmd], {
    encoding: 'utf-8',
    timeout: SSH_TIMEOUT_MS,
  });
}

/**
 * Execute a command on a remote server via SSH. Swallows errors silently.
 * Used for best-effort cleanup operations.
 */
function trySSH(serverIp: string, sshKeyPath: string, remoteCmd: string): void {
  try {
    runSSH(serverIp, sshKeyPath, remoteCmd);
  } catch {
    // Intentionally swallowed -- used for cleanup
  }
}
