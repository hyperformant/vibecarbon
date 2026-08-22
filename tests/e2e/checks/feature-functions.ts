/**
 * Edge Functions runtime verification check.
 *
 * Asserts the supabase/edge-runtime container is actually up and serving,
 * not crash-looping. The runtime listens on :9000 which isn't publicly
 * routed, so this is SSH-based (same approach as the Redis check).
 *
 * RCA prod-1 2026-05-26: the edge-functions container crash-looped from first
 * boot ("could not find an appropriate entrypoint") because the deploy bundle
 * never shipped functions/, yet no e2e check looked at it — the container can
 * be dead without affecting health/auth/db/storage/realtime.
 *
 * SECURITY: execFileSync with SSH; all args come from trusted scenario config
 * (server IP, key path, project name), never external input. Same pattern as
 * feature-redis.ts.
 */

import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { VerificationResult } from '../scenarios/types.js';
import { e2eSshOpts } from '../utils/ssh.js';

const SSH_TIMEOUT_MS = 10_000;
const SSH_OPTIONS = e2eSshOpts(5);

function runSSH(serverIp: string, sshKeyPath: string, remoteCmd: string): string {
  return execFileSync('ssh', [...SSH_OPTIONS, '-i', sshKeyPath, `root@${serverIp}`, remoteCmd], {
    encoding: 'utf-8',
    timeout: SSH_TIMEOUT_MS,
  });
}

/**
 * Verify the edge-functions container is running and its runtime answers on
 * :9000. A crash-looping runtime refuses the connection (or `.State.Running`
 * is false / RestartCount climbs), so a healthy HTTP status from :9000 — even
 * a 404 from the stub dispatcher — is the proof we want.
 *
 * @param serverIp    Primary server IP (SSH target)
 * @param sshKeyPath  Path to the deploy SSH key
 * @param projectName Used to derive the container name `<project>-functions`
 * @param isCompose   Edge functions ship via docker-compose.prod.yml; the k8s
 *                    path differs, so this check only applies to compose modes.
 * @param enabled     Whether edge functions are opted in for this deploy. Since
 *                    2026-05-26 they're OFF by default in both compose (behind a
 *                    `functions` compose profile) and k8s
 *                    (`deployment.functions.enabled`, default false) — the
 *                    template ships only a 404 stub, so the container isn't
 *                    started on a normal deploy. Asserting health when nothing
 *                    opted in is a guaranteed false failure, so skip unless
 *                    `enabled`.
 */
export async function runEdgeFunctionChecks(
  serverIp: string | undefined,
  sshKeyPath: string | undefined,
  projectName: string,
  isCompose = true,
  enabled = false,
): Promise<VerificationResult[]> {
  const start = performance.now();

  if (!enabled) {
    return [
      {
        checkName: 'edge_functions_health',
        status: 'skip',
        details: {
          skipped: true,
          reason:
            'edge functions are opt-in (compose `functions` profile / k8s deployment.functions.enabled) and not enabled for this deploy',
        },
      },
    ];
  }

  if (!isCompose) {
    return [
      {
        checkName: 'edge_functions_health',
        status: 'skip',
        details: {
          skipped: true,
          reason: 'edge functions check is compose-only (k8s path differs)',
        },
      },
    ];
  }

  if (!serverIp || !sshKeyPath) {
    return [
      {
        checkName: 'edge_functions_health',
        status: 'skip',
        details: { skipped: true, reason: 'no SSH access to inspect the edge-functions container' },
      },
    ];
  }

  const container = `${projectName}-functions`;
  const MAX_ATTEMPTS = 4;
  const RETRY_DELAY_MS = 5_000;
  let lastError = '';
  let lastDetails: Record<string, unknown> = {};

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // State + restart count (one round-trip)
      const state = runSSH(
        serverIp,
        sshKeyPath,
        `docker inspect ${container} --format '{{.State.Running}} {{.RestartCount}} {{.State.Status}}' 2>/dev/null || echo 'missing'`,
      ).trim();

      if (state === 'missing') {
        lastError = `Container ${container} not found`;
        lastDetails = { container };
      } else {
        const [running, restartCount, status] = state.split(/\s+/);
        // The decisive signal: does the runtime actually serve on :9000?
        // A crash-looping runtime refuses the connection. Any HTTP status
        // (the stub returns 404) means the worker booted successfully.
        const httpCode = runSSH(
          serverIp,
          sshKeyPath,
          `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:9000/ 2>/dev/null || echo '000'`,
        ).trim();

        lastDetails = { container, running, restartCount, status, httpCode };

        if (running === 'true' && /^[1-5][0-9][0-9]$/.test(httpCode)) {
          return [
            {
              checkName: 'edge_functions_health',
              status: 'pass',
              responseTimeMs: Math.round(performance.now() - start),
              details: { ...lastDetails, attempts: attempt },
            },
          ];
        }
        lastError = `Container not healthy (Running=${running}, Status=${status}, RestartCount=${restartCount}, :9000 HTTP=${httpCode})`;
      }
    } catch (err) {
      lastError = `SSH inspect failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  return [
    {
      checkName: 'edge_functions_health',
      status: 'fail',
      responseTimeMs: Math.round(performance.now() - start),
      errorMessage: lastError,
      details: { ...lastDetails, attempts: MAX_ATTEMPTS },
    },
  ];
}
