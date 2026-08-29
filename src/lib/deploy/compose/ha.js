/**
 * Docker Compose HA Deployment Module
 *
 * Deploys Vibecarbon to 2 VPS in different regions with:
 * - Docker Compose on both servers
 * - PostgreSQL streaming replication (primary → standby)
 * - Cloudflare health checks + failover (or manual DNS instructions)
 *
 * Available on the Fullerene tier.
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { reapChallengeRecords } from '../../acme-challenge.js';
import { exitCancelled, exitDeclined } from '../../cli/exit-guard.js';
import { c } from '../../colors.js';
import { saveProjectConfig } from '../../config.js';
import { environmentServerNames } from '../../destroy/server-naming.js';
import {
  DNS_PROVIDERS,
  findZoneForDomain,
  getDnsProvider,
  hasAutomatedDns,
  resolveDnsToken,
} from '../../dns-provider.js';
import { providerFor, providerIdFor } from '../../providers/index.js';
import { armComposeAcme, disarmComposeAcme } from '../acme-role.js';
import {
  buildNodePgdataSwapScript,
  buildPrimaryConninfo,
  buildReplicationHbaLines,
  buildStagedBasebackupScript,
  REPL_PORT,
} from '../replication.js';
import { mergeRemoteDotenv, pinnedSshOptsString, readReplPassword } from '../utils.js';
import {
  assertWalgBackupsWorking,
  composeWalgAuditShell,
  WALG_AUDIT_PROBE_TIMEOUT_MS,
} from '../walg-audit.js';
import { composeDbRecreateShell, WALG_ROLE_ENV, walgRoleDegradedMessage } from '../walg-role.js';
import {
  exchangeAndBringUpTunnel,
  REPL_GATEWAY_PORT,
  WG_PRIMARY_IP,
  WG_SUBNET_CIDR,
} from '../wireguard.js';
import { composeHaFailoverRecoveryInstructions } from './ha-role-swap.js';
import { sshRun, sshRunAsync, sshRunChecked } from './index.js';

/**
 * Resolve the VPS set that destroyComposeHA should delete.
 *
 * envConfig.servers is the canonical source when deploy completed and wrote
 * it back. But when deploy gets canceled after Pulumi creates the VMs and
 * before envConfig is persisted (the 2026-05-16 compose-ha matrix stall at
 * "Waiting for primary services to initialize"), .vibecarbon.json never
 * gets the IDs — destroy then sees `servers: []`, deletes nothing, and the
 * test runner's orphan sweep has to mop up the leak.
 *
 * Fall back to name-based discovery: the Pulumi program names servers
 * deterministically as `${projectName}-${environment}-(primary|standby)`,
 * so a fresh Hetzner lookup recovers what envConfig is missing. Mirrors
 * the pattern already used for firewall cleanup below.
 *
 * The names walked are the WHOLE lifecycle family (server-naming.js), not just
 * the deploy's pair. `scale` provisions its blue-green replacement outside
 * Pulumi as `<name>-new` and only renames it on success, so a killed mid-scale
 * run leaves a live server under a name the deploy never creates — and, since
 * it was never a Pulumi resource, in no state file either. Walking only the
 * deploy's two names is how a destroy shipped a clean leak report over two
 * running VMs on 2026-08-10.
 *
 * A `-new` name is checked even when the permanent server is already known:
 * mid-scale, BOTH exist (scale persists the swap only after it completes), so
 * "we already have the primary" says nothing about its replacement.
 *
 * Exported for unit-test access; in production it's called only from
 * destroyComposeHA.
 *
 * @param {object} args
 * @param {string} args.projectName
 * @param {string} args.environment
 * @param {object} args.envConfig
 * @param {import('../../providers/base.js').BaseProvider|null} args.provider
 * @returns {Promise<Array<{id: number|string, name?: string, providerServerName?: string}>>}
 */
export async function resolveHaServers({ projectName, environment, envConfig, provider }) {
  const expectedNames = environmentServerNames({
    projectName,
    environment,
    roles: (envConfig?.servers || []).map((s) => s?.role),
  });

  const knownById = new Map(
    (envConfig?.servers || []).filter((s) => s?.id && provider).map((s) => [String(s.id), s]),
  );

  if (!provider) return Array.from(knownById.values());

  for (const name of expectedNames) {
    const alreadyKnown = [...knownById.values()].some(
      (s) => s.providerServerName === name || s.name === name,
    );
    if (alreadyKnown) continue;
    try {
      const found = await provider.findServersByName(name);
      for (const server of found) {
        knownById.set(String(server.id), { id: server.id, name, providerServerName: name });
      }
    } catch {
      // Discovery is best-effort — keep moving with whatever envConfig had.
    }
  }

  return Array.from(knownById.values());
}

// ============================================================================
// POSTGRESQL STREAMING REPLICATION SETUP
// ============================================================================

// WAL-G / ARCHIVING DOVETAIL INVARIANTS (wal-g unify, 2026-05-31)
//
// Invariant 1 — archiving survives failover.
//   carbon/docker-compose.yml hardcodes `archive_mode=on` and
//   `archive_command=bash /etc/postgresql/wal-archive.sh %p` in the db
//   container's `command:`. A promoted standby runs the SAME image/command,
//   so it starts archiving WAL on the new timeline immediately after promotion.
//   No extra step is needed.
//   WALG_S3_PREFIX is derived from S3_BACKUP_BUCKET + PROJECT_NAME (see
//   docker-compose.yml:197) and is identical on both nodes — same .env is
//   deployed to both servers via setupServerFiles. The WAL timeline is therefore
//   continuous across failover: pre-promotion WAL is on TL1, post-promotion WAL
//   is on TL2, both under the same S3 prefix.
//   Note: a PostgreSQL standby with archive_mode=on does NOT archive while it is
//   in recovery — only the primary archives. There is no double-archive risk
//   before failover.
//
// Invariant 2 — backup guard means only the active primary backs up.
//   carbon/backup/compose-backup.sh checks `pg_is_in_recovery()='f'` before
//   calling `wal-g backup-push` (and self-skips with exit 0 when no S3 backup
//   target / credentials are configured). Before failover: standby cron is a
//   no-op; primary cron backs up. After failover: promoted standby cron backs
//   up; old primary (if still alive) is now a standby, so its cron is a no-op.
//   The scheduled backup cron is installed on BOTH nodes at the end of the
//   compose-ha deploy (see the setupComposeBackupCron fan-out after
//   replication verification in effects/compose-ha.js). The standby's cron is a guarded no-op until it is promoted —
//   installing on both means the survivor always has the cron after a failover,
//   so scheduled backups don't silently stop when DNS flips to the standby.
//
// Invariant 3 — restore seeds the primary; standby is REBUILT afterward.
//   compose restore (restoreCompose in compose/index.js) rewinds the primary's
//   data directory and replays WAL from S3. A standby that was streaming from the
//   old (pre-restore) primary then has WAL *ahead* of the restored primary's LSN
//   and CANNOT resume streaming — PG would reject it with "requested timeline
//   does not contain minimum recovery point" (timeline divergence). The correct
//   post-restore sequence is:
//     1. Restore the primary (restoreCompose → backup-fetch + archive recovery).
//     2. Re-seed the standby via configureStandbyReplication (pg_basebackup
//        from the now-restored primary). This wipes the diverged standby state
//        and brings it in sync with the new primary timeline.
//   This is wired in restore.js:runComposeRestore — after restoreCompose on the
//   primary, it re-runs configureStandbyReplication against the standby whenever
//   deployMode === 'compose-ha' (skipped for single-region compose, which has no
//   standby). configureStandbyReplication is exported from this file for that.

/**
 * Build the compose replication overlay (`docker-compose.replication.yml`) for
 * ONE node, with that node's own WireGuard tunnel IP baked into the relay.
 *
 * Two pieces:
 *   1. `db` publishes the raw replication port (REPL_PORT=5433 → container 5432)
 *      so the local socat relay has a plaintext postgres to forward to
 *      (supavisor owns 5432 and can't speak the replication protocol).
 *   2. `repl-gateway` — a socat relay on the HOST network namespace (so it sees
 *      the host's `wg0`, brought up by exchangeAndBringUpTunnel) that binds this
 *      node's OWN tunnel IP (`selfWgIp:REPL_GATEWAY_PORT`) and forwards to the
 *      local db (`127.0.0.1:REPL_PORT`). Binding the tunnel IP (not 0.0.0.0)
 *      means the relay is reachable ONLY over wg0 — never on the public IP — so
 *      it needs no firewall rule of its own. NO `NET_ADMIN`/in-container
 *      WireGuard: the tunnel lives on the host, the container is a pure relay.
 *      `restart: unless-stopped` so a transient socat exit self-heals.
 *
 * Each node self-exposes its LOCAL db at `<self-tunnel-ip>:REPL_GATEWAY_PORT`,
 * which makes the transport symmetric for failover: whichever node is currently
 * standby dials the current primary's tunnel IP over wg0 (docker bridge → host
 * wg0), and the promoted node already exposes its db on its own tunnel IP.
 *
 * @param {string} selfWgIp - this node's WireGuard tunnel IP (WG_PRIMARY_IP on
 *   the primary, WG_STANDBY_IP on the standby)
 * @returns {string} the YAML overlay content
 */
/**
 * socat image for the replication gateway. Pinned rather than floating: this
 * container relays Postgres replication over the WireGuard tunnel, and an
 * untagged `alpine/socat` meant each node cached whatever `:latest` resolved to
 * on ITS first pull, so two nodes in one HA pair could run different builds.
 *
 * LOCKSTEP: must match the tag in
 * carbon/k8s/base/repl-gateway/repl-gateway.yaml (the k8s-tier gateway).
 * tests/unit/deploy/socat-pin.test.ts fails the build if they drift.
 */
export const SOCAT_IMAGE_TAG = '1.8.1.3';

export function buildReplicationOverlay(selfWgIp) {
  return `version: "3.8"
services:
  db:
    ports:
      - "${REPL_PORT}:5432"
  repl-gateway:
    image: alpine/socat:${SOCAT_IMAGE_TAG}
    network_mode: host
    restart: unless-stopped
    command:
      - "TCP-LISTEN:${REPL_GATEWAY_PORT},bind=${selfWgIp},fork,reuseaddr"
      - "TCP:127.0.0.1:${REPL_PORT}"
`;
}

// The compose flags that include the replication overlay so `up`/`restart`
// against the repl-gateway service resolves it. Exported so the compose-ha
// deploy effects (write-replication-overlay) build the identical file set.
export const REPL_COMPOSE_FLAGS =
  '-f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.replication.yml';

