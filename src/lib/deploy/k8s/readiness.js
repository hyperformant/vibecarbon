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
 * RCA 2026-08-14 (run 31763728135, mitigation-audit cluster 5): the db
 * install's wait returned with the db pod `Running` and the very next psql died on
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
 * @param {string} params.dbPod - e.g. db-0
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
          'postgres',
        ],
        { env, silent: true },
      ),
  });
}

/**
 * Wait until the db pod's postgres has left recovery: a restored database
 * replays the WAL after its base, then promotes (recovery_target_action
 * 'promote'). The pod is Ready (hot standby, accepting reads) before that,
 * so the rollout wait cannot see it. Throws the last real answer at the
 * budget; a recovery that fails outright crashes the pod instead.
 *
 * @param {object} params
 * @param {NodeJS.ProcessEnv} params.env - carries KUBECONFIG
 * @param {string} params.dbPod - e.g. db-0
 * @param {string} params.dbContainer - e.g. db
 * @param {string} [params.namespace]
 * @param {number} [params.budgetMs]
 * @param {Function} [params.exec] - test seam, defaults to runCommandAsync
 * @param {Function} [params.sleep] - test seam
 * @param {Function} [params.nowFn] - test seam
 */
export async function awaitPostgresPromoted({
  env,
  dbPod,
  dbContainer,
  namespace = 'vibecarbon',
  budgetMs = 300_000,
  exec = defaultExec,
  sleep = defaultSleep,
  nowFn,
}) {
  await pollCondition({
    name: `restored postgres promoted (${dbPod})`,
    budgetMs,
    sleep,
    nowFn,
    attempt: async () => {
      const out = await exec(
        [
          'kubectl',
          '-n',
          namespace,
          'exec',
          dbPod,
          '-c',
          dbContainer,
          '--',
          'psql',
          '-U',
          'postgres',
          '-tAc',
          'SELECT pg_is_in_recovery()',
        ],
        { env, silent: true },
      );
      const v = String(out ?? '').trim();
      if (v !== 'f') throw new Error(`pg_is_in_recovery() = ${v || '(no answer)'}`);
    },
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

/** The app Deployment's pod selector (k8s/base/app/deployment.yaml). */
export const APP_POD_SELECTOR = 'app=vibecarbon-app';

/**
 * The newest pod of the app Deployment's CURRENT ReplicaSet, or null while
 * it has none. During a rolling update `kubectl exec deploy/app` may pick an
 * old-ReplicaSet pod, which reports the migrations it applied long ago, so
 * the watch would miss the new pod's failure until the rollout timeout. The
 * current ReplicaSet is the one with the highest
 * `deployment.kubernetes.io/revision`; its pods carry its
 * `pod-template-hash` label.
 *
 * @param {object} params
 * @param {NodeJS.ProcessEnv} params.env
 * @param {string} params.namespace
 * @param {Function} params.exec
 * @returns {Promise<string|null>} a pod name
 */
export async function newestAppPod({ env, namespace, exec }) {
  return (await newestAppPodObject({ env, namespace, exec }))?.metadata?.name ?? null;
}

/**
 * The newest pod of the current ReplicaSet as kubectl's JSON (newestAppPod),
 * status included, or null.
 *
 * @param {object} params
 * @param {NodeJS.ProcessEnv} params.env
 * @param {string} params.namespace
 * @param {Function} params.exec
 * @returns {Promise<any|null>}
 */
async function newestAppPodObject({ env, namespace, exec }) {
  const getJson = async (kind, selector) =>
    JSON.parse(
      String(
        (await exec(['kubectl', '-n', namespace, 'get', kind, '-l', selector, '-o', 'json'], {
          env,
          silent: true,
        })) ?? '',
      ) || '{"items":[]}',
    ).items ?? [];
  const sets = await getJson('replicasets', APP_POD_SELECTOR);
  const revision = (rs) =>
    Number(rs?.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? -1);
  const current = sets.reduce((best, rs) => (revision(rs) > revision(best) ? rs : best), null);
  const hash = current?.metadata?.labels?.['pod-template-hash'];
  if (!hash) return null;
  const pods = await getJson('pods', `${APP_POD_SELECTOR},pod-template-hash=${hash}`);
  const created = (pod) => Date.parse(pod?.metadata?.creationTimestamp ?? '') || 0;
  return pods
    .filter((pod) => !pod?.metadata?.deletionTimestamp)
    .reduce((best, pod) => (created(pod) >= created(best) ? pod : best), null);
}

/** The app pod's init container that runs the migrations (deployment.yaml). */
export const MIGRATE_INIT_CONTAINER = 'migrate';

/**
 * The exit code of the pod's `migrate` init container when its current or
 * last run ended in failure, else null. It exits non-zero only for a real
 * failure (a failed migration, rejected owner credentials): it waits out a
 * database that is not up yet instead of exiting.
 *
 * @param {any} pod - kubectl's pod JSON
 * @returns {number|null}
 */
export function failedMigrateExitCode(pod) {
  const status = (pod?.status?.initContainerStatuses ?? []).find(
    (c) => c?.name === MIGRATE_INIT_CONTAINER,
  );
  for (const state of [status?.state, status?.lastState]) {
    const code = state?.terminated?.exitCode;
    if (typeof code === 'number' && code !== 0) return code;
  }
  return null;
}

/**
 * Watch, alongside `kubectl rollout status deployment/app`, for the one
 * outcome the rollout wait cannot see: a failed database migration. The
 * pod's `migrate` init container applies them before the app container
 * starts, and until they are applied the app's readiness probe answers 503,
 * so a failed migration would otherwise surface only as the rollout's 600 s
 * timeout. This REJECTS at once when the newest pod's migrate init container
 * exited non-zero, with its log tail; and it polls the same in-container
 * /api/health probe as awaitAppAdminReady (exec works on a running container
 * whether or not it is Ready), rejecting on MIGRATIONS_FAILED (the app could
 * not read the ledger), with the app's log tail and the probe's hint. Every other answer (no pod yet, pending,
 * ready) just means keep watching. It is a condition watch for the rollout's
 * lifetime, not a retry: it resolves when `signal` aborts, which the caller
 * does as soon as the rollout settles. Each poll probes the newest pod of the
 * rollout's current ReplicaSet (newestAppPod), so an old pod that migrated
 * long ago cannot answer for the new one.
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
    let code = null;
    // The rollout's own pod, never an old-ReplicaSet one (newestAppPod). A
    // failed lookup is "no pod yet": only the probe's exit code decides.
    const podObject = await newestAppPodObject({ env, namespace, exec }).catch(() => null);
    const pod = podObject?.metadata?.name ?? null;
    // The migrations run in the pod's `migrate` init container, before the
    // app container exists: a failure there is the one this watch is for.
    const migrateExit = failedMigrateExitCode(podObject);
    if (pod && migrateExit !== null) {
      const terminatedNow = (podObject.status.initContainerStatuses ?? []).find(
        (c) => c?.name === MIGRATE_INIT_CONTAINER,
      )?.state?.terminated;
      let logs = '';
      try {
        logs = String(
          (await exec(
            [
              'kubectl',
              '-n',
              namespace,
              'logs',
              `pod/${pod}`,
              '-c',
              MIGRATE_INIT_CONTAINER,
              ...(terminatedNow ? [] : ['--previous']),
              '--tail=40',
            ],
            { env, silent: true },
          )) ?? '',
        );
      } catch {
        /* best effort */
      }
      if (signal.aborted) return;
      throw new Error(
        `The database migrations failed: the migrate init container exited ${migrateExit} ` +
          `(pod ${pod}).\n` +
          `See \`kubectl -n ${namespace} logs pod/${pod} -c ${MIGRATE_INIT_CONTAINER}\` for the error.\n` +
          `--- migrate log tail ---\n${logs.trim()}`,
      );
    }
    if (pod) {
      try {
        await exec(
          [
            'kubectl',
            '-n',
            namespace,
            'exec',
            `pod/${pod}`,
            '-c',
            'app',
            '--',
            'node',
            '-e',
            adminReadyProbeScript(),
          ],
          { env, silent: true },
        );
        code = 0;
      } catch (err) {
        code = err?.status ?? null;
      }
    }
    if (signal.aborted) return;
    if (code === ADMIN_PROBE_EXIT.MIGRATIONS_FAILED) {
      let logs = '';
      try {
        logs = String(
          (await exec(
            ['kubectl', '-n', namespace, 'logs', `pod/${pod}`, '-c', 'app', '--tail=40'],
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
        `The app is not ready: ${describeAdminProbeExit(code)} (pod ${pod}).\n` +
          `${adminNotReadyHint(`kubectl -n ${namespace} logs pod/${pod} -c app`)}\n` +
          `--- app log tail ---\n${logs.trim()}`,
      );
    }
    await pause(intervalMs);
  }
}
