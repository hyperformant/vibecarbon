/**
 * Condition probes for the k8s deploy path — the root fix for mitigation-audit
 * clusters 1 (ACME/cert-manager) and 4 (control-plane warm-up), 2026-08-16.
 *
 * THE PROBLEM THESE REPLACE. The deploy used to gate on proxies for readiness:
 * `kubectl wait --for=condition=Available` and elapsed time. `Available` is
 * not *serving* — the webhook pod can be seconds from dialable, the caBundle
 * seconds from injected, the apiserver's admission chain seconds from
 * answering — and every one of those gaps grew its own downstream retry
 * ladder (KUBECTL_WEBHOOK_RETRY_DELAYS_MS for the 502 window,
 * runHelmWithWebhookRetry for the caBundle window, KUBECTL_TRANSIENT_PATTERN
 * generalized across applies). Twenty ACME-flavored fix commits across all six
 * months of the project trace back to this one inversion: timers standing in
 * for conditions.
 *
 * THE SHAPE. Each probe polls the ACTUAL condition the downstream work needs
 * and resolves only when it holds:
 *
 *   - `awaitControlPlaneServing` — the apiserver answers `/readyz` AND
 *     round-trips a server-side dry-run apply in the same iteration. A control
 *     plane that satisfies both is proven to serve discovery + admission, not
 *     merely to exist.
 *
 *   - `awaitCertManagerAdmission` — a server-side dry-run of a REAL
 *     cert-manager resource succeeds. That single round-trip exercises
 *     apiserver → ValidatingWebhookConfiguration → caBundle → webhook pod:
 *     exactly the three windows the two webhook ladders separately absorbed
 *     (the 502 window observed 2026-08-07, the caBundle window observed
 *     2026-08-10). Server-side dry-run creates nothing.
 *
 * On budget exhaustion each probe throws the LAST REAL error — a genuinely
 * broken webhook (CrashLoopBackOff, no endpoints) still fails the deploy
 * loudly with its own message, which is the property that keeps these from
 * being another absorption layer. The existing ladders stay in place as
 * tripwires; per the mitigation policy they become removable once a matrix
 * shows they no longer fire.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { progressLog } from '../../cli/progress.js';
import { runCommandAsync } from '../../command.js';
import {
  ADMIN_PROBE_EXIT,
  adminNotReadyHint,
  adminReadyProbeScript,
  describeAdminProbeExit,
  isAdminProbeExit,
  isTerminalAdminProbeExit,
} from '../admin-ready.js';

/**
 * Inert probe resource: namespaced (no cluster-wide footprint), self-signed
 * (no ACME side effects), and only ever applied with --dry-run=server (never
 * persisted). Its one job is to traverse cert-manager's admission pipeline.
 */
export const CERT_MANAGER_ADMISSION_PROBE_MANIFEST = `apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: vibecarbon-admission-probe
  namespace: cert-manager
spec:
  selfSigned: {}
`;

const CONTROL_PLANE_PROBE_MANIFEST = `apiVersion: v1
kind: ConfigMap
metadata:
  name: vibecarbon-readiness-probe
  namespace: default
data:
  probe: "server-dry-run"
`;

/** Poll interval: short — the observed Available→serving gap is seconds. */
const PROBE_INTERVAL_MS = 2000;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defaultExec = (argv, opts) => runCommandAsync(argv, opts);

async function pollCondition({ name, attempt, budgetMs, sleep, nowFn, isFinal }) {
  const now = nowFn ?? Date.now;
  const deadline = now() + budgetMs;
  const startedAt = now();
  let lastErr;
  let attempts = 0;
  while (now() < deadline) {
    attempts += 1;
    try {
      await attempt();
      if (attempts > 1) {
        progressLog(
          `[readiness] ${name}: serving after ${Math.round((now() - startedAt) / 1000)}s (${attempts} probes)`,
        );
      }
      return;
    } catch (err) {
      // A condition that reported a final answer (it will never hold) fails
      // now instead of burning the budget.
      if (isFinal?.(err)) throw err;
      lastErr = err;
      if (attempts === 1) {
        progressLog(`[readiness] ${name}: not serving yet, polling the condition`);
      }
      if (now() >= deadline) break;
      await sleep(PROBE_INTERVAL_MS);
    }
  }
  // The last real error, not a synthetic timeout: a genuinely broken component
  // must fail the deploy with its own message.
  const seconds = Math.round(budgetMs / 1000);
  throw new Error(
    `${name} did not become serving within ${seconds}s. Last error: ${lastErr?.message ?? '(none recorded)'}`,
  );
}

