/**
 * Configure-key propagation canary.
 *
 * Proves end-to-end that a key written by `vibecarbon configure` (here a
 * billing secret) actually reaches the running app container/pod — across
 * compose and k8s, with or without CI. The harness seeds
 * STRIPE_SECRET_KEY=<CANARY> into .env.local right after `create`; this check
 * execs into the app and asserts `printenv` echoes it back.
 *
 * Without this, the deploy layer can seed vibecarbon-secrets perfectly while a
 * missing `envFrom`/`env_file` leaves the app blind to the value — the exact
 * class of silent regression this whole change set closes.
 *
 * sk_test_ prefix: a Stripe *test-mode* sentinel, never a real key.
 */

import { execFileSync } from 'node:child_process';
import type { VerificationResult } from '../scenarios/types.js';
import { e2eSshOpts } from '../utils/ssh.js';
import {
  isSshConnectTimeout,
  noteSshConnectTimeout,
  sshUnreachableDiagnosis,
  sshUnreachableSince,
} from '../utils/ssh-reachability.js';

/** The sentinel value the harness injects into .env.local and asserts here. */
export const CONFIG_CANARY_SECRET = 'sk_test_e2e_canary_propagation';

/**
 * OAuth canary: seeded as GOOGLE_CLIENT_ID and asserted inside the GoTrue
 * (auth) container as GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID — proving the
 * configure→GoTrue mapping (compose env interpolation / k8s valueFrom
 * secretKeyRef) end-to-end. Deliberately NOT paired with GOOGLE_ENABLED: a
 * half-configured enabled provider could fail GoTrue's boot validation, and
 * an unused client id on a disabled provider is inert.
 */
export const OAUTH_CANARY_CLIENT_ID = 'e2e-canary-client-id.apps.example.invalid';

function ssh(ip: string, sshKeyPath: string, cmd: string): string {
  // SECURITY: all args come from trusted test config, not user input.
  return execFileSync('ssh', [...e2eSshOpts(10), '-i', sshKeyPath, `root@${ip}`, cmd], {
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: 'pipe',
  }).trim();
}

/**
 * Poll `probe` until it returns a non-empty string or the attempt budget is
 * exhausted. Retries exist to cover the FAILOVER case: the app-tier restart
 * cycles 6 containers (~50-60s to running, measured), during which
 * `docker exec` into a not-yet-running container returns empty / errors.
 *
 * The pre-2026-08-10 budget (4 attempts × 5s ≈ 15s) was tuned for DEPLOY
 * (settled containers pass on the first probe) and misread a mid-restart
 * container as "env missing" at verify-failover — a false negative that the
 * d2 kept-rig RCA traced to timing, not propagation (both nodes carried the
 * env before AND the promoted node after failover). The budget now covers
 * the restart window. A non-empty value returns IMMEDIATELY, so a settled
 * container never pays the wider budget; only a genuinely-empty or
 * mid-restart probe waits.
 *
 * Attempt-count driven (not wall-clock) and `sleep`-injectable so the retry
 * behavior is deterministic under unit test.
 */
export async function pollForEnvValue(
  probe: () => string,
  opts: {
    budgetMs: number;
    intervalMs: number;
    sleep?: (ms: number) => Promise<void>;
    /**
     * Consulted on every probe error. Returning true stops the poll on the
     * spot — for errors the remaining budget cannot fix. A black-holed :22
     * does not heal in 90s of retries, and re-probing it is exactly the serial
     * burn this whole module exists to prevent.
     */
    shouldAbort?: (err: Error) => boolean;
  },
): Promise<{ value: string; lastErr: Error | null; aborted: boolean }> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, Math.ceil(opts.budgetMs / opts.intervalMs));
  let value = '';
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      value = probe();
      if (value) return { value, lastErr, aborted: false };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (opts.shouldAbort?.(lastErr)) return { value: '', lastErr, aborted: true };
    }
    if (i < attempts - 1) await sleep(opts.intervalMs);
  }
  return { value, lastErr, aborted: false };
}

/**
 * @param masterIp    serverIps[0] — compose host or k8s master node.
 * @param sshKeyPath  per-env private key.
 * @param projectName used for the compose container name (<name>-app).
 * @param isCompose   compose vs k8s exec path.
 */
