/**
 * Compose-HA single-active-ACME-issuer policy — the compose mirror of
 * src/lib/deploy/k8s/acme-issuer-policy.js.
 *
 * THE PROBLEM (runs 33273372657 / 33276113128, DigitalOcean compose-ha):
 * a compose-ha environment runs a full Traefik on BOTH nodes, each with an
 * armed `letsencrypt` resolver for the SAME domain. The apex and wildcard
 * certs both validate at ONE TXT name (`_acme-challenge.${domain}`);
 * renderTraefikDefaultCert's apex/wildcard split makes their orders serial
 * PER INSTANCE, but two instances yield up to four concurrent
 * authorizations on that one name. lego instances add competing values
 * ("Incorrect TXT record ... (and 1 more) found") and delete each other's
 * pending records during cleanup ("No TXT record found"). Narrow race
 * windows on fast DNS (Cloudflare/Hetzner) let this usually win; DO's slow
 * anycast plus the (correct) 300s propagation window made collision
 * near-certain.
 *
 * THE POLICY: only the node currently in the PRIMARY role holds an armed
 * ACME issuer.
 *
 *   - Deploy half: haWriteNodeRoles writes `ACME_DISARMED_CA_SERVER` into
 *     the standby's `.env` (and explicitly empty into the primary's)
 *     BEFORE the stacks start. Both Traefik `caserver` flags interpolate
 *     `${ACME_DISARMED_CA_SERVER:-${ACME_CA_SERVER:-<prod LE>}}`, so the
 *     standby's lego dials a reserved-`.invalid` host — instant NXDOMAIN,
 *     zero ACME traffic, zero TXT writes — and the standby serves the
 *     Traefik default cert (accepted design; nothing probes the standby's
 *     TLS directly, and the DOMAIN always points at the active primary).
 *   - Failover half: armComposeAcme empties the key on the promoted node
 *     and recreates traefik (its container command is fixed at create
 *     time); disarmComposeAcme sets it on the retired node, best-effort.
 *     Both follow demoteComposeWalgRole's failure semantics: a DR path
 *     never throws over cert re-arming.
 */

import * as p from '@clack/prompts';
import { VC_COMPOSE } from './compose/command.js';
import { sshRunAsync } from './compose/index.js';
import { mergeRemoteDotenv, pinnedSshOptsString } from './utils.js';
import { PUBLISHED_PORTS_TEMPLATE } from './walg-role.js';

/** The `.env` key both Traefik `caserver` flags consult first. */
export const ACME_DISARM_ENV = 'ACME_DISARMED_CA_SERVER';

/**
 * Where a disarmed node's lego dials. `.invalid` is RFC 2606-reserved —
 * guaranteed NXDOMAIN, so registration fails instantly, no CA is ever
 * reached, and the hostname explains itself in any Traefik log tail.
 */
export const ACME_DISARMED_CA_SERVER = 'https://acme-disarmed.invalid/directory';

/**
 * Bash that RECREATES the compose `traefik` service so it picks up the
 * `ACME_DISARMED_CA_SERVER` value just merged into `.env` (the value lives
 * in the container COMMAND via compose interpolation, fixed at create
 * time). The wrong-`-f` hazard: a bare `up`
 * resolves docker-compose.yml alone and would recreate Traefik WITHOUT the
 * dns01 override's command, silently reverting the node to HTTP-01. So it
 * runs vc-compose, the server's own `-f` set (compose/command.js), and the
 * published-ports assertion still catches a recreate that dropped 80/443.
 *
 * @param {string} remoteDir e.g. `/opt/<project>`
 * @returns {string} a bash script, run as one SSH command
 */
export function composeTraefikRecreateShell(remoteDir) {
  return [
    'set -e',
    `cd ${remoteDir}`,
    `CID="$(${VC_COMPOSE} ps -q traefik | head -n1)"`,
    'if [ -z "$CID" ]; then',
    `  echo "[acme-role] no traefik container is running in ${remoteDir}, refusing to recreate blind" >&2`,
    '  exit 1',
    'fi',
    `PORTS_BEFORE="$(docker inspect -f '${PUBLISHED_PORTS_TEMPLATE}' "$CID" 2>/dev/null || true)"`,
    `echo "[acme-role] recreating traefik: ${VC_COMPOSE} up -d --no-deps traefik"`,
    `${VC_COMPOSE} up -d --no-deps traefik`,
    `CID_NEW="$(${VC_COMPOSE} ps -q traefik | head -n1)"`,
    `PORTS_AFTER="$(docker inspect -f '${PUBLISHED_PORTS_TEMPLATE}' "$CID_NEW" 2>/dev/null || true)"`,
    'MISSING=""',
    'for pp in $PORTS_BEFORE; do',
    '  case " $PORTS_AFTER " in',
    '    *" $pp "*) ;;',
    '    *) MISSING="$MISSING $pp" ;;',
    '  esac',
    'done',
    'if [ -n "$MISSING" ]; then',
    '  echo "[acme-role] traefik recreate DROPPED published port(s):$MISSING. Re-run \\`vibecarbon deploy <env>\\` to reconcile the node." >&2',
    '  exit 1',
    'fi',
    'echo "[acme-role] traefik recreated; published:$PORTS_AFTER"',
  ].join('\n');
}

