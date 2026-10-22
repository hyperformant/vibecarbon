/**
 * k8s-ha replication helpers (Fullerene).
 * Licensed under FSL-1.1-MIT.
 *
 * The k8s-ha deploy/destroy/failover flows now live in the step-plan
 * (plan/deploy-plan.js, plan/destroy-plan.js) + effects registry
 * (effects/k8s-ha.js). This module owns what those effects call into for the
 * cross-cluster WireGuard replication transport:
 * - buildReplGatewaySocatArgs / renderReplGatewayManifest — the repl-gateway
 *   DaemonSet that relays the WG tunnel to each node's postgres port
 * - buildDbHostPortPatch — hostPort patch so the standby's basebackup/streaming
 *   probe can reach the primary's postgres pod directly
 * - setupReplication — orchestrates the above into a working primary/standby
 *   streaming pair
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// Keep the import narrow — we only need join() to resolve .env.local relative to cwd.
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { runCommandAsync } from '../../../command.js';
import {
  buildHostKeyOptsForPath,
  knownHostsPathForKey,
  seedKnownHosts,
} from '../../../host-keys.js';
import { perfAsync } from '../../../perf.js';
import { scpWithRetry, sshRun } from '../../../ssh.js';
import { DB_CONTAINER, DB_POD, DB_STATEFULSET } from '../../db-workload.js';
import {
  buildPrimaryConninfo,
  buildReplicationHbaLines,
  buildStagedBasebackupScript,
  DB_STS_BOOT_TIMEOUT_S,
  parsePgdataClaimFromPodJson,
  probeStreaming,
  REPL_PORT,
  SYSTEM_IDENTIFIER_SQL,
  swapPgdataViaHelperPod,
  verifyStreaming,
} from '../../replication.js';
import { readReplPassword } from '../../utils.js';
import {
  exchangeAndBringUpTunnel,
  REGISTRY_RELAY_PORT,
  REPL_GATEWAY_PORT,
  WG_PRIMARY_IP,
  WG_STANDBY_IP,
  WG_SUBNET_CIDR,
} from '../../wireguard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to HA scripts in the template
const HA_SCRIPTS_PATH = join(__dirname, '../../../../../carbon/ha');

// The k3s cluster pod CIDR (default `--cluster-cidr`). Our k3s install
// (k8s/k3s.js) does NOT pass --cluster-cidr, so every cluster runs the k3s
// default — which is what makes ONE pg_hba line valid on both clusters across
// a failover. If we ever pin cluster-cidr in the k3s install args, thread the
// pinned value through to here. Used because the relayed replication
// connection is NAT'd into the pod network: the primary's postgres sees the
// node's cni0 gateway (a per-node /24 inside this CIDR) as the source.
const K3S_POD_CIDR = '10.42.0.0/16';

// The repl-gateway manifest (Deployment + additive egress NetworkPolicy). HA-only, so
// it lives outside the base kustomization; setupReplication renders its
// placeholders per-cluster and applies it via `kubectl apply -f -`.
const REPL_GATEWAY_MANIFEST = join(
  __dirname,
  '../../../../../carbon/k8s/base/repl-gateway/repl-gateway.yaml',
);
const REGISTRY_RELAY_MANIFEST = join(
  __dirname,
  '../../../../../carbon/k8s/base/repl-gateway/registry-relay.yaml',
);

/**
 * The two socat address specs for the repl-gateway relay, keyed by cluster
 * role. Pure — unit-tested; rendered into the repl-gateway manifest.
 *
 *   - primary: bind the tunnel IP (10.99.0.1:15433) and forward to the local
 *     postgres hostPort (127.0.0.1:5433). Reachable only via wg0.
 *   - standby: bind the node's private IP (<priv>:15433) and forward INTO the
 *     tunnel to the primary gateway (10.99.0.1:15433). This is the address the
 *     standby db pod dials.
 *
 * @param {'primary'|'standby'} role
 * @param {string} nodePrivateIp - this cluster's database node private IP
 * @returns {{relayListen: string, relayTarget: string}}
 */
export function buildReplGatewaySocatArgs(role, nodePrivateIp) {
  if (role === 'primary') {
    return {
      relayListen: `TCP-LISTEN:${REPL_GATEWAY_PORT},bind=${WG_PRIMARY_IP},fork,reuseaddr`,
      relayTarget: `TCP:127.0.0.1:${REPL_PORT}`,
    };
  }
  if (role === 'standby') {
    return {
      relayListen: `TCP-LISTEN:${REPL_GATEWAY_PORT},bind=${nodePrivateIp},fork,reuseaddr`,
      relayTarget: `TCP:${WG_PRIMARY_IP}:${REPL_GATEWAY_PORT}`,
    };
  }
  throw new Error(`buildReplGatewaySocatArgs: unknown role '${role}'`);
}

/**
 * Render the repl-gateway manifest for one cluster: substitute the socat relay
 * direction + the local node private IP (egress NetworkPolicy scope). The
 * result is applied via `kubectl apply -f -` — placeholders are resolved at
 * apply time, never left for runtime.
 *
 * @param {object} o
 * @param {string} o.template - the raw repl-gateway.yaml
 * @param {'primary'|'standby'} o.role
 * @param {string} o.nodePrivateIp - this cluster's database node private IP
 * @returns {string}
 */
export function renderReplGatewayManifest({ template, role, nodePrivateIp }) {
  const { relayListen, relayTarget } = buildReplGatewaySocatArgs(role, nodePrivateIp);
  return template
    .replaceAll('__RELAY_LISTEN__', relayListen)
    .replaceAll('__RELAY_TARGET__', relayTarget)
    .replaceAll('__DB_PRIVATE_IP__', nodePrivateIp);
}

/**
 * Where the standby's image copy reads the primary's registry: the primary's
 * wg0 address and the relay port. k8s-ha addresses wg0 by ROLE
 * (exchangeAndBringUpTunnel is always called with the role primary's db node
 * first), so the role primary is always WG_PRIMARY_IP.
 */
export const REGISTRY_RELAY_SOURCE_HOST = `${WG_PRIMARY_IP}:${REGISTRY_RELAY_PORT}`;

/**
 * Render the registry-relay Pod: listen only on the primary's wg0 address,
 * admit only the standby's tunnel IP, forward to the primary master's registry.
 *
 * @param {object} o
 * @param {string} o.template - the raw registry-relay.yaml
 * @param {string} o.primaryMasterPrivateIp - the primary master's private IP (registry hostPort bind)
 * @returns {string}
 */
export function renderRegistryRelayManifest({ template, primaryMasterPrivateIp }) {
  if (!primaryMasterPrivateIp) {
    throw new Error('renderRegistryRelayManifest: primaryMasterPrivateIp is required');
  }
  return template
    .replaceAll(
      '__RELAY_LISTEN__',
      `TCP-LISTEN:${REGISTRY_RELAY_PORT},bind=${WG_PRIMARY_IP},fork,reuseaddr,range=${WG_STANDBY_IP}/32`,
    )
    .replaceAll('__RELAY_TARGET__', `TCP:${primaryMasterPrivateIp}:5000`);
}