/**
 * Configure the primary PostgreSQL server for streaming replication.
 *
 * 1. Bring up the point-to-point WireGuard tunnel (host wg0, UDP 51821) between
 *    the two nodes and start the primary's `repl-gateway` socat relay
 * 2. Create a dedicated replication user
 * 3. Allow replication from the WireGuard tunnel subnet in pg_hba.conf (plain
 *    `host` — WireGuard encrypts the wire, so Postgres doesn't also need TLS)
 * 4. Set wal_level=replica and max_wal_senders
 * 5. Restart PostgreSQL to apply changes
 */
export async function configurePrimaryReplication(primaryIp, standbyIp, sshKeyPath, projectName) {
  const remoteDir = `/opt/${projectName}`;

  // Establish the WireGuard replication transport. Keys are generated on-node
  // (private key never leaves the node); only the derived public keys transit
  // the orchestrator. Endpoints/SSH targets are the two VPS PUBLIC IPs. This
  // must run BEFORE starting the socat relay, since the relay binds the tunnel
  // IP (10.99.0.x) which only exists once `wg0` is up.
  await exchangeAndBringUpTunnel({ primaryIp, standbyIp, sshKeyPath });

  // Start the primary's repl-gateway (socat, host netns). The overlay file was
  // written to the node earlier in the deploy flow; `up -d repl-gateway` binds
  // WG_PRIMARY_IP:REPL_GATEWAY_PORT → 127.0.0.1:REPL_PORT now that wg0 exists.
  await sshRunChecked(
    primaryIp,
    sshKeyPath,
    `cd ${remoteDir} && docker compose ${REPL_COMPOSE_FLAGS} up -d repl-gateway 2>&1`,
    { timeout: 60_000, what: "primary's repl-gateway start" },
  );
  // replPassword is generated at create time from crypto.randomBytes and is
  // restricted to base64url characters — no shell escaping needed.
  // Read from process.env first (CI), then .env.local (the `vibecarbon create`
  // default write target). Without the .env.local fallback, HA deploys fail
  // the moment the CLI is invoked without the env var pre-exported.
  const replPassword = readReplPassword();
  if (!replPassword) {
    throw new Error(
      'REPL_PASSWORD is not set in process.env or .env.local. Regenerate your .env.local or run `vibecarbon configure` — HA deploys require a replication password generated at create time.',
    );
  }

  // Create or update replication user + physical replication slot.
  //
  // Without a replication slot, the standby's WAL follow position isn't
  // persisted on the primary — if the standby falls behind by more than
  // `wal_keep_size` (512MB), primary recycles WAL segments and streaming
  // breaks silently. The standby keeps appearing "up" but stops receiving
  // updates. A physical slot (vibecarbon_standby_slot) tells primary to
  // hold WAL until the standby confirms receipt, closing the drift
  // window.
  //
  // The SQL (which embeds the replication password) is piped to psql via STDIN
  // (`input:`), so it never appears in argv / the ssh command string / the
  // remote shell's /proc/cmdline. `docker compose exec -T` forwards our stdin
  // straight into psql.
  const createRoleSql = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'replicator') THEN
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${replPassword}';
  ELSE
    ALTER ROLE replicator WITH PASSWORD '${replPassword}';
  END IF;
END $$;

-- Create the physical replication slot if missing. pg_create_physical_replication_slot
-- returns a row when successful, so wrap in a DO block that swallows the
-- 'already exists' error for idempotent reruns.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_replication_slots WHERE slot_name = 'vibecarbon_standby_slot'
  ) THEN
    PERFORM pg_create_physical_replication_slot('vibecarbon_standby_slot');
  END IF;
END $$;
`;
  await sshRunChecked(
    primaryIp,
    sshKeyPath,
    `cd ${remoteDir} && docker compose exec -T db psql -U supabase_admin -d postgres`,
    { timeout: 30_000, input: createRoleSql, what: 'replicator role + replication slot creation' },
  );

  // Update pg_hba.conf to allow replication from the WireGuard tunnel subnet
  // (WG_SUBNET_CIDR) AND from the db container's docker network subnet(s).
  //
  // WHY the bridge subnet: the replication connection is relayed — standby db
  // → host wg0 → primary socat (host netns) → 127.0.0.1:5433 published port →
  // docker-proxy NAT into the db container — so the primary's postgres sees
  // the PROJECT NETWORK'S BRIDGE GATEWAY as the source, not a tunnel IP (same
  // NAT-source class as the k8s pod-CIDR RCA 2026-07-06; the pg_isready probe
  // cannot catch this — it never authenticates, so it sails through pg_hba).
  // Resolve the db container's ACTUAL network subnets live via docker
  // inspect; fall back to docker's default-address-pool supernet
  // (172.16.0.0/12) only if resolution yields nothing.
  //
  // Security: bridge subnets are host-internal, non-routable sources; the only
  // cross-host path into them remains the WireGuard tunnel (UDP 51821, peer-
  // scoped firewall), and auth remains scram-sha-256 with the per-deploy
  // random REPL_PASSWORD.
  //
  // The supabase/postgres image overrides hba_file to
  // /etc/postgresql/pg_hba.conf (NOT the default
  // /var/lib/postgresql/data/pg_hba.conf). RCA: compose-ha 2026-05-01 fanout12
  // — appended to the wrong file, postgres never saw the rule, every
  // replication connection was rejected with "no pg_hba.conf entry" while
  // pg_hba_file_rules reflected the actual /etc loaded contents (no replicator
  // entry). Resolve the path at runtime via SHOW hba_file so we don't break
  // again if the image moves the file. Appends are idempotent (grep -qxF) so
  // re-deploys / failover re-seeds don't grow the file.
  const netOut = await sshRun(
    primaryIp,
    sshKeyPath,
    `cd ${remoteDir} && for NET in $(docker inspect -f '{{ range $k,$v := .NetworkSettings.Networks }}{{ $v.NetworkID }} {{ end }}' $(docker compose ps -q db)); do ` +
      `docker network inspect -f '{{ range .IPAM.Config }}{{ .Subnet }} {{ end }}' "$NET"; done`,
    { timeout: 30_000 },
  );
  const ipv4Cidr = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;
  const resolvedSubnets = [
    ...new Set(
      (typeof netOut === 'string' ? netOut : '')
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => ipv4Cidr.test(s)),
    ),
  ];
  const bridgeCidrs = resolvedSubnets.length > 0 ? resolvedSubnets : ['172.16.0.0/12'];
  const hbaLines = buildReplicationHbaLines([WG_SUBNET_CIDR, ...bridgeCidrs]);
  const hbaAppendCmds = hbaLines
    .map((l) => `grep -qxF '${l}' $HBA_FILE || echo '${l}' >> $HBA_FILE`)
    .join('; ');
  const hbaOut = await sshRun(
    primaryIp,
    sshKeyPath,
    `cd ${remoteDir} && HBA_FILE=$(docker compose exec -T db psql -U supabase_admin -d postgres -tAc 'SHOW hba_file;' | tr -d '[:space:]') && ` +
      `docker compose exec -T db sh -c "${hbaAppendCmds}; ` +
      `psql -U supabase_admin -d postgres -tAc 'SELECT pg_reload_conf();'"`,
    { timeout: 15_000 },
  );
  if (hbaOut === false) {
    // sshRun returns false on failure (it never throws). Without this check a
    // failed hba update surfaces only as the reseed's pg_basebackup FATAL
    // minutes later.
    throw new Error(
      `configurePrimaryReplication: updating pg_hba on ${primaryIp} failed; replication ` +
        `connections would be rejected with "no pg_hba.conf entry".`,
    );
  }

  // Set WAL settings for replication
  await sshRunChecked(
    primaryIp,
    sshKeyPath,
    `cd ${remoteDir} && docker compose exec -T db psql -U supabase_admin -d postgres -c "ALTER SYSTEM SET wal_level = 'replica';" && docker compose exec -T db psql -U supabase_admin -d postgres -c "ALTER SYSTEM SET max_wal_senders = 5;" && docker compose exec -T db psql -U supabase_admin -d postgres -c "ALTER SYSTEM SET wal_keep_size = '512MB';"`,
    { timeout: 30_000, what: 'WAL replication settings (ALTER SYSTEM)' },
  );

  // No app-layer TLS. Replication runs over the WireGuard tunnel (brought up
  // above), which encrypts the wire, so Postgres itself speaks plaintext — the
  // retired verify-ca transport's cert install + `ALTER SYSTEM SET ssl='on'`
  // are gone (public-IP-era plumbing).

  // Restart PostgreSQL to apply WAL changes
  await sshRunChecked(primaryIp, sshKeyPath, `cd ${remoteDir} && docker compose restart db`, {
    timeout: 60_000,
    what: 'primary db restart (to load the new WAL settings)',
  });

  // Wait for PostgreSQL to be ready again.
  //
  // This loop used to be `try { await sshRun(...); return; } catch { /* retry */ }`.
  // sshRun answers `false` and never throws, so the catch was unreachable and
  // the `return` fired unconditionally on the FIRST iteration — it waited for
  // nothing, and had no sleep either. configurePrimaryReplication then returned
  // while the restart above was still in flight, and the standby's
  // pg_basebackup raced a postmaster that was not yet accepting connections.
  for (let i = 0; i < 15; i++) {
    const ready = await sshRun(
      primaryIp,
      sshKeyPath,
      `cd ${remoteDir} && docker compose exec -T db pg_isready -h 127.0.0.1 -U postgres`,
      { timeout: 10_000 },
    );
    if (ready !== false) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `Primary PostgreSQL did not become ready on ${primaryIp} within ~30s of the ` +
      'WAL-settings restart; the standby base backup would race an unavailable postmaster.',
  );
}

/**
 * Configure the standby PostgreSQL server as a hot standby replica.
 *
 * 1. Stage pg_basebackup (with standby.signal + primary_conninfo) into a
 *    PGDATA subdir while the standby postgres is still running
 * 2. Resolve the db volume's host path, `docker compose stop db` (host-side)
 * 3. Atomically swap PGDATA on the HOST (shared buildNodePgdataSwapScript)
 * 4. `docker compose start db` and wait (loudly) for recovery mode
 */
