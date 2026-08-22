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
 *   - loadOperatorCidrs / addCidr / removeCidr / pruneCidrs / refreshLastUsed
 *   - findMatchingCidr — checks if an IP is contained by any persisted CIDR
 *   - applyToFirewall — patches the live Hetzner firewall via the Cloud API
 *   - ensureOperatorIpAccess — the all-in-one helper for command run()s
 */

import { saveProjectConfig } from './config.js';
import { fetchWithRetry } from './fetch-retry.js';
import { providerFor } from './providers/index.js';

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

export function refreshLastUsed(list, cidr, now = new Date()) {
  const nowIso = now.toISOString();
  return list.map((e) => (e.cidr === cidr ? { ...e, lastUsedAt: nowIso } : e));
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

// ============================================================================
// AUTO-ADD HELPER
// ============================================================================

/**
 * Ensure the current operator's IP is covered by the project's CIDR list,
 * persisting + applying to the live firewall if not.
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
 *   cwd — passed to saveProjectConfig
 *
 * Returns { added, cidr, list, fromEnv }:
 *   added — true if the list was modified this call
 *   cidr — the CIDR that was added (or matched, when added=false)
 *   list — the updated list
 *   fromEnv — true if the list was bootstrapped from ALLOWED_SSH_IPS env var
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
    const envCidrs = parseAllowedSshIpsEnv(process.env.ALLOWED_SSH_IPS);
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
    persist(projectConfig, newList, cwd);
    return { added: true, cidr: envCidrs.join(','), list: newList, fromEnv: true };
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

  const match = findMatchingCidr(list, ip, version);
  if (match) {
    const refreshed = refreshLastUsed(list, match.cidr);
    persist(projectConfig, refreshed, cwd);
    return { added: false, cidr: match.cidr, list: refreshed };
  }

  const newCidr = cidrFromIp(ip, version);
  if (onMessage) onMessage(`Detected your IP: ${newCidr}, adding to access list...`);
  const updatedList = addCidr(list, newCidr);
  persist(projectConfig, updatedList, cwd);

  // Apply to Hetzner firewall when the env is already deployed (firewall
  // exists). For first-deploy bootstrap, the deploy flow itself will create
  // the firewall with the right CIDRs from the persisted list.
  const envDeployed = !!projectConfig?.environments?.[environment];
  if (envDeployed && apiToken) {
    const environments = isHA
      ? [`${environment}-primary`, `${environment}-standby`]
      : [environment];
    await applyToFirewall({
      projectName: projectConfig.projectName,
      environments,
      operatorCidrs: updatedList,
      apiToken,
      envConfig: projectConfig.environments[environment],
    });
  }

  return { added: true, cidr: newCidr, list: updatedList };
}

function persist(projectConfig, newList, cwd) {
  if (!projectConfig) return;
  const updated = { ...projectConfig, operatorCidrs: newList };
  // Mutate in place so callers holding a reference see the new list.
  projectConfig.operatorCidrs = newList;
  saveProjectConfig(updated, cwd);
}

export function parseAllowedSshIpsEnv(envVar) {
  if (!envVar) return [];
  return envVar
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * ensureOperatorIpAccess with the stderr feedback style shared by the debug
 * commands (`diagnose`, `shell`). Info goes to console.error so it never
 * pollutes stdout (diagnose tees a report; shell prints an rcfile banner),
 * and a failed check warns-and-continues — the operator may be debugging
 * exactly the case where the firewall API is unreachable.
 *
 * No-op when the project config or token is missing.
 */
export async function ensureOperatorIpAccessWarn({ projectConfig, environment, apiToken }) {
  if (!projectConfig || !apiToken) return;
  const { c } = await import('./colors.js');
  try {
    const isHA = !!projectConfig.environments?.[environment]?.ha?.enabled;
    const result = await ensureOperatorIpAccess({
      projectConfig,
      environment,
      isHA,
      apiToken,
      yes: false,
      onMessage: (msg) => console.error(`${c.info('i')} ${msg}`),
    });
    if (result.added) {
      console.error(`${c.success('✓')} Firewall updated: SSH/k8s API now allow ${result.cidr}`);
    }
  } catch (err) {
    console.error(`${c.warning('!')} Operator-IP check failed: ${err.message}`);
    console.error('  Continuing, kubectl/SSH may time out if your IP is not allowlisted.');
  }
}