/** The first line of a failed command's stderr (or message): one-line causes only. */
function firstErrorLine(err) {
  return String(err?.stderr || err?.message || err)
    .split('\n')[0]
    .trim();
}

/**
 * Why a relay never got Ready: its pod phase and last few log lines, so a
 * crashed socat says why instead of only "timed out". One bounded call each;
 * a failed lookup contributes nothing.
 */
async function relayDiagnostics(exec, primaryIp) {
  const ask = async (script) => {
    try {
      return String((await exec(primaryIp, script)) ?? '').trim();
    } catch {
      return '';
    }
  };
  const phase = await ask(
    'kubectl get pod registry-relay -n vibecarbon -o jsonpath={.status.phase}',
  );
  const logs = await ask('kubectl logs registry-relay -n vibecarbon --tail=5');
  const parts = [];
  if (phase) parts.push(`pod phase: ${phase}`);
  if (logs) parts.push(`relay log:\n${logs}`);
  return parts.length ? `\n${parts.join('\n')}` : '';
}

const RELAY_DELETE = 'kubectl delete pod registry-relay -n vibecarbon --ignore-not-found';

/**
 * Run `fn` while a registry-relay Pod is up on the primary. wg0 must already
 * be up. The relay is owned by the copy: a leftover from a dead process (or a
 * role swap) is deleted first, the new one is applied and waited Ready, and it
 * is deleted when `fn` settles. A failed cleanup is logged, never masks `fn`:
 * the next copy deletes a stray relay in step 1/2 anyway.
 *
 * @param {object} o
 * @param {string} o.primaryIp - primary master public IP (ssh)
 * @param {string} o.standbyIp - standby master public IP (ssh)
 * @param {string} o.primaryMasterPrivateIp
 * @param {string} o.sshKeyPath
 * @param {(ip: string, script: string, input?: string) => Promise<unknown>} [o.run]
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function withRegistryRelay(
  { primaryIp, standbyIp, primaryMasterPrivateIp, sshKeyPath, run },
  fn,
) {
  const exec =
    run ??
    ((ip, script, input) =>
      sshRun(ip, sshKeyPath, ['sh', '-c', script], { input, timeout: 120_000 }));
  const manifest = renderRegistryRelayManifest({
    template: readFileSync(REGISTRY_RELAY_MANIFEST, 'utf-8'),
    primaryMasterPrivateIp,
  });
  await exec(standbyIp, RELAY_DELETE);
  try {
    await exec(primaryIp, `${RELAY_DELETE} && kubectl apply -f -`, manifest);
    try {
      await exec(
        primaryIp,
        'kubectl wait --for=condition=Ready pod/registry-relay -n vibecarbon --timeout=60s',
      );
    } catch (err) {
      const why = await relayDiagnostics(exec, primaryIp);
      throw new Error(`registry relay not ready on the primary: ${firstErrorLine(err)}${why}`);
    }
    return await fn();
  } finally {
    try {
      await exec(primaryIp, `${RELAY_DELETE} --wait=false`);
    } catch (err) {
      p.log.warn(
        `[image-copy] could not delete registry-relay on the primary: ${firstErrorLine(err)}`,
      );
    }
  }
}

/**
 * Strategic-merge patch that binds the primary's postgres to
 * `127.0.0.1:REPL_PORT` (hostPort + hostIP) → containerPort 5432 on the node.
 * The primary repl-gateway (hostNetwork socat) relays tunnel traffic to
 * `127.0.0.1:REPL_PORT`; this hostPort IS that local listener, and its only
 * consumer. `hostIP: '127.0.0.1'` is what makes "localhost-only" true: a
 * hostPort with no hostIP is published on EVERY node address (public and
 * private), leaving the cloud firewall (which admits only WG udp/51821) as the
 * sole barrier. Without this hostPort the db is reachable only inside the
 * cluster and the gateway's local relay target would have nothing to connect
 * to. One db pod per node (StatefulSet), so the node's :REPL_PORT is
 * uncontended. Enforced by tests/unit/deploy/hostport-binding-census.test.ts.
 *
 * Patched in here rather than written into k8s/base/db/statefulset.yaml: only
 * an HA cluster needs the node port, and a single cluster's db stays
 * cluster-internal. A strategic-merge patch keyed by container `name` + port
 * `containerPort` updates the existing port entry in place (adds hostPort + hostIP)
 * rather than appending a duplicate, and a later `kubectl apply` of k8s/base
 * leaves it alone (the three-way merge only removes fields the previous apply
 * set).
 * @returns {object}
 */
export function buildDbHostPortPatch() {
  return {
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: DB_CONTAINER,
              ports: [{ containerPort: 5432, hostPort: REPL_PORT, hostIP: '127.0.0.1' }],
            },
          ],
        },
      },
    },
  };
}

/**
 * The repl-gateway apply, manifest on stdin. It first removes the bare
 * `repl-gateway` Pod a cluster deployed before the Deployment shipped: that
 * hostNetwork socat holds the gateway port, so the Deployment's pod would
 * crash-loop beside it, and nothing else ever deletes a bare Pod. Deployment
 * pods carry hashed names, so this only ever matches the legacy Pod, and
 * `--ignore-not-found` makes it a no-op everywhere else. The delete waits for
 * the pod to go, which frees the port before the apply.
 */
export const REPL_GATEWAY_APPLY_SHELL =
  'kubectl delete pod repl-gateway -n vibecarbon --ignore-not-found >/dev/null && kubectl apply -f -';

/**
 * Apply the repl-gateway manifest to both clusters and bring up the WireGuard
 * tunnel between the two database nodes. Shared by setupReplication (the
 * serial path) and prepareReplicationTransport (the deploy fan-out overlap) so
 * the two paths cannot drift. Idempotent: kubectl apply reconciles the gateway
 * Deployment/netpol, and exchangeAndBringUpTunnel regenerates + re-exchanges keys on
 * every call.
 */
