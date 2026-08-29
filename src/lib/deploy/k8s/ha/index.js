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
import { scpWithRetry } from '../../../ssh.js';
import {
  buildPrimaryConninfo,
  buildReplicationHbaLines,
  buildStagedBasebackupScript,
  DB_STS_BOOT_TIMEOUT_S,
  parsePgdataClaimFromPodJson,
  REPL_PORT,
  swapPgdataViaHelperPod,
  verifyStreaming,
} from '../../replication.js';
import { readReplPassword } from '../../utils.js';
import {
  exchangeAndBringUpTunnel,
  REPL_GATEWAY_PORT,
  WG_PRIMARY_IP,
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

// The repl-gateway manifest (Pod + additive egress NetworkPolicy). HA-only, so
// it lives outside the base kustomization; setupReplication renders its
// placeholders per-cluster and applies it via `kubectl apply -f -`.
const REPL_GATEWAY_MANIFEST = join(
  __dirname,
  '../../../../../carbon/k8s/base/repl-gateway/repl-gateway.yaml',
);

/**
 * The two socat address specs for the repl-gateway relay, keyed by cluster
 * role. Pure — unit-tested; rendered into the repl-gateway Pod manifest.
 *
 *   - primary: bind the tunnel IP (10.99.0.1:15433) and forward to the local
 *     postgres hostPort (127.0.0.1:5433). Reachable only via wg0.
 *   - standby: bind the node's private IP (<priv>:15433) and forward INTO the
 *     tunnel to the primary gateway (10.99.0.1:15433). This is the address the
 *     standby db pod dials.
 *
 * @param {'primary'|'standby'} role
 * @param {string} nodePrivateIp - this cluster's supabase node private IP
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
 * @param {string} o.nodePrivateIp - this cluster's supabase node private IP
 * @returns {string}
 */
export function renderReplGatewayManifest({ template, role, nodePrivateIp }) {
  const { relayListen, relayTarget } = buildReplGatewaySocatArgs(role, nodePrivateIp);
  return template
    .replaceAll('__RELAY_LISTEN__', relayListen)
    .replaceAll('__RELAY_TARGET__', relayTarget)
    .replaceAll('__SUPABASE_PRIVATE_IP__', nodePrivateIp);
}

/**
 * Strategic-merge patch that binds the primary's postgres to REPL_PORT (hostPort)
 * → containerPort 5432 on the node. The primary repl-gateway (hostNetwork socat)
 * relays tunnel traffic to `127.0.0.1:REPL_PORT` — this hostPort IS that local
 * listener. NOTE: the port is NOT opened in the Hetzner firewall (the firewall
 * now admits only WG udp/51821), so postgres is reachable only via localhost on
 * the node, never cross-cluster over the public internet. Without this hostPort
 * the db is reachable only inside the cluster and the gateway's local relay
 * target would have nothing to connect to. Mirrors the traefik/registry hostPort
 * pattern. One db pod per node (StatefulSet), so the node's :REPL_PORT is
 * uncontended.
 *
 * The container name in the supabase chart's db StatefulSet is `supabase-db`.
 * A strategic-merge patch keyed by container `name` + port `containerPort`
 * updates the existing port entry in place (adds hostPort) rather than
 * appending a duplicate.
 * @returns {object}
 */
export function buildDbHostPortPatch() {
  return {
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: 'supabase-db',
              ports: [{ containerPort: 5432, hostPort: REPL_PORT }],
            },
          ],
        },
      },
    },
  };
}

/**
 * Apply the repl-gateway manifest to both clusters and bring up the WireGuard
 * tunnel between the two supabase nodes. Shared by setupReplication (the
 * serial path) and prepareReplicationTransport (the deploy fan-out overlap) so
 * the two paths cannot drift. Idempotent: kubectl apply reconciles the gateway
 * pod/netpol, and exchangeAndBringUpTunnel regenerates + re-exchanges keys on
 * every call.
 */