export async function runConfigCanaryChecks(
  masterIp: string | undefined,
  sshKeyPath: string | undefined,
  projectName: string,
  isCompose: boolean,
): Promise<VerificationResult[]> {
  const start = process.hrtime();
  const elapsed = () => {
    const [s, ns] = process.hrtime(start);
    return Math.round(s * 1000 + ns / 1_000_000);
  };

  // Self-skip (status 'skip', NOT pass) when we have no way in — keeps the
  // check from failing scenarios that don't expose an SSH handle, while a
  // missing precondition still stays distinct from a green pass (matches
  // edge/redis checks).
  if (!masterIp || !sshKeyPath) {
    return ['config_secret_propagation', 'config_oauth_gotrue_propagation'].map((checkName) => ({
      checkName,
      status: 'skip' as const,
      responseTimeMs: elapsed(),
      // Name WHICH handle is missing. "no serverIp/sshKeyPath" cost a whole
      // diagnostic cycle on the k8s tier (2026-08-21): the checks skipped at
      // verify-deploy on every provider and the message could not say whether
      // the IP or the key was absent, so the fix was guesswork.
      details: {
        skipped: !masterIp
          ? sshKeyPath
            ? 'no serverIp (sshKeyPath present)'
            : 'no serverIp and no sshKeyPath'
          : 'no sshKeyPath (serverIp present)',
      },
    }));
  }

  // Two propagation paths, each with its own consumer:
  //  - app: envFrom (k8s) / env_file (compose) — the whole-secret path
  //  - auth (GoTrue): explicit per-key mapping — compose env interpolation /
  //    k8s valueFrom secretKeyRef (the path that was silently missing on k8s
  //    until 2026-07-15; see memory project_configure_gaps_audit)
  const specs = [
    {
      checkName: 'config_secret_propagation',
      envName: 'STRIPE_SECRET_KEY',
      expected: CONFIG_CANARY_SECRET,
      target: 'app',
      cmd: isCompose
        ? `docker exec ${projectName}-app printenv STRIPE_SECRET_KEY 2>/dev/null || true`
        : `kubectl -n vibecarbon exec deploy/app -- printenv STRIPE_SECRET_KEY 2>/dev/null || true`,
    },
    {
      checkName: 'config_oauth_gotrue_propagation',
      envName: 'GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID',
      expected: OAUTH_CANARY_CLIENT_ID,
      target: 'auth',
      cmd: isCompose
        ? `docker exec ${projectName}-auth printenv GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID 2>/dev/null || true`
        : `kubectl -n vibecarbon exec deploy/supabase-supabase-auth -- printenv GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID 2>/dev/null || true`,
    },
  ];

  const results: VerificationResult[] = [];
  for (const spec of specs) {
    // Never spend a 90s poll budget on a host that already proved its :22 is
    // black-holed — the first check pays the diagnosis, the rest fail fast.
    const alreadyDead = sshUnreachableSince(masterIp);
    if (alreadyDead) {
      results.push({
        checkName: spec.checkName,
        status: 'fail',
        responseTimeMs: elapsed(),
        errorMessage: `${spec.envName} unverifiable — ${sshUnreachableDiagnosis(masterIp)}`,
        details: { mode: isCompose ? 'compose' : 'k8s', target: spec.target, sshUnreachable: true },
      });
      continue;
    }

    // Retry across the app-tier restart window — at verify-failover the six
    // app-tier containers were just `docker restart`ed and take ~50-60s to
    // be running; a settled container (deploy path) returns on the first
    // probe. See pollForEnvValue for the full RCA.
    //
    // The abort predicate condemns the host on the FIRST connect timeout, so
    // even this first spec stops after one attempt instead of re-probing a
    // black-holed :22 for the whole budget.
    const { value, lastErr, aborted } = await pollForEnvValue(
      () => ssh(masterIp, sshKeyPath, spec.cmd),
      {
        budgetMs: 90_000,
        intervalMs: 5_000,
        shouldAbort: (err) => {
          if (!isSshConnectTimeout(err.message)) return false;
          noteSshConnectTimeout(masterIp, err.message);
          return true;
        },
      },
    );

    if (aborted) {
      results.push({
        checkName: spec.checkName,
        status: 'fail',
        responseTimeMs: elapsed(),
        errorMessage: `${spec.envName} unverifiable — ${sshUnreachableDiagnosis(masterIp)}`,
        details: { mode: isCompose ? 'compose' : 'k8s', target: spec.target, sshUnreachable: true },
      });
      continue;
    }

    if (value === spec.expected) {
      results.push({
        checkName: spec.checkName,
        status: 'pass',
        responseTimeMs: elapsed(),
        details: { mode: isCompose ? 'compose' : 'k8s', target: spec.target },
      });
    } else {
      results.push({
        checkName: spec.checkName,
        status: 'fail',
        responseTimeMs: elapsed(),
        errorMessage:
          value === ''
            ? `${spec.envName} not present in ${spec.target} ${isCompose ? 'container' : 'pod'} — configure key did not propagate${lastErr ? ` (ssh: ${lastErr.message})` : ''}`
            : `${spec.envName} mismatch: expected the injected canary, got a ${value.length}-char value`,
        details: {
          mode: isCompose ? 'compose' : 'k8s',
          target: spec.target,
          present: value !== '',
        },
      });
    }
  }
  return results;
}
