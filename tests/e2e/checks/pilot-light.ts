/**
 * Pilot-light standby shape verification for k8s-ha deploys.
 *
 * `vibecarbon deploy` is the role reconciler: whichever cluster
 * `.vibecarbon.json`'s `ha.standby` block currently points at is supposed to
 * come out of a deploy in "pilot-light" shape — a warm streaming-replica
 * postgres with the app tier and worker fleet scaled to zero, ready to be
 * promoted by `vibecarbon failover` without a cold provisioning step. The
 * deploy CLI itself enforces this while it runs, but (matching the standing
 * pattern in checks/replication.ts) a green run that only trusts the CLI's
 * exit code proves nothing on its own — these checks reach the standby
 * cluster directly, over SSH, and assert the pilot-light invariants from the
 * OUTSIDE:
 *
 *   - pilot_light_deployments_zero    — EVERY Deployment in ns `vibecarbon`
 *                                        has spec.replicas === 0 (app tier is
 *                                        fully quiesced).
 *   - pilot_light_db_statefulset_ready — the `supabase-supabase-db`
 *                                        StatefulSet is 1/1 (the streaming
 *                                        replica postgres is up and ready).
 *   - pilot_light_autoscaler_zero      — the `cluster-autoscaler` Deployment
 *                                        in `kube-system` has spec.replicas
 *                                        === 0 (no autoscaler running to
 *                                        undo the zeroed worker fleet).
 *   - pilot_light_zero_worker_nodes    — `kubectl get nodes` shows ZERO
 *                                        nodes with `-worker-` in the name
 *                                        (Pulumi-managed worker fleet is
 *                                        actually provisioned down to zero,
 *                                        not just scaled-to-zero at the pod
 *                                        level).
 *
 * We reach the standby purely via `kubectl` over SSH to its master node (the
 * k3s API server runs there) — the same customer-reachable path
 * checks/replication.ts uses for k8s-ha's psql access. All SSH command
 * strings here are fixed (no interpolated marker ids / user input), so there
 * is zero injection surface. Every function fails soft on an SSH/exec error —
 * the check reports fail with a diagnostic, it never throws.
 */

import { execFileSync } from 'node:child_process';
import type { VerificationResult } from '../scenarios/types.js';
import { e2eSshOpts } from '../utils/ssh.js';
import { classifySshExecFailure, type SshExecFailureKind } from './replication.js';

const NAMESPACE = 'vibecarbon';
const DB_STATEFULSET = 'supabase-supabase-db';
const AUTOSCALER_NAMESPACE = 'kube-system';
const AUTOSCALER_DEPLOYMENT = 'cluster-autoscaler';
const WORKER_NAME_MARKER = '-worker-';
const KUBECTL_ENV = 'KUBECONFIG=/etc/rancher/k3s/k3s.yaml';

const SSH_OPTS = e2eSshOpts(10);

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable — no SSH round-trips)
// ---------------------------------------------------------------------------

export interface K8sDeploymentSummary {
  name: string;
  replicas: number;
}

/**
 * Parse `kubectl get deployments -o json` output into name/replicas pairs.
 * Returns null (not an empty array) on unparseable input so callers can
 * distinguish "no deployments" from "couldn't read the response".
 */
export function parseDeploymentList(
  json: string | null | undefined,
): K8sDeploymentSummary[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as {
      items?: Array<{ metadata?: { name?: string }; spec?: { replicas?: number } }>;
    };
    return (parsed.items ?? []).map((item) => ({
      name: item.metadata?.name ?? '(unknown)',
      // A Deployment with no explicit `spec.replicas` defaults to 1 in k8s —
      // treat a missing field as non-zero rather than silently passing.
      replicas: item.spec?.replicas ?? 1,
    }));
  } catch {
    return null;
  }
}

/** Deployment names whose spec.replicas is anything other than exactly 0. */
/**
 * Floor components the pilot-light spec KEEPS running on the standby's
 * 2-node floor (idle-state architecture): traefik serves the master's
 * hostPort ingress (cert issuance still happens at deploy) and the
 * in-cluster registry holds the app image failover's scale-up pulls.
 * Everything else in ns vibecarbon must be zeroed. (repl-gateway is a bare
 * Pod, not a Deployment, so it never enters this check.)
 * First live run (2026-07-17 e4) failed here because the check swept the
 * whole namespace — the deploy was correct, the assertion was not.
 */
