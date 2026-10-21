/**
 * Primary-only add-on checks for the HA scenarios: the add-ons that write to
 * the database (n8n, metabase) stay off the standby and come up when a node is
 * promoted, with the database left alone by the promotion.
 *
 *   - standby_primary_only_absent   compose-ha at verify-deploy: the standby
 *                                    holds no container for a scaled-to-zero
 *                                    add-on service (docker ps -a).
 *   - promoted_primary_only_running compose-ha after a promotion: the promoted
 *                                    node runs every promotion service.
 *   - promoted_db_not_recreated     compose-ha after a promotion: the db
 *                                    container id read on the standby before
 *                                    the failover equals the one after.
 *   - promoted_addons_ready         k8s-ha after a promotion: every failover
 *                                    add-on Deployment on the promoted
 *                                    cluster has readyReplicas >= 1.
 *
 * Every list comes from src/lib/services/standby-policy.js, never a literal.
 * With no add-on of the relevant kind enabled a check reports `skip` (the
 * feature is off, so there is nothing to prove). With add-ons enabled but no
 * SSH handle it FAILS, never skips: HA scenarios always have a handle
 * (hollow-pass-census.test.ts). Remote commands are fixed text built from
 * the project name, never user input.
 */

import {
  composePromotionServices,
  composeStandbyScaledServices,
  declaredAddonNames,
  enabledAddonNames,
  k8sFailoverAddonWorkloads,
} from '../../../src/lib/services/standby-policy.js';
import type { DeployMode, VerificationResult } from '../scenarios/types.js';
import {
  defaultRun,
  fail,
  type IncarnationRead,
  missingHandle,
  type RemoteRun,
} from './ha-integrity.js';

const KUBECTL = 'KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n vibecarbon';
const PROBE_DONE = 'PROBE_DONE';

interface SshArgs {
  mode: DeployMode;
  projectName: string;
  sshKeyPath: string | null;
  /** The enabled feature names (config.features). */
  features: readonly string[];
  run?: RemoteRun;
}

/** The enabled add-ons among a feature list, as the policy module names them. */
export function enabledAddons(features: readonly string[]): string[] {
  return enabledAddonNames(Object.fromEntries(features.map((f) => [f, true])));
}

/**
 * The feature set an HA scenario runs: the base set plus every declared
 * add-on, so the standby policy is exercised. Non-HA modes and an explicit
 * `--features=` override are returned unchanged (no extra deploy time).
 */
export function haScenarioFeatures(
  mode: string,
  base: readonly string[],
  overridden: boolean,
): readonly string[] {
  if (overridden || !mode.endsWith('-ha')) return base;
  return [...new Set([...base, ...declaredAddonNames()])];
}

const skip = (checkName: string, why: string): VerificationResult => ({
  checkName,
  status: 'skip',
  details: { skipped: why },
});

const NO_PRIMARY_ONLY = 'no primary-only add-on enabled';

/** Container names from `docker ps` output; null when the sentinel is missing. */
export function parseContainerNames(output: string | null | undefined): string[] | null {
  const lines = String(output ?? '')
    .split('\n')
    .map((l) => l.trim());
  if (!lines.includes(PROBE_DONE)) return null;
  return lines.filter((l) => l && l !== PROBE_DONE);
}

export function buildContainerListCommand(all: boolean): string {
  return `docker ps ${all ? '-a ' : ''}--format '{{.Names}}' && echo ${PROBE_DONE}`;
}

async function readContainerNames(
  opts: SshArgs & { ip: string | null },
  role: string,
  all: boolean,
): Promise<{ ok: true; names: string[] } | { ok: false; message: string }> {
  const { mode, projectName, ip, sshKeyPath } = opts;
  const missing = missingHandle(ip, sshKeyPath, role);
  if (missing) return { ok: false, message: `cannot reach the ${role}: ${missing}` };
  const run = opts.run ?? defaultRun(mode, projectName, sshKeyPath as string, role);
  const res = await run(ip as string, buildContainerListCommand(all));
  if (!res.ok) return { ok: false, message: `could not list containers on ${ip}: ${res.error}` };
  const names = parseContainerNames(res.output);
  if (!names) {
    return {
      ok: false,
      message: `unreadable container list from ${ip}: ${res.output.slice(0, 200)}`,
    };
  }
  return { ok: true, names };
}

/** standby_primary_only_absent: the standby runs no scaled-to-zero add-on container. */
export async function checkStandbyPrimaryOnlyAbsent(
  opts: SshArgs & { standbyIp: string | null },
): Promise<VerificationResult> {
  const checkName = 'standby_primary_only_absent';
  const services = composeStandbyScaledServices(enabledAddons(opts.features));
  if (services.length === 0) return skip(checkName, NO_PRIMARY_ONLY);
  const read = await readContainerNames({ ...opts, ip: opts.standbyIp }, 'standby', true);
  if ('message' in read) return fail(checkName, read.message);
  const present = services
    .map((s) => `${opts.projectName}-${s}`)
    .filter((name) => read.names.includes(name));
  if (present.length > 0) {
    return fail(
      checkName,
      `the standby ${opts.standbyIp} still has primary-only add-on container(s): ${present.join(', ')}`,
      { standbyIp: opts.standbyIp, present },
    );
  }
  return { checkName, status: 'pass', details: { standbyIp: opts.standbyIp, services } };
}