export async function configureStandbyReplication(standbyIp, primaryIp, sshKeyPath, projectName) {
  const remoteDir = `/opt/${projectName}`;
  // replPassword is generated at create time from crypto.randomBytes and is
  // restricted to base64url characters — no shell escaping needed.
  // Read from process.env first (CI), then .env.local (the `vibecarbon create`
  // default write target). Without the .env.local fallback, HA deploys fail
  // the moment the CLI is invoked without the env var pre-exported.
  const replPassword = readReplPassword();
  if (!replPassword) {
    throw new Error(
      'REPL_PASSWORD is not set in process.env or .env.local. Regenerate your .env.local or run `vibecarbon configure` — HA deploys require a replication password generated at create time.',
    );
  }

  // Ensure the physical replication slot exists on the PRIMARY before the
  // standby streams. configurePrimaryReplication creates it at deploy time, but
  // a wal-g RESTORE overwrites the primary's PGDATA — which includes pg_replslot
  // — so the slot is wiped. The reseeded standby streams through this persistent
  // slot post-swap (primary_slot_name in its auto.conf); without it, it connects
  // and errors `replication slot "vibecarbon_standby_slot" does not exist` and
  // never streams. (The basebackup itself uses a TEMPORARY slot now — see
  // buildStagedBasebackupScript — so it no longer depends on this slot; streaming
  // does.) Idempotent (IF NOT EXISTS), so it's a safe no-op on the deploy path
  // where the slot already exists. RCA 2026-06-01: compose-ha failover after
  // wal-g restore.
  const ensureSlotSql = `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_replication_slots WHERE slot_name = 'vibecarbon_standby_slot'
  ) THEN
    PERFORM pg_create_physical_replication_slot('vibecarbon_standby_slot');
  END IF;
END $$;`;
  const ensureSlotB64 = Buffer.from(ensureSlotSql).toString('base64');
  await sshRunChecked(
    primaryIp,
    sshKeyPath,
    `cd ${remoteDir} && echo ${ensureSlotB64} | base64 -d | docker compose exec -T db psql -U supabase_admin -d postgres`,
    { timeout: 30_000, what: 'replication-slot re-create on the primary' },
  );

  // Start the standby's repl-gateway (socat, host netns). The tunnel (host wg0)
  // is already up — configurePrimaryReplication brought it up on both nodes at
  // deploy time, and it persists across the restore/re-seed re-entry. Binding
  // WG_STANDBY_IP:REPL_GATEWAY_PORT self-exposes the standby's LOCAL db over the
  // tunnel so the transport is symmetric after a failover (the promoted standby
  // is then the primary, and the old primary streams from WG_STANDBY_IP).
  await sshRunChecked(
    standbyIp,
    sshKeyPath,
    `cd ${remoteDir} && docker compose ${REPL_COMPOSE_FLAGS} up -d repl-gateway 2>&1`,
    { timeout: 60_000, what: "standby's repl-gateway start" },
  );

  // 2026-07-06 restructure (same bug class as the k8s reseed fix): the old flow
  // stopped db FIRST, then wiped + swapped PGDATA in-place from a throwaway
  // `docker compose run` container, with primary_conninfo appended as a script
  // tail. Any failure in that window (and sshRun's false-not-throw contract
  // swallowed them all — the old "silent:true makes sshRun THROW" comment
  // predates the async exec migration) left the standby restarting as a plain
  // independent primary with no standby.signal and no conninfo. New flow:
  //   1. STAGE the basebackup while the standby postgres is still RUNNING
  //      (`docker compose exec` into the live db container), into a staging
  //      subdir of PGDATA (on the db volume → same filesystem for an atomic
  //      host-side rename). standby.signal + the explicit primary_conninfo are
  //      written INTO the staging by the shared builder, so everything the
  //      standby needs exists before anything is stopped.
  //   2. Resolve the db volume's host mountpoint (while the container exists).
  //   3. Host-side `docker compose stop db` (with the replication overlay
  //      flags), atomic host-side PGDATA swap (shared buildNodePgdataSwapScript
  //      — same primitive as the k8s node-side swap), `start db`.
  //   4. The existing loud wait-for-recovery probe below.
  // Every step is sentinel-checked (sshRun returns false on failure — it does
  // NOT throw), so a failed stage/stop/swap aborts loudly instead of booting a
  // silently-independent standby.
  //
  // The connection targets the PRIMARY's WireGuard tunnel IP (WG_PRIMARY_IP) on
  // the repl-gateway relay port (REPL_GATEWAY_PORT), NOT the primary's public
  // IP: the standby db container reaches 10.99.0.1:15433 via the host's wg0
  // (docker bridge → host route → wg0), where the primary's socat relay
  // forwards to the primary db (127.0.0.1:REPL_PORT). WG_PRIMARY_IP is fixed to
  // whichever node is currently primary (exchangeAndBringUpTunnel assigns it),
  // so this stays correct across a role swap once failover re-establishes the
  // tunnel with swapped endpoints. probeFirst aborts cleanly (exit 0, nothing
  // staged, db never stopped) when the primary's gateway is unreachable.
  // Plaintext (no PGSSLMODE/PGSSLROOTCERT) — WireGuard is the encryption layer.
  const stagingDir = '/var/lib/postgresql/data/.reseed_staging';
  const basebackupScript = `${buildStagedBasebackupScript({
    replPassword,
    primaryHost: WG_PRIMARY_IP,
    primaryPort: String(REPL_GATEWAY_PORT),
    probeFirst: true,
    swap: false,
    stagingDir,
    // Pin primary_conninfo explicitly in the STAGING dir (last entry in
    // postgresql.auto.conf wins): pg_basebackup -R records a conninfo from the
    // backup connection, but we write our own anyway so it's byte-identical to
    // what the shared builder produces.
    primaryConninfo: buildPrimaryConninfo({
      primaryHost: WG_PRIMARY_IP,
      port: REPL_GATEWAY_PORT,
      replPassword,
    }),
    label: 'compose-ha-repl',
  })}
echo COMPOSE_RESEED_STAGED
`;
  // Stage into the RUNNING db container. Use bash, not sh: the supabase/postgres
  // image symlinks /bin/sh → dash, which rejects `set -o pipefail` and silently
  // neuters every failure check (RCA: compose-ha 2026-05-01 fanout10 failover).
  // The script (which embeds the replication password in PGPASSWORD +
  // primary_conninfo) is piped to bash via STDIN (`input:`), so it never appears
  // in argv / the ssh command string. `-T` forwards stdin. `|| true` keeps the
  // remote exit 0 so sshRun returns the OUTPUT even on failure (instead of a
  // detail-free `false`) — success/skip/failure is classified via the sentinel
  // marker + the probe's skip message.
  const stageOut = await sshRun(
    standbyIp,
    sshKeyPath,
    `cd ${remoteDir} && docker compose ${REPL_COMPOSE_FLAGS} exec -T db bash 2>&1 || true`,
    // 300s basebackup budget + the probe's retry budget (12 × 10s ≈ 2 min) —
    // the probe must never eat into the basebackup's transfer window.
    { timeout: 420_000, input: basebackupScript },
  );
  const stageText = typeof stageOut === 'string' ? stageOut : '';
  if (stageText.includes('skipping pg_basebackup')) {
    // probeFirst skip: primary gateway unreachable from the standby db
    // container. Nothing was staged and the db was never stopped — the standby
    // keeps serving its independent postgres. Loud (the caller decides whether
    // to warn-and-continue), and faster than burning the 180s recovery budget.
    throw new Error(
      `configureStandbyReplication: primary's repl-gateway (${WG_PRIMARY_IP}:${REPL_GATEWAY_PORT}) ` +
        `is not reachable from the standby db container: pg_basebackup skipped, standby ` +
        `left untouched. Check the WireGuard tunnel (wg show) and the repl-gateway ` +
        `services on both nodes.`,
    );
  }
  if (!stageText.includes('COMPOSE_RESEED_STAGED')) {
    throw new Error(
      `configureStandbyReplication: staging the basebackup on ${standbyIp} failed. The ` +
        `standby db is still running on its previous PGDATA (nothing was stopped or ` +
        `swapped).\n--- staging output ---\n${stageText.trim() || '(no output)'}`,
    );
  }

  // Resolve the db volume's HOST mountpoint BEFORE stopping — docker inspect
  // needs the container, and the host-side swap below needs the node-local
  // PGDATA path. `.Source` of the /var/lib/postgresql/data mount is the named
  // volume's _data dir on the host filesystem.
  const volOut = await sshRun(
    standbyIp,
    sshKeyPath,
    `cd ${remoteDir} && docker inspect -f ` +
      `'{{ range .Mounts }}{{ if eq .Destination "/var/lib/postgresql/data" }}{{ .Source }}{{ end }}{{ end }}' ` +
      `"$(docker compose ${REPL_COMPOSE_FLAGS} ps -q db)"`,
    { timeout: 30_000 },
  );
  const pgdataHostPath = typeof volOut === 'string' ? volOut.trim() : '';
  if (!pgdataHostPath.startsWith('/')) {
    throw new Error(
      `configureStandbyReplication: could not resolve the standby db volume's host path ` +
        `(docker inspect returned ${JSON.stringify(pgdataHostPath)}). Refusing to stop the ` +
        `db without a swap target, standby left running on its previous PGDATA.`,
    );
  }

  try {
    // Host-side, kubelet-free equivalent of the k8s scale-to-zero: compose owns
    // the container lifecycle (never an in-container pg_ctl stop — postgres is
    // the container's PID 1, so that kills the container out from under us).
    // Include the replication overlay flags so the compose file set matches
    // every other db invocation in the HA flow (walg gotcha: an overlay-less
    // recreate drops the 5433 mapping; stop/start don't recreate, but keep the
    // file set consistent anyway).
    const stopRes = await sshRun(
      standbyIp,
      sshKeyPath,
      `cd ${remoteDir} && docker compose ${REPL_COMPOSE_FLAGS} stop db`,
      { timeout: 120_000 },
    );
    if (stopRes === false) {
      throw new Error(
        `configureStandbyReplication: 'docker compose stop db' failed on ${standbyIp} — ` +
          `refusing the host-side PGDATA swap while the db may still be running.`,
      );
    }

    // Atomic host-side swap (shared primitive with the k8s node-side swap):
    // verified staging → three same-filesystem renames; the previous PGDATA
    // survives at <path>.old until the next reseed. No secrets in this script.
    const swapOut = await sshRun(standbyIp, sshKeyPath, 'bash -s 2>&1', {
      timeout: 60_000,
      input: buildNodePgdataSwapScript({ pgdataDir: pgdataHostPath }),
    });
    const swapText = typeof swapOut === 'string' ? swapOut : '';
    if (!swapText.includes('RESEED_SWAPPED')) {
      // The stage step verified the staging above, so SKIPPED (or any failure)
      // here means it vanished/corrupted between steps — a real failure. The
      // old PGDATA is untouched (the swap is ordered rename-last).
      throw new Error(
        `configureStandbyReplication: host-side PGDATA swap did not complete on ` +
          `${standbyIp}; the standby keeps its previous PGDATA.\n--- swap output ---\n` +
          `${swapText.trim() || '(no output)'}`,
      );
    }
  } finally {
    // Always start the db back up — on any failure above the previous PGDATA is
    // intact and boots the standby's prior state (sshRun never throws, so this
    // best-effort start cannot mask the in-flight error).
    await sshRun(
      standbyIp,
      sshKeyPath,
      `cd ${remoteDir} && docker compose ${REPL_COMPOSE_FLAGS} start db`,
      { timeout: 120_000 },
    );
  }

  // Verify the standby is in recovery mode.
  //
  // Two independent signals — either is sufficient:
  //   1. standby's pg_is_in_recovery() returns 't' (requires hot_standby on
  //      AND consistent recovery state — can take 60-180s after fresh
  //      basebackup of a Supabase cluster, especially under fanout-3 load)
  //   2. primary's pg_stat_replication has a row with client_addr matching
  //      this standby AND state in ('streaming','catchup','startup')
  //
  // The standby probe alone is fragile: with hot_standby still applying
  // initial WAL, psql gets "Hot standby mode is disabled / database system
  // is not accepting connections" — sshRun returns false (without
  // silent:true), result becomes empty, the 60s budget burns through, and
  // failover (which calls this function for re-seed) hard-fails with
  // "did not enter recovery mode" even though the standby is fine.
  //
  // RCA: compose-ha 2026-05-01 fanout13 — replication was actively
  // streaming (verifyReplication on the primary saw "Streaming replication
  // active") but failover's re-seed still aborted because the standby's
  // psql probe returned empty for the entire 60s. Bumped the budget to
  // 180s and added the primary-side signal.
  const PROBE_BUDGET_S = 180;
  const PROBE_INTERVAL_S = 3;
  let lastProbeResult = '';
  let lastPrimarySignal = '';
  for (let i = 0; i < PROBE_BUDGET_S / PROBE_INTERVAL_S; i++) {
    try {
      const result = await sshRun(
        standbyIp,
        sshKeyPath,
        `cd ${remoteDir} && docker compose exec -T db psql -U supabase_admin -d postgres -tAc 'SELECT pg_is_in_recovery()'`,
        { timeout: 10_000 },
      );
      lastProbeResult = typeof result === 'string' ? result.trim() : '';
      if (lastProbeResult === 't') return true;
    } catch {
      // Retry — database may still be applying initial WAL, hot_standby off
    }
    try {
      const primaryResult = await sshRun(
        primaryIp,
        sshKeyPath,
        `cd ${remoteDir} && docker compose exec -T db psql -U supabase_admin -d postgres -tAc "SELECT state FROM pg_stat_replication WHERE client_addr = '${standbyIp}'::inet"`,
        { timeout: 10_000 },
      );
      lastPrimarySignal = typeof primaryResult === 'string' ? primaryResult.trim() : '';
      if (
        lastPrimarySignal === 'streaming' ||
        lastPrimarySignal === 'catchup' ||
        lastPrimarySignal === 'startup'
      ) {
        return true;
      }
    } catch {
      // Retry
    }
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_S * 1000));
  }

  throw new Error(
    `configureStandbyReplication: standby ${standbyIp} did not enter recovery mode ` +
      `within ${PROBE_BUDGET_S}s after pg_basebackup. Last standby pg_is_in_recovery() = ` +
      `${JSON.stringify(lastProbeResult)}, last primary pg_stat_replication.state for this ` +
      `standby = ${JSON.stringify(lastPrimarySignal)}. SSH in and check: docker compose exec ` +
      `db psql -U supabase_admin -d postgres -tAc 'SELECT pg_is_in_recovery()' and ` +
      `ls /var/lib/postgresql/data/standby.signal`,
  );
}