export const PILOT_KEPT_DEPLOYMENTS = ['traefik', 'local-registry'];

export function findNonZeroReplicaDeployments(deployments: K8sDeploymentSummary[]): string[] {
  return deployments
    .filter((d) => !PILOT_KEPT_DEPLOYMENTS.includes(d.name))
    .filter((d) => d.replicas !== 0)
    .map((d) => d.name);
}

export interface StatefulSetStatus {
  specReplicas: number;
  readyReplicas: number;
}

/** Parse `kubectl get statefulset <name> -o json` into replicas/readyReplicas. */
export function parseStatefulSetStatus(json: string | null | undefined): StatefulSetStatus | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as {
      spec?: { replicas?: number };
      status?: { readyReplicas?: number };
    };
    return {
      specReplicas: parsed.spec?.replicas ?? 1,
      readyReplicas: parsed.status?.readyReplicas ?? 0,
    };
  } catch {
    return null;
  }
}

/** Parse `kubectl get deployment <name> -o json` into just spec.replicas. */
export function parseDeploymentReplicaCount(json: string | null | undefined): number | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { spec?: { replicas?: number } };
    return parsed.spec?.replicas ?? 1;
  } catch {
    return null;
  }
}

/** Parse `kubectl get nodes -o json` into the list of node names containing `-worker-`. */
export function findWorkerNodeNames(json: string | null | undefined): string[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { items?: Array<{ metadata?: { name?: string } }> };
    return (parsed.items ?? [])
      .map((item) => item.metadata?.name ?? '')
      .filter((name) => name.includes(WORKER_NAME_MARKER));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SSH exec — retried, transport-vs-remote classified (mirrors
// checks/replication.ts's sshExecOnce/sshExecWithRetry; kubectl-only here so
// there's no ReplTarget/mode/projectName to thread).
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface SshExecOnceResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  message: string;
}

/** Single ssh exec attempt. Never throws. */
function sshExecOnce(ip: string, sshKeyPath: string, remote: string): SshExecOnceResult {
  try {
    // SECURITY: execFileSync invokes ssh directly (no shell). ip/key come
    // from our own config; `remote` is always a fixed kubectl command string
    // with no interpolated marker ids or user input.
    const out = execFileSync('ssh', [...SSH_OPTS, '-i', sshKeyPath, `root@${ip}`, remote], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: 'pipe',
    });
    return { ok: true, status: 0, stdout: out.trim(), stderr: '', message: '' };
  } catch (err) {
    const e = err as {
      status?: number | null;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      message?: string;
    };
    return {
      ok: false,
      status: typeof e.status === 'number' ? e.status : null,
      stdout: e.stdout ? e.stdout.toString().trim() : '',
      stderr: e.stderr ? e.stderr.toString().trim() : '',
      message: e.message ?? 'ssh exec failed',
    };
  }
}

// Same budget as checks/replication.ts: 3 attempts, 5s apart. Rides out an
// sshd MaxStartups penalty window from the verify-step's SSH fan-out without
// masking a real outage (which still surfaces well within a step's timeout).
const SSH_ATTEMPTS = 3;
const SSH_RETRY_DELAY_MS = 5_000;

interface SshExecRetryResult {
  ok: boolean;
  stdout: string;
  errorText: string;
  failureKind?: SshExecFailureKind;
  attempts: number;
}

/** ssh exec with transient-transport retry. Never throws. */
async function sshExecWithRetry(
  ip: string,
  sshKeyPath: string,
  remote: string,
): Promise<SshExecRetryResult> {
  let last = sshExecOnce(ip, sshKeyPath, remote);
  let attempts = 1;
  while (!last.ok && attempts < SSH_ATTEMPTS) {
    const cls = classifySshExecFailure(last.status, `${last.stderr}\n${last.message}`);
    if (!cls.transient) break;
    await sleep(SSH_RETRY_DELAY_MS);
    last = sshExecOnce(ip, sshKeyPath, remote);
    attempts++;
  }
  if (last.ok) {
    return { ok: true, stdout: last.stdout, errorText: '', attempts };
  }
  const cls = classifySshExecFailure(last.status, `${last.stderr}\n${last.message}`);
  return {
    ok: false,
    stdout: last.stdout,
    errorText: last.stderr || last.message,
    failureKind: cls.kind,
    attempts,
  };
}

