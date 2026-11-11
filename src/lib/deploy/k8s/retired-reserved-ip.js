/**
 * The reserved IP a DigitalOcean k8s cluster made before 2026-11 still holds.
 *
 * Those clusters had a reserved IP their domain pointed at. Today's program
 * makes none (`DigitalOceanProvider.K8S_FLOATING_IP = false`): the domain
 * points at the master's own address (clusterIngressIp, ./ingress-ip.js).
 * Every `up` and preview takes the old reserved IP and its assignment out of
 * the stack's state first (lib/iac/retired-resources.js), so Pulumi never
 * deletes them: the address stays assigned to the master, keeps serving, and
 * costs nothing while assigned. The environment's record keeps naming it
 * (`floatingIp`, or `ha.<role>.floatingIp` on k8s-ha) until it is released.
 *
 * The deploy releases it here, and only once nothing in DNS points at it: a
 * released address goes back to DigitalOcean's pool, and whoever is handed it
 * next could serve on any name that still resolves to it. Released when all of
 * these hold, else kept for the next deploy:
 *
 *   - the domain's own nameservers, asked directly for every name the
 *     environment manages (the apex and the wildcard), answer and none
 *     answers with the address (lookupAuthoritativeA, lib/dns-authoritative.js);
 *   - with managed DNS, this run's DNS writer has the records at the new
 *     address, every nameserver answers it, and at least the record's TTL has
 *     passed since that write, so no resolver still holds the old answer;
 *   - with DNS kept by hand, the user moved the records: a deploy first saw
 *     DNS without the address, and at least the record's TTL (and never less
 *     than MANUAL_DNS_MIN_WAIT_SECONDS, since the old record's TTL is not
 *     ours to know) has passed since that check. Until then the deploy prints
 *     the old and the new address and asks the user to move the records.
 *
 * Nothing here waits: an address whose time has not come stays for the next
 * deploy. A release that fails keeps the record, and the next deploy or
 * `vibecarbon destroy` releases it (destroy's backstop reads the same keys).
 *
 * Never on Hetzner or Linode: their recorded floating IP is the cluster's live
 * ingress (retiredReservedIps returns nothing there).
 */
import { loadProjectConfig, updateProjectConfig } from '../../config.js';
import { lookupAuthoritativeA, managedRecordNames } from '../../dns-authoritative.js';

/**
 * With DNS kept by hand, the least time between a deploy first seeing DNS
 * without the address and its release. The old record's TTL is the user's
 * and the lookup can no longer see it; an hour covers the common defaults
 * (300 to 3600 s), and a longer TTL on the current record raises it.
 */
export const MANUAL_DNS_MIN_WAIT_SECONDS = 3600;

/**
 * The reserved-IP addresses an environment has on record that its provider's
 * k8s clusters no longer use: every recorded one on a provider whose clusters
 * have no floating IP, none on a provider whose clusters do.
 *
 * @param {{K8S_FLOATING_IP?: boolean}} Provider
 * @param {object|null|undefined} envConfig
 * @returns {string[]}
 */
export function retiredReservedIps(Provider, envConfig) {
  if (Provider?.K8S_FLOATING_IP !== false || !envConfig) return [];
  const recorded = [
    envConfig.floatingIp,
    envConfig.ha?.primary?.floatingIp,
    envConfig.ha?.standby?.floatingIp,
  ].filter(Boolean);
  return [...new Set(recorded)];
}

/**
 * @typedef {{ target: string, changedAt: number }} DnsWrite
 *   This run's managed-DNS writer has the domain's records at `target`, as
 *   set by the write at `changedAt` (epoch ms): this run's, or an earlier
 *   run's the writer's gate found unchanged.
 */

/**
 * @typedef {{
 *   release: boolean,
 *   kind: 'release'|'unchecked'|'still-answered'|'not-moved'|'no-answer'|'settling',
 *   names?: string[],
 *   waitSeconds?: number,
 *   remainingSeconds?: number,
 *   clearSince?: number|null,
 *   reason?: string,
 * }} ReleaseVerdict
 *   `clearSince`: what the record's clear-since stamp for the address becomes
 *   (epoch ms; null removes it; absent leaves it as it is).
 */