// ============================================================================
// FIREWALL: OPEN REPLICATION PORT BETWEEN SERVERS
// ============================================================================

/**
 * Open the WireGuard tunnel port (UDP 51821) from the HA peer in UFW.
 *
 * Replication no longer traverses a public TCP port — it runs over a
 * point-to-point WireGuard tunnel between the two nodes' public IPs. The only
 * inbound the peer needs is the WG handshake/data on UDP 51821 (51820 is
 * flannel-wg's in k3s; compose uses 51821 for parity). Scoped to the peer's IP,
 * never the public internet. The raw replication port (5433) is no longer
 * exposed to the peer at the host firewall — the socat relay binds the tunnel
 * IP and is reachable only over wg0.
 */
export async function openWireguardPortUfw(ip, peerIp, sshKeyPath) {
  await sshRunAsync(ip, sshKeyPath, `ufw allow from ${peerIp} to any port 51821 proto udp`, {
    timeout: 15_000,
  });
}

/**
 * Open the WireGuard tunnel port (UDP 51821) scoped to the peer's IP on a
 * server's Hetzner Cloud firewall. UFW alone isn't enough — the Cloud Firewall
 * sits in front of the host and drops the packet before it ever reaches UFW.
 * Without this, the WG handshake from the peer never lands, the tunnel never
 * comes up, and pg_basebackup over the relay times out.
 *
 * The Pulumi-managed firewall (src/lib/iac/programs/hetzner-compose.js) only
 * declares 22/80/443 because the peer's IP isn't known at stack-up time. Patch
 * in the UDP 51821 rule here, after both stacks are up. Uses the provider's
 * own buildReplicationFirewallRules (see BaseProvider's doc — moved onto the
 * provider class since the rule-JSON shape is provider wire knowledge) so
 * compose-ha and k8s-ha compute the exact same rule set for a given provider
 * (peer-scoped udp/51821 + Hetzner's scrub of stale tcp 5432/5433/30432 rules
 * from the retired public-IP TLS transport).
 *
 * Idempotent: buildReplicationFirewallRules returns null when the rule already
 * exists and no stale rules remain. Non-fatal on error — the deploy continues
 * with a warning; HA replication just won't work until 51821 is open (B0-1:
 * previously the docstring claimed this but any throw aborted the deploy
 * through haSetupServerFiles' bare Promise.all, and a non-2xx set_rules was
 * silently swallowed — both now land in the warning path).
 */
export async function openWireguardPortHetznerFirewall(serverName, peerIp, provider) {
  if (!provider) return;
  const firewallName = `${serverName}-firewall`;
  try {
    const firewall = await provider.findFirewallByName(firewallName);
    if (!firewall) return;
    const updatedRules = provider.buildReplicationFirewallRules(firewall, peerIp);
    if (!updatedRules) return; // already correct
    await provider.setFirewallRules(firewall.id, updatedRules);
  } catch (err) {
    p.log.warn(
      `Could not open WireGuard port 51821 on cloud firewall ${firewallName}: ${err.message}. ` +
        `HA replication won't work until UDP 51821 is open to the peer.`,
    );
  }
}

/**
 * Check whether the primary server is reachable and its Postgres accepting
 * connections. Short timeout — the failover flow needs to decide in seconds
 * whether to attempt a re-seed or skip it and promote with current state.
 *
 * Returns true only when both the SSH connection works AND Postgres inside
 * the db container reports ready. A firewall-level reachable + Postgres-
 * unhealthy state should be treated the same as unreachable, since a
 * re-seed would stall.
 */
async function isPrimaryReachable(primaryIp, sshKeyPath, remoteDir) {
  try {
    const result = await sshRun(
      primaryIp,
      sshKeyPath,
      `cd ${remoteDir} && docker compose exec -T db pg_isready -h 127.0.0.1 -U postgres -t 3`,
      { timeout: 10_000 },
    );
    return result?.includes('accepting connections') ?? false;
  } catch {
    return false;
  }
}

/**
 * Is the standby ALREADY streaming, read from the STANDBY side (compose)?
 *
 * Queries pg_stat_wal_receiver.status inside the standby's db container — the
 * standby's own view of its walreceiver. Returns true only when
 * status='streaming'. Used by failover to SKIP the pre-promotion re-seed: an
 * already-streaming standby is in-parity with the primary, so the basebackup is
 * wasted RTO, and its live walreceiver holds the persistent replication slot
 * (a `pg_basebackup -S <slot>` against it would error "slot is active"). The
 * standby-side signal is preferred because failover often runs when the primary
 * is unreachable. Non-throwing — any failure returns false so the caller falls
 * back to a normal re-seed. Exported for unit-test access.
 */
export async function isComposeStandbyStreaming(standbyIp, sshKeyPath, remoteDir) {
  try {
    const result = await sshRun(
      standbyIp,
      sshKeyPath,
      `cd ${remoteDir} && docker compose exec -T db psql -U supabase_admin -d postgres -tAc 'SELECT status FROM pg_stat_wal_receiver'`,
      { silent: true, timeout: 10_000 },
    );
    return (typeof result === 'string' ? result : '').trim() === 'streaming';
  } catch {
    return false;
  }
}

// ============================================================================
// DESTROY
// ============================================================================

/**
 * Destroy a Compose HA environment (both VPS, firewalls, SSH keys, DNS/LB)
 *
 * EVERY delete below runs under `Promise.allSettled` on purpose: one refusal
 * must not strand the rest of the teardown. What changed is that the
 * settlements are no longer DISCARDED. They are collected and returned, because
 * `allSettled` + a caller that never inspected the results is precisely how a
 * compose-ha destroy could leave both servers, three firewalls and the shared
 * SSH key running and still report "Compose HA environment destroyed" with exit
 * 0 (the 2026-07-22 leak class). destroy.js folds the returned verdicts into
 * its leak report and exit code.
 *
 * @param {object} options
 * @param {string} options.projectName
 * @param {string} options.environment
 * @param {object} options.envConfig
 * @param {string} options.providerToken
 * @param {Function} [options.onProgress]
 * @returns {Promise<{ leaks: Array<{ resourceClass: string, resource: string, reason: string }> }>}
 *   One entry per resource this teardown could not confirm gone. Empty on a
 *   clean teardown.
 */