interface KubectlJsonResult {
  ok: boolean;
  json: string;
  error?: string;
}

/** Run `kubectl get <args> -o json` on the standby master over SSH (retried). */
async function kubectlGetJson(
  ip: string,
  sshKeyPath: string,
  args: string,
): Promise<KubectlJsonResult> {
  const remote = `${KUBECTL_ENV} kubectl get ${args} -o json`;
  const res = await sshExecWithRetry(ip, sshKeyPath, remote);
  if (res.ok) return { ok: true, json: res.stdout };
  const prefix =
    res.failureKind === 'ssh-transport' ? `[ssh-transport, ${res.attempts} attempts]` : '[kubectl]';
  return {
    ok: false,
    json: res.stdout,
    error: `${prefix} ${res.errorText || 'ssh/kubectl failed'}`,
  };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkDeploymentsZero(
  ip: string,
  sshKeyPath: string,
  label: string,
): Promise<VerificationResult> {
  const start = Date.now();
  const checkName = 'pilot_light_deployments_zero';
  const res = await kubectlGetJson(ip, sshKeyPath, `deployments -n ${NAMESPACE}`);
  if (!res.ok) {
    return {
      checkName,
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage: `Could not list deployments in ns ${NAMESPACE} on ${label} (${ip}): ${res.error ?? 'unknown error'}`,
      details: { standbyIp: ip },
    };
  }
  const deployments = parseDeploymentList(res.json);
  if (deployments === null) {
    return {
      checkName,
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage: `Could not parse deployments JSON from ${label} (${ip})`,
      details: { standbyIp: ip, raw: res.json.slice(0, 500) },
    };
  }
  const offending = findNonZeroReplicaDeployments(deployments);
  if (offending.length > 0) {
    return {
      checkName,
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage:
        `${offending.length} deployment(s) in ns ${NAMESPACE} on ${label} (${ip}) have ` +
        `non-zero replicas (expected 0 — pilot-light standby): ${offending.join(', ')}`,
      details: { standbyIp: ip, offending },
    };
  }
  return {
    checkName,
    status: 'pass',
    responseTimeMs: Date.now() - start,
    details: { standbyIp: ip, deploymentCount: deployments.length },
  };
}

async function checkDbStatefulSetReady(
  ip: string,
  sshKeyPath: string,
  label: string,
): Promise<VerificationResult> {
  const start = Date.now();
  const checkName = 'pilot_light_db_statefulset_ready';
  const res = await kubectlGetJson(ip, sshKeyPath, `statefulset ${DB_STATEFULSET} -n ${NAMESPACE}`);
  if (!res.ok) {
    return {
      checkName,
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage: `Could not read StatefulSet ${DB_STATEFULSET} in ns ${NAMESPACE} on ${label} (${ip}): ${res.error ?? 'unknown error'}`,
      details: { standbyIp: ip },
    };
  }
  const status = parseStatefulSetStatus(res.json);
  if (status === null) {
    return {
      checkName,
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage: `Could not parse StatefulSet ${DB_STATEFULSET} JSON from ${label} (${ip})`,
      details: { standbyIp: ip, raw: res.json.slice(0, 500) },
    };
  }
  // Require the exact "1/1" shape, not just readyReplicas===1 — a
  // statefulset scaled to specReplicas=3 with only 1 ready would otherwise
  // slip past as "ready" while clearly not being the single-replica
  // pilot-light streaming standby this check is asserting.
  if (status.specReplicas !== 1 || status.readyReplicas !== 1) {
    return {
      checkName,
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage:
        `StatefulSet ${DB_STATEFULSET} on ${label} (${ip}) is ${status.readyReplicas}/${status.specReplicas} ` +
        `ready (expected 1/1 — streaming replica postgres up)`,
      details: { standbyIp: ip, ...status },
    };
  }
  return {
    checkName,
    status: 'pass',
    responseTimeMs: Date.now() - start,
    details: { standbyIp: ip, ...status },
  };
}

async function checkAutoscalerZero(
  ip: string,
  sshKeyPath: string,
  label: string,
): Promise<VerificationResult> {
  const start = Date.now();
  const checkName = 'pilot_light_autoscaler_zero';
  const res = await kubectlGetJson(
    ip,
    sshKeyPath,
    `deployment ${AUTOSCALER_DEPLOYMENT} -n ${AUTOSCALER_NAMESPACE}`,
  );
  if (!res.ok) {
    return {
      checkName,
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage: `Could not read Deployment ${AUTOSCALER_DEPLOYMENT} in ns ${AUTOSCALER_NAMESPACE} on ${label} (${ip}): ${res.error ?? 'unknown error'}`,
      details: { standbyIp: ip },
    };
  }
  const replicas = parseDeploymentReplicaCount(res.json);
  if (replicas === null) {
    return {
      checkName,
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage: `Could not parse Deployment ${AUTOSCALER_DEPLOYMENT} JSON from ${label} (${ip})`,
      details: { standbyIp: ip, raw: res.json.slice(0, 500) },
    };
  }
  if (replicas !== 0) {
    return {
      checkName,
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage:
        `${AUTOSCALER_DEPLOYMENT} in ns ${AUTOSCALER_NAMESPACE} on ${label} (${ip}) has ` +
        `spec.replicas=${replicas} (expected 0 — pilot-light standby must not run an autoscaler)`,
      details: { standbyIp: ip, replicas },
    };
  }
  return {
    checkName,
    status: 'pass',
    responseTimeMs: Date.now() - start,
    details: { standbyIp: ip, replicas },
  };
}

async function checkZeroWorkerNodes(
  ip: string,
  sshKeyPath: string,
  label: string,
): Promise<VerificationResult> {
  const start = Date.now();
  const checkName = 'pilot_light_zero_worker_nodes';
  const res = await kubectlGetJson(ip, sshKeyPath, 'nodes');
  if (!res.ok) {
    return {
      checkName,
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage: `Could not list nodes on ${label} (${ip}): ${res.error ?? 'unknown error'}`,
      details: { standbyIp: ip },
    };
  }
  const workerNodes = findWorkerNodeNames(res.json);
  if (workerNodes === null) {
    return {
      checkName,
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage: `Could not parse nodes JSON from ${label} (${ip})`,
      details: { standbyIp: ip, raw: res.json.slice(0, 500) },
    };
  }
  if (workerNodes.length > 0) {
    return {
      checkName,
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage:
        `${workerNodes.length} node(s) with '${WORKER_NAME_MARKER}' in the name found on ${label} ` +
        `(${ip}) (expected 0 — pilot-light standby's worker fleet must be provisioned down to zero): ` +
        `${workerNodes.join(', ')}`,
      details: { standbyIp: ip, workerNodes },
    };
  }
  return {
    checkName,
    status: 'pass',
    responseTimeMs: Date.now() - start,
    details: { standbyIp: ip, workerNodeCount: 0 },
  };
}

export interface PilotLightOpts {
  sshKeyPath: string | null;
  /** Human label for messages, e.g. "standby" / "new-standby". Default 'standby'. */
  label?: string;
}

/**
 * Assert that the k8s-ha standby cluster at `standbyMasterIp` is in
 * pilot-light shape: app tier zeroed, db statefulset 1/1, cluster-autoscaler
 * zeroed, zero worker nodes. Self-skips (status 'skip', NOT pass) when we lack
 * an SSH handle or an IP to target — a missing precondition must not read as
 * green, same fault-tolerant contract as checks/replication.ts's
 * runReplicationChecks.
 */
export async function assertPilotLightStandby(
  standbyMasterIp: string | null | undefined,
  opts: PilotLightOpts,
): Promise<VerificationResult[]> {
  const { sshKeyPath } = opts;
  const label = opts.label ?? 'standby';
  const CHECK_NAMES = [
    'pilot_light_deployments_zero',
    'pilot_light_db_statefulset_ready',
    'pilot_light_autoscaler_zero',
    'pilot_light_zero_worker_nodes',
  ];
  if (!standbyMasterIp || !sshKeyPath) {
    return CHECK_NAMES.map((checkName) => ({
      checkName,
      status: 'skip' as const,
      details: { skipped: 'no sshKeyPath or unresolved standby master IP' },
    }));
  }

  return [
    await checkDeploymentsZero(standbyMasterIp, sshKeyPath, label),
    await checkDbStatefulSetReady(standbyMasterIp, sshKeyPath, label),
    await checkAutoscalerZero(standbyMasterIp, sshKeyPath, label),
    await checkZeroWorkerNodes(standbyMasterIp, sshKeyPath, label),
  ];
}
