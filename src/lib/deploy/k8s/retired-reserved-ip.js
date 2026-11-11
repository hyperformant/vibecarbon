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
 * (`floatingIp`, or `ha.<role>.floatingIp` on k8s-ha) until it is released;
 * the surgery records an address the record lacks (recordRetiredReservedIps).
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
 *     address, every nameserver answers it, at least the record's TTL has
 *     passed since that write, so no resolver still holds the old answer, and
 *     no A record anywhere in the zone has the address (the backend's
 *     findARecordsAt: a record the user added, or a proxied one whose origin
 *     the nameservers do not show);
 *   - with DNS kept by hand, the user moved the records: a deploy first saw
 *     DNS without the address, and at least the record's TTL (and never less
 *     than MANUAL_DNS_MIN_WAIT_SECONDS, since the old record's TTL is not
 *     ours to know) has passed since that check. Until then the deploy prints
 *     the old and the new address and asks the user to move the records,
 *     and the origin of any proxy or CDN in front of the domain.
 *
 * Just before the release, the address leaves every stack that still lists
 * it (`dropRetired`): a warm redeploy runs no `up`, so its stack can still
 * hold the IP and its assignment, and a stack holding an address already
 * released fails every `vibecarbon destroy` after. No drop, no release.
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

/** The stack a k8s-ha side deploys as: its recorded `.stack`, else its role's default. */
function sideStack(environment, side, role) {
  return side?.stack ?? `${environment}-${role}`;
}

/**
 * The Pulumi stacks that may still list each retired address: single k8s's
 * stack is the environment; a k8s-ha side's is its `.stack` (a failover's
 * role swap carries it), else `<env>-<role>`, as destroy's backstop matches
 * (planK8sBackstopTargets). An environment-level address on k8s-ha could be
 * either side's, so both are named.
 *
 * @param {string} environment
 * @param {object|null|undefined} envConfig
 * @returns {Map<string, string[]>} address -> stack names
 */
export function retiredReservedIpStacks(environment, envConfig) {
  const stacks = new Map();
  const add = (address, stack) => {
    if (!address) return;
    const list = stacks.get(address) ?? [];
    if (!list.includes(stack)) list.push(stack);
    stacks.set(address, list);
  };
  const ha = envConfig?.ha;
  const primary = sideStack(environment, ha?.primary, 'primary');
  const standby = sideStack(environment, ha?.standby, 'standby');
  if (ha?.primary || ha?.standby) {
    add(envConfig?.floatingIp, primary);
    add(envConfig?.floatingIp, standby);
  } else {
    add(envConfig?.floatingIp, environment);
  }
  add(ha?.primary?.floatingIp, primary);
  add(ha?.standby?.floatingIp, standby);
  return stacks;
}

/**
 * The record a stack's retired address belongs on: the k8s-ha side whose
 * stack it is (by `.stack`, else by role, a side created if the record has
 * none), else the environment itself for single k8s's stack. Null for a
 * stack that is neither.
 */
function recordFor(env, environment, stackName) {
  const sides = [env.ha?.primary, env.ha?.standby];
  const byStack = sides.find((side) => side?.stack === stackName);
  if (byStack) return byStack;
  if (stackName === environment) return env;
  for (const role of ['primary', 'standby']) {
    if (stackName !== `${environment}-${role}`) continue;
    if (env.ha?.[role]?.stack) return null;
    env.ha = env.ha ?? {};
    env.ha[role] = env.ha[role] ?? { stack: stackName };
    return env.ha[role];
  }
  return null;
}

/**
 * Write the addresses the surgery took out of `stackName` onto the record
 * that owns that stack (`floatingIp`), where it names none: the stack was
 * their last record, and the release and destroy's backstop find a retired
 * address only by the environment's record. An environment saved before the
 * deploy recorded `floatingIp` has none. The surgery calls this before its
 * import (dropRetiredStackResources).
 *
 * @param {object} o
 * @param {string} o.environment - the environment as the operator names it
 * @param {string} o.stackName - the stack the addresses left
 * @param {string[]} o.addresses
 * @param {(fn: (config: object) => void) => unknown} [o.updateConfig]
 */