async function applyGatewaysAndBringUpTunnel({
  primaryIp,
  standbyIp,
  primaryDbIp,
  standbyDbIp,
  primaryDbPrivateIp,
  standbyDbPrivateIp,
  sshOpts,
  sshKeyPath,
}) {
  const gatewayTemplate = readFileSync(REPL_GATEWAY_MANIFEST, 'utf-8');
  // repl-gateway is a one-replica Deployment, so a plain apply takes a changed
  // relay direction (a role-swapped redeploy after a failover renders each
  // cluster's gateway the opposite way): the controller replaces the pod, with
  // `Recreate` so the old relay frees the port before the new one binds it.
  const applyGateway = (masterIp, rendered) =>
    runCommandAsync(['ssh', ...sshOpts, `root@${masterIp}`, REPL_GATEWAY_APPLY_SHELL], {
      silent: true,
      input: rendered,
    });
  await applyGateway(
    primaryIp,
    renderReplGatewayManifest({
      template: gatewayTemplate,
      role: 'primary',
      nodePrivateIp: primaryDbPrivateIp,
    }),
  );
  await applyGateway(
    standbyIp,
    renderReplGatewayManifest({
      template: gatewayTemplate,
      role: 'standby',
      nodePrivateIp: standbyDbPrivateIp,
    }),
  );

  // Generate a keypair on each database node, cross-distribute PUBLIC keys, and
  // bring up wg0. Private keys are generated on-node and never leave it (see
  // exchangeAndBringUpTunnel). The WG endpoints/SSH targets are the database
  // nodes' PUBLIC IPs.
  await exchangeAndBringUpTunnel({
    primaryIp: primaryDbIp,
    standbyIp: standbyDbIp,
    sshKeyPath,
  });
}

/**
 * Deploy-fan-out transport prep: bring up the replication transport (gateway
 * pods + WireGuard tunnel) while the two clusters are still installing
 * manifests/helm — this work only needs the database NODES and each cluster's
 * k3s apiserver, both available minutes before the cluster deploys finish.
 * The one k8s-level prerequisite is the vibecarbon namespace, which each
 * cluster's applyVibecarbonSecrets creates. The caller starts prep only once
 * both clusters have signalled it (onNamespaceReady, effects/k8s-ha.js); prep
 * never polls for it and never creates it.
 *
 * Opportunistic by contract: the caller treats any throw as "not prepared"
 * and setupReplication then brings the transport up on the serial path
 * exactly as before this optimization existed.
 */
export async function prepareReplicationTransport({
  primaryIp,
  standbyIp,
  primaryDbIp,
  standbyDbIp,
  primaryDbPrivateIp,
  standbyDbPrivateIp,
  sshKeyPath,
}) {
  if (!primaryIp || !standbyIp || !sshKeyPath) {
    throw new Error('prepareReplicationTransport requires primaryIp, standbyIp, and sshKeyPath');
  }
  // The database nodes' PRIVATE IPs are real IaC outputs on every provider
  // (Hetzner pins 10.0.1.2 statically; DO exports the Pulumi-assigned VPC
  // address). A missing value means the infra step result is incomplete —
  // never assume a Hetzner-shaped address here: socat would bind a
  // nonexistent IP and the egress NetworkPolicy would scope to a /32 that
  // exists on no node.
  if (!primaryDbPrivateIp) {
    throw new Error(
      'prepareReplicationTransport: primaryDbPrivateIp is required — the IaC program ' +
        'outputs it; a missing value means the infra step result is incomplete',
    );
  }
  if (!standbyDbPrivateIp) {
    throw new Error(
      'prepareReplicationTransport: standbyDbPrivateIp is required — the IaC program ' +
        'outputs it; a missing value means the infra step result is incomplete',
    );
  }
  return perfAsync('deploy.ha.replication.transportEarly', async () => {
    const khPath = knownHostsPathForKey(sshKeyPath);
    await seedKnownHosts(khPath, primaryIp);
    await seedKnownHosts(khPath, standbyIp);
    const sshOpts = ['-i', sshKeyPath, ...buildHostKeyOptsForPath(khPath)];
    await applyGatewaysAndBringUpTunnel({
      primaryIp,
      standbyIp,
      primaryDbIp: primaryDbIp || primaryIp,
      standbyDbIp: standbyDbIp || standbyIp,
      primaryDbPrivateIp,
      standbyDbPrivateIp,
      sshOpts,
      sshKeyPath,
    });
  });
}

/**
 * Belt for the k8s-ha scale flow (item I-1): re-establish the replication
 * TRANSPORT after a node resize rebooted the database node(s). It does NOT
 * re-seed — streaming replication resumes on its own once the tunnel + gateway
 * are back; this only restores the plumbing that the reboot dropped.
 *
 * With the systemd persistence unit in place (exchangeAndBringUpTunnel writes
 * it), wg0 is already recreated at boot — but this belt makes recovery prompt
 * and self-healing regardless:
 *   1. Re-run exchangeAndBringUpTunnel (idempotent): recreates wg0 on both
 *      database nodes AND (re)installs the systemd unit, so an env deployed
 *      before this fix gets persistence retrofitted during scale.
 *   2. Per cluster: re-apply the gateway manifest, then restart the
 *      `repl-gateway` Deployment. Its pod crash-looped while wg0 was gone (it
 *      could not bind its tunnel IP); a fresh pod binds cleanly now wg0
 *      exists, skipping the up-to-5-min CrashLoopBackOff that otherwise wedges
 *      the primary's post-resize `kubectl wait --for=Ready pods --all -n vibecarbon`.
 *
 * All args mirror setupReplication's. Same known-hosts pinning + sshOpts.
 *
 * @param {object} options
 * @param {string} options.primaryIp - primary master node IP (SSH/kubectl target)
 * @param {string} options.standbyIp - standby master node IP (SSH/kubectl target)
 * @param {string} options.sshKeyPath - shared HA SSH key
 * @param {string} [options.primaryDbIp] - primary database node PUBLIC IP (WG endpoint + SSH)
 * @param {string} [options.standbyDbIp] - standby database node PUBLIC IP (WG endpoint + SSH)
 * @param {string} [options.primaryDbPrivateIp] - primary database node private IP (gateway bind + netpol)
 * @param {string} [options.standbyDbPrivateIp] - standby database node private IP (gateway bind + netpol)
 */
export async function reestablishReplicationTransport(options) {
  const { primaryIp, standbyIp, sshKeyPath } = options;
  if (!primaryIp || !standbyIp || !sshKeyPath) {
    throw new Error(
      'reestablishReplicationTransport requires primaryIp, standbyIp, and sshKeyPath',
    );
  }
  const primaryDbIp = options.primaryDbIp || primaryIp;
  const standbyDbIp = options.standbyDbIp || standbyIp;
  // Required, never defaulted — see prepareReplicationTransport's guard for why.
  const { primaryDbPrivateIp, standbyDbPrivateIp } = options;
  if (!primaryDbPrivateIp || !standbyDbPrivateIp) {
    throw new Error(
      'reestablishReplicationTransport: primaryDbPrivateIp and standbyDbPrivateIp ' +
        'are required — the IaC program outputs them; redeploy to persist them if absent',
    );
  }

  const khPath = knownHostsPathForKey(sshKeyPath);
  await seedKnownHosts(khPath, primaryIp);
  await seedKnownHosts(khPath, standbyIp);
  const sshOpts = ['-i', sshKeyPath, ...buildHostKeyOptsForPath(khPath)];

  // 1. Recreate wg0 on both database nodes (+ retrofit the systemd unit).
  await exchangeAndBringUpTunnel({
    primaryIp: primaryDbIp,
    standbyIp: standbyDbIp,
    sshKeyPath,
  });

  // 2. Re-apply + restart the repl-gateway on each cluster.
  const gatewayTemplate = readFileSync(REPL_GATEWAY_MANIFEST, 'utf-8');
  for (const [masterIp, role, nodePrivateIp] of [
    [primaryIp, 'primary', primaryDbPrivateIp],
    [standbyIp, 'standby', standbyDbPrivateIp],
  ]) {
    await runCommandAsync(['ssh', ...sshOpts, `root@${masterIp}`, REPL_GATEWAY_APPLY_SHELL], {
      silent: true,
      input: renderReplGatewayManifest({ template: gatewayTemplate, role, nodePrivateIp }),
    });
    await runCommandAsync(
      [
        'ssh',
        ...sshOpts,
        `root@${masterIp}`,
        'kubectl rollout restart deployment/repl-gateway -n vibecarbon',
      ],
      { silent: true },
    );
  }
}