async function applyGatewaysAndBringUpTunnel({
  primaryIp,
  standbyIp,
  primarySupabaseIp,
  standbySupabaseIp,
  primarySupabasePrivateIp,
  standbySupabasePrivateIp,
  sshOpts,
  sshKeyPath,
}) {
  const gatewayTemplate = readFileSync(REPL_GATEWAY_MANIFEST, 'utf-8');
  // repl-gateway is a BARE Pod, and bare-Pod specs are immutable beyond
  // image/tolerations. A role-swapped redeploy (post-failover reconverge)
  // renders each cluster's gateway with the OPPOSITE relay direction, so a
  // plain `kubectl apply` over the surviving pod fails with
  //   The Pod "repl-gateway" is invalid: spec: Forbidden: pod updates may
  //   not change fields other than ...
  // (RCA 2026-07-17 e4 run 5 — same-role redeploys render byte-identical
  // specs and never hit this). On that rejection, delete the pod and
  // re-apply: the relay drops for the seconds between delete and re-create,
  // which is fine — replication re-establishes and the serial path's
  // recovery waits already cover a briefly-absent transport.
  const applyGatewayPod = async (masterIp, rendered) => {
    const apply = () =>
      runCommandAsync(['ssh', ...sshOpts, `root@${masterIp}`, 'kubectl apply -f -'], {
        silent: true,
        input: rendered,
      });
    try {
      await apply();
    } catch (err) {
      const msg = err?.message || String(err);
      if (!/Forbidden: pod updates may not change fields/.test(msg)) throw err;
      console.error(
        '[repl-gateway] pod spec changed (role-swapped redeploy), deleting and re-creating the gateway pod',
      );
      await runCommandAsync(
        [
          'ssh',
          ...sshOpts,
          `root@${masterIp}`,
          'kubectl delete pod repl-gateway -n vibecarbon --ignore-not-found --wait=true --timeout=60s',
        ],
        { silent: true },
      );
      await apply();
    }
  };
  await applyGatewayPod(
    primaryIp,
    renderReplGatewayManifest({
      template: gatewayTemplate,
      role: 'primary',
      nodePrivateIp: primarySupabasePrivateIp,
    }),
  );
  await applyGatewayPod(
    standbyIp,
    renderReplGatewayManifest({
      template: gatewayTemplate,
      role: 'standby',
      nodePrivateIp: standbySupabasePrivateIp,
    }),
  );

  // Generate a keypair on each supabase node, cross-distribute PUBLIC keys, and
  // bring up wg0. Private keys are generated on-node and never leave it (see
  // exchangeAndBringUpTunnel). The WG endpoints/SSH targets are the supabase
  // nodes' PUBLIC IPs.
  await exchangeAndBringUpTunnel({
    primaryIp: primarySupabaseIp,
    standbyIp: standbySupabaseIp,
    sshKeyPath,
  });
}

/**
 * Wait (bounded) until `kubectl get namespace <ns>` answers on a cluster.
 * Injectable runner + sleep for unit tests (same pattern as waitForDnsToPoint).
 * Best-effort: returns false on budget exhaustion, never throws — the caller
 * decides whether a missing namespace is fatal.
 *
 * @param {(cmd: string) => Promise<string|false|null>} runKubectl - executes a
 *   kubectl command on the target cluster (SSH-wrapped in production) and
 *   resolves its stdout, or false/null on failure.
 */