export function recordRetiredReservedIps({
  environment,
  stackName,
  addresses,
  updateConfig = updateProjectConfig,
}) {
  if (!addresses?.length) return;
  updateConfig((onDisk) => {
    const env = onDisk.environments?.[environment];
    if (!env) return;
    const record = recordFor(env, environment, stackName);
    // One recorded address per record: a second one (never seen, the old
    // program made one per stack) has nowhere to go.
    if (record && !record.floatingIp) record.floatingIp = addresses[0];
  });
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
 *   kind: 'release'|'unchecked'|'still-answered'|'not-moved'|'no-answer'|'settling'|'zone-record',
 *   names?: string[],
 *   served?: Array<{name: string, host: string, server: string, addresses: string[]}>,
 *   waitSeconds?: number,
 *   remainingSeconds?: number,
 *   clearSince?: number|null,
 *   reason?: string,
 *   source?: 'nameservers'|'zone',
 * }} ReleaseVerdict
 *   `clearSince`: what the record's clear-since stamp for the address becomes
 *   (epoch ms; null removes it; absent leaves it as it is). `served`
 *   (not-moved): what each nameserver that missed the new address answered.
 *   `source` (unchecked): what could not be read.
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
    return {
      release: false,
      kind: 'unchecked',
      source: 'nameservers',
      reason: lookup?.reason ?? 'no lookup',
    };
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
        served: missing.map(({ name, host, server, addresses }) => ({
          name,
          host,
          server,
          addresses,
        })),
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

/**
 * With managed DNS, a verdict that would release (or will, once resolvers
 * catch up) holds only if no A record in the zone has the address: the
 * nameservers were asked for the apex and the wildcard, and a record the
 * user added under another name, or a proxied one whose origin they do not
 * show, is just as live. A zone that could not be listed keeps the address
 * (fail closed). Other verdicts pass through. Pure.
 *
 * @param {ReleaseVerdict} verdict
 * @param {{ok: true, names: string[]} | {ok: false, reason: string}} zone
 * @returns {ReleaseVerdict}
 */