export async function destroyComposeHA(options) {
  const { projectName, environment, envConfig, providerToken, onProgress = () => {} } = options;

  const sshKeyPath = join(process.cwd(), '.vibecarbon', `deploy_key_${environment}`);
  const provider = new (providerFor(envConfig))(providerToken);

  /** @type {Array<{ resourceClass: string, resource: string, reason: string }>} */
  const leaks = [];
  const noteLeak = (resourceClass, resource, reason) =>
    leaks.push({ resourceClass, resource, reason });

  // Stop compose services on both servers in parallel
  onProgress('Stopping services on all servers...');
  if (existsSync(sshKeyPath)) {
    await Promise.allSettled(
      (envConfig.servers || [])
        .filter((s) => s.ip)
        .map((server) =>
          sshRunAsync(
            server.ip,
            sshKeyPath,
            `cd /opt/${projectName} && docker compose down -v --remove-orphans 2>/dev/null; rm -rf /opt/${projectName}`,
            { timeout: 120_000, ignoreError: true },
          ),
        ),
    );
  }

  // Delete both VPS in parallel.
  //
  // Hetzner's DELETE /servers/{id} is async: it returns 202 immediately
  // and the actual VM removal continues for several seconds afterwards.
  // The previous code only awaited the 202 — Pulumi state was wiped
  // moments later when the S3 bucket got deleted, then compose-ha
  // restore re-ran the deploy with a fresh Pulumi stack and tried to
  // create a server with the same `${projectName}-${environment}-primary`
  // name. Hetzner rejected with HTTP 409 'server name is already used
  // (uniqueness_error)' because the old VM was still draining
  // (observed in compose-ha restore matrix runs).
  //
  // provider.deleteServer(id, {waitUntilGone: true}) (C10a) issues the
  // DELETE and then polls GET /servers/{id} itself until it returns 404
  // (90s budget, 2s interval — same numbers this file used inline before).
  // Running one such call per server under Promise.allSettled is
  // concurrency-equivalent to the old batch-DELETE-then-shared-poll-loop:
  // both dispatch every server's DELETE immediately and both cap total wall
  // time at ~90s regardless of server count. A rejected deleteServer (a
  // non-404 DELETE error) is swallowed by allSettled exactly as the old
  // `.catch(() => {})` on the DELETE swallowed it — the caller never
  // inspects settlement results either way.
  onProgress('Deleting VPS...');
  const serversToDelete = await resolveHaServers({
    projectName,
    environment,
    envConfig,
    provider,
  });
  if (serversToDelete.length > 0) {
    onProgress('Waiting for VPS deletion to complete...');
  }
  const serverOutcomes = await Promise.allSettled(
    serversToDelete.map((server) => provider.deleteServer(server.id, { waitUntilGone: true })),
  );
  serverOutcomes.forEach((outcome, index) => {
    if (outcome.status !== 'rejected') return;
    const server = serversToDelete[index];
    noteLeak(
      'server',
      `${server.name ?? `id ${server.id}`}${server.name ? ` (id ${server.id})` : ''}`,
      `delete failed: ${outcome.reason?.message ?? outcome.reason}`,
    );
  });

  // Delete firewalls — delete matching in parallel.
  // The Pulumi program (hetzner-compose.js) names firewalls
  //   `${projectName}-${stackEnv}-firewall`
  // where stackEnv is `${environment}-primary` or `${environment}-standby`
  // (set by the compose-ha deploy in effects/compose-ha.js). Earlier the names tried below were
  // `vibecarbon-${projectName}-${environment}[-primary|-standby]` — none of
  // those match what Pulumi created, so destroy left every firewall behind
  // and the next deploy hit "name is already used (uniqueness_error)" on
  // pulumi up. Match the actual Pulumi naming convention.
  //
  // provider.deleteFirewallByName(name) (C10a) does the detach-then-poll
  // dance this file used to do inline: looks up the firewall by its exact
  // `?name=` (no pagination concern), detaches any still-attached servers
  // (server deletion above is async, so the firewall can still be
  // `applied_to` a deleting server when we hit DELETE — a 409 there means
  // "still attached", which the old `.catch(() => {})` on the DELETE was
  // silently swallowing, leaving the firewall behind and the next re-deploy
  // hitting "name is already used (uniqueness_error)" on Pulumi up), then
  // polls DELETE until it actually removes it. Its richer
  // {deleted, everExisted, apiError} return is now READ: `apiError` is exactly
  // the "delete never confirmed" case that leaves a firewall behind and fails
  // the NEXT deploy with uniqueness_error, and it used to be discarded here.
  onProgress('Deleting firewalls...');
  const fwNames = [
    `${projectName}-${environment}-primary-firewall`,
    `${projectName}-${environment}-standby-firewall`,
    `${projectName}-${environment}-firewall`,
  ];
  const fwOutcomes = await Promise.allSettled(
    fwNames.map((name) => provider.deleteFirewallByName(name)),
  );
  fwOutcomes.forEach((outcome, index) => {
    const name = fwNames[index];
    if (outcome.status === 'rejected') {
      noteLeak('firewall', name, `delete threw: ${outcome.reason?.message ?? outcome.reason}`);
      return;
    }
    // `everExisted: false` is the normal case for two of these three names —
    // only one naming convention matches any given deploy. Not a leak.
    if (outcome.value?.apiError) {
      noteLeak('firewall', name, `delete did not complete: ${outcome.value.apiError.message}`);
    }
  });

  // Delete SSH key + DNS resources in parallel
  onProgress('Cleaning up resources...');
  await Promise.allSettled([
    // SSH key deletion. The compose-ha deploy creates a SHARED ssh key named
    //   `${projectName}-${environment}-key`
    // (effects/compose-ha.js — `provider.createSSHKey(sharedSshKeyName, ...)`)
    // and passes its ID into both Pulumi programs as existingSshKeyId so
    // Pulumi never creates per-cluster keys. The old name pattern here
    // (`vibecarbon-${projectName}-${environment}`) didn't match anything
    // Pulumi or HA actually created — the shared key always leaked.
    //
    // provider.deleteSSHKeyByName(name) (C10a) uses Hetzner's `?name=<exact>`
    // filter instead of listing every key unfiltered/unpaginated and
    // client-side-matching by name (SANCTIONED DEVIATION #2 — RCA-mirror of
    // destroy's 2026-04-27 firewall pagination fix): once the project (or
    // e2e matrix) accumulates 25+ ssh keys, the shared key falls off page 1
    // of the old unfiltered `/ssh_keys` list and destroy silently no-ops on
    // it, leaking the key. Never throws — false on no match.
    (async () => {
      const sshKeyName = `${projectName}-${environment}-key`;
      try {
        await provider.deleteSSHKeyByName(sshKeyName);
      } catch (error) {
        // Non-fatal for the rest of the teardown, but never silent: this key is
        // created OUTSIDE Pulumi, so nothing else will ever reap it.
        noteLeak('ssh-key', sshKeyName, `delete failed: ${error.message}`);
      }
    })(),
    // DNS resource deletion (ownership-filtered — only records pointing at
    // this env's server IPs are removed; shared zones keep their other
    // tenants' records intact). Registry-driven: every DNS_PROVIDERS backend
    // exposes deleteApexAndWildcard (root + wildcard — M3 Task 9i: deploy
    // creates both records, so destroy must delete both, or the wildcard
    // orphans at a released IP). Token resolution is env-first under the
    // same-token rule; a missing token is a LEAK entry, never a silent skip.
    (async () => {
      const ownedIps = (envConfig.servers || []).map((srv) => srv.ip).filter(Boolean);
      // Nested persisted block first, else the pre-deploy flat binding — a
      // compose-ha deploy that died before its mid-deploy persist leaves
      // only the flat key (same class destroy.js's cleanupDnsRecords covers;
      // observed live 2026-08-08 on the compose-single path).
      const dnsProvider = envConfig.dns?.provider ?? envConfig.dnsProvider;
      if (!hasAutomatedDns(dnsProvider) || !envConfig.domain) return;
      const row = DNS_PROVIDERS[dnsProvider];
      const token = resolveDnsToken(dnsProvider, {
        computeProviderId: providerIdFor(envConfig),
        computeToken: providerToken,
      });
      if (!token) {
        noteLeak(
          'dns-record',
          `${envConfig.domain} (${row.name})`,
          `no ${row.tokenEnv} available for DNS cleanup`,
        );
        return;
      }
      let zoneId = envConfig.dns?.zoneId ?? null;
      try {
        const dns = await getDnsProvider(dnsProvider);
        if (!zoneId) {
          const zone = findZoneForDomain(await dns.getZones(token), envConfig.domain);
          zoneId = zone ? String(zone.id) : null;
          if (!zoneId) return;
        }
        // The 0.0.0.0 warm-up sentinel is always ours to reap — a deploy
        // that died pre-provision leaves records no server ever "owned".
        await dns.deleteApexAndWildcard(token, zoneId, envConfig.domain, [...ownedIps, '0.0.0.0']);
        // The ACME client's DNS-01 residue. Written by lego/cert-manager, so
        // the ownership-filtered delete above structurally cannot reach it —
        // which is why `_acme-challenge.<env>` TXTs accumulated across every
        // destroy until the 2026-08-10 audit found twelve tokens in one
        // (see lib/acme-challenge.js). Reported, never silently skipped: a
        // stale challenge record shadows the next DNS-01 wildcard validation.
        const challenge = await reapChallengeRecords({
          dns,
          token,
          zoneId,
          domain: envConfig.domain,
        });
        if (challenge.error) {
          noteLeak(
            'dns-record',
            `_acme-challenge.${envConfig.domain} (${row.name} zone ${zoneId})`,
            `challenge-record delete failed: ${challenge.error.message}`,
          );
        }
        if (typeof dns.deleteHealthCheck === 'function') {
          await Promise.allSettled(
            (envConfig.servers || []).map((server) =>
              dns.deleteHealthCheck(token, zoneId, `${server.name}-health`),
            ),
          );
        }
      } catch (error) {
        noteLeak(
          'dns-record',
          `${envConfig.domain} (${row.name} zone ${zoneId})`,
          `delete failed: ${error.message}`,
        );
      }
    })(),
  ]);

  // Clean up local SSH key files
  for (const f of [sshKeyPath, `${sshKeyPath}.pub`]) {
    if (existsSync(f)) {
      try {
        rmSync(f);
      } catch {
        // Non-fatal — a stale local key file leaks nothing billable.
      }
    }
  }

  // `handledServerIds` lets destroy's backstop sweep (lib/destroy/server-sweep.js)
  // tell "a server this teardown already deleted, still showing in a lagging
  // listing" apart from "a server nobody reaped" — without it, listing lag
  // reads as a fresh discovery on every compose-ha destroy.
  return { leaks, handledServerIds: serversToDelete.map((server) => server.id) };
}

// ============================================================================
// FAILOVER
// ============================================================================

/**
 * The app-tier services failover Step 1b restarts on the new primary (container
 * names are `${projectName}-<svc>`). Exported so the serve-gate coverage census
 * can assert every member is either probed by newPrimaryApiProbeCmd or carries
 * an explicit exemption — the invariant that made the 2026-08-19 storage gap
 * (gate proved rest only; storage still booting; verify 502'd) unrepresentable.
 */
export const APP_TIER_RESTART_SERVICES = [
  'supavisor',
  'auth',
  'rest',
  'realtime',
  'storage',
  'app',
];

/**
 * Restarted services the serve gate deliberately does NOT probe, with the
 * reason. The census requires every non-probed member to appear here.
 */