export async function waitForNamespace(
  runKubectl,
  {
    namespace = 'vibecarbon',
    attempts = 36,
    delayMs = 5000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  for (let i = 0; i < attempts; i++) {
    try {
      const out = await runKubectl(`kubectl get namespace ${namespace} -o name`);
      if (typeof out === 'string' && out.includes(`namespace/${namespace}`)) return true;
    } catch {
      // cluster still coming up (SSH refused, apiserver not answering) — keep polling
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return false;
}

/**
 * Deploy-fan-out transport prep: bring up the replication transport (gateway
 * pods + WireGuard tunnel) while the two clusters are still installing
 * manifests/helm — this work only needs the supabase NODES and each cluster's
 * k3s apiserver, both available minutes before the cluster deploys finish.
 * The one k8s-level prerequisite is the vibecarbon namespace (applyBase
 * creates it early in each cluster's applyManifests), so wait for it on both
 * sides first; prep must NOT create the namespace itself — applyBase owns it.
 *
 * Opportunistic by contract: the caller treats any throw as "not prepared"
 * and setupReplication then brings the transport up on the serial path
 * exactly as before this optimization existed.
 */
export async function prepareReplicationTransport({
  primaryIp,
  standbyIp,
  primarySupabaseIp,
  standbySupabaseIp,
  primarySupabasePrivateIp,
  standbySupabasePrivateIp,
  sshKeyPath,
}) {
  if (!primaryIp || !standbyIp || !sshKeyPath) {
    throw new Error('prepareReplicationTransport requires primaryIp, standbyIp, and sshKeyPath');
  }
  // The supabase nodes' PRIVATE IPs are real IaC outputs on every provider
  // (Hetzner pins 10.0.1.2 statically; DO exports the Pulumi-assigned VPC
  // address). A missing value means the infra step result is incomplete —
  // never assume a Hetzner-shaped address here: socat would bind a
  // nonexistent IP and the egress NetworkPolicy would scope to a /32 that
  // exists on no node.
  if (!primarySupabasePrivateIp) {
    throw new Error(
      'prepareReplicationTransport: primarySupabasePrivateIp is required — the IaC program ' +
        'outputs it; a missing value means the infra step result is incomplete',
    );
  }
  if (!standbySupabasePrivateIp) {
    throw new Error(
      'prepareReplicationTransport: standbySupabasePrivateIp is required — the IaC program ' +
        'outputs it; a missing value means the infra step result is incomplete',
    );
  }
  return perfAsync('deploy.ha.replication.transportEarly', async () => {
    const khPath = knownHostsPathForKey(sshKeyPath);
    await seedKnownHosts(khPath, primaryIp);
    await seedKnownHosts(khPath, standbyIp);
    const sshOpts = ['-i', sshKeyPath, ...buildHostKeyOptsForPath(khPath)];

    const nsOk = await Promise.all(
      [primaryIp, standbyIp].map((ip) =>
        waitForNamespace((cmd) =>
          runCommandAsync(['ssh', ...sshOpts, `root@${ip}`, cmd], {
            silent: true,
            ignoreError: true,
          }),
        ),
      ),
    );
    if (!nsOk.every(Boolean)) {
      throw new Error(
        'vibecarbon namespace did not appear on both clusters within the wait budget',
      );
    }
    await applyGatewaysAndBringUpTunnel({
      primaryIp,
      standbyIp,
      primarySupabaseIp: primarySupabaseIp || primaryIp,
      standbySupabaseIp: standbySupabaseIp || standbyIp,
      primarySupabasePrivateIp,
      standbySupabasePrivateIp,
      sshOpts,
      sshKeyPath,
    });
  });
}

/**
 * Belt for the k8s-ha scale flow (item I-1): re-establish the replication
 * TRANSPORT after a node resize rebooted the supabase node(s). It does NOT
 * re-seed — streaming replication resumes on its own once the tunnel + gateway
 * are back; this only restores the plumbing that the reboot dropped.
 *
 * With the systemd persistence unit in place (exchangeAndBringUpTunnel writes
 * it), wg0 is already recreated at boot — but this belt makes recovery prompt
 * and self-healing regardless:
 *   1. Re-run exchangeAndBringUpTunnel (idempotent): recreates wg0 on both
 *      supabase nodes AND (re)installs the systemd unit, so an env deployed
 *      before this fix gets persistence retrofitted during scale.
 *   2. Per cluster: delete the crash-looped `repl-gateway` Pod (it couldn't
 *      bind its tunnel IP while wg0 was gone) then re-apply the gateway
 *      manifest — a bare Pod isn't recreated by any controller, so delete THEN
 *      apply gives a fresh Pod that binds cleanly now wg0 exists, skipping the
 *      up-to-5-min CrashLoopBackOff that otherwise wedges the primary's
 *      post-resize `kubectl wait --for=Ready pods --all -n vibecarbon`.
 *
 * All args mirror setupReplication's. Same known-hosts pinning + sshOpts.
 *
 * @param {object} options
 * @param {string} options.primaryIp - primary master node IP (SSH/kubectl target)
 * @param {string} options.standbyIp - standby master node IP (SSH/kubectl target)
 * @param {string} options.sshKeyPath - shared HA SSH key
 * @param {string} [options.primarySupabaseIp] - primary supabase node PUBLIC IP (WG endpoint + SSH)
 * @param {string} [options.standbySupabaseIp] - standby supabase node PUBLIC IP (WG endpoint + SSH)
 * @param {string} [options.primarySupabasePrivateIp] - primary supabase node private IP (gateway bind + netpol)
 * @param {string} [options.standbySupabasePrivateIp] - standby supabase node private IP (gateway bind + netpol)
 */
export async function reestablishReplicationTransport(options) {
  const { primaryIp, standbyIp, sshKeyPath } = options;
  if (!primaryIp || !standbyIp || !sshKeyPath) {
    throw new Error(
      'reestablishReplicationTransport requires primaryIp, standbyIp, and sshKeyPath',
    );
  }
  const primarySupabaseIp = options.primarySupabaseIp || primaryIp;
  const standbySupabaseIp = options.standbySupabaseIp || standbyIp;
  // Required, never defaulted — see prepareReplicationTransport's guard for why.
  const { primarySupabasePrivateIp, standbySupabasePrivateIp } = options;
  if (!primarySupabasePrivateIp || !standbySupabasePrivateIp) {
    throw new Error(
      'reestablishReplicationTransport: primarySupabasePrivateIp and standbySupabasePrivateIp ' +
        'are required — the IaC program outputs them; redeploy to persist them if absent',
    );
  }

  const khPath = knownHostsPathForKey(sshKeyPath);
  await seedKnownHosts(khPath, primaryIp);
  await seedKnownHosts(khPath, standbyIp);
  const sshOpts = ['-i', sshKeyPath, ...buildHostKeyOptsForPath(khPath)];

  // 1. Recreate wg0 on both supabase nodes (+ retrofit the systemd unit).
  await exchangeAndBringUpTunnel({
    primaryIp: primarySupabaseIp,
    standbyIp: standbySupabaseIp,
    sshKeyPath,
  });

  // 2. Bounce + re-apply the repl-gateway on each cluster.
  const gatewayTemplate = readFileSync(REPL_GATEWAY_MANIFEST, 'utf-8');
  for (const [masterIp, role, nodePrivateIp] of [
    [primaryIp, 'primary', primarySupabasePrivateIp],
    [standbyIp, 'standby', standbySupabasePrivateIp],
  ]) {
    await runCommandAsync(
      [
        'ssh',
        ...sshOpts,
        `root@${masterIp}`,
        'kubectl delete pod repl-gateway -n vibecarbon --ignore-not-found',
      ],
      { silent: true, ignoreError: true },
    );
    await runCommandAsync(['ssh', ...sshOpts, `root@${masterIp}`, 'kubectl apply -f -'], {
      silent: true,
      input: renderReplGatewayManifest({ template: gatewayTemplate, role, nodePrivateIp }),
    });
  }
}

/**
 * Primary-side replication configuration — everything the primary needs
 * BEFORE a standby can basebackup from it: replication role/slot SQL,
 * the hostPort relay target, durable pg_hba admission, the wal_level
 * restart, and the post-restart rollout of postgres-dependent deployments.
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
  // throughout, so the log showed nothing between reloadPostgrest and the
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
          'cat /tmp/primary-init.sql | kubectl exec -i -n vibecarbon supabase-supabase-db-0 -- psql -U supabase_admin',
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

  // 1b. Bind the primary's postgres to a node hostPort (REPL_PORT → containerPort
  // 5432) so the primary repl-gateway's socat can relay tunnel traffic to it at
  // 127.0.0.1:REPL_PORT. Not opened in the firewall — localhost-only on the node
  // (the gateway is hostNetwork, so it shares the node netns). Without the
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
        'kubectl patch statefulset supabase-supabase-db -n vibecarbon --type strategic --patch-file /dev/stdin',
      ],
      { silent: true, input: JSON.stringify(buildDbHostPortPatch()) },
    );
    await runCommandAsync(
      [
        'ssh',
        ...sshOpts,
        `root@${primaryIp}`,
        `kubectl rollout status statefulset/supabase-supabase-db -n vibecarbon --timeout=${DB_STS_BOOT_TIMEOUT_S}s`,
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
  // pg_basebackup copies the (PGDATA-durable, see below) pg_hba byte-for-byte
  // into the standby, so the reverse re-seed needs no per-peer bookkeeping.
  //
  // Security: both CIDRs are non-routable, cluster-internal sources. The only
  // cross-host path into them remains the WireGuard tunnel (UDP 51821, peer-
  // scoped firewall rule), and auth remains scram-sha-256 with the per-deploy
  // random REPL_PASSWORD.
  //
  // DURABILITY (same-wave finding): the supabase/postgres image points
  // hba_file at /etc/postgresql/pg_hba.conf — a container-EPHEMERAL path
  // (compose RCA fanout12 2026-05-01 established the override; the k8s db
  // image is the same family). Appending to the live file would be reverted by
  // the very next pod restart — and step 3 deletes this pod moments from now —
  // while appending only to PGDATA/pg_hba.conf targets a file postgres never
  // reads. So: copy the LIVE hba file (resolved via SHOW hba_file) into PGDATA
  // once, append our lines idempotently THERE, and repoint hba_file via ALTER
  // SYSTEM (postgresql.auto.conf lives in PGDATA too). hba_file is a
  // server-start parameter — no reload here; step 3's pod restart applies it.
  // Net: the replication hba survives pod restarts, rides wal-g base backups,
  // and is inherited by the standby via pg_basebackup.
  const hbaLines = buildReplicationHbaLines([WG_SUBNET_CIDR, K3S_POD_CIDR]);
  const hbaSetupScript = [
    'set -e',
    `HBA_LIVE=$(psql -U supabase_admin -d postgres -tAc 'SHOW hba_file;' | tr -d '[:space:]')`,
    'HBA_DURABLE=/var/lib/postgresql/data/pg_hba.conf',
    'if [ "$HBA_LIVE" != "$HBA_DURABLE" ]; then',
    '  cp "$HBA_LIVE" "$HBA_DURABLE"',
    '  chown postgres:postgres "$HBA_DURABLE"',
    '  chmod 600 "$HBA_DURABLE"',
    `  psql -U supabase_admin -d postgres -c "ALTER SYSTEM SET hba_file = '$HBA_DURABLE'"`,
    'fi',
    ...hbaLines.map((l) => `grep -qxF '${l}' "$HBA_DURABLE" || echo '${l}' >> "$HBA_DURABLE"`),
  ].join('\n');
  await perfAsync('deploy.ha.replication.hba', () =>
    runCommandAsync(
      [
        'ssh',
        ...sshOpts,
        `root@${primaryIp}`,
        'kubectl exec -i -n vibecarbon supabase-supabase-db-0 -- bash',
      ],
      { silent: true, input: hbaSetupScript },
    ),
  );

  // 3. Restart primary postgres to apply wal_level change (requires restart, not just reload)
  await perfAsync('deploy.ha.replication.primaryRestart', async () => {
    await runCommandAsync(
      [
        'ssh',
        ...sshOpts,
        `root@${primaryIp}`,
        'kubectl delete pod supabase-supabase-db-0 -n vibecarbon --wait=true',
      ],
      { silent: true },
    );
    // Wait for pod to come back
    for (let i = 0; i < 30; i++) {
      try {
        const ready = await runCommandAsync(
          [
            'ssh',
            ...sshOpts,
            `root@${primaryIp}`,
            // -h 127.0.0.1 (TCP): discriminates the real server from the
            // docker-entrypoint's socket-only first-boot temp server — see
            // awaitPostgresAccepting (readiness.js) for the d4 run-2 RCA.
            // This pod restarts with existing PGDATA (no init flow), so the
            // socket form was safe here, but TCP is the uniform condition.
            'kubectl exec -n vibecarbon supabase-supabase-db-0 -- pg_isready -h 127.0.0.1 -U supabase_admin 2>/dev/null && echo IS_READY || echo NOT_READY',
          ],
          { silent: true, ignoreError: true },
        );
        if (ready?.trim()?.includes('IS_READY')) break;
      } catch {
        // Retry
      }
      if (i === 29) break;
      const interval = i < 5 ? 500 : 2000;
      await new Promise((r) => setTimeout(r, interval));
    }
  });

  // 3b. Rollout-restart the postgres-dependent Deployments on primary
  //     so they drop stale connection pools to the (now-restarted)
  //     postgres.
  //
  //     RCA from k8s-ha 2026-04-28 deploy runs: an earlier version
  //     restarted only `app`, but the public probe still returned a
  //     19-byte `404 page not found`. cert-manager state
  //     was clean (vibecarbon-tls READY=True, Order=valid), but app
  //     pods kept failing readiness 503. The app's
  //     `/api/health/ready` queries `supabaseAdmin.from(...)`, which
  //     hits SUPABASE_URL=http://supabase-supabase-kong:8000 → kong
  //     → supabase-supabase-rest → postgres. When primary postgres
  //     restarted, supabase-rest + auth + realtime + meta held onto
  //     stale connections; restarting only `app` left the readiness
  //     path broken. Service `app` then had zero Ready endpoints and
  //     Traefik's IngressRoute fell through to its default 404
  //     backend on the public probe.
  //
  //     We restart specifically the deployments that hold direct
  //     postgres connections. We do NOT restart:
  //       - traefik          — hostPort 80/443; RollingUpdate races
  //                            with itself (new pod can't bind ports
  //                            while old pod still listens) and
  //                            traefik doesn't talk to postgres.
  //       - supabase-storage — single replica with RWO PVC; old pod
  //                            holds the volume and new pod stays in
  //                            Init forever waiting for attach.
  //                            Storage will reconnect on next request.
  //       - supabase-kong    — supabase community chart runs kong in
  //                            DB-less mode (declarative config),
  //                            no postgres connection.
  //       - supabase-imgproxy — image proxy, no postgres connection.
  //       - supabase-studio  — talks via meta/kong, no direct conn.
  //
  //     Verified on a live standby cluster on 2026-04-28: restarting
  //     all 10 deployments hung on traefik (10 min progress deadline)
  //     and storage (RWO PVC stuck attaching). The selective list
  //     below completes in <2 min.
  const postgresDependentDeployments = [
    'app',
    'supabase-supabase-auth',
    'supabase-supabase-rest',
    'supabase-supabase-realtime',
    'supabase-supabase-meta',
  ];
  // Restart + status-wait the 5 postgres-dependent deployments in parallel.
  // All 5 share the same apiserver but live in independent ReplicaSets — kubelet
  // can roll them concurrently and rollout-status only blocks on its own
  // deployment. Previously serial: total ≈ Σ(per-deploy rollout) = 5 × ~30-60s
  // worst case = 2.5-5 min. Parallel: total ≈ max(per-deploy) = ~30-60s.
  // perfAsync wraps the whole batch so the next run's perf_substep shows the
  // critical-path cost in one place (uninstrumented before).
  await perfAsync('deploy.ha.replication.rolloutRestart', () =>
    Promise.all(
      postgresDependentDeployments.map((deploy) =>
        runCommandAsync(
          [
            'ssh',
            ...sshOpts,
            `root@${primaryIp}`,
            `kubectl rollout restart deployment/${deploy} -n vibecarbon`,
          ],
          { silent: true, ignoreError: true },
        ),
      ),
    ),
  );
  await perfAsync('deploy.ha.replication.rolloutStatus', () =>
    Promise.all(
      postgresDependentDeployments.map((deploy) =>
        runCommandAsync(
          [
            'ssh',
            ...sshOpts,
            `root@${primaryIp}`,
            `kubectl rollout status deployment/${deploy} -n vibecarbon --timeout=300s`,
          ],
          { silent: true, ignoreError: true },
        ),
      ),
    ),
  );

  // Mirror of reloadPostgrest() in the base k8s path. The rollout-restart of
  // supabase-supabase-rest above already refreshes its schema cache, but issue
  // the canonical NOTIFY explicitly so the app tables stay visible to PostgREST
  // even if that restart list ever changes — same PGRST205 class the base
  // deploy guards against. Best-effort (ignoreError): a missed reload
  // self-heals on the next rest restart.
  await perfAsync('deploy.ha.replication.reloadPostgrest', () =>
    runCommandAsync(
      [
        'ssh',
        ...sshOpts,
        `root@${primaryIp}`,
        `kubectl exec -i -n vibecarbon supabase-supabase-db-0 -- psql -U supabase_admin -d postgres -c "NOTIFY pgrst, 'reload schema'"`,
      ],
      { silent: true, ignoreError: true },
    ),
  );
}

/**
 * Setup PostgreSQL streaming replication
 * @param {object} options - Replication options
 * @param {string} options.primaryIp - Primary master node IP (for SSH)
 * @param {string} options.standbyIp - Standby master node IP (for SSH)
 * @param {string} options.sshKeyPath - Path to shared SSH key
 * @param {string} options.primarySupabaseIp - Primary supabase node PUBLIC IP (WG endpoint + SSH)
 * @param {string} options.standbySupabaseIp - Standby supabase node PUBLIC IP (WG endpoint + SSH)
 * @param {string} [options.primarySupabasePrivateIp] - Primary supabase node private IP (gateway bind + egress netpol)
 * @param {string} [options.standbySupabasePrivateIp] - Standby supabase node private IP (gateway bind + egress netpol)
 * @param {boolean} [options.transportPrepared] - Gateway pods + WG tunnel already brought up by prepareReplicationTransport during the deploy fan-out; skips the transport phase
 * @param {boolean} [options.primaryConfigured] - Primary-side replication config (primary-init.sql, hostPort patch, pg_hba, restart, dependent-deployment rollout) already applied via configurePrimaryForReplication during the cluster fan-out; skips those phases
 * @returns {Promise<{streaming: boolean}>} Replication status
 */
export async function setupReplication(options) {
  const { primaryIp, standbyIp, sshKeyPath } = options;
  // The supabase node PUBLIC IPs are BOTH the WireGuard tunnel endpoints and the
  // SSH targets for the gateway bring-up. Fall back to master IP if not provided.
  const _primarySupabaseIp = options.primarySupabaseIp || primaryIp;
  const _standbySupabaseIp = options.standbySupabaseIp || standbyIp;
  // The supabase nodes' PRIVATE IPs — real IaC outputs on every provider
  // (Hetzner pins them statically; DO exports the Pulumi-assigned VPC
  // address), threaded through the deploy outputs. Used for the repl-gateway
  // socat bind + the egress NetworkPolicy scope on each cluster. Required,
  // never defaulted — a Hetzner-shaped assumption here silently breaks every
  // other provider.
  const _primarySupabasePrivateIp = options.primarySupabasePrivateIp;
  const _standbySupabasePrivateIp = options.standbySupabasePrivateIp;
  if (!_primarySupabasePrivateIp || !_standbySupabasePrivateIp) {
    throw new Error(
      'setupReplication: primarySupabasePrivateIp and standbySupabasePrivateIp are required — ' +
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
  // WG_PORT=51821) between the two clusters' supabase nodes, relayed by a
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
        primarySupabaseIp: _primarySupabaseIp,
        standbySupabaseIp: _standbySupabaseIp,
        primarySupabasePrivateIp: _primarySupabasePrivateIp,
        standbySupabasePrivateIp: _standbySupabasePrivateIp,
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
  // re-swap of a healthy replica). If the standby is already streaming —
  // the seed-standby init's happy path — the entire
  // resolvePvc/stage/swap/standbyBoot/recoveryWait block is unnecessary.
  const probe = await perfAsync('deploy.ha.replication.streamingProbe', () =>
    verifyStreaming({
      readState: async () => {
        const result = await runCommandAsync(
          [
            'ssh',
            ...sshOpts,
            `root@${primaryIp}`,
            `kubectl exec -n vibecarbon supabase-supabase-db-0 -- psql -U supabase_admin -tAc "SELECT state FROM pg_stat_replication ORDER BY (state = 'streaming') DESC LIMIT 1"`,
          ],
          { silent: true, ignoreError: true },
        );
        return (typeof result === 'string' ? result : '').trim();
      },
      attempts: 3,
      delaysMs: [2000],
    }),
  );
  if (probe.streaming) {
    p.log.info('Standby already streaming (seeded at first boot), skipping the reseed');
    return { streaming: true, lastState: probe.lastState || 'streaming' };
  }

  // 4. Initialize standby as a streaming replica of the primary.
  // Runs pg_basebackup inside the standby pod, dialing the standby's OWN node
  // private IP on the repl-gateway relay port (REPL_GATEWAY_PORT=15433). That
  // intra-node hop is admitted by the additive allow-db-repl-gateway-egress
  // netpol; the standby gateway relays it through the WireGuard tunnel to the
  // primary gateway, which forwards to the primary postgres hostPort. Plaintext
  // (no PGSSLMODE/PGSSLROOTCERT) — WireGuard is the encryption layer.
  const primaryHost = _standbySupabasePrivateIp;
  const primaryPort = String(REPL_GATEWAY_PORT);
  const dbSts = 'supabase-supabase-db';
  const dbPod = 'supabase-supabase-db-0';

  // The standby streams through its LOCAL repl-gateway (own node private IP :
  // REPL_GATEWAY_PORT), NOT the primary's public IP. This explicit conninfo is
  // written INTO the staged basebackup (below) so it is present the moment the
  // reseeded PGDATA boots. Plaintext (sslmode=disable) — WireGuard encrypts the
  // wire. The password is delivered over stdin (never argv).
  const standbyConninfo = buildPrimaryConninfo({
    primaryHost: _standbySupabasePrivateIp,
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
  // RWO PVC attaches. We also carry the db subPath (the chart mounts the PVC at
  // /var/lib/postgresql/data via subPath postgres-data → PGDATA on the raw
  // volume is <mount-root>/<subPath>) and the db image (reused so it is already
  // pulled on the node).
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
  // Probe retry budget (RCA 2026-07-06 e4 rig): step 3 deleted the primary db
  // pod moments ago, and the in-pod pg_isready wait can pass before the
  // hostPort→relay path is reachable again — a single-shot probe then skips the
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
        `standby supabase-db pod did not terminate within budget after scale-to-zero, ` +
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
            `WireGuard tunnel (wg show) on both supabase nodes.`,
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
  // minutes (volume reattach + the 4 init containers + backup recovery ran
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
          // -c supabase-db: without it kubectl prepends a 'Defaulted container
          // ...' stderr notice which the 2>&1 fold (needed to capture psql
          // FATAL details for config-error classification) would mix into the
          // output — the old strict === 't' match then never succeeded on this
          // multi-init-container pod and every reseed "timed out" while the
          // standby was recovering fine underneath.
          `kubectl exec -n vibecarbon ${dbPod} -c supabase-db -- psql -U supabase_admin -tAc 'SELECT pg_is_in_recovery()' 2>&1 || true`,
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
    // "Hot standby mode is disabled" is a CONFIG error (hot_standby=off won —
    // the image's wal-g.conf ships it off and the staged auto.conf override
    // did not take), NOT a timing issue: waiting longer can never fix it.
    if (lastRecoveryOut.includes('Hot standby mode is disabled')) {
      throw new Error(
        `standby reseed: the standby is streaming but refusing read-only connections ` +
          `("Hot standby mode is disabled") — hot_standby is OFF in its effective config ` +
          `(the image's wal-g.conf ships hot_standby=off; the staged postgresql.auto.conf ` +
          `must override it with hot_standby = on). Config error, not a timing issue.`,
      );
    }
    throw new Error(
      `standby reseed swapped in a fresh basebackup but the standby never entered ` +
        `recovery mode within the budget; the reseeded PGDATA is not replaying from ` +
        `the primary (check the standby supabase-db logs and the repl-gateway tunnel).`,
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
            `kubectl exec -n vibecarbon supabase-supabase-db-0 -- psql -U supabase_admin -tAc "SELECT state FROM pg_stat_replication ORDER BY (state = 'streaming') DESC LIMIT 1"`,
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

  return { streaming, lastState };
}