/**
 * Primary-side replication configuration — everything the primary needs
 * BEFORE a standby can basebackup from it: replication role/slot SQL,
 * the hostPort relay target, and durable pg_hba admission with a reload. The
 * db is never restarted: the replication settings are on its argv.
 * Extracted from setupReplication (phases + perf slices verbatim) so the HA
 * fan-out can run it opportunistically the moment the primary cluster
 * completes (mirrors prepareReplicationTransport) — the standby's seed init
 * needs the primary replication-ready ~T+370s at worst, well inside its
 * 6-minute budget. setupReplication remains the serial fallback owner.
 */
export async function configurePrimaryForReplication({ primaryIp, sshKeyPath }) {
  const replPassword = readReplPassword();
  if (!replPassword) {
    throw new Error(
      'REPL_PASSWORD is not set in process.env or .env.local, HA deploys require a replication password generated at create time.',
    );
  }
  const khPath = knownHostsPathForKey(sshKeyPath);
  await seedKnownHosts(khPath, primaryIp);
  const sshOpts = ['-i', sshKeyPath, ...buildHostKeyOptsForPath(khPath)];

  // 1. Apply primary-init.sql on primary.
  // Render the SQL template locally (substituting REPL_PASSWORD), SCP the rendered
  // copy, then delete the temp file. Approach A from spec.
  const primaryInitSql = join(HA_SCRIPTS_PATH, 'primary-init.sql');
  if (!existsSync(primaryInitSql)) {
    throw new Error(`Missing HA script: ${primaryInitSql}`);
  }

  // All SSH commands use runCommandAsync in argv form — ssh/scp receive
  // separate tokens and the final remote-command string is the only place
  // a shell parses anything. No local template-literal interpolation.

  // Render primary-init.sql with the real REPL_PASSWORD, SCP to remote, then
  // clean up. The SQL template ships the `{{REPL_PASSWORD}}` placeholder (a
  // token, not a credential); substitute the per-deploy random password. These
  // two MUST stay in sync — if the template's placeholder is renamed, k8s-HA
  // would SCP an unrendered SQL file and replication auth would break.
  // Perf slices: this function was the largest un-instrumented block of the
  // k8s-ha deploy (~185s opaque tail in run 29354358889 — silent:true
  // throughout, so the log showed nothing between the app rollout and the
  // final reseed grep-line). Each phase below gets a deploy.ha.replication.*
  // marker so perf_substep can attribute the tail. Wrappers only — the
  // operations, their order, and their throw semantics are unchanged.
  await perfAsync('deploy.ha.replication.primaryInit', async () => {
    const sqlTemplate = readFileSync(primaryInitSql, 'utf-8');
    const renderedSql = sqlTemplate.replaceAll('{{REPL_PASSWORD}}', replPassword);
    const tmpDir = mkdtempSync(join(tmpdir(), 'vibecarbon-repl-'));
    const renderedSqlPath = join(tmpDir, 'primary-init.sql');
    try {
      writeFileSync(renderedSqlPath, renderedSql, { mode: 0o600 });
      await scpWithRetry([...sshOpts, renderedSqlPath, `root@${primaryIp}:/tmp/primary-init.sql`]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    try {
      await runCommandAsync(
        [
          'ssh',
          ...sshOpts,
          `root@${primaryIp}`,
          `cat /tmp/primary-init.sql | kubectl exec -i -n vibecarbon ${DB_POD} -c ${DB_CONTAINER} -- psql -U postgres`,
        ],
        { silent: true },
      );
    } finally {
      // Always remove the rendered SQL — it contains the replication password.
      await runCommandAsync(
        ['ssh', ...sshOpts, `root@${primaryIp}`, 'rm -f /tmp/primary-init.sql'],
        {
          silent: true,
          ignoreError: true,
        },
      );
    }
  });

  // 1b. Bind the primary's postgres to a node hostPort on loopback
  // (127.0.0.1:REPL_PORT → containerPort 5432) so the primary repl-gateway's
  // socat can relay tunnel traffic to it. Localhost-only on the node by its
  // hostIP, not only by the firewall (the gateway is hostNetwork, so it shares
  // the node netns). Without the
  // hostPort the db is cluster-internal only and the gateway relay target has
  // nothing to connect to. The strategic-merge patch travels via stdin
  // (--patch-file /dev/stdin) so the JSON never hits argv / the remote shell's
  // /proc/cmdline. The patch triggers a pod recreate; wait for the StatefulSet
  // rollout before opening replication.
  await perfAsync('deploy.ha.replication.dbHostPort', async () => {
    await runCommandAsync(
      [
        'ssh',
        ...sshOpts,
        `root@${primaryIp}`,
        `kubectl patch statefulset ${DB_STATEFULSET} -n vibecarbon --type strategic --patch-file /dev/stdin`,
      ],
      { silent: true, input: JSON.stringify(buildDbHostPortPatch()) },
    );
    await runCommandAsync(
      [
        'ssh',
        ...sshOpts,
        `root@${primaryIp}`,
        `kubectl rollout status statefulset/${DB_STATEFULSET} -n vibecarbon --timeout=${DB_STS_BOOT_TIMEOUT_S}s`,
      ],
      { silent: true },
    );
  });

  // 2. Admit replication in pg_hba — from the WireGuard tunnel subnet AND the
  // cluster pod CIDR. Plain `host` (buildReplicationHbaLines), not `hostssl` —
  // WireGuard encrypts the wire, so Postgres doesn't also require TLS.
  //
  // WHY the pod CIDR (live RCA 2026-07-06 e4 rig): the replication connection
  // is relayed — standby db → local gateway → wg0 → primary gateway →
  // 127.0.0.1:5433 hostPort → NAT into the pod network — so the primary's
  // postgres sees the NODE'S CNI GATEWAY as the source (observed: `FATAL: no
  // pg_hba.conf entry for replication connection from host "10.42.2.1"`), not
  // a tunnel IP. cni0 gateways are per-node /24s carved from the cluster pod
  // CIDR, so admit the whole pod CIDR (a /32 or /24 would break on node
  // replacement). (The step-4 pg_isready probe passed anyway: pg_isready never
  // authenticates, so it sails through pg_hba — see the shared builder's probe
  // comment.)
  //
  // Both lines stay valid from BOTH sides after a failover: the tunnel /30
  // covers both peers, and both clusters run the same k3s pod CIDR — and
  // pg_basebackup copies the (PGDATA-resident, see below) pg_hba byte-for-byte
  // into the standby, so the reverse re-seed needs no per-peer bookkeeping.
  //
  // Security: both CIDRs are non-routable, cluster-internal sources. The only
  // cross-host path into them remains the WireGuard tunnel (UDP 51821, peer-
  // scoped firewall rule), and auth remains scram-sha-256 with the per-deploy
  // random REPL_PASSWORD.
  //
  // DURABILITY: the rules must land in the file postgres actually reads AND
  // survive a pod restart. Our db image leaves hba_file at its
  // default, PGDATA/pg_hba.conf (docker/postgres-walg/postgresql.conf), which
  // lives on the PVC: it survives restarts, rides wal-g base backups, and is
  // inherited by the standby via pg_basebackup. The script resolves the live
  // path with SHOW hba_file and REFUSES (exit 1, failing this step) when it is
  // not under PGDATA — appending to a container-ephemeral file would be
  // reverted by the very next restart and fail replication much later and
  // much less clearly. The script ends with a reload that loads the new rules.
  const hbaLines = buildReplicationHbaLines([WG_SUBNET_CIDR, K3S_POD_CIDR]);
  const hbaSetupScript = [
    'set -e',
    `HBA=$(psql -U postgres -d postgres -tAc 'SHOW hba_file;' | tr -d '[:space:]')`,
    'case "$HBA" in',
    '  /var/lib/postgresql/data/*) ;;',
    '  *) echo "hba_file is $HBA, not under PGDATA; replication rules there would not survive a restart" >&2; exit 1 ;;',
    'esac',
    ...hbaLines.map((l) => `grep -qxF '${l}' "$HBA" || echo '${l}' >> "$HBA"`),
    // Reload, never restart: the serving primary's postgres is not bounced by a
    // deploy. wal_level and the other replication settings are on the db argv.
    `psql -U postgres -d postgres -tAc 'SELECT pg_reload_conf();'`,
  ].join('\n');
  await perfAsync('deploy.ha.replication.hba', () =>
    runCommandAsync(
      [
        'ssh',
        ...sshOpts,
        `root@${primaryIp}`,
        `kubectl exec -i -n vibecarbon ${DB_POD} -c ${DB_CONTAINER} -- bash`,
      ],
      { silent: true, input: hbaSetupScript },
    ),
  );
}

/**
 * Setup PostgreSQL streaming replication
 * @param {object} options - Replication options
 * @param {string} options.primaryIp - Primary master node IP (for SSH)
 * @param {string} options.standbyIp - Standby master node IP (for SSH)
 * @param {string} options.sshKeyPath - Path to shared SSH key
 * @param {string} options.primaryDbIp - Primary database node PUBLIC IP (WG endpoint + SSH)
 * @param {string} options.standbyDbIp - Standby database node PUBLIC IP (WG endpoint + SSH)
 * @param {string} [options.primaryDbPrivateIp] - Primary database node private IP (gateway bind + egress netpol)
 * @param {string} [options.standbyDbPrivateIp] - Standby database node private IP (gateway bind + egress netpol)
 * @param {boolean} [options.transportPrepared] - Gateway pods + WG tunnel already brought up by prepareReplicationTransport during the deploy fan-out; skips the transport phase
 * @param {boolean} [options.primaryConfigured] - Primary-side replication config (primary-init.sql, hostPort patch, pg_hba + reload) already applied via configurePrimaryForReplication during the cluster fan-out; skips those phases
 * @returns {Promise<{streaming: boolean, lastState: string, systemIdentifier: string|null}>} Replication status;
 *   systemIdentifier is the standby's, set only when streaming was verified
 */
export async function setupReplication(options) {
  const { primaryIp, standbyIp, sshKeyPath } = options;
  // The database node PUBLIC IPs are BOTH the WireGuard tunnel endpoints and the
  // SSH targets for the gateway bring-up. Fall back to master IP if not provided.
  const _primaryDbIp = options.primaryDbIp || primaryIp;
  const _standbyDbIp = options.standbyDbIp || standbyIp;
  // The database nodes' PRIVATE IPs — real IaC outputs on every provider
  // (Hetzner pins them statically; DO exports the Pulumi-assigned VPC
  // address), threaded through the deploy outputs. Used for the repl-gateway
  // socat bind + the egress NetworkPolicy scope on each cluster. Required,
  // never defaulted — a Hetzner-shaped assumption here silently breaks every
  // other provider.
  const _primaryDbPrivateIp = options.primaryDbPrivateIp;
  const _standbyDbPrivateIp = options.standbyDbPrivateIp;
  if (!_primaryDbPrivateIp || !_standbyDbPrivateIp) {
    throw new Error(
      'setupReplication: primaryDbPrivateIp and standbyDbPrivateIp are required — ' +
        'the IaC program outputs them; a missing value means the infra step result is incomplete',
    );
  }

  // replPassword is generated at create time from crypto.randomBytes and is
  // restricted to base64url characters — no shell escaping needed. Read from
  // process.env first (CI), then .env.local (the `vibecarbon create` default
  // write target). Without the .env.local fallback, HA deploys fail the moment
  // the CLI is invoked without the env var pre-exported.
  const replPassword = readReplPassword();
  if (!replPassword) {
    throw new Error(
      'REPL_PASSWORD is not set in process.env or .env.local, HA deploys require a replication password generated at create time.',
    );
  }

  // SSH opts as argv — keeps all command builders below in argv form (no
  // local-shell parsing). Host keys are pinned to the per-env known_hosts file
  // derived from the shared HA deploy key. Seed both cluster IPs first (the
  // clusters just finished deploying, so they're reachable) so accept-new pins
  // the real host keys via ssh-keyscan instead of blindly trusting the first
  // connection. GlobalKnownHostsFile=/dev/null ignores the system-wide file;
  // accept-new TOFUs a fresh/recycled Hetzner IP but REJECTS a changed key for
  // an already-pinned host.
  const khPath = knownHostsPathForKey(sshKeyPath);
  await seedKnownHosts(khPath, primaryIp);
  await seedKnownHosts(khPath, standbyIp);
  const sshOpts = ['-i', sshKeyPath, ...buildHostKeyOptsForPath(khPath)];

  // 1a. Stand up the WireGuard replication transport.
  //
  // Replication runs over a point-to-point WireGuard tunnel (wg0, UDP
  // WG_PORT=51821) between the two clusters' database nodes, relayed by a
  // hostNetwork `repl-gateway` socat pod on each cluster:
  //
  //   standby db pod ─tcp <priv>:15433─► standby repl-gateway ─wg0→10.99.0.1:15433─►
  //     primary repl-gateway ─tcp 127.0.0.1:5433─► primary postgres (hostPort)
  //
  // The old public-IP TLS transport (per-deploy CA/cert Secret + public-IP
  // NetworkPolicy allowances) is gone: WireGuard encrypts the wire, so there is
  // no cert Secret, and the ONLY netpol change is the single additive
  // `allow-db-repl-gateway-egress` shipped INSIDE the gateway manifest (db pod →
  // local node private IP tcp 15433) — default-deny-all and rp_filter are
  // untouched.
  //
  // Render + apply the gateway manifest to BOTH clusters (each with its own
  // relay direction + node private IP), then generate keys + bring up wg0.
  //
  // Skipped when the deploy fan-out already ran prepareReplicationTransport
  // (options.transportPrepared) — re-running would spend the same ~seconds
  // regenerating WG keys for no benefit. If the early prep silently rotted in
  // the interim, the reseed's in-pod probe (12 × 10s, loud) catches it.
  if (options.transportPrepared === true) {
    p.log.info('Replication transport already prepared during the cluster fan-out');
  } else {
    await perfAsync('deploy.ha.replication.transport', () =>
      applyGatewaysAndBringUpTunnel({
        primaryIp,
        standbyIp,
        primaryDbIp: _primaryDbIp,
        standbyDbIp: _standbyDbIp,
        primaryDbPrivateIp: _primaryDbPrivateIp,
        standbyDbPrivateIp: _standbyDbPrivateIp,
        sshOpts,
        sshKeyPath,
      }),
    );
  }

  if (options.primaryConfigured === true) {
    p.log.info('Primary replication config already applied during the cluster fan-out');
  } else {
    await configurePrimaryForReplication({ primaryIp, sshKeyPath });
  }

  // UNCONDITIONAL fast-path (spec: streaming probe is NOT gated on the
  // opportunistic flags — a lost flag must never trigger a pointless
  // re-swap of a healthy replica). If the standby is already streaming (a
  // redeploy of a healthy pair), the entire
  // resolvePvc/stage/swap/standbyBoot/recoveryWait block is unnecessary.
  const probe = await perfAsync('deploy.ha.replication.streamingProbe', () =>
    probeStreaming({
      exec: (sql) =>
        runCommandAsync(
          [
            'ssh',
            ...sshOpts,
            `root@${primaryIp}`,
            `kubectl exec -n vibecarbon ${DB_POD} -c ${DB_CONTAINER} -- psql -U postgres -tAc "${sql}"`,
          ],
          { silent: true, ignoreError: true },
        ),
    }),
  );
  // The verified-streaming result carries the standby's system identifier: the
  // deploy persists it as envConfig.ha.systemIdentifier, the value failover's
  // replica proof (R1) compares against. Read on the standby, the side failover
  // will promote; streaming already implies the primary's identity matches.
  const readStandbySystemIdentifier = async () => {
    const out = await runCommandAsync(
      [
        'ssh',
        ...sshOpts,
        `root@${standbyIp}`,
        `kubectl exec -n vibecarbon ${DB_POD} -c ${DB_CONTAINER} -- psql -U postgres -tAc "${SYSTEM_IDENTIFIER_SQL}"`,
      ],
      { silent: true },
    );
    const sysid = (typeof out === 'string' ? out : '').trim();
    if (!/^\d+$/.test(sysid)) {
      throw new Error(
        `replication is streaming but the standby's system identifier could not be read ` +
          `(got: ${sysid.slice(0, 80) || 'empty'})`,
      );
    }
    return sysid;
  };

  if (probe.streaming) {
    p.log.info('Standby already streaming (seeded at first boot), skipping the reseed');
    return {
      streaming: true,
      lastState: probe.lastState || 'streaming',
      systemIdentifier: await readStandbySystemIdentifier(),
    };
  }

  // 4. Initialize standby as a streaming replica of the primary.
  // Runs pg_basebackup inside the standby pod, dialing the standby's OWN node
  // private IP on the repl-gateway relay port (REPL_GATEWAY_PORT=15433). That
  // intra-node hop is admitted by the additive allow-db-repl-gateway-egress
  // netpol; the standby gateway relays it through the WireGuard tunnel to the
  // primary gateway, which forwards to the primary postgres hostPort. Plaintext
  // (no PGSSLMODE/PGSSLROOTCERT) — WireGuard is the encryption layer.
  const primaryHost = _standbyDbPrivateIp;
  const primaryPort = String(REPL_GATEWAY_PORT);
  const dbSts = DB_STATEFULSET;
  const dbPod = DB_POD;

  // The standby streams through its LOCAL repl-gateway (own node private IP :
  // REPL_GATEWAY_PORT), NOT the primary's public IP. This explicit conninfo is
  // written INTO the staged basebackup (below) so it is present the moment the
  // reseeded PGDATA boots. Plaintext (sslmode=disable) — WireGuard encrypts the
  // wire. The password is delivered over stdin (never argv).
  const standbyConninfo = buildPrimaryConninfo({
    primaryHost: _standbyDbPrivateIp,
    replPassword,
    port: REPL_GATEWAY_PORT,
  });

  // 4a. Resolve the swap-pod inputs BEFORE scaling the pod down — the volume →
  // PVC chain can only be read while the pod exists. The swap (4d) runs in a
  // helper pod that mounts the SAME PVC, so it works uniformly for local-path
  // AND csi.hetzner.cloud volumes — a CSI PV has no node hostPath and detaches
  // on scale-to-zero, which made the old node-side-ssh swap structurally
  // impossible on CSI clusters (RCA 2026-07-07 e4 rig). All kubectl runs on the
  // standby master (standbyIp); the scheduler places the helper pod wherever the
  // RWO PVC attaches. We also carry the db subPath (the StatefulSet mounts the
  // PVC at /var/lib/postgresql/data via subPath postgres-data → PGDATA on the
  // raw volume is <mount-root>/<subPath>) and the db image (reused so it is
  // already pulled on the node).
  // Self-heal a damaged rig first: a prior deploy that died mid-reseed (or
  // predates the finally-scale-up fix) can leave the sts at replicas=0 with
  // no db pod at all — and re-running deploy is exactly what our own failure
  // message tells the operator to do. Scale up and wait for the pod before
  // reading it; a healthy rig no-ops through this in one kubectl call.
  let claimName;
  let claimSubPath;
  let dbImage;
  await perfAsync('deploy.ha.replication.reseed.resolvePvc', async () => {
    await runCommandAsync(
      [
        'ssh',
        ...sshOpts,
        `root@${standbyIp}`,
        `kubectl scale statefulset ${dbSts} -n vibecarbon --replicas=1`,
      ],
      { silent: true, ignoreError: true },
    );
    let podRaw = '';
    for (let i = 0; i < 60; i++) {
      podRaw = await runCommandAsync(
        [
          'ssh',
          ...sshOpts,
          `root@${standbyIp}`,
          `kubectl get pod ${dbPod} -n vibecarbon -o json 2>/dev/null || true`,
        ],
        { silent: true, ignoreError: true },
      );
      if (typeof podRaw === 'string' && podRaw.includes('"phase": "Running"')) break;
      if (i === 59) {
        throw new Error(
          `standby db pod ${dbPod} is not Running (sts may have been scaled down by a prior ` +
            `failed deploy and did not come back), cannot resolve the PGDATA PVC for reseed.`,
        );
      }
      await new Promise((r) => setTimeout(r, i < 5 ? 1000 : 5000));
    }
    try {
      ({ claimName, subPath: claimSubPath, image: dbImage } = parsePgdataClaimFromPodJson(podRaw));
    } catch (err) {
      throw new Error(
        `Could not resolve the standby PGDATA PVC/image for reseed (needed for the ` +
          `scale-to-zero + helper-pod swap): ${err.message}`,
      );
    }
  });

  // 4b. Stage a fresh pg_basebackup INTO a subdir of the still-running standby's
  // PGDATA (so it lands on the PVC filesystem for an atomic node-side rename).
  // swap:false — the in-pod postmaster is PID 1, so we must NOT pg_ctl-stop it
  // here (that terminates the container; kubelet restarts it as a fresh
  // independent primary — the RCA'd cause of every k8s-ha replication failure).
  // probeFirst aborts cleanly (exit 0, nothing staged) when the primary is
  // unreachable — the node-side swap then reports RESEED_SKIPPED (degraded).
  // Hardening (set -e -o pipefail, PG_VERSION verify, standby.signal +
  // primary_conninfo written into staging) is the SAME shared builder the
  // failover/restore re-seed uses, so deploy-time and recovery-time seeds cannot
  // drift apart. The script (PGPASSWORD + conninfo password) is piped over stdin,
  // never argv.
  const stagingDir = '/var/lib/postgresql/data/.reseed_staging';
  // Probe retry budget (RCA 2026-07-06 e4 rig): the in-pod pg_isready wait can
  // pass before the hostPort→relay path is reachable (the hostPort patch above
  // recreates the pod on a first deploy) — a single-shot probe then skips the
  // entire reseed silently. 12 × 10s ≈ 2 min, each attempt logged in-script.
  const PROBE_ATTEMPTS = 12;
  const PROBE_DELAY_S = 10;
  const pgBasebackupScript = buildStagedBasebackupScript({
    replPassword,
    primaryHost,
    primaryPort,
    probeFirst: true,
    probeAttempts: PROBE_ATTEMPTS,
    probeDelayS: PROBE_DELAY_S,
    swap: false,
    stagingDir,
    primaryConninfo: standbyConninfo,
    label: 'ha-replication',
  });
  await perfAsync('deploy.ha.replication.reseed.stage', () =>
    runCommandAsync(
      ['ssh', ...sshOpts, `root@${standbyIp}`, `kubectl exec -i -n vibecarbon ${dbPod} -- bash`],
      // input: pipes the basebackup script over stdin — requires silent:true. This
      // MUST NOT ignore errors: a failed stage (that produced a partial staging
      // dir) is surfaced, and the node-side swap refuses to promote a bad staging.
      { silent: true, input: pgBasebackupScript },
    ),
  );

  // 4c. Stop the standby cleanly via the StatefulSet controller (kubelet-
  // sanctioned; the RWO PVC releases and the pod is fully gone) — the ONLY safe
  // way to quiesce the postmaster when it is the container's PID 1.
  await perfAsync('deploy.ha.replication.reseed.swap', async () => {
    await runCommandAsync(
      [
        'ssh',
        ...sshOpts,
        `root@${standbyIp}`,
        `kubectl scale statefulset ${dbSts} -n vibecarbon --replicas=0`,
      ],
      { silent: true },
    );
    // Wait for the pod to be fully gone (PVC released) before the node-side swap.
    let podGone = false;
    for (let i = 0; i < 60; i++) {
      const out = await runCommandAsync(
        [
          'ssh',
          ...sshOpts,
          `root@${standbyIp}`,
          `kubectl get pod ${dbPod} -n vibecarbon --ignore-not-found -o name`,
        ],
        { silent: true, ignoreError: true },
      );
      if (!out?.trim()) {
        podGone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, i < 5 ? 1000 : 2000));
    }
    if (!podGone) {
      throw new Error(
        `standby db pod did not terminate within budget after scale-to-zero, ` +
          `refusing the helper-pod PGDATA swap while the pod may still hold the PVC.`,
      );
    }

    // 4d. Atomic PGDATA swap in a short-lived helper pod that mounts the released
    // PVC (pod gone → RWO PVC free). Uniform for local-path AND csi.hetzner.cloud
    // volumes. Reports RESEED_SWAPPED (new basebackup promoted) or RESEED_SKIPPED
    // (the probe never reached the primary, so nothing was staged).
    //
    // RESEED_SKIPPED is LOUD here: the deploy path hard-gates on streaming, so a
    // silently-skipped reseed is a GUARANTEED deploy failure ~10 minutes later
    // with a misleading "no replica connected". Fail fast with the real cause
    // instead. The throw is caught by the caller and folded into the shared gate,
    // so -allow-degraded still finalizes a warm-standby deploy. (The quiet-skip
    // probe semantics are preserved where they belong: compose classifies the
    // skip message itself, and the failover/restore re-seed probes separately
    // with probeFirst:false.)
    const swapKubectl = (argv, opts = {}) =>
      runCommandAsync(['ssh', ...sshOpts, `root@${standbyIp}`, ['kubectl', ...argv].join(' ')], {
        silent: true,
        ...opts,
      });
    let swapText = '';
    try {
      swapText =
        (await swapPgdataViaHelperPod(swapKubectl, {
          claimName,
          subPath: claimSubPath,
          image: dbImage,
        })) || '';
      if (swapText.includes('RESEED_SKIPPED')) {
        throw new Error(
          `standby reseed skipped: the in-pod probe could not reach the primary via the ` +
            `local relay ${primaryHost}:${primaryPort} after ${PROBE_ATTEMPTS} attempts ` +
            `(~${(PROBE_ATTEMPTS * PROBE_DELAY_S) / 60} min), so nothing was staged and the ` +
            `standby keeps its independent postgres. Check the repl-gateway pods and the ` +
            `WireGuard tunnel (wg show) on both database nodes.`,
        );
      }
      if (!swapText.includes('RESEED_SWAPPED')) {
        throw new Error(
          `standby reseed: helper-pod PGDATA swap did not complete, ` +
            `the standby keeps its previous PGDATA.\n--- swap pod logs ---\n` +
            `${swapText.trim() || '(no output)'}`,
        );
      }
    } finally {
      // 4e. ALWAYS scale the standby back up — on the failure paths above the
      // sts would otherwise stay at replicas=0 with NO standby db at all
      // (live-hit 2026-07-07: an unschedulable swap pod left the rig scaled to
      // zero, contradicting every "keeps its previous PGDATA" promise here).
      // On failure the pod restarts on its old PGDATA; on success it boots the
      // swapped one — the rollout wait below covers both.
      await runCommandAsync(
        [
          'ssh',
          ...sshOpts,
          `root@${standbyIp}`,
          `kubectl scale statefulset ${dbSts} -n vibecarbon --replicas=1`,
        ],
        { silent: true, ignoreError: true },
      );
    }
  });
  // Standby boot on the (possibly swapped) PGDATA — on csi.hetzner.cloud PVCs
  // this is minutes (volume reattach + init containers), so it gets its own
  // slice separate from the swap itself. Budget is the shared
  // DB_STS_BOOT_TIMEOUT_S: at the old 300s, DigitalOcean's CSI
  // detach/attach settle failed a HEALTHY boot here (run 33252884427 — the
  // wait timed out, the pod was Ready a minute later).
  await perfAsync('deploy.ha.replication.reseed.standbyBoot', () =>
    runCommandAsync(
      [
        'ssh',
        ...sshOpts,
        `root@${standbyIp}`,
        `kubectl rollout status statefulset/${dbSts} -n vibecarbon --timeout=${DB_STS_BOOT_TIMEOUT_S}s`,
      ],
      { silent: true },
    ),
  );

  // 4f. Wait for the reseeded standby to ENTER RECOVERY. A swap went in (4d
  // threw otherwise), so we EXPECT recovery — if it never enters within the
  // budget, FAIL LOUD here (not 10 minutes later at verify). The throw is
  // caught by the caller and folded into the shared hard-gate, so
  // -allow-degraded semantics are unchanged.
  // Budget: ~10 min. On csi.hetzner.cloud PVCs the scale-up alone costs
  // minutes (volume reattach + the init containers + backup recovery ran
  // ~5 min on a live cpx31 rig, 2026-07-07) and postgres only accepts the
  // read-only probe after reaching consistent state — the old ~2 min loop
  // declared failure while the standby was still coming up (and then
  // streamed fine on its own). local-path rigs pass in seconds either way.
  let inRecovery = false;
  let lastRecoveryOut = '';
  await perfAsync('deploy.ha.replication.reseed.recoveryWait', async () => {
    for (let i = 0; i < 150; i++) {
      // `2>&1 || true` folds psql's FATAL detail into stdout (a refused
      // connection would otherwise surface as a detail-free null via
      // ignoreError), so the budget-exhausted throw below can classify config
      // errors distinctly from timing.
      const result = await runCommandAsync(
        [
          'ssh',
          ...sshOpts,
          `root@${standbyIp}`,
          // -c db: without it kubectl prepends a 'Defaulted container
          // ...' stderr notice which the 2>&1 fold (needed to capture psql
          // FATAL details for config-error classification) would mix into the
          // output — the old strict === 't' match then never succeeded on this
          // multi-init-container pod and every reseed "timed out" while the
          // standby was recovering fine underneath.
          `kubectl exec -n vibecarbon ${dbPod} -c ${DB_CONTAINER} -- psql -U postgres -tAc 'SELECT pg_is_in_recovery()' 2>&1 || true`,
        ],
        { silent: true, ignoreError: true },
      );
      if (typeof result === 'string' && result.trim()) lastRecoveryOut = result;
      // Tolerant match: psql -tA prints the bare value on its own line; accept
      // it as the LAST non-empty line so an incidental notice can never blind
      // this loop again.
      const lastLine =
        typeof result === 'string'
          ? result
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .pop()
          : '';
      if (lastLine === 't') {
        inRecovery = true;
        break;
      }
      await new Promise((r) => setTimeout(r, i < 5 ? 500 : 4000));
    }
  });
  if (!inRecovery) {
    // "Hot standby mode is disabled" is a CONFIG error (hot_standby=off won
    // because the staged auto.conf override did not take), NOT a timing issue:
    // waiting longer can never fix it.
    if (lastRecoveryOut.includes('Hot standby mode is disabled')) {
      throw new Error(
        `standby reseed: the standby is streaming but refusing read-only connections ` +
          `("Hot standby mode is disabled") — hot_standby is OFF in its effective config ` +
          `(the staged postgresql.auto.conf must pin hot_standby = on, and it did not take). ` +
          `Config error, not a timing issue.`,
      );
    }
    throw new Error(
      `standby reseed swapped in a fresh basebackup but the standby never entered ` +
        `recovery mode within the budget; the reseeded PGDATA is not replaying from ` +
        `the primary (check the standby db logs and the repl-gateway tunnel).`,
    );
  }

  // One grep-able line answering "which reseed phase happened" from any e2e log
  // (values are all yes on this path — each phase throws loudly otherwise, and
  // the throw names the failing phase).
  p.log.info(
    `k8s-ha reseed: staged=yes swapped=yes recovery=yes ` +
      `(relay ${primaryHost}:${primaryPort}, pvc ${claimName}, subPath ${claimSubPath})`,
  );

  // 5. Verify replication is streaming on the primary. Once standby catches
  // up, pg_stat_replication.state flips to 'streaming' on the next read. Uses
  // the shared verifyStreaming poller (finding #2) with a k8s readState closure
  // so compose + k8s share ONE verify implementation; lastState feeds the
  // finding-#1 hard-gate error message.
  //
  // The closure must NOT swallow exec failures into '' (RCA 2026-07-06 e4 rig:
  // the primary pod was just recreated, kubectl exec failed transiently, and
  // ignoreError turned "command terminated with exit code 1" into a terminal
  // verify result). Instead: throw on exec failure or non-state output so
  // verifyStreaming RETRIES within its budget; only a budget-exhausted run
  // reports the failure (as 'unreadable …'). Budget: 24 × 5s ≈ 120s.
  const VALID_STATES = new Set(['', 'startup', 'catchup', 'streaming', 'backup', 'stopping']);
  const { streaming, lastState } = await perfAsync('deploy.ha.replication.verifyStreaming', () =>
    verifyStreaming({
      readState: async () => {
        const result = await runCommandAsync(
          [
            'ssh',
            ...sshOpts,
            `root@${primaryIp}`,
            `kubectl exec -n vibecarbon ${DB_POD} -c ${DB_CONTAINER} -- psql -U postgres -tAc "SELECT state FROM pg_stat_replication ORDER BY (state = 'streaming') DESC LIMIT 1"`,
          ],
          { silent: true },
        );
        const out = (typeof result === 'string' ? result : '').trim();
        if (!VALID_STATES.has(out)) {
          throw new Error(
            `could not read pg_stat_replication (unexpected output: ${out.slice(0, 120)})`,
          );
        }
        return out;
      },
      attempts: 24,
      delaysMs: [5000],
    }),
  );

  return {
    streaming,
    lastState,
    systemIdentifier: streaming ? await readStandbySystemIdentifier() : null,
  };
}