export const NEW_PRIMARY_PROBE_EXEMPT = {
  supavisor:
    'not Kong-routed: supavisor serves EXTERNAL database clients on its own ports; ' +
    'the app tier and verify-failover never traverse it',
  realtime:
    'no crisp keyless 200: every /realtime/v1 route is key-auth’d and the service ' +
    'answers non-200 on bare paths (its own healthcheck accepts any HTTP code); ' +
    'verify-failover’s realtime check carries a WS→HTTP fallback of its own',
};

/**
 * Build the compound curl used to probe the new primary's app tier locally —
 * one labeled status code per Kong-routed service the failover restarted.
 *
 * `--resolve <domain>:443:127.0.0.1` pins the hostname to loopback, so the
 * probe hits Traefik on the new-primary host itself and is independent of DNS
 * propagation (the DNS flip happens later in failover, and the operator host's
 * resolver may still be cached). `-k` skips the LE-staging cert.
 *
 * The three probes, and why these paths:
 *  - rest/app: /api/v1/notifications — the exact endpoint verify-failover
 *    checks; 200 means app → Kong → PostgREST → DB is serving, including
 *    PostgREST's schema cache (cold for ~10-30s after the restart).
 *  - auth: /auth/v1/health — Kong's OPEN health route (no key-auth), 200 from
 *    GoTrue itself.
 *  - storage: /storage/v1/object/public/<nonexistent> — the OPEN route the
 *    2026-08-19 verify upload actually 502'd through. storage-api answering
 *    AT ALL (200/400/404 for a bucket that doesn't exist) proves the upstream
 *    is up; only Kong can say 502/503/504 here. The key-auth'd
 *    /storage/v1/status is useless for this: Kong 401s it before storage-api
 *    is ever consulted (the k8s auth-probe trap of 2026-07-08).
 *
 * @param {string} domain
 * @returns {string}
 */
export function newPrimaryApiProbeCmd(domain) {
  const curlTo = (path) =>
    `curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve ${domain}:443:127.0.0.1 https://${domain}${path}`;
  return (
    `r=$(${curlTo('/api/v1/notifications')}); ` +
    `a=$(${curlTo('/auth/v1/health')}); ` +
    `s=$(${curlTo('/storage/v1/object/public/vc-serve-gate-probe/probe')}); ` +
    'echo "rest=$r auth=$a storage=$s"'
  );
}

/**
 * Storage readiness codes: anything storage-api itself would say to a GET of a
 * nonexistent public object. 502/503/504 are Kong speaking FOR a dead upstream;
 * 000 is curl reaching nothing.
 */
const STORAGE_UPSTREAM_ANSWERED = new Set(['200', '400', '404']);

/**
 * Parse one probe output line into a verdict. Exported-shape deliberate: the
 * old single-code output ('200') parses to not-ready — there is no silent
 * fallback to the one-service premise this sweep replaced.
 *
 * @param {string} out
 * @returns {{ready: boolean, detail: string}}
 */
function parseNewPrimaryProbe(out) {
  const detail = out.trim();
  const m = /rest=(\S+) auth=(\S+) storage=(\S+)/.exec(detail);
  if (!m) return { ready: false, detail: detail || 'none' };
  const [, rest, auth, storage] = m;
  return {
    ready: rest === '200' && auth === '200' && STORAGE_UPSTREAM_ANSWERED.has(storage),
    detail,
  };
}

/**
 * Poll the new primary until its restarted app tier actually SERVES.
 *
 * Root-cause fix for the compose-ha failover-readiness race, twice over: Step
 * 1b runs `docker restart … rest storage app …` to force a clean reconnect
 * against the now-read-write DB, but restart returns when containers *start*,
 * not when they're *ready*. PostgREST spends ~10-30s rebuilding its schema
 * cache (RCA 2026-05-30); storage-api replays its DB migrations and rises even
 * later (RCA 2026-08-19, DO run 32309395314 — the gate proved rest only, and
 * verify-failover's single-shot upload met Kong's 502). Gating on every
 * Kong-routed restarted service closes the race for the e2e *and* real
 * operators (a failover that reports success before the app serves is itself
 * a bug).
 *
 * Best-effort: returns false (and logs the last labeled statuses) on timeout
 * rather than throwing — a not-yet-confirmed new primary is still better than
 * aborting a promotion that already happened.
 *
 * @param {string} ip - new primary IP
 * @param {string} sshKeyPath
 * @param {string} domain
 * @param {object} [opts]
 * @param {number} [opts.attempts=40]
 * @param {number} [opts.intervalMs=3000]
 * @param {(ip: string, key: string, cmd: string, o: object) => string|false} [opts.runner=sshRun]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<boolean>}
 */
export async function waitForNewPrimaryApi(ip, sshKeyPath, domain, opts = {}) {
  const {
    attempts = 40,
    intervalMs = 3000,
    runner = sshRun,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  const cmd = newPrimaryApiProbeCmd(domain);
  let last = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const out = await runner(ip, sshKeyPath, cmd, { silent: true, timeout: 20_000 });
      const { ready, detail } = parseNewPrimaryProbe(typeof out === 'string' ? out : '');
      last = detail;
      if (ready) return true;
    } catch {
      last = 'error';
    }
    if (i < attempts - 1) await sleep(intervalMs);
  }
  console.error(
    `[ha] new primary app tier not fully serving (last ${last || 'none'}) ` +
      `after ${attempts} probes, proceeding, but verify-failover may race readiness`,
  );
  return false;
}

/**
 * Move the wal-g WRITE-GUARD onto the node this failover just promoted, and
 * PROVE it took — see src/lib/deploy/walg-role.js for why nothing else does.
 *
 * On compose, `WALG_ROLE` reaches the db container from `/opt/<project>/.env`
 * (`WALG_ROLE: ${WALG_ROLE:-primary}` in docker-compose.yml). Merging the file
 * is therefore only half of it: container environment is fixed at create time,
 * so the db service is RECREATED (`up -d --no-deps db`, with the node's real
 * `-f` set — composeDbRecreateShell) before anything reads the new value.
 *
 * Returns rather than throws. By the time this runs the standby is already
 * promoted, so there is no half-failover left to prevent: aborting here would
 * strand a promoted database behind un-flipped DNS, which is strictly worse than
 * finishing the failover and reporting loudly that its backups are dead. The
 * caller carries the verdict to the end of the flow and fails the command there.
 *
 * The old primary is demoted separately (demoteComposeWalgRole) — it is still
 * serving traffic at this point, because compose-HA does not stop it until
 * after the promoted node is confirmed serving.
 *
 * @param {object} args
 * @param {string} args.promotedIp    the new primary (the old standby)
 * @param {string} args.sshKeyPath
 * @param {string} args.projectName
 * @param {object} [args.deps] injected seams for unit tests
 * @returns {Promise<{ok: boolean, error?: Error}>}
 */