export function zoneVerdict(verdict, zone) {
  if (verdict.kind !== 'release' && verdict.kind !== 'settling') return verdict;
  if (!zone?.ok) {
    return {
      release: false,
      kind: 'unchecked',
      source: 'zone',
      reason: zone?.reason ?? 'no zone listing',
    };
  }
  if (zone.names.length > 0) return { release: false, kind: 'zone-record', names: zone.names };
  return verdict;
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

/** What the release checks, for the lines that name it. */
function checkedNames(domain, managed) {
  return (
    `${domain} and *.${domain} at ${domain}'s nameservers` +
    (managed ? ', and every A record in its DNS zone' : '')
  );
}

/**
 * The sentence every kept line ends with: what is checked before the
 * release, and what is not and so has to move first.
 */
function beforeRelease({ address, domain, newAddress, managed }) {
  const to = newAddress ?? "the cluster's master";
  return (
    ` Before it goes, vibecarbon checks ${checkedNames(domain, managed)}. Anything else that ` +
    `points at ${address} has to move to ${to} first: a record in another zone, or the origin ` +
    `of a proxy or CDN in front of ${domain} (Cloudflare's orange cloud, say), which the ` +
    'nameservers do not show.'
  );
}

/** "ns1 (192.0.2.1) answered 203.0.113.9 for example.com", the first few. */
function servedList(served) {
  const shown = served
    .slice(0, 4)
    .map(
      ({ name, host, server, addresses }) =>
        `${host} (${server}) answered ${addresses.length > 0 ? addresses.join(', ') : 'no A record'} ` +
        `for ${name}`,
    );
  const more = served.length - shown.length;
  return `${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
}

/**
 * The line a kept address gets, or null for none.
 * @returns {{level: 'info'|'warn', line: string}|null}
 */
function keptLine(verdict, { address, environment, domain, newAddress, dnsWrite, providerName }) {
  const destroyHint = `\`vibecarbon destroy ${environment}\` releases it too.`;
  const managed = Boolean(dnsWrite);
  const note = beforeRelease({ address, domain, newAddress, managed });
  switch (verdict.kind) {
    case 'unchecked':
      // Kept on every deploy whose check fails (fail closed), so the line
      // says why and what the address costs: free while assigned, billed
      // whenever it is not.
      return {
        level: 'warn',
        line:
          `the reserved IP ${address} stays assigned to this cluster's master for now: ` +
          (verdict.source === 'zone'
            ? `vibecarbon could not list the A records in ${domain}'s DNS zone (${verdict.reason}), ` +
              'so it cannot tell whether one still points at it. '
            : `vibecarbon could not check what ${domain}'s nameservers answer (${verdict.reason}), ` +
              'so it cannot tell whether DNS still points at it. ') +
          'Releasing it while DNS does would ' +
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
          `The next deploy checks again, and ${destroyHint}${note}`,
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
              `point it at ${dnsWrite.target}; the next deploy checks again.${note}`,
          }
        : {
            level: 'warn',
            line:
              `your DNS for ${domain} is kept by hand and still answers ${address}, the reserved ` +
              `IP this cluster used before. Point the A records for ${domain} and *.${domain} at ` +
              `${newAddress}, the cluster's master. Until then ${address} stays assigned to the ` +
              'master and keeps serving, and a later deploy releases it once DNS no longer ' +
              `answers with it.${note}`,
          };
    case 'zone-record': {
      const one = verdict.names.length === 1;
      return {
        level: 'warn',
        line:
          `${listed(verdict.names)} in ${domain}'s DNS zone still ${one ? 'points' : 'point'} at ` +
          `${address}, the reserved IP this cluster used before, though this deploy pointed ` +
          `${domain} and *.${domain} at ${dnsWrite?.target}. ${address} stays assigned to the ` +
          `master and keeps serving until ${one ? 'it moves' : 'they move'}: point ` +
          `${one ? 'it' : 'them'} at ${dnsWrite?.target}, or remove ${one ? 'it' : 'them'}, and ` +
          `a later deploy releases the address.${note}`,
      };
    }
    case 'not-moved':
      return {
        level: 'info',
        line:
          `${domain}'s nameservers do not answer ${dnsWrite?.target} for every name yet` +
          (verdict.served?.length ? ` (${servedList(verdict.served)})` : '') +
          `, so the reserved IP ${address} stays assigned to the master for now. The next ` +
          `deploy checks again.${note}`,
      };
    case 'no-answer':
      return {
        level: 'warn',
        line:
          `${domain} has no A record at its nameservers, so vibecarbon cannot tell whether ` +
          `anything still points at the reserved IP ${address}. It stays assigned to the master. ` +
          `Point ${domain} and *.${domain} at ${newAddress}, and a later deploy releases it.${note}`,
      };
    case 'settling':
      return {
        level: 'info',
        line:
          `DNS no longer answers with the reserved IP ${address}. Resolvers may still have it ` +
          `cached for up to ${verdict.remainingSeconds} s more, so it stays assigned to the ` +
          `master and the next deploy after that releases it.${note}`,
      };
    default:
      return null;
  }
}

/** An error's first line, short enough for a log line. */
function oneLine(err) {
  const text = err instanceof Error ? err.message : String(err);
  const first = text.split('\n').find((l) => l.trim() !== '') ?? text;
  return first.length > 300 ? `${first.slice(0, 297)}...` : first.trim();
}

/**
 * Release every retired reserved IP the environment has on record whose DNS
 * has moved off it (releaseVerdict, and zoneVerdict with managed DNS), once
 * every stack that may still list it no longer does (`dropRetired`), and
 * forget each one released. One that may not go yet, or whose drop or
 * release fails, stays on record with a line that says why and what
 * releases it.
 *
 * @param {object} o
 * @param {string} o.environment
 * @param {{K8S_FLOATING_IP?: boolean, NAME: string}} o.Provider
 * @param {{deleteReservedIpByAddress: (address: string) => Promise<boolean>}} o.provider
 * @param {{info: (line: string) => void, warn: (line: string) => void}} o.log
 * @param {string|null|undefined} o.domain - the environment's domain
 * @param {DnsWrite|null} o.dnsWrite - this run's managed-DNS write; null when DNS is kept by hand
 * @param {string|null} o.newAddress - where the domain should point now (the cluster's ingress)
 * @param {(stackName: string) => Promise<unknown>} [o.dropRetired] - take the
 *   retired resources out of that stack's state (dropRetiredStackResources);
 *   throws when it could not. Without one, nothing is released.
 * @param {((address: string) => Promise<string[]>)|null} [o.zoneRecordsAt] -
 *   managed DNS: every A record in the zone at the address (the backend's
 *   findARecordsAt). Without one, managed DNS releases nothing.
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
  dropRetired = async () => {
    throw new Error('no way to open the stack');
  },
  zoneRecordsAt = null,
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
  // SECURITY: the zone's own listing, asked only when the nameservers'
  // answer would let the address go. A listing that fails or throws keeps it.
  const listZone = async (address) => {
    if (!zoneRecordsAt) return { ok: false, reason: 'no DNS API access to list it' };
    try {
      const names = await zoneRecordsAt(address);
      if (!Array.isArray(names)) return { ok: false, reason: 'the listing returned no records' };
      return { ok: true, names };
    } catch (err) {
      return { ok: false, reason: oneLine(err) };
    }
  };
  // Each stack once, however many of its addresses go.
  const drops = new Map();
  const dropFrom = (stackName) => {
    if (!drops.has(stackName)) {
      drops.set(
        stackName,
        Promise.resolve()
          .then(() => dropRetired(stackName))
          .then(
            () => null,
            (err) => oneLine(err),
          ),
      );
    }
    return drops.get(stackName);
  };
  const stacksOf = retiredReservedIpStacks(environment, env);

  for (const address of addresses) {
    let verdict = releaseVerdict({
      address,
      lookup: answer,
      dnsWrite,
      clearSince: clearSinceOf(env, address),
      domain,
      now: now(),
    });
    // Listed only when the nameservers' answer would let it go (now, or
    // once resolvers catch up): any other verdict keeps it regardless.
    if (dnsWrite && (verdict.kind === 'release' || verdict.kind === 'settling')) {
      verdict = zoneVerdict(verdict, await listZone(address));
    }
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

    // A stack that still lists the address (a warm redeploy ran no up) must
    // let go of it first: released while listed, it fails every destroy after.
    let dropped = true;
    for (const stackName of stacksOf.get(address) ?? []) {
      const failure = await dropFrom(stackName);
      if (!failure) continue;
      dropped = false;
      kept.push({ address, reason: `stack ${stackName}: ${failure}` });
      log.warn(
        `DNS no longer answers with the reserved IP ${address}, but it is not released yet: ` +
          `vibecarbon could not take it out of stack ${stackName}'s Pulumi state (${failure}), ` +
          `and releasing it while the stack still lists it would make \`vibecarbon destroy ` +
          `${environment}\` fail on it. It stays assigned to the master, and the next deploy ` +
          'tries again.',
      );
      break;
    }
    if (!dropped) continue;

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
        `their master's own address${newAddress ? ` (${newAddress})` : ''}. vibecarbon checked ` +
        `${checkedNames(domain, Boolean(dnsWrite))} and none points at it. Anything else that ` +
        `still did, a record in another zone or the origin of a proxy or CDN, needs to point at ` +
        `${newAddress ?? "the cluster's master"} now.`,
    );
  }
  return { released, kept };
}
