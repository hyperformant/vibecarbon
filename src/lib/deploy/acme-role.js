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
 *   - Deploy half: haMergeWalgRole writes `ACME_DISARMED_CA_SERVER` into
 *     the standby's `.env` (and explicitly empty into the primary's)
 *     BEFORE the stacks start. Both Traefik `caserver` flags interpolate
 *     `${ACME_DISARMED_CA_SERVER:-${ACME_CA_SERVER:-<prod LE>}}`, so the
 *     standby's lego dials a reserved-`.invalid` host — instant NXDOMAIN,
 *     zero ACME traffic, zero TXT writes — and the standby serves the
 *     Traefik default cert (accepted design; nothing probes the standby's
 *     TLS directly, and the DOMAIN always points at the active primary).
 *   - Failover half: armComposeAcme empties the key on the promoted node
 *     and recreates traefik (container command is fixed at create time —
 *     the same reason the WALG_ROLE swap recreates db); disarmComposeAcme
 *     sets it on the retired node, best-effort. Both mirror
 *     restoreComposeWalgRole/demoteComposeWalgRole's mechanics and
 *     failure semantics: a DR path never throws over cert re-arming.
 */

import * as p from '@clack/prompts';
import { DNS01_OVERRIDE_FILE } from './acme.js';
import { COMPOSE_BASE_FILES } from './bundle.js';
import { sshRunAsync } from './compose/index.js';
import { mergeRemoteDotenv, pinnedSshOptsString } from './utils.js';
import { COMPOSE_CONFIG_FILES_LABEL, PUBLISHED_PORTS_TEMPLATE } from './walg-role.js';

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
 * time). Same wrong-`-f` hazard as composeDbRecreateShell: a bare `up`
 * resolves docker-compose.yml alone and would recreate Traefik WITHOUT the
 * dns01 override's command — silently reverting the node to HTTP-01. So
 * the `-f` set comes from the running container's config_files label,
 * falling back to base + the dns01 override when the file is present, and
 * the published-ports assertion catches a recreate that dropped 80/443.
 *
 * @param {string} remoteDir e.g. `/opt/<project>`
 * @returns {string} a bash script, run as one SSH command
 */
export function composeTraefikRecreateShell(remoteDir) {
  const baseFlags = COMPOSE_BASE_FILES.map((f) => `-f ${f}`).join(' ');
  return [
    'set -e',
    `cd ${remoteDir}`,
    'CID="$(docker compose ps -q traefik | head -n1)"',
    'if [ -z "$CID" ]; then',
    `  echo "[acme-role] no traefik container is running in ${remoteDir}, refusing to recreate blind" >&2`,
    '  exit 1',
    'fi',
    `FILES="$(docker inspect -f '{{ index .Config.Labels "${COMPOSE_CONFIG_FILES_LABEL}" }}' "$CID" 2>/dev/null || true)"`,
    `PORTS_BEFORE="$(docker inspect -f '${PUBLISHED_PORTS_TEMPLATE}' "$CID" 2>/dev/null || true)"`,
    'FLAGS=""',
    'if [ -n "$FILES" ]; then',
    '  OLD_IFS="$IFS"; IFS=,',
    '  for f in $FILES; do',
    '    case "$f" in *[!\\ ]*) FLAGS="$FLAGS -f $f" ;; esac',
    '  done',
    '  IFS="$OLD_IFS"',
    'fi',
    'case "$FLAGS" in',
    '  *.yml*|*.yaml*)',
    '    echo "[acme-role] using the -f set the running traefik was created with" ;;',
    '  *)',
    `    FLAGS="${baseFlags}"`,
    `    if [ -f ${DNS01_OVERRIDE_FILE} ]; then FLAGS="$FLAGS -f ${DNS01_OVERRIDE_FILE}"; fi`,
    '    echo "[acme-role] no usable compose config_files label, rebuilt the -f set from base + dns01 override" ;;',
    'esac',
    'echo "[acme-role] recreating traefik: docker compose $FLAGS up -d --no-deps traefik"',
    'docker compose $FLAGS up -d --no-deps traefik',
    'CID_NEW="$(docker compose ps -q traefik | head -n1)"',
    `PORTS_AFTER="$(docker inspect -f '${PUBLISHED_PORTS_TEMPLATE}' "$CID_NEW" 2>/dev/null || true)"`,
    'MISSING=""',
    'for pp in $PORTS_BEFORE; do',
    '  case " $PORTS_AFTER " in',
    '    *" $pp "*) ;;',
    '    *) MISSING="$MISSING $pp" ;;',
    '  esac',
    'done',
    'if [ -n "$MISSING" ]; then',
    '  echo "[acme-role] traefik recreate DROPPED published port(s):$MISSING — the node was recreated from the wrong compose file set; re-run \\`vibecarbon deploy <env>\\` to reconcile." >&2',
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
    // Single attempt on the DR path — same reasoning as restoreComposeWalgRole.
    await run(promotedIp, sshKeyPath, composeTraefikRecreateShell(remoteDir), {
      timeout: 120_000,
      retries: 1,
    });
    log(`[acme-role] promoted node ${promotedIp} ACME issuer armed; certificate issuance started.`);
    return true;
  } catch (err) {
    warn(
      `Could not re-arm the promoted node's ACME issuer (${promotedIp}): ${err.message}. ` +
        `The site serves, but the domain presents an untrusted certificate until this lands — ` +
        `re-run the failover, or fix connectivity and \`docker compose up -d traefik\` after ` +
        `emptying ${ACME_DISARM_ENV} in /opt/${projectName}/.env.`,
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
