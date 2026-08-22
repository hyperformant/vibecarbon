/**
 * Cluster-scoped failure diagnostics for the e2e bundle.
 *
 * The per-scenario bundle written by `captureFailureDiagnostics`
 * (tests/e2e/scenarios/_run-lifecycle.ts) has always been scoped to the
 * `vibecarbon` namespace, because most failures are app failures. Two blind
 * RCAs proved that is the wrong default for cluster-scoped steps:
 *
 *  - 2026-07-27 — a deploy failure whose cause lived outside `vibecarbon`
 *    produced a bundle with nothing to go on. Logged as carbon-autoscaler
 *    a carbon-autoscaler follow-up.
 *  - 2026-07-31 (k8s e3) — deploy died on "cluster-autoscaler rollout status
 *    failed (timeout 300s)". cluster-autoscaler lives in `kube-system`, so the
 *    bundle held zero evidence: ImagePullBackOff, CrashLoopBackOff and plain
 *    slow-start were indistinguishable after the rig was destroyed.
 *
 * When the failing step is cluster-scoped, this module adds cluster-wide pod
 * and event state plus describe + logs (current AND --previous) for every
 * NOT-READY pod in `kube-system` and the app namespace.
 *
 * Everything here is bounded on purpose — this lands in a log file, not a
 * database: `head -N` caps the pod fan-out, `--tail=` caps each log dump,
 * `timeout N` caps each per-pod kubectl call, and the caller clips each
 * section to ~4KB.
 *
 * Pure command assembly (no execution) so the shape is unit-testable without
 * a cluster — see tests/unit/e2e/cluster-scoped-diagnostics.test.ts.
 */

import type { StepName } from '../scenarios/types.js';

/** Namespaces the cluster-scoped bundle walks, in order. */
export const CLUSTER_DIAG_NAMESPACES = ['kube-system', 'vibecarbon'] as const;

/** Max not-ready pods per namespace we describe / dump logs for. */
export const CLUSTER_DIAG_MAX_PODS = 6;

/** Lines kept per container log dump. */
export const CLUSTER_DIAG_LOG_TAIL = 50;

/**
 * Registry-log capture depths. Run 31961619204 (registry-500, third
 * occurrence) proved a 50-line RAW tail loses the evidence even with the
 * collector firing: readiness probes log ~17 lines/min, so by the time the
 * bundle runs (minutes after the push failed) the error window has rotated
 * out. Fetch deep, drop the probe chatter, keep a generous tail of substance.
 */
export const CLUSTER_DIAG_REGISTRY_FETCH_TAIL = 4000;
export const CLUSTER_DIAG_REGISTRY_KEEP_TAIL = 400;

/** Lines kept per `describe pod`. */
export const CLUSTER_DIAG_DESCRIBE_TAIL = 40;

/** Cluster-wide event lines kept. */
export const CLUSTER_DIAG_EVENT_TAIL = 60;

/** Per-pod kubectl wall-clock cap, seconds — one wedged pod can't starve the rest. */
const PER_POD_TIMEOUT_S = 12;

/**
 * Steps whose failure can be caused by anything in the cluster, not just the
 * app namespace.
 *
 * `deploy` and its variants apply cluster-scoped manifests (cert-manager,
 * traefik, cluster-autoscaler, CSI); `scale` and `restore` drive node and
 * volume churn that surfaces in kube-system; `failover` promotes a whole
 * cluster. Everything else (verify-*, create, backup, destroy) is either
 * app-level or has its own targeted capture, and stays on the narrow bundle.
 */
const CLUSTER_SCOPED_STEPS: ReadonlySet<StepName> = new Set<StepName>([
  'deploy',
  'warm-deploy',
  'warm-redeploy-change',
  'reconverge-deploy',
  'scale',
  'restore',
  'failover',
]);

export function isClusterScopedStep(step: StepName): boolean {
  return CLUSTER_SCOPED_STEPS.has(step);
}

/** One capture: a program, its argv, a section label, and a wall-clock cap. */
export interface DiagnosticCommand {
  label: string;
  cmd: string;
  argv: string[];
  timeoutMs: number;
}

/**
 * Shell fragment listing the NOT-READY pods in `ns`, capped at
 * CLUSTER_DIAG_MAX_PODS.
 *
 * "Not ready" is deliberately broader than the pre-existing app-namespace
 * sections' filters (`STATUS != Running` for describe, `RESTARTS > 0` for
 * logs). The 2026-07-31 CA rollout timeout produced a pod that was Running
 * with 0 restarts and 1/2 containers ready — invisible to both. The READY
 * column (`$2`, e.g. `1/2`) is the signal that catches it.
 */
function notReadyPodsExpr(kubeconfig: string, ns: string): string {
  return (
    `kubectl --kubeconfig ${kubeconfig} -n ${ns} get pods --no-headers 2>&1 | ` +
    `awk '{split($2,r,"/"); if ($3!="Completed" && ($3!="Running" || r[1]+0 < r[2]+0)) print $1}' | ` +
    `head -${CLUSTER_DIAG_MAX_PODS}`
  );
}