/**
 * Prove the control plane SERVES — discovery and admission, not liveness.
 * Both checks must pass in the same iteration: a control plane can answer
 * health checks while its admission chain still 500s, and that half-state is
 * precisely what the generalized kubectl ladders were absorbing.
 *
 * @param {object} params
 * @param {NodeJS.ProcessEnv} params.env - carries KUBECONFIG
 * @param {number} [params.budgetMs]
 * @param {Function} [params.exec] - test seam, defaults to runCommandAsync
 * @param {Function} [params.sleep] - test seam
 * @param {Function} [params.nowFn] - test seam
 */
export async function awaitControlPlaneServing({
  env,
  budgetMs = 180_000,
  exec = defaultExec,
  sleep = defaultSleep,
  nowFn,
}) {
  await pollCondition({
    name: 'control-plane',
    budgetMs,
    sleep,
    nowFn,
    attempt: async () => {
      await exec(['kubectl', 'get', '--raw', '/readyz'], { env, silent: true });
      await exec(['kubectl', 'apply', '--dry-run=server', '-f', '-'], {
        env,
        silent: true,
        input: CONTROL_PLANE_PROBE_MANIFEST,
      });
    },
  });
}

/**
 * Prove cert-manager's admission pipeline round-trips. Placed once, after the
 * Available wait and before ANYTHING that creates cert-manager resources —
 * the ClusterIssuer kustomization AND the third-party DNS-01 webhook chart
 * (whose own Issuer/Certificate pass through this same pipeline) are both
 * downstream of this single probe.
 */
export async function awaitCertManagerAdmission({
  env,
  budgetMs = 180_000,
  exec = defaultExec,
  sleep = defaultSleep,
  nowFn,
}) {
  await pollCondition({
    name: 'cert-manager admission',
    budgetMs,
    sleep,
    nowFn,
    attempt: () =>
      exec(['kubectl', 'apply', '--dry-run=server', '-f', '-'], {
        env,
        silent: true,
        input: CERT_MANAGER_ADMISSION_PROBE_MANIFEST,
      }),
  });
}

/**
 * Prove Postgres is ACCEPTING connections — the condition, not the proxy.
 *
 * RCA 2026-08-14 (run 31763728135, mitigation-audit cluster 5): helm-wait
 * returned with the db pod `Running` and the very next psql died on
 * `FATAL: the database system is shutting down` — Pod-Running is not
 * database-accepting-connections; init containers had just finished and
 * Postgres was mid-lifecycle. The PSQL_LIFECYCLE ladder absorbed that gap per
 * call site; this gate closes it once at the source, before ANY psql-bearing
 * step. `pg_isready` exits 0 only when the server would accept a connection
 * (1 = rejecting: starting/shutting down; 2 = no response) — precisely the
 * lifecycle window the ladder's FATALs spell out.
 *
 * @param {object} params
 * @param {NodeJS.ProcessEnv} params.env - carries KUBECONFIG
 * @param {string} params.dbPod - e.g. supabase-supabase-db-0
 * @param {string} [params.namespace]
 * @param {number} [params.budgetMs]
 * @param {Function} [params.exec] - test seam, defaults to runCommandAsync
 * @param {Function} [params.sleep] - test seam
 * @param {Function} [params.nowFn] - test seam
 */
export async function awaitPostgresAccepting({
  env,
  dbPod,
  namespace = 'vibecarbon',
  budgetMs = 180_000,
  exec = defaultExec,
  sleep = defaultSleep,
  nowFn,
}) {
  await pollCondition({
    name: `postgres (${dbPod})`,
    budgetMs,
    sleep,
    nowFn,
    // `-h 127.0.0.1` (TCP), NEVER the default Unix socket — the condition
    // must discriminate the REAL server from the docker-entrypoint's
    // first-boot TEMPORARY one. That temp server (initdb flow: start temp →
    // run init scripts → stop temp → start real) listens ONLY on the Unix
    // socket, so a socket probe passes against it and the caller's next
    // psql lands in the temp-shutdown gap (d4 run 2 RCA, 2026-08-28: the
    // restore-path standby booted UNSEEDED by design, the socket gate passed
    // at 05:29:38 against the temp server, ALTER SYSTEM hit "No such file or
    // directory" in the 300ms gap before the real server's 05:29:41.8
    // startup). Only the real server binds TCP.
    attempt: () =>
      exec(
        [
          'kubectl',
          '-n',
          namespace,
          'exec',
          dbPod,
          '--',
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'supabase_admin',
        ],
        { env, silent: true },
      ),
  });
}