export async function restoreComposeWalgRole({ promotedIp, sshKeyPath, projectName, deps = {} }) {
  const {
    run = sshRunAsync,
    mergeEnv = mergeRemoteDotenv,
    audit = assertWalgBackupsWorking,
    log = (msg) => p.log.info(msg),
  } = deps;
  const remoteDir = `/opt/${projectName}`;

  try {
    await mergeEnv(promotedIp, pinnedSshOptsString(sshKeyPath), remoteDir, {
      [WALG_ROLE_ENV]: 'primary',
    });
    // 300s: a db container recreate plus the script's own 90s readiness wait,
    // with room for a slow image start on a node that is mid-incident.
    //
    // `retries: 1` is load-bearing on the DR path. sshRunAsync defaults to 3
    // attempts and classes a TIMEOUT as transient, so a wedged recreate would
    // burn 3 × 300s — up to ~15 minutes of RTO before the DNS flip, while the
    // site is down. One attempt, then report. (A script exit-1 is already
    // non-transient and never retried.)
    await run(promotedIp, sshKeyPath, composeDbRecreateShell(remoteDir), {
      timeout: 300_000,
      retries: 1,
    });
    // requirePrimary: the ONLY reason this audit is here is to catch a promoted
    // node still reading `standby`, which the deploy-time probe treats as a
    // legitimate skip.
    await audit({
      path: 'compose',
      context: 'failover',
      probe: async () => {
        const out = await run(
          promotedIp,
          sshKeyPath,
          `cd ${remoteDir} && ${composeWalgAuditShell({ requirePrimary: true })}`,
          { timeout: WALG_AUDIT_PROBE_TIMEOUT_MS },
        );
        return typeof out === 'string' ? out : '';
      },
    });
    log(`[walg-role] new primary ${promotedIp} is archiving (WALG_ROLE=primary, audit passed).`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * Demote the old primary's wal-g write-guard so the two nodes never write the
 * same canonical WAL prefix at once. Its database keeps running after a
 * failover — out of recovery and still `WALG_ROLE=primary` — so without this it
 * carries on pushing WAL into the stream the NEW primary now owns.
 *
 * Best-effort by design (an unreachable old primary is the usual reason to fail
 * over) and NEVER called before the old primary's app tier is stopped: this
 * recreates its db container, and compose-HA keeps the old primary serving
 * until the promoted node is confirmed.
 *
 * @param {object} args
 * @param {string} args.oldPrimaryIp
 * @param {string} args.sshKeyPath
 * @param {string} args.projectName
 * @param {object} [args.deps] injected seams for unit tests
 * @returns {Promise<boolean>} whether the demote landed
 */
export async function demoteComposeWalgRole({ oldPrimaryIp, sshKeyPath, projectName, deps = {} }) {
  const {
    run = sshRunAsync,
    mergeEnv = mergeRemoteDotenv,
    log = (msg) => p.log.info(msg),
    warn = (msg) => p.log.warn(msg),
  } = deps;
  const remoteDir = `/opt/${projectName}`;
  try {
    await mergeEnv(oldPrimaryIp, pinnedSshOptsString(sshKeyPath), remoteDir, {
      [WALG_ROLE_ENV]: 'standby',
    });
    // Same single-attempt budget as the promote side — this is best-effort and
    // must never stretch the DR path (see restoreComposeWalgRole).
    await run(oldPrimaryIp, sshKeyPath, composeDbRecreateShell(remoteDir), {
      timeout: 300_000,
      retries: 1,
    });
    log(`[walg-role] old primary ${oldPrimaryIp} demoted to the standby write-guard.`);
    return true;
  } catch (err) {
    warn(
      `Could not demote the old primary's wal-g write-guard (${oldPrimaryIp}): ${err.message}. ` +
        `If it comes back up it may archive into the same backup prefix as the new primary, ` +
        `\`vibecarbon deploy\` fixes this when it converges the ex-primary to standby.`,
    );
    return false;
  }
}

/**
 * Perform failover for a Compose HA environment.
 * Promotes the standby database and updates DNS if Cloudflare configured.
 */
export async function failoverComposeHA(envName, envConfig, projectConfig, parsed, tracker) {
  const servers = envConfig.servers || [];
  const primaryServer = servers.find((s) => s.role === 'primary');
  const standbyServer = servers.find((s) => s.role === 'standby');

  if (!primaryServer || !standbyServer) {
    p.log.error('Could not identify primary and standby servers from config');
    p.log.info('Ensure Compose HA deployment was set up with vibecarbon deploy --ha');
    process.exit(1);
  }

  const sshKeyPath = join(process.cwd(), '.vibecarbon', `deploy_key_${envName}`);
  if (!existsSync(sshKeyPath)) {
    p.log.error(`SSH key not found: ${sshKeyPath}`);
    process.exit(1);
  }

  const projectName = projectConfig.projectName;
  const remoteDir = `/opt/${projectName}`;

  p.log.info(c.bold('Current Compose HA state:'));
  p.log.message(`  ${c.dim(`Primary (${primaryServer.region})`.padEnd(22))} ${primaryServer.ip}`);
  p.log.message(`  ${c.dim(`Standby (${standbyServer.region})`.padEnd(22))} ${standbyServer.ip}`);

  p.log.info(c.bold('This will:'));
  p.log.message('  1. Promote the standby database to primary (docker compose exec)');
  p.log.message('  2. Update Cloudflare DNS (if configured)');
  p.log.message('  3. Print DNS update instructions (if manual DNS)');

  if (parsed.dryRun) {
    p.log.info(c.dim('Dry run: no changes made'));
    return;
  }

  if (!parsed.yes) {
    const confirm = await p.confirm({
      message: `Execute failover for ${c.bold(envName)}?`,
    });
    // Ctrl-C/ESC and an explicit "no" are different answers: one is an
    // interrupt, the other a considered refusal. Both stop the run.
    if (p.isCancel(confirm)) {
      exitCancelled();
    }
    if (!confirm) {
      exitDeclined();
    }
  }

  const s = tracker.spinner();

  // Step 0: Re-seed standby from primary if primary is still reachable.
  //
  // Streaming replication is best-effort; without a replication slot (which
  // we don't configure), the standby can fall behind if primary churns
  // through WAL faster than `wal_keep_size`. A stale standby yields
  // "undefined column" (PG code 42703) errors post-promotion because recent
  // migrations on primary never streamed over.
  //
  // For planned failover (the e2e-test case), primary is still alive
  // — run pg_basebackup to guarantee schema parity, then promote. For a
  // real disaster failover where primary is unreachable, skip the re-seed
  // and promote whatever state standby has (best-effort recovery).
  //
  // WAL-G archiving invariant (Invariant 1): the promoted node starts
  // archiving on the new timeline immediately after pg_promote() — the
  // docker-compose.yml command hardcodes archive_mode=on + archive_command
  // on the db image. WALG_S3_PREFIX is the same on both nodes (same .env),
  // so the WAL timeline is continuous in S3 across the failover. No extra
  // action needed here.
  // Skip the re-seed entirely when the standby is already verifiably streaming:
  // parity is guaranteed by the streaming state, the full basebackup is wasted
  // RTO, and the standby's live walreceiver holds the persistent slot (this is
  // the exact live RCA — compose-ha 2026-07-07 — where the reseed's
  // `pg_basebackup -S vibecarbon_standby_slot` failed "slot is active for PID").
  // Read from the standby side so it works even if the primary is unhealthy.
  const standbyStreaming = await isComposeStandbyStreaming(standbyServer.ip, sshKeyPath, remoteDir);
  if (standbyStreaming) {
    p.log.info(
      'Standby already streaming, skipping re-seed (parity guaranteed by streaming state)',
    );
  } else if (await isPrimaryReachable(primaryServer.ip, sshKeyPath, remoteDir)) {
    s.start('Re-seeding standby from primary (pg_basebackup)');
    try {
      await configureStandbyReplication(
        standbyServer.ip,
        primaryServer.ip,
        sshKeyPath,
        projectName,
      );
      s.stop('Standby re-seeded with primary state');
    } catch (err) {
      // Hard fail (was once catch+warn+proceed — misleading). Since the
      // 2026-07-06 restructure the re-seed stages first and swaps PGDATA
      // atomically host-side, so on failure the standby's PREVIOUS data dir is
      // intact and running — but its state relative to the primary is unknown,
      // so promoting it silently would still be wrong. Abort so the operator
      // sees the issue instead of a confusing pg_promote failure 5 minutes
      // later.
      s.stop('Re-seed failed, aborting failover');
      throw new Error(
        `Failover aborted: re-seed failed; the standby keeps its previous data ` +
          `directory (the staged swap is atomic), but its parity with the primary is ` +
          `not guaranteed. Fix the re-seed issue and retry.\nUnderlying error: ${err.message}`,
      );
    }
  } else {
    p.log.warn('Primary unreachable, skipping re-seed. Standby will promote with current state.');
  }

  // Step 1: Promote standby database.
  //
  // Use SQL `pg_promote(wait => true, wait_seconds => 120)` instead of
  // `pg_ctl promote`. Why: pg_ctl is fire-and-forget — it writes the promote
  // signal file and returns. If the postmaster hasn't fully bound the socket
  // yet (configureStandbyReplication's `docker compose start db` finished
  // mere seconds earlier), pg_ctl can fail or no-op silently, leaving the
  // standby in recovery mode. The downstream poll loop then sees `t` for its
  // entire budget and we declare "Promotion may still be in progress" while
  // the function continues to restart app-tier + DNS-flip — verify-failover
  // ends up hitting a read-only DB and fails with 500 "Database error finding
  // user" (auth) + 544 "DatabaseTimeout" (storage).
  // (Observed compose-ha 2026-04-29 — 2m 40s of polling with promoted=false.)
  //
  // pg_promote() is server-side and synchronous: with `wait=>true` it blocks
  // until the standby has actually exited recovery (or `wait_seconds` lapses)
  // and returns the result. We retry a handful of times because the very
  // first call can race the postmaster startup ("connection refused" /
  // "the database system is starting up").
  // `silent: true` is load-bearing: the shared compose sshRun wraps runCommand,
  // which on non-zero exit returns `false` (not throws) unless silent — so
  // without it, a still-booting postmaster's exit-1 manifests downstream as
  // `false?.trim is not a function`, the catch records it, and all 5 attempts
  // fail with the same TypeError instead of actually retrying the SQL call.
  // Helper: probe pg_is_in_recovery() and return 't'/'f'/'' (unknown).
  // Used after pg_promote to disambiguate three cases:
  //   - pg_promote returned 't' → success
  //   - pg_promote returned 'f' (timed out internally) → check probe
  //   - pg_promote threw (psql exit 1, e.g. "recovery is not in progress"
  //     because a previous attempt actually promoted) → check probe
  // Without the catch-side probe, the first attempt's success was silently
  // converted to "did not exit recovery mode after 5 attempts" because
  // attempts 2-5 hit the same not-in-recovery error and never re-checked.
  // RCA: compose-ha 2026-05-01 fanout4b failover.
  const probeRecovery = async () => {
    try {
      const r = await sshRun(
        standbyServer.ip,
        sshKeyPath,
        `cd ${remoteDir} && docker compose exec -T db psql -U supabase_admin -d postgres -tAc 'SELECT pg_is_in_recovery()'`,
        { silent: true, timeout: 10_000 },
      );
      return typeof r === 'string' ? r.trim() : '';
    } catch {
      return '';
    }
  };

  s.start('Promoting standby database');
  // Use SQL pg_promote(wait => true). hot_standby=on (set in carbon/
  // docker-compose.yml) guarantees the standby accepts read connections,
  // so psql can reach pg_promote even before promotion finishes. Verified
  // 2026-05-01 fanout13 — without hot_standby the standby rejects every
  // psql connection with "Hot standby mode is disabled" and pg_promote
  // can't be invoked at all.
  let promoted = false;
  let lastPromoteError = null;
  const MAX_PROMOTE_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_PROMOTE_ATTEMPTS && !promoted; attempt++) {
    try {
      const result = await sshRun(
        standbyServer.ip,
        sshKeyPath,
        `cd ${remoteDir} && docker compose exec -T db psql -U supabase_admin -d postgres -tAc "SELECT pg_promote(wait => true, wait_seconds => 120)"`,
        { silent: true, timeout: 150_000 },
      );
      const trimmed = typeof result === 'string' ? result.trim() : '';
      if (trimmed === 't') {
        promoted = true;
        break;
      }
      const probeTrimmed = await probeRecovery();
      if (probeTrimmed === 'f') {
        promoted = true;
        break;
      }
      lastPromoteError = new Error(
        `pg_promote returned ${JSON.stringify(trimmed)}; pg_is_in_recovery=${JSON.stringify(probeTrimmed)}`,
      );
    } catch (err) {
      const probeTrimmed = await probeRecovery();
      if (probeTrimmed === 'f') {
        promoted = true;
        break;
      }
      lastPromoteError = err;
    }
    if (!promoted && attempt < MAX_PROMOTE_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  if (!promoted) {
    // Capture diagnostics so the operator can see why the promotion failed
    // instead of guessing. Best-effort — failover-step abort is what matters.
    let dbLogs = '';
    try {
      dbLogs = await sshRun(
        standbyServer.ip,
        sshKeyPath,
        `cd ${remoteDir} && docker compose logs db --tail=60`,
        { silent: true, timeout: 30_000 },
      );
      if (typeof dbLogs !== 'string') dbLogs = '(db logs returned non-string)';
    } catch (err) {
      dbLogs = `(failed to capture db logs: ${err.message})`;
    }
    s.stop('Promotion failed, standby still in recovery mode');
    throw new Error(
      `Failover aborted: standby ${standbyServer.ip} did not exit recovery mode after ${MAX_PROMOTE_ATTEMPTS} pg_promote attempts. ` +
        `Last error: ${lastPromoteError?.message || 'unknown'}.\n` +
        `--- db container logs (last 60 lines) ---\n${dbLogs}`,
    );
  }

  s.stop('Standby database promoted to primary');

  // Step 1a2: Move the wal-g WRITE-GUARD with the promotion. The promoted node
  // was deployed as the standby, so its db container still reads
  // WALG_ROLE=standby — which silently disables BOTH WAL archiving and base
  // backups on the node that now holds the only live copy of the data. Runs
  // BEFORE the app-tier restart on purpose: it recreates the db container, and
  // restarting the app tier afterwards is exactly what re-pools it against the
  // recreated database. Never throws — the verdict is carried to the end of the
  // failover (see restoreComposeWalgRole).
  s.start('Moving the wal-g write-guard to the new primary');
  const backupHealth = await restoreComposeWalgRole({
    promotedIp: standbyServer.ip,
    sshKeyPath,
    projectName,
  });
  // Step 1a3: Arm the promoted node's ACME issuer (single-active-issuer
  // policy — it was deployed as the standby with a disarmed caserver, so
  // until this lands the domain would serve the Traefik default cert after
  // the DNS flip). Runs THIS early on purpose: issuance (DNS-01 propagation
  // included) overlaps the app-tier restart, API gate, and DNS flip below.
  // Best-effort like the write-guard — a failed re-arm degrades TLS, it
  // must never abort a DR flip (armComposeAcme warns with the manual fix).
  s.start("Arming the promoted node's ACME issuer");
  const acmeArmed = await armComposeAcme({
    promotedIp: standbyServer.ip,
    sshKeyPath,
    projectName,
  });
  s.stop(
    acmeArmed
      ? 'Promoted node ACME issuer armed (certificate issuance underway)'
      : 'Promoted node ACME issuer NOT armed — domain serves an untrusted cert (see warning)',
  );
  s.stop(
    backupHealth.ok
      ? 'wal-g write-guard moved, new primary is archiving'
      : 'wal-g write-guard NOT confirmed on the new primary',
  );
  if (!backupHealth.ok) {
    p.log.error(
      walgRoleDegradedMessage({
        path: 'compose',
        envName,
        promotedIp: standbyServer.ip,
        detail: backupHealth.error?.message ?? 'unknown failure',
      }),
    );
  }

  // Step 1b: Restart app-tier services on the new primary so they re-pool
  // against the now-read-write DB. These services were started during deploy
  // while the local DB was in recovery — supavisor's tenant pools and the
  // app/auth/rest/realtime/storage DB handles can hold stale connections that
  // surface as 500 "Database error" / 544 DatabaseTimeout right after
  // promotion. Restart is cheap (~10s) and forces a clean reconnect.
  s.start('Restarting new-primary app-tier');
  // sshRun answers `false`; it never throws, so the try/catch this replaces
  // could not fire and the spinner asserted success unconditionally.
  //
  // CONTAINER names, not compose service names: this used to run bare
  // `docker compose restart supavisor auth ...`, but supavisor is defined
  // only in docker-compose.prod.yml — bare compose (no -f chain in this
  // remote invocation) failed service-name resolution and exited in ~2s
  // having restarted NOTHING, on every failover (2026-08-09 round-A d2
  // verify-failover RCA; two earlier runs passed only because the step-1c
  // API wait let PostgREST self-recover). Every app-tier service stamps
  // `container_name: ${PROJECT_NAME}-<svc>`, so `docker restart` by
  // container name needs no compose file resolution at all.
  const appTierContainers = APP_TIER_RESTART_SERVICES.map((svc) => `${projectName}-${svc}`).join(
    ' ',
  );
  const restarted = await sshRun(
    standbyServer.ip,
    sshKeyPath,
    `docker restart ${appTierContainers}`,
    { timeout: 180_000 },
  );
  if (restarted === false) {
    p.log.warn('Restart of the new primary app-tier FAILED; it may not serve traffic.');
  }
  s.stop(
    restarted === false
      ? 'New-primary app-tier restart FAILED (continuing: see warning)'
      : 'New-primary app-tier restarted',
  );

  // Step 1c: Gate on the new primary actually SERVING a DB-backed request
  // before we stop the old primary and flip DNS. The Step 1b restart only
  // *starts* the app tier; PostgREST's schema cache is cold for ~10-30s after,
  // during which /api/v1/notifications 500s. Without this wait, failover
  // returned into that window and verify-failover (no retry on 500) failed.
  // Probed locally via curl --resolve so readiness is independent of the DNS
  // flip below. Best-effort — see waitForNewPrimaryApi.
  if (envConfig.domain) {
    s.start('Waiting for new primary to serve API traffic');
    const apiReady = await waitForNewPrimaryApi(standbyServer.ip, sshKeyPath, envConfig.domain);
    s.stop(
      apiReady
        ? 'New primary serving API traffic'
        : 'New primary API not confirmed, proceeding (verify may race readiness)',
    );
  }

  // Step 2: Stop old primary services to prevent split-brain.
  //
  // Stays BEST-EFFORT — the old primary being unreachable is often the very
  // reason we are failing over, and aborting here would leave the failover
  // half-done with DNS not yet flipped. What changes is that it now tells the
  // truth. The previous `try/catch` could never fire (sshRun answers `false`,
  // it does not throw), so the warn was dead code and the spinner printed
  // "Old primary services stopped" unconditionally — including in the exact
  // case this step exists to prevent, where the old primary is still up and
  // still accepting writes.
  s.start('Stopping old primary services');
  // CONTAINER names, not compose service names — same RCA as the app-tier
  // restart above (2026-08-09): bare `docker compose stop … supavisor`
  // could not resolve the overlay-only supavisor service and exited in ~2s
  // having stopped NOTHING, so the old primary kept serving writes behind
  // the SPLIT-BRAIN warning on every failover. The compose-invocation
  // census (compose-invocation-service-names.test.ts) bans the old shape.
  const oldPrimaryContainers = ['app', 'auth', 'rest', 'realtime', 'storage', 'supavisor']
    .map((svc) => `${projectName}-${svc}`)
    .join(' ');
  const stopped = await sshRun(
    primaryServer.ip,
    sshKeyPath,
    `docker stop ${oldPrimaryContainers}`,
    {
      timeout: 90_000,
    },
  );
  if (stopped === false) {
    p.log.warn(
      `Could not stop services on the old primary (${primaryServer.ip}). SPLIT-BRAIN RISK: ` +
        'it may still be serving writes. Stop it by hand before pointing clients at the ' +
        `new primary — ssh root@${primaryServer.ip} 'docker stop ${oldPrimaryContainers}'.`,
    );
  }
  s.stop(
    stopped === false
      ? 'Old primary NOT stopped, split-brain risk (see warning)'
      : 'Old primary services stopped',
  );

  // Step 2b: Demote the old primary's wal-g write-guard, so it stops pushing
  // WAL into the prefix the new primary now owns. Deliberately AFTER step 2:
  // this recreates its db container, and until the step above the old primary
  // was still serving traffic (DNS has not flipped yet either). Best-effort.
  s.start("Demoting the old primary's wal-g write-guard");
  const demoted = await demoteComposeWalgRole({
    oldPrimaryIp: primaryServer.ip,
    sshKeyPath,
    projectName,
  });
  // Step 2c: Disarm the retired node's ACME issuer — the swapped pair must
  // never run two armed solvers against one `_acme-challenge` TXT name (the
  // dual-solver clobbering class, acme-role.js). Best-effort for the same
  // reason the demote is.
  await disarmComposeAcme({
    oldPrimaryIp: primaryServer.ip,
    sshKeyPath,
    projectName,
  });
  s.stop(
    demoted
      ? 'Old primary demoted to the standby write-guard'
      : 'Old primary write-guard NOT demoted (best-effort); see the warning above',
  );

  // Step 3: DNS flip — registry-driven. Every backend's upsertApexAndWildcard
  // repoints apex + wildcard at the promoted standby (Cloudflare keeps its
  // proxied:false RCA inside its module; Hetzner its ttl:60 — the per-provider
  // wire details live with the backends, not here). No compute token in scope
  // (failover is DNS-only), so resolveDnsToken resolves env-first.
  if (hasAutomatedDns(envConfig.dns?.provider) && envConfig.dns?.zoneId) {
    const dnsProvider = envConfig.dns.provider;
    const zoneId = envConfig.dns.zoneId;
    const domain = envConfig.domain;
    const token = resolveDnsToken(dnsProvider, {
      computeProviderId: providerIdFor(envConfig),
      computeToken: undefined,
    });
    if (token) {
      s.start('Updating DNS A record');
      try {
        const dns = await getDnsProvider(dnsProvider);
        await dns.upsertApexAndWildcard({ token, zoneId }, domain, standbyServer.ip);
        s.stop(`DNS updated: ${domain} → ${standbyServer.ip}`);
      } catch (error) {
        s.stop(`DNS update failed: ${error.message}`);
        p.log.warn(`Manually update the A record for ${domain} to ${standbyServer.ip}`);
      }
    } else {
      p.log.warn(`${DNS_PROVIDERS[dnsProvider].tokenEnv} not set, update DNS A record manually`);
    }
  } else {
    // Manual DNS instructions
    const domain = envConfig.domain || '<your-domain>';
    p.log.info(c.bold('Update DNS to complete failover:'));
    p.log.message(`  ${c.dim('Domain'.padEnd(14))} ${c.bold(domain)}`);
    p.log.message(`  ${c.dim('New IP'.padEnd(14))} ${c.bold(standbyServer.ip)} (promoted standby)`);
  }

  // Update config: swap primary/standby roles so subsequent commands reflect reality
  const updatedServers = servers.map((s) => ({
    ...s,
    role: s.role === 'primary' ? 'standby' : 'primary',
  }));
  const updatedEnvConfig = {
    ...envConfig,
    servers: updatedServers,
    region: standbyServer.region,
    secondaryRegion: primaryServer.region,
    ha: { ...envConfig.ha, failoverRegion: primaryServer.region },
    lastFailover: new Date().toISOString(),
  };
  saveProjectConfig({
    ...projectConfig,
    environments: {
      ...projectConfig.environments,
      [envName]: updatedEnvConfig,
    },
  });

  p.log.success('Failover complete');
  // The roles persisted above are now inverted relative to the Pulumi stacks,
  // and compose-HA deploy resolves the pair from the stacks — so a redeploy
  // would re-point DNS at the retired node and re-seed (WIPE) the node just
  // promoted. `deploy` refuses this environment outright (see
  // ha-role-swap.js); these instructions are the operator-facing half of that
  // refusal and are rendered from the same module so the two cannot drift.
  p.log.info(c.bold('Recovery instructions:'));
  for (const line of composeHaFailoverRecoveryInstructions({
    envName,
    promotedIp: standbyServer.ip,
    retiredIp: primaryServer.ip,
  })) {
    p.log.message(`  ${line}`);
  }

  // TERMINAL: the failover itself succeeded (promoted, DNS flipped, roles
  // persisted, recovery steps printed above) but its backups did not. Throw
  // LAST so the command exits non-zero — a failover that leaves the new primary
  // archiving nothing must never be reported as a clean success, and an
  // automated caller has to be able to see that.
  if (!backupHealth.ok) {
    throw new Error(
      walgRoleDegradedMessage({
        path: 'compose',
        envName,
        promotedIp: standbyServer.ip,
        detail: backupHealth.error?.message ?? 'unknown failure',
      }),
    );
  }
}