/**
 * Build the cluster-scoped section of the failure bundle for one kubeconfig.
 *
 * @param kubeconfig absolute path to the kubeconfig to query
 * @param label      section-label prefix (the kubeconfig's basename)
 */
export function buildClusterScopedDiagnostics(
  kubeconfig: string,
  label: string,
): DiagnosticCommand[] {
  const cmds: DiagnosticCommand[] = [
    {
      // The one command that answers "is anything, anywhere, unhealthy?".
      label: `${label}: pods (ALL namespaces)`,
      cmd: 'kubectl',
      argv: ['--kubeconfig', kubeconfig, 'get', 'pods', '-A', '-o', 'wide'],
      timeoutMs: 20_000,
    },
    {
      // Cluster-wide events catch what pod state cannot: failed scheduling,
      // node NotReady/pressure, volume attach errors, admission rejections.
      label: `${label}: events (ALL namespaces, last ${CLUSTER_DIAG_EVENT_TAIL})`,
      cmd: 'bash',
      argv: [
        '-c',
        `kubectl --kubeconfig ${kubeconfig} get events -A --sort-by=.lastTimestamp 2>&1 | tail -${CLUSTER_DIAG_EVENT_TAIL}`,
      ],
      timeoutMs: 30_000,
    },
  ];

  cmds.push({
    // `local-registry` is registry:2 on an S3 backend. When S3 errors it
    // answers `docker push` with HTTP 500 while its /v2/ readiness probe keeps
    // passing — so it stays 1/1 Running and the not-Ready collector below
    // never dumps it. Two matrices lost their push-failure evidence exactly
    // that way (31763728135 hetzner/k8s, 31857911325 hetzner/k8s-ha restore:
    // five consecutive 500s then `blob upload unknown`, with the registry
    // showing only as a Running line in the pod table).
    //
    // Collected unconditionally: for this workload readiness is not evidence
    // of health. See tests/unit/e2e/cluster-diagnostics-registry.test.ts.
    label: `${label}: local-registry logs (collected Ready-or-not, probe noise filtered)`,
    cmd: 'bash',
    argv: [
      '-c',
      // Deep fetch + de-noise: both probe log forms (the access-log line and
      // the structured response line) carry the literal "kube-probe", and
      // they are what rotated the 31961619204 error window out of a raw
      // 50-line tail. grep -v exits 1 on all-filtered — the trailing || true
      // keeps that from reading as a collector failure.
      `timeout ${PER_POD_TIMEOUT_S} kubectl --kubeconfig ${kubeconfig} -n vibecarbon logs ` +
        `-l app=local-registry --all-containers --prefix --tail=${CLUSTER_DIAG_REGISTRY_FETCH_TAIL} 2>&1 | ` +
        `grep -v kube-probe | tail -${CLUSTER_DIAG_REGISTRY_KEEP_TAIL} || true`,
    ],
    timeoutMs: 30_000,
  });

  for (const ns of CLUSTER_DIAG_NAMESPACES) {
    const bad = notReadyPodsExpr(kubeconfig, ns);
    cmds.push({
      // describe = WHAT (image pull URL, probe failure, unschedulable reason).
      label: `${label}: describe not-Ready pods (${ns})`,
      cmd: 'bash',
      argv: [
        '-c',
        `set -o pipefail; bad=$(${bad}); if [ -z "$bad" ]; then echo '(all pods Ready)'; else ` +
          `for p in $bad; do echo "=== $p ==="; timeout ${PER_POD_TIMEOUT_S} kubectl --kubeconfig ${kubeconfig} -n ${ns} describe pod "$p" 2>&1 | tail -${CLUSTER_DIAG_DESCRIBE_TAIL} || true; done; fi`,
      ],
      timeoutMs: 60_000,
    });
    cmds.push({
      // logs = WHY. --previous holds the dead instance's reason on a crash
      // loop; current holds it when the live attempt fails differently (or
      // when there is no previous at all). Capture both — the seeding RCA on
      // run 29472203674 was undiagnosable with only one of them.
      label: `${label}: logs from not-Ready pods (--previous + current, ${ns})`,
      cmd: 'bash',
      argv: [
        '-c',
        `set -o pipefail; bad=$(${bad}); if [ -z "$bad" ]; then echo '(all pods Ready)'; else ` +
          `for p in $bad; do ` +
          `echo "=== $p (--previous) ==="; timeout ${PER_POD_TIMEOUT_S} kubectl --kubeconfig ${kubeconfig} -n ${ns} logs "$p" --previous --all-containers --tail=${CLUSTER_DIAG_LOG_TAIL} 2>&1 | tail -${CLUSTER_DIAG_LOG_TAIL} || true; ` +
          `echo "=== $p (current) ==="; timeout ${PER_POD_TIMEOUT_S} kubectl --kubeconfig ${kubeconfig} -n ${ns} logs "$p" --all-containers --tail=${CLUSTER_DIAG_LOG_TAIL} 2>&1 | tail -${CLUSTER_DIAG_LOG_TAIL} || true; ` +
          `done; fi`,
      ],
      timeoutMs: 90_000,
    });
  }

  return cmds;
}