/**
 * Prove the operator can sign in: the app reports `adminReady: true` on its
 * own `/api/health` (it creates the super admin at startup from ADMIN_EMAIL /
 * ADMIN_PASSWORD, see src/lib/deploy/admin-ready.js). Probed from inside an
 * app pod with the image's own `node`, so no port-forward is involved. Any
 * pod answering ready is enough: they share one database, and the flag means
 * the admin row exists there. A terminal adminStatus (refused, skipped,
 * failed) fails at once with its reason rather than at the budget.
 *
 * @param {object} params
 * @param {NodeJS.ProcessEnv} params.env - carries KUBECONFIG
 * @param {string} [params.namespace]
 * @param {number} [params.budgetMs]
 * @param {Function} [params.exec] - test seam, defaults to runCommandAsync
 * @param {Function} [params.sleep] - test seam
 * @param {Function} [params.nowFn] - test seam
 */
export async function awaitAppAdminReady({
  env,
  namespace = 'vibecarbon',
  budgetMs = 180_000,
  exec = defaultExec,
  sleep = defaultSleep,
  nowFn,
}) {
  try {
    await pollCondition({
      name: 'app super admin',
      budgetMs,
      sleep,
      nowFn,
      isFinal: (err) => err?.terminal === true,
      attempt: async () => {
        try {
          await exec(
            [
              'kubectl',
              '-n',
              namespace,
              'exec',
              'deploy/app',
              '-c',
              'app',
              '--',
              'node',
              '-e',
              adminReadyProbeScript(),
            ],
            { env, silent: true },
          );
        } catch (err) {
          // The probe's own exit codes say which half is missing; anything
          // else (no pod yet, apiserver blip) keeps kubectl's message.
          const code = err?.status;
          if (isTerminalAdminProbeExit(code)) {
            throw Object.assign(
              new Error(`app super admin is not ready: ${describeAdminProbeExit(code)}`),
              { terminal: true },
            );
          }
          if (isAdminProbeExit(code) && code !== 0) {
            throw new Error(describeAdminProbeExit(code));
          }
          // kubectl itself failed (no pod yet, apiserver blip): keep its
          // message, stderr included.
          throw err;
        }
      },
    });
  } catch (err) {
    throw new Error(
      `${err.message}\n${adminNotReadyHint(`kubectl -n ${namespace} logs deploy/app -c app`)}`,
    );
  }
}

/**
 * Watch, alongside `kubectl rollout status deployment/app`, for the one
 * outcome the rollout wait cannot see: a failed database migration. The app
 * migrates at startup, and until migrations are applied its readiness probe
 * answers 503, so a failed migration would otherwise surface only as the
 * rollout's 600 s timeout. This polls the same in-container /api/health
 * probe as awaitAppAdminReady (exec works on a running container whether or
 * not it is Ready) and REJECTS at once on MIGRATIONS_FAILED, with the app's
 * log tail and the probe's hint. Every other answer (no pod yet, pending,
 * ready) just means keep watching. It is a condition watch for the rollout's
 * lifetime, not a retry: it resolves when `signal` aborts, which the caller
 * does as soon as the rollout settles.
 *
 * @param {object} params
 * @param {NodeJS.ProcessEnv} params.env - carries KUBECONFIG
 * @param {AbortSignal} params.signal - stops the watch
 * @param {string} [params.namespace]
 * @param {number} [params.intervalMs]
 * @param {Function} [params.exec] - test seam, defaults to runCommandAsync
 * @param {Function} [params.sleep] - test seam
 */
export async function watchAppMigrationFailure({
  env,
  signal,
  namespace = 'vibecarbon',
  intervalMs = 5_000,
  exec = defaultExec,
  sleep = defaultSleep,
}) {
  // The default pause ends early on abort, so a finished rollout leaves no
  // timer holding the process open.
  const pause =
    sleep === defaultSleep ? (ms) => delay(ms, undefined, { signal }).catch(() => {}) : sleep;
  while (!signal.aborted) {
    let code = 0;
    try {
      await exec(
        [
          'kubectl',
          '-n',
          namespace,
          'exec',
          'deploy/app',
          '-c',
          'app',
          '--',
          'node',
          '-e',
          adminReadyProbeScript(),
        ],
        { env, silent: true },
      );
    } catch (err) {
      code = err?.status ?? null;
    }
    if (signal.aborted) return;
    if (code === ADMIN_PROBE_EXIT.MIGRATIONS_FAILED) {
      let logs = '';
      try {
        logs = String(
          (await exec(
            ['kubectl', '-n', namespace, 'logs', 'deploy/app', '-c', 'app', '--tail=40'],
            {
              env,
              silent: true,
            },
          )) ?? '',
        );
      } catch {
        /* best effort */
      }
      throw new Error(
        `The app is not ready: ${describeAdminProbeExit(code)}.\n` +
          `${adminNotReadyHint(`kubectl -n ${namespace} logs deploy/app -c app`)}\n` +
          `--- app log tail ---\n${logs.trim()}`,
      );
    }
    await pause(intervalMs);
  }
}
