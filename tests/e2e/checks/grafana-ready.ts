/**
 * grafana_ready: wait for the Grafana Deployment to be Ready on a cluster,
 * for as long as Grafana's own manifest gives its first boot.
 *
 * Grafana comes up after the deploy returns, and a FIRST boot (an empty data
 * volume) runs its database migrations before /api/health answers. Until the
 * pod is Ready its Service has no endpoints, Traefik drops the Grafana route
 * ("no servers found for vibecarbon-observability/grafana"), and
 * `/admin/grafana` falls through to the app's page. Probing from outside
 * during that window says nothing about the route.
 *
 * The wait is bounded by the allowance the product itself declares, read from
 * services/observability/k8s/grafana-deployment.yaml: the startup probe's
 * budget plus one readiness period. Past that the kubelet restarts the pod, so
 * a Grafana that is not Ready by then is a real failure, never a slow one.
 * GitHub run 43694492910 (digitalocean/k8s-ha reconverge-deploy) is why this
 * exists: the outside checks gave Grafana 60 s, the manifest gives it 300 s.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAll } from 'js-yaml';
import type { VerificationResult } from '../scenarios/types.js';
import { sshExecOnce } from '../utils/ssh.js';

export const GRAFANA_NAMESPACE = 'vibecarbon-observability';

const MANIFEST = fileURLToPath(
  new URL('../../../services/observability/k8s/grafana-deployment.yaml', import.meta.url),
);
const KUBECTL_ENV = 'KUBECONFIG=/etc/rancher/k3s/k3s.yaml';

/** What the SSH call adds on top of kubectl's own timeout (connect, setup). */
const SSH_SLACK_MS = 60_000;

interface Probe {
  periodSeconds?: number;
  failureThreshold?: number;
}

/**
 * Seconds Grafana's manifest allows its first boot before it must be Ready:
 * startupProbe.periodSeconds x failureThreshold, plus one readiness period
 * (the first readiness check after the startup probe passes).
 */
export function grafanaStartupAllowanceSeconds(
  manifestText: string = readFileSync(MANIFEST, 'utf-8'),
): number {
  // biome-ignore lint/suspicious/noExplicitAny: parsed YAML
  for (const doc of loadAll(manifestText) as any[]) {
    if (doc?.kind !== 'Deployment' || doc.metadata?.name !== 'grafana') continue;
    const container = (doc.spec?.template?.spec?.containers ?? []).find(
      (c: { name?: string }) => c.name === 'grafana',
    );
    const startup: Probe | undefined = container?.startupProbe;
    const readiness: Probe | undefined = container?.readinessProbe;
    if (!startup?.periodSeconds || !startup.failureThreshold || !readiness?.periodSeconds) {
      throw new Error(
        'grafana-deployment.yaml: the grafana container needs a startupProbe (periodSeconds, ' +
          'failureThreshold) and a readinessProbe (periodSeconds) to bound the Ready wait',
      );
    }
    return startup.periodSeconds * startup.failureThreshold + readiness.periodSeconds;
  }
  throw new Error('grafana-deployment.yaml: no Deployment named grafana');
}

export interface SshRun {
  ok: boolean;
  output: string;
}

/**
 * One SSH command on the master (a fixed kubectl command; the only
 * interpolated value is a number). Never throws. A failure reports what the
 * command printed, stdout then stderr, or the error's own message.
 */
function sshRun(ip: string, sshKeyPath: string, remote: string, timeoutMs: number): SshRun {
  const res = sshExecOnce(ip, sshKeyPath, remote, timeoutMs);
  if (res.ok) return { ok: true, output: res.stdout };
  return { ok: false, output: [res.stdout, res.stderr].filter(Boolean).join('\n') || res.message };
}

/**
 * Wait for `deployment/grafana` to roll out on the cluster whose master is
 * `masterIp`. Passes once Ready; fails (with the pods' state) when Grafana is
 * not Ready within its own startup allowance.
 */
export async function waitForGrafanaReady(
  masterIp: string | null,
  sshKeyPath: string | null,
  deps: {
    exec?: (ip: string, key: string, remote: string, timeoutMs: number) => SshRun;
    allowanceSeconds?: number;
  } = {},
): Promise<VerificationResult> {
  const checkName = 'grafana_ready';
  const start = performance.now();
  const exec = deps.exec ?? sshRun;
  const allowance = deps.allowanceSeconds ?? grafanaStartupAllowanceSeconds();
  if (!masterIp || !sshKeyPath) {
    return {
      checkName,
      status: 'fail',
      errorMessage: `no primary master ${masterIp ? 'SSH key' : 'IP'} on record: cannot wait for Grafana to be Ready`,
    };
  }
  const rollout = exec(
    masterIp,
    sshKeyPath,
    `${KUBECTL_ENV} kubectl -n ${GRAFANA_NAMESPACE} rollout status deployment/grafana --timeout=${allowance}s`,
    allowance * 1000 + SSH_SLACK_MS,
  );
  const responseTimeMs = Math.round(performance.now() - start);
  if (rollout.ok) {
    return { checkName, status: 'pass', responseTimeMs, details: { allowanceSeconds: allowance } };
  }
  const pods = exec(
    masterIp,
    sshKeyPath,
    `${KUBECTL_ENV} kubectl -n ${GRAFANA_NAMESPACE} get pods -o wide`,
    30_000,
  );
  return {
    checkName,
    status: 'fail',
    responseTimeMs,
    errorMessage:
      `Grafana was not Ready within its own startup allowance (${allowance} s): ` +
      rollout.output.slice(-400),
    details: { allowanceSeconds: allowance, pods: pods.output.slice(0, 2000) },
  };
}
