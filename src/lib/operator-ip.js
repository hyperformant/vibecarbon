/**
 * Operator-IP detection and management for the Hetzner Cloud firewall's
 * SSH (port 22) and Kubernetes API (port 6443) rules.
 *
 * Architecture: a project-level list of operator CIDRs persisted in
 * .vibecarbon.json under `operatorCidrs`. Every interactive command that
 * needs SSH or k8s API access calls `ensureOperatorIpAccess` near the top
 * of its run() — if the operator's current public IP isn't already covered
 * by an entry in the list, the helper detects it, appends it, and patches
 * the live Hetzner firewall via the Cloud API. Subsequent commands from
 * the same IP are silent.
 *
 * Non-interactive (--yes) flows skip auto-detect and require either an
 * already-populated list or an explicit ALLOWED_SSH_IPS env var, since CI
 * runners have ephemeral IPs that would otherwise pollute the list.
 *
 * Exports:
 *   - detectOperatorIp() — primary + fallback HTTP detector
 *   - cidrFromIp(ip, version) — formats /32 or /128
 *   - loadOperatorCidrs / addCidr / removeCidr / pruneCidrs
 *   - findMatchingCidr — checks if an IP is contained by any persisted CIDR
 *   - applyToFirewall — patches the live Hetzner firewall via the Cloud API
 *   - envFirewallSides / providerTokenFor / pushOperatorCidrs — push one
 *     environment's firewalls with its own token and record what it now
 *     allows (`operatorCidrsPushed`)
 *   - ensureOperatorIpAccess — the all-in-one helper for command run()s
 *   - ensureOperatorIpAccessWarn / ensureOperatorIpAccessWarnAll — the
 *     stderr, warn-and-continue form (`shell`, `diagnose`, `status`)
 */

import { updateProjectConfig } from './config.js';
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
 * Patch the SSH (port 22) and Kubernetes API (port 6443) rules on each of
 * the named environments' firewalls to use the given CIDR list as their
 * source_ips. Other rules (HTTP/HTTPS, internal cluster traffic) are left
 * unchanged.
 *
 * environments is an array of full env identifiers — for HA, pass
 * ['<env>-primary', '<env>-standby']; for single, pass ['<env>'].
 *
 * Returns the names of firewalls that were updated. Firewalls that don't
 * exist (env not yet deployed) are skipped silently.
 *
 * Builds a single provider instance from envConfig and patches ALL environments
 * with it — assumes single-provider-per-project; mixed-provider projects must
 * be reworked to build one provider per environment.
 *
 * C9 — the Hetzner wire calls (find-by-name, rule-JSON rewrite, set_rules)
 * moved onto HetznerProvider.applyOperatorCidrs; this function now keeps
 * only the provider-neutral empty-CIDR lockout guard and the
 * `${projectName}-${env}-firewall` naming convention, delegating the actual
 * firewall patch per environment to a provider instance.
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
    const fwName = `${projectName}-${env}-firewall`;
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
 * @returns {Promise<string[]>} the firewalls updated
 */
export async function pushOperatorCidrs({
  projectConfig,
  environment,
  sides,
  operatorCidrs,
  apiToken,
  cwd,
}) {
  const updated = await applyToFirewall({
    projectName: projectConfig.projectName,
    environments: sides,
    operatorCidrs,
    apiToken,
    envConfig: projectConfig.environments?.[environment],
  });
  if (updated.length === sides.length) {
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
 * command push: a command lets its operator in and nothing more. Pushing
 * every difference would turn a routine command into a sync of the local
 * list to every firewall, so a stale checkout would re-open a CIDR someone
 * removed, or drop a teammate's newer one. Removals stay `vibecarbon
 * access`'s job.
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
 *   apiToken — Hetzner Cloud API token (from HETZNER_API_TOKEN — env or the
 *     project's .env.local)
 *   yes — non-interactive mode flag
 *   onMessage — optional callback invoked with a single info string when a
 *     new CIDR is added (caller wires this to its logger)
 *   cwd — the project directory whose .vibecarbon.json is updated
 *
 * Returns { added, cidr, list, fromEnv, pushed }:
 *   added — true if the list was modified this call
 *   cidr — the CIDR that was added (or matched, when added=false)
 *   list — the updated list
 *   fromEnv — true if the list was bootstrapped from ALLOWED_SSH_IPS env var
 *   pushed — true if this call updated a firewall of this environment
 */
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

export async function ensureOperatorIpAccess({
  projectConfig,
  environment,
  isHA = false,
  apiToken,
  yes = false,
  onMessage,
  cwd,
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
    ({ ip, version } = await detectOperatorIp());
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
  // addCidr appends a new CIDR, or refreshes a matched one's lastUsedAt and
  // re-adds it if another terminal removed it meanwhile (this operator is
  // connecting from it right now).
  const updatedList = persist(projectConfig, (fresh) => addCidr(fresh, cidr), cwd);

  // Push when the env is already deployed (its firewall exists) and its
  // record lacks this CIDR. For first-deploy bootstrap, the deploy flow
  // itself creates the firewall with the right CIDRs from the persisted list.
  const envConfig = projectConfig?.environments?.[environment];
  let pushed = false;
  if (envConfig && apiToken && !recordAllows(envConfig, cidr)) {
    const updated = await pushOperatorCidrs({
      projectConfig,
      environment,
      sides: isHA ? [`${environment}-primary`, `${environment}-standby`] : [environment],
      operatorCidrs: updatedList,
      apiToken,
      cwd,
    });
    pushed = updated.length > 0;
  }

  return { added, cidr, list: updatedList, pushed };
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
 * @returns {Promise<void>}
 */
export async function ensureOperatorIpAccessWarnAll({
  projectConfig,
  environments,
  yes = true,
  cwd,
  tokenFor = providerTokenFor,
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
    });
  } catch (err) {
    console.error(`${c.warning('!')} Operator-IP check failed: ${err.message}`);
    console.error(mayTimeOut);
    return;
  }

  // Detection failed (and the saved list was trusted): no CIDR to check for.
  if (!result.cidr) return;
  for (const environment of environments) {
    const envConfig = projectConfig.environments?.[environment];
    if (!envConfig || recordAllows(envConfig, result.cidr)) continue;
    const apiToken = tokenFor(envConfig);
    if (!apiToken) {
      console.error(
        `${c.warning('!')} Firewall of ${environment} not updated: ${providerFor(envConfig).TOKEN_ENV} is not set.`,
      );
      console.error(mayTimeOut);
      continue;
    }
    const sides = envFirewallSides(environment, envConfig);
    try {
      const updated = await pushOperatorCidrs({
        projectConfig,
        environment,
        sides,
        operatorCidrs: result.list,
        apiToken,
        cwd,
      });
      if (updated.length === sides.length) {
        console.error(
          `${c.success('✓')} Firewall of ${environment} updated: SSH/k8s API now allow ${result.cidr}`,
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