/**
 * Whether `address` may be released now. Pure.
 *
 * @param {object} o
 * @param {string} o.address - the held reserved IP
 * @param {{ok: boolean, reason?: string, answers?: import('../../dns-authoritative.js').AuthoritativeAnswer[]}} o.lookup
 * @param {DnsWrite|null} o.dnsWrite - null: DNS is kept by hand
 * @param {number|null} o.clearSince - DNS by hand: when a deploy first saw DNS without the address (epoch ms)
 * @param {string} o.domain
 * @param {number} o.now - epoch ms
 * @returns {ReleaseVerdict}
 */
export function releaseVerdict({ address, lookup, dnsWrite, clearSince, domain, now }) {
  if (!lookup?.ok) {
    return { release: false, kind: 'unchecked', reason: lookup?.reason ?? 'no lookup' };
  }
  const answers = lookup.answers ?? [];
  const holding = [
    ...new Set(answers.filter((a) => a.addresses.includes(address)).map((a) => a.name)),
  ];
  if (holding.length > 0) {
    return { release: false, kind: 'still-answered', names: holding, clearSince: null };
  }
  const ttls = answers.map((a) => a.ttl).filter((t) => typeof t === 'number');
  const ttl = ttls.length > 0 ? Math.max(...ttls) : 0;

  let since;
  let waitSeconds;
  let stamp;
  if (dnsWrite) {
    // Managed: the records are ours, so every nameserver must serve the new
    // address for every name, or the zone asked is not the one the deploy
    // wrote (or has not caught up). The write's time is when the address left.
    const missing = answers.filter((a) => !a.addresses.includes(dnsWrite.target));
    if (answers.length === 0 || missing.length > 0 || dnsWrite.target === address) {
      return {
        release: false,
        kind: 'not-moved',
        names: [...new Set(missing.map((a) => a.name))],
      };
    }
    since = dnsWrite.changedAt;
    waitSeconds = ttl;
  } else {
    // By hand: the apex must answer, on every nameserver, or nothing says
    // these servers serve the domain at all. When the user moved the records
    // is unknown, so the first deploy that sees them moved starts the clock.
    const apex = answers.filter((a) => a.name === domain);
    if (apex.length === 0 || apex.some((a) => a.addresses.length === 0)) {
      return { release: false, kind: 'no-answer', names: [domain] };
    }
    since = clearSince ?? now;
    if (clearSince == null) stamp = now;
    waitSeconds = Math.max(ttl, MANUAL_DNS_MIN_WAIT_SECONDS);
  }
  const elapsedSeconds = (now - since) / 1000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < waitSeconds) {
    return {
      release: false,
      kind: 'settling',
      waitSeconds,
      remainingSeconds: Math.ceil(
        Number.isFinite(elapsedSeconds) ? waitSeconds - elapsedSeconds : waitSeconds,
      ),
      ...(stamp !== undefined && { clearSince: stamp }),
    };
  }
  return { release: true, kind: 'release' };
}

/** Drop `address` from every place the environment records a floating IP. */
function forgetReservedIp(env, address) {
  if (env.floatingIp === address) delete env.floatingIp;
  for (const side of [env.ha?.primary, env.ha?.standby]) {
    if (side?.floatingIp === address) delete side.floatingIp;
  }
  setClearSince(env, address, null);
}

/** Set (epoch ms) or clear (null) the address's clear-since stamp. */
function setClearSince(env, address, at) {
  const stamps = { ...(env.retiredIpDnsClearSince ?? {}) };
  if (at == null) delete stamps[address];
  else stamps[address] = new Date(at).toISOString();
  if (Object.keys(stamps).length > 0) env.retiredIpDnsClearSince = stamps;
  else delete env.retiredIpDnsClearSince;
}

