/**
 * Operator-IP detection and management for the SSH (port 22) and Kubernetes
 * API (port 6443) rules of every environment's cloud firewall.
 *
 * Architecture: a project-level list of operator CIDRs persisted in
 * .vibecarbon.json under `operatorCidrs`. Every command that needs SSH or
 * k8s API access calls `ensureOperatorIpAccess` near the top of its run():
 * it detects the operator's current public IP, saves it to the list if no
 * entry covers it, and, when the environment's record
 * (`operatorCidrsPushed`) lacks it, pushes the whole saved list to that
 * environment's firewall with its own provider's API. Once the record holds
 * the address, later commands from it push nothing, and within a day of the
 * entry's `lastUsedAt` they write nothing either (touchCidr).
 *
 * Only a `-y` run under CI skips auto-detect (shouldAutoDetectOperatorIp):
 * it requires an already-populated list or an explicit ALLOWED_SSH_IPS env
 * var, since CI runners have ephemeral IPs that would otherwise pollute the
 * list.
 *
 * Exports:
 *   - detectOperatorIp() — primary + fallback HTTP detector
 *   - cidrFromIp(ip, version) — formats /32 or /128
 *   - loadOperatorCidrs / addCidr / touchCidr / removeCidr / pruneCidrs
 *   - findMatchingCidr — checks if an IP is contained by any persisted CIDR
 *   - applyToFirewall — patches one environment's firewalls through its
 *     provider
 *   - envFirewallSides / providerTokenFor / pushOperatorCidrs — push one
 *     environment's firewalls with its own token and record what it now
 *     allows (`operatorCidrsPushed`)
 *   - ensureOperatorIpAccess — the all-in-one helper for command run()s
 *   - ensureOperatorIpAccessWarn / ensureOperatorIpAccessWarnAll — the
 *     stderr, warn-and-continue form (`shell`, `diagnose`, `status`)
 */

import { readProjectConfigFile, updateProjectConfig } from './config.js';
import { fetchWithRetry } from './fetch-retry.js';
import { readOperatorVar } from './operator-env.js';
import { armOperatorIpGuard } from './operator-ip-guard.js';
import { providerFor, providerIdFor, resolveProviderToken } from './providers/index.js';

// ============================================================================
// IP DETECTION
// ============================================================================

const PRIMARY_DETECTOR = 'https://api.ipify.org';
const FALLBACK_DETECTOR = 'https://icanhazip.com';

/**
 * Resolve the operator's current public IP. Returns { ip, version: 4|6 }.
 * Throws if both detectors fail.
 */