/** promoted_primary_only_running: the promoted node runs every promotion service. */
export async function checkPromotedPrimaryOnlyRunning(
  opts: SshArgs & { primaryIp: string | null },
): Promise<VerificationResult> {
  const checkName = 'promoted_primary_only_running';
  const services = composePromotionServices(enabledAddons(opts.features));
  if (services.length === 0) return skip(checkName, NO_PRIMARY_ONLY);
  const read = await readContainerNames({ ...opts, ip: opts.primaryIp }, 'promoted primary', false);
  if ('message' in read) return fail(checkName, read.message);
  const missing = services
    .map((s) => `${opts.projectName}-${s}`)
    .filter((name) => !read.names.includes(name));
  if (missing.length > 0) {
    return fail(
      checkName,
      `the promoted primary ${opts.primaryIp} is not running add-on container(s): ${missing.join(', ')}`,
      { primaryIp: opts.primaryIp, missing },
    );
  }
  return { checkName, status: 'pass', details: { primaryIp: opts.primaryIp, services } };
}

/** promoted_db_not_recreated: promotion kept the standby's db container (same id). */
export function checkPromotedDbNotRecreated(opts: {
  features: readonly string[];
  ip: string | null;
  /** The standby's db read before the failover. */
  before: IncarnationRead;
  /** The same node's db read after the failover. */
  after: IncarnationRead;
}): VerificationResult {
  const checkName = 'promoted_db_not_recreated';
  if (composePromotionServices(enabledAddons(opts.features)).length === 0) {
    return skip(checkName, NO_PRIMARY_ONLY);
  }
  const { ip, before, after } = opts;
  if ('error' in before) {
    return fail(checkName, `could not read the db container before the failover: ${before.error}`);
  }
  if ('error' in after) {
    return fail(checkName, `could not read the db container after the failover: ${after.error}`);
  }
  const details = { ip, before: before.incarnation, after: after.incarnation };
  if (before.incarnation.id !== after.incarnation.id) {
    return fail(
      checkName,
      `promotion recreated the db container on ${ip} (${before.incarnation.id} -> ${after.incarnation.id})`,
      details,
    );
  }
  return { checkName, status: 'pass', details };
}

/** Deployment names with readyReplicas >= 1 from `kubectl get deployments -o json`; null if unparseable. */
export function parseReadyDeployments(json: string | null | undefined): Set<string> | null {
  try {
    const parsed = JSON.parse(String(json ?? '')) as {
      items?: Array<{ metadata?: { name?: string }; status?: { readyReplicas?: number } }>;
    };
    if (!Array.isArray(parsed.items)) return null;
    return new Set(
      parsed.items
        .filter((i) => (i.status?.readyReplicas ?? 0) >= 1)
        .map((i) => i.metadata?.name ?? ''),
    );
  } catch {
    return null;
  }
}

/** promoted_addons_ready: every failover add-on Deployment is ready on the promoted cluster. */
export async function checkPromotedAddonsReady(
  opts: SshArgs & { primaryIp: string | null },
): Promise<VerificationResult> {
  const checkName = 'promoted_addons_ready';
  const workloads = k8sFailoverAddonWorkloads(enabledAddons(opts.features));
  if (workloads.length === 0) return skip(checkName, 'no add-on enabled');
  const { mode, projectName, primaryIp, sshKeyPath } = opts;
  const missing = missingHandle(primaryIp, sshKeyPath, 'promoted primary');
  if (missing) return fail(checkName, `cannot reach the promoted primary: ${missing}`);
  const run = opts.run ?? defaultRun(mode, projectName, sshKeyPath as string, 'promoted');
  const res = await run(primaryIp as string, `${KUBECTL} get deployments -o json`);
  if (!res.ok) return fail(checkName, `could not list deployments on ${primaryIp}: ${res.error}`);
  const ready = parseReadyDeployments(res.output);
  if (!ready) {
    return fail(
      checkName,
      `unreadable deployment list from ${primaryIp}: ${res.output.slice(0, 200)}`,
    );
  }
  const notReady = workloads.map((w) => w.name).filter((n) => !ready.has(n));
  if (notReady.length > 0) {
    return fail(
      checkName,
      `add-on Deployment(s) not ready on the promoted cluster ${primaryIp}: ${notReady.join(', ')}`,
      { primaryIp, notReady },
    );
  }
  return {
    checkName,
    status: 'pass',
    details: { primaryIp, deployments: workloads.map((w) => w.name) },
  };
}