/**
 * Re-arm ACME on the promoted node: empty the disarm key (the nested
 * default falls through to the real CA) and recreate traefik so the new
 * command takes. Called early in failoverComposeHA — before the app-tier
 * restart and DNS flip — so issuance overlaps the remaining failover work.
 *
 * `deps.restore` (optional) puts the saved certificate into the node's
 * acme.json between the .env merge and the recreate, so the recreated Traefik
 * starts on it and serves HTTPS without issuing (failover passes
 * restoreFailoverTls). It never blocks the re-arm: a restore that throws is
 * ignored and Traefik issues a new certificate.
 *
 * @param {{promotedIp: string, sshKeyPath: string, projectName: string, deps?: object}} args
 * @returns {Promise<boolean>} whether the re-arm landed
 */
export async function armComposeAcme({ promotedIp, sshKeyPath, projectName, deps = {} }) {
  const {
    run = sshRunAsync,
    mergeEnv = mergeRemoteDotenv,
    restore = null,
    log = (msg) => p.log.info(msg),
    warn = (msg) => p.log.warn(msg),
  } = deps;
  const remoteDir = `/opt/${projectName}`;
  try {
    await mergeEnv(promotedIp, pinnedSshOptsString(sshKeyPath), remoteDir, {
      [ACME_DISARM_ENV]: '',
    });
    let restored = false;
    if (restore) {
      try {
        restored = (await restore())?.restored === true;
      } catch {
        // restoreFailoverTls never throws; any other restore degrades to issuance.
      }
    }
    // Single attempt on the DR path: sshRunAsync's default 3 attempts would let a
    // wedged recreate burn minutes of RTO before the DNS flip.
    await run(promotedIp, sshKeyPath, composeTraefikRecreateShell(remoteDir), {
      timeout: 120_000,
      retries: 1,
    });
    log(
      restored
        ? `[acme-role] promoted node ${promotedIp} ACME issuer armed; serving the restored certificate.`
        : `[acme-role] promoted node ${promotedIp} ACME issuer armed; certificate issuance started.`,
    );
    return true;
  } catch (err) {
    warn(
      `Could not re-arm the promoted node's ACME issuer (${promotedIp}): ${err.message}. ` +
        `The site serves, but the domain presents an untrusted certificate until this lands. ` +
        `Re-run the failover, or fix connectivity and run \`cd /opt/${projectName} && ` +
        `${VC_COMPOSE} up -d --no-deps traefik\` after emptying ${ACME_DISARM_ENV} in its .env.`,
    );
    return false;
  }
}

/**
 * Disarm ACME on the retired node so the swapped pair never runs two armed
 * issuers. Best-effort — an unreachable old primary is the usual reason to
 * fail over (the demoteComposeWalgRole doctrine).
 *
 * @param {{oldPrimaryIp: string, sshKeyPath: string, projectName: string, deps?: object}} args
 * @returns {Promise<boolean>} whether the disarm landed
 */
export async function disarmComposeAcme({ oldPrimaryIp, sshKeyPath, projectName, deps = {} }) {
  const {
    run = sshRunAsync,
    mergeEnv = mergeRemoteDotenv,
    log = (msg) => p.log.info(msg),
    warn = (msg) => p.log.warn(msg),
  } = deps;
  const remoteDir = `/opt/${projectName}`;
  try {
    await mergeEnv(oldPrimaryIp, pinnedSshOptsString(sshKeyPath), remoteDir, {
      [ACME_DISARM_ENV]: ACME_DISARMED_CA_SERVER,
    });
    await run(oldPrimaryIp, sshKeyPath, composeTraefikRecreateShell(remoteDir), {
      timeout: 120_000,
      retries: 1,
    });
    log(`[acme-role] retired node ${oldPrimaryIp} ACME issuer disarmed.`);
    return true;
  } catch (err) {
    warn(
      `Could not disarm the retired node's ACME issuer (${oldPrimaryIp}): ${err.message}. ` +
        `If it comes back up it may contend for the domain's ACME challenges; ` +
        `\`vibecarbon deploy\` reconverges the roles when the node returns.`,
    );
    return false;
  }
}