export async function detectOperatorIp({ fetcher = fetchWithRetry } = {}) {
  const errors = [];
  for (const url of [PRIMARY_DETECTOR, FALLBACK_DETECTOR]) {
    try {
      const res = await fetcher(url, { method: 'GET' });
      if (!res.ok) {
        errors.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      const ip = (await res.text()).trim();
      const version = ip.includes(':') ? 6 : 4;
      if (!isValidIp(ip, version)) {
        errors.push(`${url}: invalid response "${ip}"`);
        continue;
      }
      return { ip, version };
    } catch (err) {
      errors.push(`${url}: ${err.message || err}`);
    }
  }
  throw new Error(`Unable to detect operator IP — ${errors.join('; ')}`);
}

function isValidIp(ip, version) {
  if (version === 4) {
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
    return ip.split('.').every((p) => {
      const n = Number(p);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }
  // IPv6 — must contain colons and only hex chars
  return /^[0-9a-fA-F:]+$/.test(ip) && ip.includes(':');
}

export function cidrFromIp(ip, version) {
  return `${ip}/${version === 6 ? 128 : 32}`;
}

// ============================================================================
// CIDR MATCHING
// ============================================================================

/**
 * Find the first persisted CIDR entry that contains the given IP, or null.
 */
export function findMatchingCidr(list, ip, version) {
  for (const entry of list) {
    if (cidrContainsIp(entry.cidr, ip, version)) return entry;
  }
  return null;
}

export function cidrContainsIp(cidr, ip, version) {
  const slashIdx = cidr.indexOf('/');
  if (slashIdx < 0) return false;
  const base = cidr.slice(0, slashIdx);
  const bits = Number(cidr.slice(slashIdx + 1));
  if (!Number.isInteger(bits) || bits < 0) return false;

  const cidrIsV6 = base.includes(':');
  if (cidrIsV6 !== (version === 6)) return false;

  if (version === 4) {
    if (bits > 32) return false;
    const baseNum = ipv4ToInt(base);
    const ipNum = ipv4ToInt(ip);
    if (baseNum === null || ipNum === null) return false;
    if (bits === 0) return true;
    if (bits === 32) return baseNum === ipNum;
    const mask = (-1 << (32 - bits)) >>> 0;
    return (baseNum & mask) === (ipNum & mask);
  }

  if (bits > 128) return false;
  const baseNum = ipv6ToBigInt(base);
  const ipNum = ipv6ToBigInt(ip);
  if (baseNum === null || ipNum === null) return false;
  if (bits === 0) return true;
  if (bits === 128) return baseNum === ipNum;
  const shift = BigInt(128 - bits);
  return baseNum >> shift === ipNum >> shift;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const num = Number(p);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    n = (n << 8) | num;
  }
  return n >>> 0;
}

function ipv6ToBigInt(ip) {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (head.length + tail.length > 8) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  const fillCount = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array(fillCount).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    result = (result << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return result;
}

// ============================================================================
// CIDR LIST MANAGEMENT
// ============================================================================

export function loadOperatorCidrs(projectConfig) {
  return projectConfig?.operatorCidrs ?? [];
}

/**
 * Append a CIDR to the list, or refresh lastUsedAt if it's already present.
 * Returns the new list (input is not mutated).
 */
export function addCidr(list, cidr, now = new Date()) {
  const nowIso = now.toISOString();
  const idx = list.findIndex((e) => e.cidr === cidr);
  if (idx >= 0) {
    return list.map((e, i) => (i === idx ? { ...e, lastUsedAt: nowIso } : e));
  }
  return [...list, { cidr, addedAt: nowIso, lastUsedAt: nowIso }];
}

/** How long a refreshed `lastUsedAt` stands before a command writes it again. */
const LAST_USED_REFRESH_MS = 86_400_000;

/**
 * addCidr for a command's own address, without rewriting .vibecarbon.json
 * on every run: an entry whose `lastUsedAt` is under a day old is left as
 * it is, and the list comes back unchanged, so updateProjectConfig writes
 * nothing. Projects commit that file, and a status run must not dirty it.
 * A missing entry (another terminal removed it meanwhile) is re-added, and
 * an older one refreshed: pruneCidrs works in days, so a day's lag costs
 * nothing.
 *
 * @param {Array<{cidr: string, lastUsedAt?: string}>} list
 * @param {string} cidr
 * @param {Date} [now]
 */
export function touchCidr(list, cidr, now = new Date()) {
  const entry = list.find((e) => e.cidr === cidr);
  const age = now.getTime() - new Date(entry?.lastUsedAt).getTime();
  if (entry && age >= 0 && age < LAST_USED_REFRESH_MS) return list;
  return addCidr(list, cidr, now);
}

export function removeCidr(list, cidr) {
  return list.filter((e) => e.cidr !== cidr);
}

/**
 * Drop entries whose lastUsedAt is older than maxAgeDays.
 */
export function pruneCidrs(list, now = new Date(), maxAgeDays = 90) {
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  return list.filter((e) => {
    const t = new Date(e.lastUsedAt).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

/**
 * Change the persisted allowlist under the config lock: `change` gets the
 * list as it is on disk now (another terminal may have added or removed an
 * entry since this command loaded its copy) and returns the new one. A change
 * that would leave the list empty is refused, since that locks everyone out.
 * The in-memory projectConfig is updated too. Returns the list as written,
 * for the firewall push.
 *
 * @param {object} projectConfig
 * @param {(list: Array<{cidr: string}>) => Array<{cidr: string}>} change
 * @param {string} [cwd]
 */
export function updateOperatorCidrs(projectConfig, change, cwd) {
  let written;
  updateProjectConfig((config) => {
    written = change(loadOperatorCidrs(config));
    if (written.length === 0) {
      throw new Error(
        'Refusing to leave the operator allowlist empty; that would lock everyone out of every environment. Add another entry first.',
      );
    }
    config.operatorCidrs = written;
  }, cwd);
  if (projectConfig) projectConfig.operatorCidrs = written;
  return written;
}

// ============================================================================
// FIREWALL UPDATE
// ============================================================================

/**
 * The operator firewall's name for one side of an environment.
 *
 * @param {string} projectName
 * @param {string} side the environment, or `<env>-primary` / `<env>-standby`
 */
export function firewallName(projectName, side) {
  return `${projectName}-${side}-firewall`;
}

/**
 * Patch the SSH (port 22) and Kubernetes API (port 6443) rules on each of
 * one environment's firewalls to use the given CIDR list as their sources.
 * Other rules (HTTP/HTTPS, internal cluster traffic) are left unchanged.
 * The whole list replaces the sources: an entry missing from it is no
 * longer let in.
 *
 * environments holds that one environment's sides: for HA,
 * ['<env>-primary', '<env>-standby']; otherwise ['<env>'].
 *
 * Returns the names of firewalls that were updated. A firewall the provider
 * does not find is skipped; callers that must not pass over one compare the
 * names returned with the ones asked for.
 *
 * Builds one provider instance from envConfig, that environment's own
 * provider, and the token passed must be that provider's: a project can mix
 * providers, so callers push each environment on its own
 * (pushOperatorCidrs). The provider's applyOperatorCidrs does the wire calls
 * (find by name, rewrite the rules); this keeps the provider-neutral
 * empty-list lockout guard and the `${projectName}-${env}-firewall` naming.
 */
export async function applyToFirewall({
  projectName,
  environments,
  operatorCidrs,
  apiToken,
  envConfig,
}) {
  const cidrs = operatorCidrs.map((e) => e.cidr);
  if (cidrs.length === 0) {
    throw new Error('Refusing to update firewall with empty CIDR list (would lock everyone out).');
  }
  const Provider = providerFor(envConfig);
  if (!apiToken) {
    throw new Error(
      `${Provider.NAME} API token required to update firewall (set ${Provider.TOKEN_ENV}).`,
    );
  }

  const provider = new Provider(apiToken);
  const updated = [];
  for (const env of environments) {
    const fwName = firewallName(projectName, env);
    const wasUpdated = await provider.applyOperatorCidrs({ firewallName: fwName, cidrs });
    if (wasUpdated) updated.push(fwName);
  }
  return updated;
}

/**
 * The firewall names' environment part for one environment as its record
 * describes it: both sides of compose-HA and k8s HA, the one otherwise.
 *
 * @param {string} environment user-facing environment name
 * @param {{ deployMode?: string, ha?: { enabled?: boolean } } | undefined} envConfig
 * @returns {string[]}
 */
export function envFirewallSides(environment, envConfig) {
  return envConfig?.deployMode === 'compose-ha' || envConfig?.ha?.enabled
    ? [`${environment}-primary`, `${environment}-standby`]
    : [environment];
}

/**
 * Whether an environment records any server, so is deployed: the flat
 * `servers` list (every mode's final save, and the early writes of compose
 * and compose-HA), or an address on an HA side (k8s-HA writes
 * `ha.primary`/`ha.standby` once both clusters are up, before its final
 * save). An environment with neither is the skeleton of a first deploy that
 * stopped before its servers were recorded. `status` passes over it, having
 * nothing to read; `vibecarbon access` pushes it best-effort, since a
 * single-k8s first deploy records its servers only in its final save and
 * may have left a firewall.
 *
 * @param {{ servers?: unknown[], ha?: Record<string, any> } | undefined} envConfig
 * @returns {boolean}
 */
export function envHasServers(envConfig) {
  if (Array.isArray(envConfig?.servers) && envConfig.servers.length > 0) return true;
  return ['primary', 'standby'].some((side) => {
    const s = envConfig?.ha?.[side];
    return !!(s?.ingressIp || s?.masterIp || s?.floatingIp || s?.dbIp || s?.ip);
  });
}

/**
 * The operator's token for an environment's own provider. A project can mix
 * providers, so a push to several environments looks it up per environment.
 *
 * @param {{ provider?: string } | undefined} envConfig
 * @returns {string | null | undefined}
 */
export function providerTokenFor(envConfig) {
  return resolveProviderToken(providerIdFor(envConfig));
}

/** The CIDRs of a list, sorted: the form `operatorCidrsPushed` keeps. */
function sortedCidrs(operatorCidrs) {
  return operatorCidrs.map((e) => e.cidr).sort();
}

/**
 * Push the list to one environment's firewalls (applyToFirewall), then record
 * on that environment, in .vibecarbon.json and in memory, the CIDRs its
 * firewalls now allow (`operatorCidrsPushed`, sorted). The list is saved
 * project-wide, but most pushes reach one environment, so the record is how
 * a later command finds an environment whose firewall does not let the
 * operator's address in yet (recordAllows).
 *
 * Recorded only when every side was found and updated: a provider's firewall
 * lookup answers "not found" for an API error too, and a record written then
 * would keep the next run from trying again.
 *
 * Every push goes through here, so every push is recorded
 * (tests/unit/access/operator-ip-everywhere.test.ts holds the other callers
 * of applyToFirewall to none).
 *
 * @param {object} o
 * @param {object} o.projectConfig loaded .vibecarbon.json
 * @param {string} o.environment user-facing environment name
 * @param {string[]} o.sides the firewall names' environment parts
 * @param {Array<{cidr: string}>} o.operatorCidrs
 * @param {string | null | undefined} o.apiToken the environment's provider token
 * @param {string} [o.cwd] the project directory whose .vibecarbon.json is updated
 * @param {boolean} [o.record] false when `sides` are not all the
 *   environment's: the record says what the whole environment allows
 * @returns {Promise<string[]>} the firewalls updated
 */
export async function pushOperatorCidrs({
  projectConfig,
  environment,
  sides,
  operatorCidrs,
  apiToken,
  cwd,
  record = true,
}) {
  const updated = await applyToFirewall({
    projectName: projectConfig.projectName,
    environments: sides,
    operatorCidrs,
    apiToken,
    envConfig: projectConfig.environments?.[environment],
  });
  if (record && updated.length === sides.length) {
    const pushed = sortedCidrs(operatorCidrs);
    updateProjectConfig((config) => {
      const env = config.environments?.[environment];
      if (env) env.operatorCidrsPushed = pushed;
    }, cwd);
    const inMemory = projectConfig.environments?.[environment];
    if (inMemory) inMemory.operatorCidrsPushed = pushed;
  }
  return updated;
}

/**
 * Whether an environment's record says its firewall was last pushed a list
 * holding `cidr`. No record (an environment last pushed before records
 * existed, or never) counts as not.
 *
 * This, not "the record differs from the saved list", is what makes a
 * command push: a command pushes to let its operator in, never because the
 * lists differ. Pushing every difference would turn a routine command into a
 * sync of the local list to every firewall, so a stale checkout would
 * re-open a CIDR someone removed, or drop a teammate's newer one, on every
 * run. A push still sends the whole saved list (applyToFirewall), so the
 * one a command does make carries its checkout's list.
 *
 * @param {{ operatorCidrsPushed?: string[] } | undefined} envConfig
 * @param {string | null} cidr
 */
function recordAllows(envConfig, cidr) {
  const record = envConfig?.operatorCidrsPushed;
  return Array.isArray(record) && record.includes(cidr);
}

// ============================================================================
// AUTO-ADD HELPER
// ============================================================================

/**
 * Whether to auto-detect the operator's current public IP and ensure it's on
 * the allowlist. Interactive deploys always do. Non-interactive (`-y`) deploys
 * ALSO do — `-y` means "don't prompt me", not "don't protect me": a redeploy
 * from a new network must re-assert the operator's IP or SSH-dependent steps
 * (sideload) time out. The ONE exception is CI, where ephemeral runner IPs
 * would pollute the persisted list, so CI relies on a pre-populated list or
 * ALLOWED_SSH_IPS instead. (GitHub Actions & friends set CI=true.)
 *
 * @param {{yes: boolean, env?: NodeJS.ProcessEnv}} args
 * @returns {boolean}
 */
export function shouldAutoDetectOperatorIp({ yes, env = process.env }) {
  if (!yes) return true;
  const inCI = ['1', 'true'].includes(String(env.CI || '').toLowerCase());
  return !inCI;
}

/**
 * A firewall push that threw inside ensureOperatorIpAccess, after the
 * address was saved. It carries whether the address was new (`added`), so a
 * gate can tell "this address may not be let in" (new: stop) from "the
 * firewall could not be refreshed for an address already on the list"
 * (operator-ip-gate.js warns and goes on). The message is the push's own.
 */
export class FirewallPushError extends Error {
  /**
   * @param {unknown} cause
   * @param {{ added: boolean, cidr: string }} o
   */
  constructor(cause, { added, cidr }) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'FirewallPushError';
    this.added = added;
    this.cidr = cidr;
  }
}

/**
 * Ensure the current operator's IP is covered by the project's CIDR list,
 * persisting it if not, and push the list to this environment's firewall
 * when its record (`operatorCidrsPushed`) lacks the operator's CIDR: a new
 * address, or one another environment's command saved and pushed only
 * there (`deploy prod` saved it, so `backup staging` must open staging).
 *
 * Inputs:
 *   projectConfig — loaded .vibecarbon.json (must include projectName and
 *     environments[<environment>] for the apply step to fire)
 *   environment — user-facing env name
 *   isHA — whether to update both '<env>-primary' and '<env>-standby'
 *     firewalls (vs just '<env>')
 *   sides - only these of them (`configure cicd` on k8s-ha, for the sides
 *     whose kubeconfig is here); the record is left as it was, since it
 *     speaks for every side
 *   apiToken — the environment's own provider API token (resolveProviderToken
 *     reads it from the shell or the project's .env.local); null pushes nothing
 *   yes — non-interactive mode flag
 *   onMessage — optional callback invoked with a single info string when a
 *     new CIDR is added (caller wires this to its logger)
 *   cwd — the project directory whose .vibecarbon.json is updated
 *   fetcher — the detectors' fetch (detectOperatorIp); status passes a quick
 *     one (quickDetectFetcher)
 *
 * Returns { added, cidr, list, fromEnv, pushed, updated, missed }:
 *   added — true if the list was modified this call
 *   cidr — the CIDR that was added (or matched, when added=false)
 *   list — the updated list
 *   fromEnv — true if the list was bootstrapped from ALLOWED_SSH_IPS env var
 *   pushed — true if a push updated every firewall of this environment
 *   updated / missed — the firewall names a push updated, and the ones it
 *     did not find (both empty when nothing was pushed)
 *
 * Throws FirewallPushError when the push throws.
 */
export async function ensureOperatorIpAccess({
  projectConfig,
  environment,
  isHA = false,
  sides: only,
  apiToken,
  yes = false,
  onMessage,
  cwd,
  fetcher = fetchWithRetry,
}) {
  const list = loadOperatorCidrs(projectConfig);

  if (!shouldAutoDetectOperatorIp({ yes })) {
    // CI (or any non-auto-detect path): trust the persisted list, else bootstrap
    // from ALLOWED_SSH_IPS. Never auto-detect — the runner IP is ephemeral.
    if (list.length > 0) {
      return { added: false, cidr: null, list };
    }
    const envCidrs = parseAllowedSshIpsEnv(readOperatorVar('ALLOWED_SSH_IPS').value);
    if (envCidrs.length === 0) {
      throw new Error(
        'No operator CIDRs configured. Run `vibecarbon deploy` interactively first, or set ALLOWED_SSH_IPS="1.2.3.4/32,5.6.7.8/32".',
      );
    }
    const now = new Date();
    const newList = envCidrs.map((cidr) => ({
      cidr,
      addedAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
    }));
    // Another command may have seeded the list meanwhile: a persisted list wins.
    const written = persist(projectConfig, (fresh) => (fresh.length > 0 ? fresh : newList), cwd);
    return { added: true, cidr: envCidrs.join(','), list: written, fromEnv: true };
  }

  // Auto-detect path — interactive OR a non-CI `-y` deploy.
  let ip;
  let version;
  try {
    ({ ip, version } = await detectOperatorIp({ fetcher }));
  } catch (err) {
    // Under -y with a populated list the operator may already be covered — warn
    // and continue rather than block the deploy on a transient detector failure.
    // (Interactive, or -y with an empty list, has nothing to fall back to.)
    if (yes && list.length > 0) {
      if (onMessage) {
        onMessage(
          `Could not detect your public IP (${err.message}), skipping allowlist refresh. ` +
            `If SSH times out, run \`vibecarbon access add <cidr>\`.`,
        );
      }
      return { added: false, cidr: null, list };
    }
    throw new Error(
      `${err.message}. Pass ALLOWED_SSH_IPS=... or run \`vibecarbon access add <cidr>\` manually.`,
    );
  }

  // Remember the IP this command was let in under: if it changes mid-command
  // the transport layers fail fast instead of waiting out locked firewalls.
  armOperatorIpGuard({ ip });

  const match = findMatchingCidr(list, ip, version);
  const added = !match;
  const cidr = match ? match.cidr : cidrFromIp(ip, version);
  if (added && onMessage) onMessage(`Detected your IP: ${cidr}, adding to access list...`);
  // touchCidr appends a new CIDR, re-adds a matched one another terminal
  // removed meanwhile (this operator is connecting from it right now), and
  // refreshes its lastUsedAt at most once a day, so a routine command leaves
  // .vibecarbon.json as it was.
  const updatedList = persist(projectConfig, (fresh) => touchCidr(fresh, cidr), cwd);

  // Push when the env is already deployed (its firewall exists) and its
  // record lacks this CIDR. For first-deploy bootstrap, the deploy flow
  // itself creates the firewall with the right CIDRs from the persisted list.
  const envConfig = projectConfig?.environments?.[environment];
  let updated = [];
  let missed = [];
  if (envConfig && apiToken && !recordAllows(envConfig, cidr)) {
    const all = isHA ? [`${environment}-primary`, `${environment}-standby`] : [environment];
    const sides = only ?? all;
    try {
      updated = await pushOperatorCidrs({
        projectConfig,
        environment,
        sides,
        operatorCidrs: updatedList,
        apiToken,
        cwd,
        // The record is the whole environment's: a push to some of its
        // sides leaves it, so the next command still pushes the rest.
        record: all.every((side) => sides.includes(side)),
      });
    } catch (err) {
      throw new FirewallPushError(err, { added, cidr });
    }
    missed = sides
      .map((side) => firewallName(projectConfig.projectName, side))
      .filter((name) => !updated.includes(name));
  }

  return {
    added,
    cidr,
    list: updatedList,
    pushed: updated.length > 0 && missed.length === 0,
    updated,
    missed,
  };
}

function persist(projectConfig, change, cwd) {
  if (!projectConfig) return change([]);
  return updateOperatorCidrs(projectConfig, change, cwd);
}

export function parseAllowedSshIpsEnv(envVar) {
  if (!envVar) return [];
  return envVar
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * ensureOperatorIpAccessWarnAll for the one environment a debug command
 * (`diagnose`, `shell`) works on, with the token the command resolved.
 *
 * No-op when the project config or token is missing.
 */
export async function ensureOperatorIpAccessWarn({ projectConfig, environment, apiToken }) {
  if (!projectConfig || !apiToken) return;
  await ensureOperatorIpAccessWarnAll({
    projectConfig,
    environments: [environment],
    yes: false,
    tokenFor: () => apiToken,
  });
}

/** Per-detector budget on the status path (quickDetectFetcher). */
const QUICK_DETECT_TIMEOUT_MS = 5_000;

/**
 * The detectors' fetch for `status`: one attempt each, cut off after
 * QUICK_DETECT_TIMEOUT_MS, so an unreachable detector costs status about
 * 10 s instead of fetchWithRetry's five attempts with backoff per detector
 * (about 30 s). Status only reads, and a missed detection only warns. A
 * deploy keeps the full retry: it cannot go on without the address.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 */
export function quickDetectFetcher(url, init = {}) {
  return fetchWithRetry(url, {
    ...init,
    maxAttempts: 1,
    signal: AbortSignal.timeout(QUICK_DETECT_TIMEOUT_MS),
  });
}

/**
 * Let the operator's current address through every named environment's
 * firewall before a command reads them remotely (`status`, and through
 * ensureOperatorIpAccessWarn `diagnose` and `shell`).
 *
 * ensureOperatorIpAccess runs once, pushing nothing, to detect and save the
 * address. Then every named environment whose record (`operatorCidrsPushed`)
 * lacks the operator's CIDR is pushed the saved list, both sides of an HA
 * one, each with its own provider's token, in one loop: a failure on any of
 * them, the first too, still lets the others through. "Already listed" is not
 * enough: a command saves an address project-wide but pushes only its own
 * environment. An environment with no record counts as lacking it. Any other
 * difference is left alone (recordAllows says why).
 *
 * The list and the record are read from disk again just before each push:
 * an `access remove` in another terminal may have pushed and recorded that
 * environment since this command saved its list, and pushing the older list
 * would re-open the CIDR it removed.
 *
 * An environment whose provider token is missing is named only when the
 * address is new: status is mostly run without tokens, and an address
 * already on the list is usually let in already.
 *
 * Under CI (`yes` and CI=true) it does nothing: the runner's address is
 * ephemeral, so the saved list is trusted and nothing is detected, saved or
 * pushed. That keeps `status -json` in CI a pure read.
 *
 * Every line goes to console.error, so stdout stays clean (status -json,
 * diagnose's teed report, shell's rcfile banner), and any failure warns and
 * continues: the operator may be looking into exactly the case where the
 * firewall API is unreachable.
 *
 * @param {object} o
 * @param {object} o.projectConfig loaded .vibecarbon.json
 * @param {string[]} o.environments user-facing environment names
 * @param {boolean} [o.yes] non-interactive (status passes true)
 * @param {string} [o.cwd] the project directory whose .vibecarbon.json is updated
 * @param {(envConfig: object) => string | null | undefined} [o.tokenFor]
 * @param {boolean} [o.quickDetect] detect within status's budget (quickDetectFetcher)
 * @returns {Promise<void>}
 */
export async function ensureOperatorIpAccessWarnAll({
  projectConfig,
  environments,
  yes = true,
  cwd,
  tokenFor = providerTokenFor,
  quickDetect = false,
}) {
  if (!projectConfig || environments.length === 0) return;
  if (!shouldAutoDetectOperatorIp({ yes })) return;
  const { c } = await import('./colors.js');
  const mayTimeOut = '  Continuing, kubectl/SSH may time out if your IP is not allowlisted.';

  let result;
  try {
    result = await ensureOperatorIpAccess({
      projectConfig,
      environment: environments[0],
      apiToken: null,
      yes,
      onMessage: (msg) => console.error(`${c.info('i')} ${msg}`),
      cwd,
      ...(quickDetect ? { fetcher: quickDetectFetcher } : {}),
    });
  } catch (err) {
    console.error(`${c.warning('!')} Operator-IP check failed: ${err.message}`);
    console.error(mayTimeOut);
    return;
  }

  // Detection failed (and the saved list was trusted): no CIDR to check for.
  const { cidr } = result;
  if (!cidr) return;
  for (const environment of environments) {
    const envConfig = projectConfig.environments?.[environment];
    if (!envConfig || recordAllows(envConfig, cidr)) continue;
    const apiToken = tokenFor(envConfig);
    if (!apiToken) {
      if (result.added) {
        console.error(
          `${c.warning('!')} Firewall of ${environment} not updated: ${providerFor(envConfig).TOKEN_ENV} is not set.`,
        );
        console.error(mayTimeOut);
      }
      continue;
    }
    const sides = envFirewallSides(environment, envConfig);
    try {
      const onDisk = readProjectConfigFile(cwd) ?? projectConfig;
      if (recordAllows(onDisk.environments?.[environment], cidr)) continue;
      const list = loadOperatorCidrs(onDisk);
      if (!list.some((e) => e.cidr === cidr)) {
        console.error(
          `${c.warning('!')} Firewall of ${environment} left alone: ${cidr} was taken off the list meanwhile.`,
        );
        continue;
      }
      const updated = await pushOperatorCidrs({
        projectConfig,
        environment,
        sides,
        operatorCidrs: list,
        apiToken,
        cwd,
      });
      if (updated.length === sides.length) {
        console.error(
          `${c.success('✓')} Firewall of ${environment} updated: SSH/k8s API now allow ${cidr}`,
        );
      } else {
        console.error(
          `${c.warning('!')} Firewall of ${environment} not fully updated: ${providerFor(envConfig).NAME} found ${updated.length} of its ${sides.length} firewalls.`,
        );
        console.error(mayTimeOut);
      }
    } catch (err) {
      console.error(`${c.warning('!')} Firewall of ${environment} not updated: ${err.message}`);
      console.error(mayTimeOut);
    }
  }
}
