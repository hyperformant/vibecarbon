/**
 * Compose-HA single-active-ACME-issuer policy — the compose mirror of
 * src/lib/deploy/k8s/acme-issuer-policy.js.
 *
 * THE PROBLEM: a compose-ha environment runs a full Traefik on BOTH nodes,
 * each with a `letsencrypt` resolver for the SAME names. Every certificate
 * validates with HTTP-01, and Let's Encrypt fetches the challenge from the
 * address the domain resolves to, so only the node DNS points at can ever
 * pass one. An armed issuer on the other node fails every order it places,
 * and each failure counts against Let's Encrypt's limit of 5 failed
 * validations per hostname per hour, which the serving node shares. Traefik
 * also never retries a failed first issuance until it restarts, so one
 * attempt made while DNS points elsewhere leaves that node on the default
 * certificate.
 *
 * THE POLICY: only the node DNS points at, the one in the PRIMARY role,
 * holds an armed ACME issuer.
 *
 *   - Deploy half: haWriteNodeRoles writes `ACME_DISARMED_CA_SERVER` into
 *     the standby's `.env` (and explicitly empty into the primary's)
 *     BEFORE the stacks start. The Traefik `caserver` flag interpolates
 *     `${ACME_DISARMED_CA_SERVER:-${ACME_CA_SERVER:-<prod LE>}}`, so the
 *     standby's lego dials a reserved-`.invalid` host: instant NXDOMAIN,
 *     zero ACME traffic. The standby serves whatever certificate its
 *     acme.json holds, or the Traefik default one (accepted design; nothing
 *     probes the standby's TLS directly, and the DOMAIN always points at the
 *     active primary).
 *   - Failover half: disarmComposeAcme sets the key on the retired node
 *     BEFORE the DNS flip, best-effort; armComposeAcme empties it on the
 *     promoted node and recreates traefik (its container command is fixed at
 *     create time) only AFTER the flip, when the challenges reach it. Both
 *     follow demoteComposeWalgRole's failure semantics: a DR path never
 *     throws over cert re-arming.
 */

import * as p from '@clack/prompts';
import { VC_COMPOSE } from './compose/command.js';
import { sshRunAsync } from './compose/index.js';
import { mergeRemoteDotenv, pinnedSshOptsString } from './utils.js';
import { PUBLISHED_PORTS_TEMPLATE } from './walg-role.js';

/** The `.env` key the Traefik `caserver` flag consults first. */
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
 * overlays the node runs (add-ons, and on compose-ha the replication
 * overlay). So it runs vc-compose, the server's own `-f` set
 * (compose/command.js), and the published-ports assertion still catches a
 * recreate that dropped 80/443.
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
 * command takes. failoverComposeHA calls it only AFTER the DNS flip, so the
 * first HTTP-01 challenge reaches this node; the saved certificate was
 * restored before the flip (restoreFailoverTls), and the recreated Traefik
 * keeps serving it. The abort's armPrimary calls it after DNS points back.
 *
 * @param {{promotedIp: string, sshKeyPath: string, projectName: string, deps?: object}} args
 * @returns {Promise<boolean>} whether the re-arm landed
 */
export async function armComposeAcme({ promotedIp, sshKeyPath, projectName, deps = {} }) {
  const {
    run = sshRunAsync,
    mergeEnv = mergeRemoteDotenv,
    log = (msg) => p.log.info(msg),
    warn = (msg) => p.log.warn(msg),
  } = deps;
  const remoteDir = `/opt/${projectName}`;
  try {
    await mergeEnv(promotedIp, pinnedSshOptsString(sshKeyPath), remoteDir, {
      [ACME_DISARM_ENV]: '',
    });
    // Single attempt on the DR path: sshRunAsync's default 3 attempts would let a
    // wedged recreate burn minutes of RTO.
    await run(promotedIp, sshKeyPath, composeTraefikRecreateShell(remoteDir), {
      timeout: 120_000,
      retries: 1,
    });
    log(`[acme-role] promoted node ${promotedIp} ACME issuer armed.`);
    return true;
  } catch (err) {
    warn(
      `Could not arm the promoted node's ACME issuer (${promotedIp}): ${err.message}. ` +
        'It cannot issue or renew a certificate until it is armed, so the domain shows an ' +
        'untrusted certificate unless a saved one was restored. The Traefik recreate ran on ' +
        'the live node and may have left Traefik stopped, so the site may be down. Check it ' +
        `with: ssh root@${promotedIp} 'cd ${remoteDir} && ${VC_COMPOSE} ps traefik'. ` +
        'Repair with: `vibecarbon deploy <env>`, which re-arms it and recreates Traefik.',
    );
    return false;
  }
}

/**
 * Disarm ACME on the retired node before DNS leaves it, so the swapped pair
 * never runs an armed issuer that DNS does not point at. Best-effort: an
 * unreachable old primary is the usual reason to fail over (the
 * demoteComposeWalgRole doctrine).
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
        `If it comes back up, its ACME challenges fail (DNS points at the promoted node) ` +
        `and count against Let's Encrypt's failed-validation limit; ` +
        `\`vibecarbon deploy\` reconverges the roles when the node returns.`,
    );
    return false;
  }
}