/** A recorded clear-since stamp as epoch ms, or null. */
function clearSinceOf(env, address) {
  const iso = env?.retiredIpDnsClearSince?.[address];
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

/** "a and b" / "a, b and c". */
function listed(items) {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The line a kept address gets, or null for none.
 * @returns {{level: 'info'|'warn', line: string}|null}
 */
function keptLine(verdict, { address, environment, domain, newAddress, dnsWrite, providerName }) {
  const destroyHint = `\`vibecarbon destroy ${environment}\` releases it too.`;
  switch (verdict.kind) {
    case 'unchecked':
      // Kept on every deploy whose lookup fails (fail closed), so the line
      // says why and what the address costs: free while assigned, billed
      // whenever it is not.
      return {
        level: 'warn',
        line:
          `the reserved IP ${address} stays assigned to this cluster's master for now: ` +
          `vibecarbon could not get an answer from ${domain}'s nameservers (${verdict.reason}), ` +
          'so it cannot tell whether DNS still points at it. Releasing it while DNS does would ' +
          `let whoever ${providerName} hands it to next serve your domain. It is still a ` +
          `reserved IP on your ${providerName} account, which bills it whenever it is not ` +
          'assigned to a droplet. ' +
          // DNS kept by hand: the move is the user's, and a failed check must
          // not cost them the instruction.
          (dnsWrite
            ? ''
            : `Your DNS for ${domain} is kept by hand, so if the A records for ${domain} and ` +
              `*.${domain} still point at ${address}, point them at ${newAddress}, the ` +
              "cluster's master. ") +
          `The next deploy checks again, and ${destroyHint}`,
      };
    case 'still-answered':
      return dnsWrite
        ? {
            level: 'warn',
            line:
              `${listed(verdict.names)} still ${verdict.names.length === 1 ? 'answers' : 'answer'} ` +
              `${address} at ${domain}'s nameservers, though this deploy pointed the records at ` +
              `${dnsWrite.target}. ${address}, the reserved IP the cluster used before, stays ` +
              'assigned to the master and keeps serving. If you added a record for it yourself, ' +
              `point it at ${dnsWrite.target}; the next deploy checks again.`,
          }
        : {
            level: 'warn',
            line:
              `your DNS for ${domain} is kept by hand and still answers ${address}, the reserved ` +
              `IP this cluster used before. Point the A records for ${domain} and *.${domain} at ` +
              `${newAddress}, the cluster's master. Until then ${address} stays assigned to the ` +
              'master and keeps serving, and a later deploy releases it once DNS no longer ' +
              'answers with it.',
          };
    case 'not-moved':
      return {
        level: 'info',
        line:
          `${domain}'s nameservers do not answer ${dnsWrite?.target} for every name yet, so the ` +
          `reserved IP ${address} stays assigned to the master for now. The next deploy checks again.`,
      };
    case 'no-answer':
      return {
        level: 'warn',
        line:
          `${domain} has no A record at its nameservers, so vibecarbon cannot tell whether ` +
          `anything still points at the reserved IP ${address}. It stays assigned to the master. ` +
          `Point ${domain} and *.${domain} at ${newAddress}, and a later deploy releases it.`,
      };
    case 'settling':
      return {
        level: 'info',
        line:
          `DNS no longer answers with the reserved IP ${address}. Resolvers may still have it ` +
          `cached for up to ${verdict.remainingSeconds} s more, so it stays assigned to the ` +
          'master and the next deploy after that releases it.',
      };
    default:
      return null;
  }
}

/**
 * Release every retired reserved IP the environment has on record whose DNS
 * has moved off it (releaseVerdict), and forget each one released. One that
 * may not go yet, or whose release fails, stays on record with a line that
 * says why and what releases it.
 *
 * @param {object} o
 * @param {string} o.environment
 * @param {{K8S_FLOATING_IP?: boolean, NAME: string}} o.Provider
 * @param {{deleteReservedIpByAddress: (address: string) => Promise<boolean>}} o.provider
 * @param {{info: (line: string) => void, warn: (line: string) => void}} o.log
 * @param {string|null|undefined} o.domain - the environment's domain
 * @param {DnsWrite|null} o.dnsWrite - this run's managed-DNS write; null when DNS is kept by hand
 * @param {string|null} o.newAddress - where the domain should point now (the cluster's ingress)
 * @param {typeof lookupAuthoritativeA} [o.lookup]
 * @param {() => number} [o.now]
 * @param {() => object|null} [o.readConfig]
 * @param {(fn: (config: object) => void) => unknown} [o.updateConfig]
 * @returns {Promise<{released: string[], kept: Array<{address: string, reason: string}>}>}
 */
export async function releaseRetiredReservedIps({
  environment,
  Provider,
  provider,
  log,
  domain,
  dnsWrite = null,
  newAddress = null,
  lookup = lookupAuthoritativeA,
  now = Date.now,
  readConfig = loadProjectConfig,
  updateConfig = updateProjectConfig,
}) {
  const env = readConfig()?.environments?.[environment];
  const addresses = retiredReservedIps(Provider, env);
  const released = [];
  const kept = [];
  if (addresses.length === 0) return { released, kept };

  if (!domain) {
    for (const address of addresses) {
      kept.push({ address, reason: 'no domain on record' });
      log.info(
        `the reserved IP ${address} is no longer this cluster's address (it takes traffic at ` +
          `${newAddress ?? "its master's own address"}), but this environment has no domain, so ` +
          'vibecarbon cannot check that nothing points at it. It stays assigned to the master. ' +
          `When nothing uses it, release it in the ${Provider.NAME} console under Networking, ` +
          `Reserved IPs, or \`vibecarbon destroy ${environment}\` releases it.`,
      );
    }
    return { released, kept };
  }

  // SECURITY: a lookup that throws is one that could not run. It keeps every
  // address (releaseVerdict's `unchecked`), never fails the deploy that just
  // passed its probe, and never lets a release through.
  let answer;
  try {
    answer = await lookup(managedRecordNames(domain), { domain });
  } catch (err) {
    answer = { ok: false, reason: err?.message ?? String(err) };
  }
  for (const address of addresses) {
    const verdict = releaseVerdict({
      address,
      lookup: answer,
      dnsWrite,
      clearSince: clearSinceOf(env, address),
      domain,
      now: now(),
    });
    if (!verdict.release) {
      kept.push({ address, reason: verdict.kind });
      if (verdict.clearSince !== undefined && verdict.clearSince !== clearSinceOf(env, address)) {
        updateConfig((onDisk) => {
          const e = onDisk.environments?.[environment];
          if (e) setClearSince(e, address, verdict.clearSince);
        });
      }
      const said = keptLine(verdict, {
        address,
        environment,
        domain,
        newAddress,
        dnsWrite,
        providerName: Provider.NAME,
      });
      if (said) log[said.level](said.line);
      continue;
    }

    let reason = null;
    try {
      if (!(await provider.deleteReservedIpByAddress(address))) {
        reason = `${Provider.NAME} did not accept the delete`;
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    if (reason) {
      kept.push({ address, reason });
      log.warn(
        `DNS no longer answers with the reserved IP ${address}, but it could not be released ` +
          `(${reason}), so it is still on your ${Provider.NAME} account, which bills a reserved ` +
          'IP while it is not assigned to a droplet. The next deploy tries again, ' +
          `\`vibecarbon destroy ${environment}\` releases it too, or you can release it in the ` +
          `${Provider.NAME} console under Networking, Reserved IPs.`,
      );
      continue;
    }
    updateConfig((onDisk) => {
      const e = onDisk.environments?.[environment];
      if (e) forgetReservedIp(e, address);
    });
    released.push(address);
    log.info(
      `released the reserved IP ${address}: ${Provider.NAME} clusters now take traffic at ` +
        "their master's own address, and DNS no longer answers with it",
    );
  }
  return { released, kept };
}
