/**
 * Vibecarbon Status Command
 * Shows project and deployment status (read-only, non-interactive)
 *
 * Usage:
 *   vibecarbon status                    # Show all status info
 *   vibecarbon status -env prod          # Show specific environment
 *   vibecarbon status -json              # Machine-readable output
 *
 * Local-dev checks are context-sensitive: skipped when stdout is not a
 * TTY OR when `-json` is set (CI / scripting paths don't want them),
 * and skipped when run outside a project directory (registry-only mode).
 */

import { existsSync, readFileSync } from 'node:fs';
import * as p from '@clack/prompts';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { c } from './lib/colors.js';
import { runCommand, runCommandAsync } from './lib/command.js';
import { cleanStaleProjects, loadGlobalRegistry, loadProjectConfig } from './lib/config.js';
import { resolveDockerHubCreds } from './lib/deploy/docker-hub.js';
import { operatorCheckEnvs } from './lib/deploy/preflight.js';
import {
  buildPrimaryLagQuery,
  buildStandbyReplayQuery,
  formatReplicationLagLine,
} from './lib/deploy/replication.js';
import { operatorScopesForProviderAndDns } from './lib/dns-provider.js';
import { checkOperatorConfig, readOperatorVar } from './lib/operator-env.js';
import { parseDotenv, readProjectEnvFiles } from './lib/project.js';
import { HetznerProvider } from './lib/providers/hetzner.js';
import { hasProvider, PROVIDERS, providerFor } from './lib/providers/index.js';
import { getPostgresPod, getSSHKeyPath, sshKubectl, sshRun } from './lib/ssh.js';
import {
  CORE_SERVICE_ORDER,
  classifyContainer,
  formatContainerRow,
  rowsFromDockerPs,
  SERVICE_DISPLAY_NAMES,
} from './lib/status/container-rows.js';
import { checkRemoteContainers } from './lib/status/remote-containers.js';
import { VERSION } from './lib/version.js';

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'status',
  summary: 'Show project & deployment status',
  description: [
    'Read-only summary of project + environment health.',
    '',
    'MODES',
    '  Run from outside a project:  Shows summary of all registered projects',
    '  Run from inside a project:   Shows detailed environment status',
    '',
    'ENVIRONMENT VARIABLES',
    '  Provider API token env (HETZNER_API_TOKEN, DIGITALOCEAN_API_TOKEN)  Enables live server status checks',
  ].join('\n'),
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
    { name: 'env', value: '<name>', description: 'Show only a specific environment' },
    { name: 'json', boolean: true, description: 'Machine-readable JSON output' },
  ],
  examples: [
    { command: 'vibecarbon status', description: 'Show full project status' },
    { command: 'vibecarbon status -env prod', description: 'Show only production' },
    { command: 'vibecarbon status -json', description: 'JSON output for CI / scripting' },
  ],
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function formatRelativeTime(isoDate) {
  if (!isoDate) return '';
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return 'in the future';

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (months > 0) return `${months} month${months === 1 ? '' : 's'} ago`;
  if (weeks > 0) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  if (days > 0) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  if (minutes > 0) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  return 'just now';
}

function getBranchName(envName) {
  return envName === 'prod' ? 'main' : envName;
}

// ============================================================================
// HEALTH CHECK FUNCTIONS
// ============================================================================

async function checkHttpEndpoint(url, timeout = 2000, fetchImpl = fetch) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - start;

    let data = null;
    try {
      data = await response.json();
    } catch {
      // Not JSON, that's fine
    }

    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      latencyMs,
      data,
    };
  } catch (error) {
    const latencyMs = Date.now() - start;
    const message = error instanceof Error ? error.message : 'Unknown error';
    const isTimeout = message.includes('abort');
    return {
      ok: false,
      status: null,
      latencyMs,
      error: isTimeout ? `timeout after ${timeout}ms` : message,
    };
  }
}

// Note: execSync calls below use only hardcoded commands (no user input),
// matching the pattern in deploy.js and destroy.js throughout this codebase.

// Core services whose container may carry no healthcheck. Probed through Kong only when
// Docker offers no verdict, on whichever host port THIS project's kong container bound.
const GATEWAY_PROBES = {
  rest: { path: '/rest/v1/', acceptCodes: [200, 401] },
  meta: { path: '/pg/', acceptCodes: [200, 401] },
};

/**
 * Parse `docker port <container> 8000/tcp` output ("0.0.0.0:8000\n[::]:8000")
 * into the host port. Null when the container isn't running or the output
 * isn't a binding.
 *
 * @param {string|null|undefined} output
 * @returns {number|null}
 */
function parseKongHostPort(output) {
  const first = (output || '').split('\n').find((line) => line.trim());
  if (!first) return null;
  const match = first.trim().match(/:(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Health of this project's local Docker stack, from Docker's point of view.
 *
 * Enumerates `docker ps -a` for containers prefixed `${projectName}-` so the
 * table shows the whole stack — core services, `vibecarbon add` add-ons, and
 * containers that have exited (which the old running-only listing hid, e.g.
 * a kong that lost its port bind). Health comes from the compose healthcheck
 * verdict in Docker's status string; the two core services without one
 * (rest, meta) are probed through Kong on the host port THIS project's kong
 * container bound, never a fixed :8000 that another project's gateway may
 * own.
 *
 * @param {string|undefined} projectName
 * @param {{runCommand?: typeof runCommandAsync, fetch?: typeof fetch, timeoutMs?: number}} [deps]
 * @returns {Promise<Array<{name: string, container: string, health: string, label: string, detail: string, latencyMs: number}>>}
 */
async function checkDockerContainers(projectName, deps = {}) {
  const { runCommand: _run = runCommandAsync, fetch: _fetch = fetch, timeoutMs = 2000 } = deps;
  // No project name means no `${name}-*` prefix to enumerate; the old fallback (strip the
  // first dash-segment of every container on the host) is exactly the cross-project
  // confusion this function exists to avoid.
  if (!projectName) return [];
  const prefix = `${projectName}-`;

  let listing = '';
  try {
    listing =
      (await _run(
        [
          'docker',
          'ps',
          '-a',
          '--filter',
          `name=^${prefix}`,
          '--format',
          '{{.Names}}\t{{.State}}\t{{.Status}}',
        ],
        {
          silent: true,
          timeout: 5000,
          ignoreError: true,
        },
      )) || '';
  } catch {
    return [];
  }

  const containers = rowsFromDockerPs(listing, projectName);

  if (containers.length === 0) return [];

  const kongRunning = containers.some((ct) => ct.container === 'kong' && ct.state === 'running');
  let kongPort = null;
  if (kongRunning) {
    try {
      kongPort = parseKongHostPort(
        await _run(['docker', 'port', `${prefix}kong`, '8000/tcp'], {
          silent: true,
          timeout: 5000,
          ignoreError: true,
        }),
      );
    } catch {
      kongPort = null;
    }
  }
  const gatewayDetail = kongRunning ? 'gateway port not published' : 'gateway down';

  const rows = await Promise.all(
    containers.map(async ({ container, state, status }) => {
      const name = SERVICE_DISPLAY_NAMES[container] || container;
      const base = classifyContainer(container, state, status);
      const probe = GATEWAY_PROBES[container];
      // Kong probe is a fallback for containers Docker has no verdict on
      // (label 'running' = up, no healthcheck). A real healthcheck verdict
      // — from compose or baked into the image — always wins.
      if (!probe || state !== 'running' || base.label !== 'running') {
        return { name, container, ...base, latencyMs: 0 };
      }
      if (kongPort === null) {
        return {
          name,
          container,
          health: 'unknown',
          label: 'unknown',
          detail: gatewayDetail,
          latencyMs: 0,
        };
      }
      const start = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await _fetch(`http://localhost:${kongPort}${probe.path}`, {
          method: 'GET',
          signal: controller.signal,
        });
        const latencyMs = Date.now() - start;
        if (probe.acceptCodes.includes(response.status)) {
          return { name, container, health: 'healthy', label: 'healthy', detail: '', latencyMs };
        }
        return {
          name,
          container,
          health: 'unhealthy',
          label: 'unhealthy',
          detail: `HTTP ${response.status}`,
          latencyMs,
        };
      } catch (err) {
        const detail = controller.signal.aborted
          ? `timeout after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
        return {
          name,
          container,
          health: 'unhealthy',
          label: 'unhealthy',
          detail,
          latencyMs: Date.now() - start,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    }),
  );

  const rank = (ct) => {
    const i = CORE_SERVICE_ORDER.indexOf(ct);
    return i === -1 ? CORE_SERVICE_ORDER.length : i;
  };
  return rows.sort(
    (a, b) => rank(a.container) - rank(b.container) || a.container.localeCompare(b.container),
  );
}

/**
 * Dev-server ports from the FIRST of `.env.local`/`.env` that exists (not a
 * per-key merge — unchanged from the regex reader this replaced, which also
 * stopped at the first existing file). Parsing is `parseDotenv`, the
 * codebase's one dotenv reader; an empty `KEY=` folds to the default via
 * `||` exactly as the old regex's non-match did.
 */
function getPortConfig() {
  const defaults = { vite: 5173, api: 3000 };
  try {
    const envFiles = ['.env.local', '.env'];
    for (const file of envFiles) {
      if (existsSync(file)) {
        const env = parseDotenv(readFileSync(file, 'utf-8'));

        const portOffset = Number.parseInt(env.DEV_PORT_OFFSET || '0', 10);
        const vitePort = env.DEV_VITE_PORT || String(5173 + portOffset);
        const apiPort = env.DEV_API_PORT || String(3000 + portOffset);

        return { vite: Number.parseInt(vitePort, 10), api: Number.parseInt(apiPort, 10) };
      }
    }
  } catch {
    // Fall through to defaults
  }
  return defaults;
}

async function checkLocalDev(projectName) {
  const ports = getPortConfig();

  const [apiCheck, viteCheck, dockerServices] = await Promise.allSettled([
    checkHttpEndpoint(`http://localhost:${ports.api}/api/health`, 2000),
    checkHttpEndpoint(`http://localhost:${ports.vite}`, 2000),
    checkDockerContainers(projectName),
  ]);

  const api =
    apiCheck.status === 'fulfilled' ? apiCheck.value : { ok: false, error: 'check failed' };
  const vite =
    viteCheck.status === 'fulfilled' ? viteCheck.value : { ok: false, error: 'check failed' };
  const docker = dockerServices.status === 'fulfilled' ? dockerServices.value : [];

  return {
    api: { running: api.ok, latencyMs: api.latencyMs, port: ports.api, data: api.data },
    vite: { running: vite.ok, port: ports.vite },
    docker,
  };
}

export async function checkRemoteHealth(domain, deps = {}) {
  const url = `https://${domain}/api/health/ready`;
  const result = await checkHttpEndpoint(url, 5000, deps.fetch || fetch);
  return {
    url,
    ok: result.ok,
    status: result.status,
    latencyMs: result.latencyMs,
    data: result.data,
    error: result.error,
  };
}

/**
 * Parse `psql -tAc <buildPrimaryLagQuery()>` output ("state|lag_seconds",
 * e.g. "streaming|0.4") into { state, lagSeconds }. Returns null when the
 * primary has no rows (no standby connected) or the output is empty — a
 * null primaryRow feeds formatReplicationLagLine's "primary view
 * unavailable" branch, which matters precisely when a disconnected standby
 * is invisible to pg_stat_replication.
 *
 * @param {string} out
 * @returns {{state: string, lagSeconds: number} | null}
 */
function parsePrimaryLagRow(out) {
  const line = (typeof out === 'string' ? out : '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)[0];
  if (!line) return null;
  const [state, lagStr] = line.split('|');
  const lagSeconds = Number.parseFloat(lagStr);
  return { state: state || 'unknown', lagSeconds: Number.isNaN(lagSeconds) ? 0 : lagSeconds };
}

/**
 * Parse `psql -tAc <buildStandbyReplayQuery()>` output
 * ("t|0/3000060|12.3", `-tA` uses '|' as the field separator;
 * pg_is_in_recovery() renders 't'/'f') into { inRecovery, lastWalReplayLsn,
 * secondsSinceReplay }. Returns null on empty output (unreadable/no rows).
 *
 * @param {string} out
 * @returns {{inRecovery: boolean, lastWalReplayLsn: string, secondsSinceReplay: number} | null}
 */
function parseStandbyReplayRow(out) {
  const line = (typeof out === 'string' ? out : '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)[0];
  if (!line) return null;
  const [inRecoveryStr, lsn, secStr] = line.split('|');
  const secondsSinceReplay = Number.parseFloat(secStr);
  return {
    inRecovery: inRecoveryStr === 't',
    lastWalReplayLsn: lsn || '',
    secondsSinceReplay: Number.isNaN(secondsSinceReplay) ? 0 : secondsSinceReplay,
  };
}

/**
 * Read the REAL streaming-replication state for an HA environment by querying
 * `pg_stat_replication` on the CURRENT primary. Surfaces honest DR state instead
 * of a hardcoded "streaming" string (finding #4). Best-effort and hard-bounded:
 * any failure (unreachable, db down, non-HA) resolves to a value the renderer
 * can degrade on, and the whole probe is raced against a short timeout so
 * `status` never hangs.
 *
 * Task 12 (pilot-light standby spec): ALONGSIDE that pre-existing byte-lag
 * query, also runs a time-based lag query (buildPrimaryLagQuery) on the same
 * primary connection, and — k8s-HA only, compose-ha stays out of scope — a
 * standby-side self-view query (buildStandbyReplayQuery) against
 * `envConfig.ha.standby.masterIp`, both inside the SAME Promise.race timeout
 * envelope as the existing probe. Both rows are threaded to the renderer via
 * the returned `lagLine` (pre-formatted) plus the raw `primaryRow`/
 * `standbyRow` (for JSON consumers). A failure in either new query degrades
 * to a null row — it never fails the whole probe, so the pre-existing
 * streaming/DR-not-guaranteed path above is unaffected.
 *
 * @returns {Promise<{ streaming: boolean, state: string, lagBytes: number|null, lagLine: string, primaryRow: {state:string,lagSeconds:number}|null, standbyRow: {inRecovery:boolean,lastWalReplayLsn:string,secondsSinceReplay:number}|null } | null>}
 */
export async function checkReplication(envName, envConfig, projectName, deps = {}) {
  const {
    sshRun: _sshRun = sshRun,
    sshKubectl: _sshKubectl = sshKubectl,
    getPostgresPod: _getPod = getPostgresPod,
    getSSHKeyPath: _getKey = getSSHKeyPath,
    timeoutMs = 10_000,
  } = deps;

  const isHA = !!(envConfig.ha?.enabled || envConfig.ha === true || envConfig.secondaryRegion);
  if (!isHA) return null;

  const servers = envConfig.servers || [];
  const primary = servers.find((sv) => sv.role === 'primary') || servers[0];
  if (!primary?.ip) return null;

  const sshKeyPath = _getKey(envName);
  if (!existsSync(sshKeyPath)) return null;

  const isCompose = envConfig.deployMode === 'compose' || envConfig.deployMode === 'compose-ha';
  // No string literals in the SQL → no shell/psql quoting hazards. `-tA` uses
  // '|' as the field separator, so a connected standby yields `streaming|<lag>`.
  const sql =
    'SELECT state, pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) FROM pg_stat_replication';

  const probe = (async () => {
    // Run one psql -tAc query against the PRIMARY over whichever transport
    // this env uses — shared by the pre-existing byte-lag query and the new
    // time-based buildPrimaryLagQuery() so a k8s primary pod lookup only
    // happens once. Resolved INSIDE the probe (not above it) so the pod
    // lookup itself stays inside the Promise.race timeout envelope below.
    const primaryPod = !isCompose ? await _getPod(primary.ip, sshKeyPath) : null;
    const runPrimaryPsql = (targetSql) =>
      isCompose
        ? _sshRun(
            primary.ip,
            sshKeyPath,
            [
              'bash',
              '-lc',
              `cd /opt/${projectName} && docker compose exec -T db psql -U supabase_admin -d postgres -tAc "${targetSql}"`,
            ],
            { timeout: timeoutMs },
          )
        : _sshKubectl(
            primary.ip,
            sshKeyPath,
            [
              'exec',
              '-n',
              'vibecarbon',
              primaryPod,
              '--',
              'psql',
              '-U',
              'supabase_admin',
              '-d',
              'postgres',
              '-tAc',
              targetSql,
            ],
            { timeout: timeoutMs },
          );

    const out = await runPrimaryPsql(sql);
    const line = (typeof out === 'string' ? out : '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)[0];
    let replication;
    if (!line) {
      replication = { streaming: false, state: 'no standby connected', lagBytes: null };
    } else {
      const [state, lagStr] = line.split('|');
      const lag = lagStr ? Number.parseInt(lagStr, 10) : Number.NaN;
      replication = {
        streaming: state === 'streaming',
        state: state || 'unknown',
        lagBytes: Number.isNaN(lag) ? null : lag,
      };
    }

    // Task 12 (pilot-light standby spec) — time-based lag line, run
    // ALONGSIDE the byte-based query above (same primary pod/connection).
    // Best-effort: a failure here degrades to a null row rather than
    // failing the whole probe, so the byte-based path above is unaffected.
    let primaryRow = null;
    try {
      primaryRow = parsePrimaryLagRow(await runPrimaryPsql(buildPrimaryLagQuery()));
    } catch {
      primaryRow = null;
    }

    // Standby's own self-view — k8s-HA only (compose-ha stays out of
    // scope). Matters precisely when primaryRow above is null: a
    // disconnected standby is invisible to pg_stat_replication, but can
    // still report its own recovery state + last-replay age.
    let standbyRow = null;
    const standbyIp = envConfig.ha?.standby?.masterIp;
    if (!isCompose && standbyIp) {
      try {
        const standbyPod = await _getPod(standbyIp, sshKeyPath);
        const standbyOut = await _sshKubectl(
          standbyIp,
          sshKeyPath,
          [
            'exec',
            '-n',
            'vibecarbon',
            standbyPod,
            '--',
            'psql',
            '-U',
            'supabase_admin',
            '-d',
            'postgres',
            '-tAc',
            buildStandbyReplayQuery(),
          ],
          { timeout: timeoutMs },
        );
        standbyRow = parseStandbyReplayRow(standbyOut);
      } catch {
        standbyRow = null;
      }
    }

    return {
      ...replication,
      primaryRow,
      standbyRow,
      lagLine: formatReplicationLagLine({ primaryRow, standbyRow }),
    };
  })();

  const unavailable = () => ({
    streaming: false,
    state: 'unknown',
    lagBytes: null,
    primaryRow: null,
    standbyRow: null,
    lagLine: formatReplicationLagLine({}),
  });

  try {
    return await Promise.race([
      probe,
      new Promise((resolve) => {
        // .unref() so a fast probe win doesn't leave this timer holding the
        // event loop open and delaying `status` exit by the timeout window.
        const t = setTimeout(() => resolve(unavailable()), timeoutMs + 2_000);
        if (typeof t?.unref === 'function') t.unref();
      }),
    ]);
  } catch {
    return unavailable();
  }
}

function checkGitSync(envName, envConfig) {
  const deployedCommit = envConfig.deployedCommit;
  if (!deployedCommit) {
    return { branch: getBranchName(envName), current: null, deployed: null, commitsAhead: null };
  }

  const branch = getBranchName(envName);

  try {
    const current = runCommand(['git', 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cleanEnv: true,
    }).trim();

    let commitsAhead = null;
    try {
      const count = runCommand(['git', 'rev-list', '--count', `${deployedCommit}..HEAD`], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cleanEnv: true,
      }).trim();
      commitsAhead = Number.parseInt(count, 10);
    } catch {
      // Deployed commit might not be in local history
    }

    let deployedMessage = null;
    try {
      deployedMessage = runCommand(['git', 'log', '--format=%s', '-1', deployedCommit], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cleanEnv: true,
      }).trim();
    } catch {
      // Commit might not be locally available
    }

    let currentMessage = null;
    try {
      currentMessage = runCommand(['git', 'log', '--format=%s', '-1', 'HEAD'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cleanEnv: true,
      }).trim();
    } catch {
      // Ignore
    }

    return {
      branch,
      current: { sha: current, message: currentMessage },
      deployed: { sha: deployedCommit, message: deployedMessage },
      commitsAhead,
    };
  } catch {
    return {
      branch,
      current: null,
      deployed: { sha: deployedCommit, message: null },
      commitsAhead: null,
    };
  }
}

// ============================================================================
// RENDERING FUNCTIONS
// ============================================================================

/**
 * Derive the operator-config scopes/keys `status`'s Configuration advisory
 * checks — the same shape checks Gate 1 (`src/deploy.js`) enforces before a
 * deploy, run here as a passive read instead of a refusal, so an operator
 * sees a malformed credential before running `deploy` at all.
 *
 * Two presence tiers, not one: `access`/`tls`/`state`/`registry` and the
 * PROJECT's configured provider (mirroring Gate 1's `?? 'hetzner'` default:
 * the first environment's provider, else the project config's own
 * `provider` field, else `hetzner` when any environment carries a
 * `deployMode`) are shape-checked only (`presence: false`) — a fresh
 * project with nothing configured yet must show `ok`, not a wall of
 * "not set". A DEPLOYED environment's own provider + DNS scope/key are
 * checked WITH presence (`presence: true`): a deployed environment whose
 * token has since gone missing is a real problem, not "not configured
 * yet". A scope already covered by a deployed environment is checked only
 * once, under the stricter (presence: true) rule.
 *
 * A THIRD pass covers the configure family (spec §5): billing/oauth/smtp/
 * analytics/landing values are written by `configure` to the project's
 * `.env`/`.env.local` FILES and read by the app from there — they are never
 * in this process's env, so the two passes above cannot see them. This pass
 * reads the files through the codebase's one dotenv parser (`parseDotenv`,
 * via project.js's `loadEnvVariables` for `.env.local`), merging `.env.local`
 * over `.env` — the precedence the app itself sees — and checks shape only
 * (`presence: false`: a feature that simply isn't configured is not a
 * problem). This is the ONLY place a stale stored value surfaces: the
 * configure prompt's Enter-on-existing deliberately keeps the current value
 * unvalidated (correct for a prompt — the operator asked to keep it), so a
 * publishable key stored as STRIPE_SECRET_KEY before shape validation
 * existed, or a hand edit, is caught here rather than at the next prompt.
 * Reading the files never echoes a value: only `checkOperatorConfig`'s
 * messages leave this function.
 *
 * `problems` is deduped by the variable name each message names — every
 * `checkOperatorConfig` message starts with `<KEY> ` (`<KEY> is not set` /
 * `<KEY> looks wrong: ...`), and env-var keys never contain a space, so the
 * first token is exactly that key. The same key CAN reach both process-env
 * passes: a project's default provider token (base, presence: false) is
 * also the lone sibling key a cross-cloud DNS pick reads (deployed,
 * presence: true) — see `operatorConfigForDns`'s cross-cloud case. Without
 * deduping, a single malformed value would be reported (and counted) twice.
 * The deployed pass's message wins on a collision (it is the stricter
 * check, and is the only one that can report an ABSENT value as a problem
 * at all — the base pass tolerates that silently under `presence: false`).
 * The configure-family pass shares no key with the other two (disjoint
 * scopes) but folds into the same map for the one ordering/count.
 *
 * @param {{provider?: string}|null|undefined} projectConfig
 * @param {Record<string, {provider?: string, dnsProvider?: string, deployMode?: string}>} environments
 * @param {{ env?: Record<string, string|undefined>, cwd?: string }} [opts] -
 *   injectable for testing; `env` defaults to `process.env`, `cwd` (the
 *   project directory whose `.env`/`.env.local` the configure-family pass
 *   reads) to `process.cwd()`.
 * @returns {{ problems: string[], checked: string[] }}
 */
function computeConfigurationCheck(projectConfig, environments, { env, cwd } = {}) {
  const envEntries = Object.entries(environments || {});

  const projectProviderId =
    envEntries[0]?.[1]?.provider ??
    projectConfig?.provider ??
    (envEntries.some(([, cfg]) => cfg.deployMode) ? 'hetzner' : null);

  const deployedScopes = new Set();
  const deployedKeys = [];
  for (const [, envConfig] of envEntries) {
    const providerId = envConfig.provider ?? (envConfig.deployMode ? 'hetzner' : null);
    const { scopes, keys } = operatorScopesForProviderAndDns(
      providerId,
      envConfig.dnsProvider ?? null,
    );
    for (const scope of scopes) deployedScopes.add(scope);
    deployedKeys.push(...keys);
  }

  const baseScopes = ['access', 'tls', 'state'];
  if (resolveDockerHubCreds({ env })) baseScopes.push('registry');
  if (projectProviderId && !deployedScopes.has(`provider:${projectProviderId}`)) {
    baseScopes.push(`provider:${projectProviderId}`);
  }

  // File-aware (review residual, PR #112): access/tls/state keys are
  // `where: '.env'`/`.env.local` and the shipping copy is the file's, so the
  // base pass checks the merged files alongside the shell — the same
  // `operatorCheckEnvs` pair Gate 1 and the orchestrator gate use; file's
  // problem first, `operator shell` keys (registry) shell-only.
  const shapeOnly = checkOperatorConfig(baseScopes, {
    presence: false,
    env: operatorCheckEnvs(cwd ?? process.cwd(), env),
  });
  const deployed =
    deployedScopes.size > 0 || deployedKeys.length > 0
      ? checkOperatorConfig([...deployedScopes], { presence: true, keys: deployedKeys, env })
      : { problems: [], checked: [] };

  const configureFamily = checkOperatorConfig(CONFIGURE_FAMILY_SCOPES, {
    presence: false,
    env: readProjectEnvFiles(cwd ?? process.cwd()),
  });

  const problemByKey = new Map();
  for (const problem of shapeOnly.problems) problemByKey.set(problem.split(' ')[0], problem);
  for (const problem of deployed.problems) problemByKey.set(problem.split(' ')[0], problem);
  for (const problem of configureFamily.problems) {
    problemByKey.set(problem.split(' ')[0], problem);
  }

  return {
    problems: [...problemByKey.values()],
    checked: [...new Set([...shapeOnly.checked, ...deployed.checked, ...configureFamily.checked])],
  };
}

/**
 * The registry scopes `configure` writes to the project's env files — the
 * ones `computeConfigurationCheck`'s configure-family pass reads (files
 * only, via `readProjectEnvFiles` from project.js). Operator scopes
 * (provider:<id>, dns:<id>, registry, state, access, tls) are deliberately
 * absent: those belong to the base/deployed passes above, which check the
 * shell and — for the `.env`/`.env.local`-stored keys — the same files.
 */
const CONFIGURE_FAMILY_SCOPES = ['billing', 'oauth', 'smtp', 'analytics', 'landing'];

/**
 * Render `computeConfigurationCheck`'s result as display lines — pure, so
 * it is unit-testable without touching the filesystem or `process.env`.
 * Never echoes a value: `problems` are the messages `checkOperatorConfig`
 * already produced, which name a variable and its expected shape but never
 * its content.
 *
 * Styling matches its neighbour, the `Access:` advisory above it: the body
 * stays plain and only the one meaningful piece is coloured — there, an
 * inline command name; here, the count (since there is no command to
 * suggest). The glyphs (`●`/`▲`), the "Configuration"/"ok" words, and every
 * `  - <problem>` detail line stay uncoloured.
 *
 * @param {string[]} problems
 * @param {string[]} checked
 * @returns {string[]}
 */
function formatConfigurationLines(problems, checked) {
  if (problems.length === 0) {
    const n = checked.length;
    return [`Configuration ● ok  ${c.success(`(${n} variable${n === 1 ? '' : 's'} checked)`)}`];
  }
  const n = problems.length;
  return [
    `▲ Configuration: ${c.warning(`${n} problem${n === 1 ? '' : 's'}`)}`,
    ...problems.map((problem) => `  - ${problem}`),
  ];
}

/**
 * Lines for the "Docker Services" section of the Local Development note.
 *
 * `done` rows (one-shot init containers that exited 0) are listed but
 * excluded from the healthy total; `starting` and `unknown` rows count
 * against it without being painted red, since neither is a failure yet.
 *
 * @param {Array<{name: string, health: string, label: string, detail: string, latencyMs: number}>} docker
 * @returns {string[]}
 */
function formatDockerServiceLines(docker) {
  if (docker.length === 0) {
    return [`${c.dim('Docker Services'.padEnd(30))}${c.dim('not running')}`];
  }
  const counted = docker.filter((s) => s.health !== 'done');
  const healthyCount = counted.filter((s) => s.health === 'healthy').length;
  const total = counted.length;
  const summary =
    total === 0
      ? c.dim('no long-running services')
      : healthyCount === total
        ? c.success(`● ${healthyCount}/${total} healthy`)
        : c.warning(`● ${healthyCount}/${total} healthy`);
  const lines = [`${c.dim('Docker Services'.padEnd(30))}${summary}`];

  for (const svc of docker) lines.push(formatContainerRow(svc));
  return lines;
}

function renderLocalDev(data) {
  const lines = [];

  // API server
  const apiStatus = data.api.running
    ? `${c.success('\u25cf')} ${c.success('Running')}  ${c.dim(`${data.api.latencyMs}ms`)}`
    : `${c.dim('\u25cb')} ${c.dim('Stopped')}`;
  const apiLabel = `API Server (port ${data.api.port})`;
  lines.push(`${c.dim(apiLabel.padEnd(30))}${apiStatus}`);

  // Vite dev server
  const viteStatus = data.vite.running
    ? `${c.success('\u25cf')} ${c.success('Running')}`
    : `${c.dim('\u25cb')} ${c.dim('Stopped')}`;
  const viteLabel = `Vite Dev Server (port ${data.vite.port})`;
  lines.push(`${c.dim(viteLabel.padEnd(30))}${viteStatus}`);

  // Docker services
  lines.push(...formatDockerServiceLines(data.docker));

  p.note(lines.join('\n'), 'Local Development');
}

/**
 * Human-readable provider name for status display.
 *
 * Pinned exactly to the ternary this replaces
 * (`envConfig.provider === 'hetzner' ? 'Hetzner Cloud' : envConfig.provider || 'unknown'`):
 * a falsy `provider` field renders 'unknown'; a registered provider id
 * renders its Provider.NAME; any other non-empty provider string renders
 * as-is. The registry lookup is deliberately case-SENSITIVE
 * (Object.hasOwn against PROVIDERS, NOT hasProvider(), which lowercases) —
 * the old strict `=== 'hetzner'` comparison rendered a case-variant like
 * 'Hetzner' as-is, and that must survive byte-identically.
 *
 * Also deliberately NOT providerFor() alone — its `?? 'hetzner'` default
 * would turn an undefined provider into 'Hetzner Cloud', which is wrong
 * here.
 *
 * @param {{provider?: string}|null|undefined} [envConfig]
 * @returns {string}
 */
function providerDisplayName(envConfig) {
  const provider = envConfig?.provider;
  if (!provider) return 'unknown';
  return Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider].NAME : provider;
}

/**
 * Resolve the Provider class an environment's live checks (region-name
 * lookup, server-status probe + its token gate) should use. The pre-C8
 * code never inspected envConfig.provider at either site — it used
 * HetznerProvider/HETZNER_API_TOKEN unconditionally — so this guard must
 * reproduce that for EVERY input: fall back to HetznerProvider for a
 * missing OR unregistered provider rather than letting a bare
 * providerFor() throw (which would crash the synchronous render loop at
 * the region site, and silently drop an environment's entire checks entry
 * from inside the Promise.allSettled callback at the probe site).
 * hasProvider()'s case-insensitivity is fine here (unlike in
 * providerDisplayName): a case-variant of a registered id still resolves
 * to the same class the old code used unconditionally.
 *
 * @param {{provider?: string}|null|undefined} [envConfig]
 * @returns {typeof BaseProvider}
 */
function resolveEnvProvider(envConfig) {
  return envConfig?.provider && hasProvider(envConfig.provider)
    ? providerFor(envConfig)
    : HetznerProvider;
}

/**
 * Is one server's container view fully healthy? Counts rows other than
 * `done`, and for k8s also every platform namespace and every node.
 */
function serverContainersHealthy(sc) {
  if (!sc || sc.error) return false;
  const counted = sc.rows.filter((r) => r.health !== 'done');
  if (counted.some((r) => r.health !== 'healthy')) return false;
  for (const ns of Object.values(sc.platform || {})) if (ns.healthy !== ns.total) return false;
  if (sc.nodes && sc.nodes.ready !== sc.nodes.total) return false;
  return true;
}

/**
 * The Servers block body: one line per server, then — when container data
 * exists for it — one rollup line and only the rows that are not healthy.
 * A healthy server costs exactly one extra line; a broken one shows what is
 * broken.
 *
 * @param {Array<{id?: string, name?: string, ip?: string, serverType?: string, type?: string}>} servers
 * @param {{serverInfo?: object, containers?: object}} checks
 * @returns {string[]}
 */
function formatServerLines(servers, checks) {
  const lines = [];
  for (const server of servers) {
    const serverInfo = checks.serverInfo?.[server.id];
    const configType = server.serverType || server.type || null;
    let statusStr;
    if (serverInfo) {
      const icon = serverInfo.status === 'running' ? c.success('●') : c.error('●');
      const typeLabel = serverInfo.serverType || configType || '';
      statusStr = `${icon} ${serverInfo.status === 'running' ? c.success('running') : c.error(serverInfo.status)}  ${c.dim(typeLabel)}`;
    } else if (configType) {
      statusStr = c.dim(configType);
    } else {
      statusStr = c.dim('–');
    }
    lines.push(
      `  ${c.info((server.name || '').padEnd(16))} ${(server.ip || '').padEnd(15)} ${statusStr}`,
    );

    const sc = checks.containers?.[server.name || server.ip];
    if (!sc) continue;
    const noun = sc.kind === 'k8s' ? 'pods' : 'containers';
    if (sc.error) {
      lines.push(`    ${c.dim(noun)} ${c.error('● unreachable')}  ${c.dim(sc.error)}`);
      continue;
    }
    const counted = sc.rows.filter((r) => r.health !== 'done');
    const healthy = counted.filter((r) => r.health === 'healthy').length;
    const parts = [`● ${healthy}/${counted.length} healthy`];
    if (sc.nodes) parts.push(`nodes ${sc.nodes.ready}/${sc.nodes.total} ready`);
    for (const [ns, n] of Object.entries(sc.platform || {}))
      parts.push(`${ns} ${n.healthy}/${n.total}`);
    const paint = serverContainersHealthy(sc) ? c.success : c.warning;
    lines.push(`    ${c.dim(noun)} ${paint(parts.join(' · '))}`);

    for (const r of sc.rows) {
      if (r.health === 'healthy' || r.health === 'done') continue;
      lines.push(formatContainerRow(r, '      '));
    }
    for (const [ns, n] of Object.entries(sc.platform || {})) {
      if (n.healthy === n.total) continue;
      lines.push(
        formatContainerRow(
          {
            name: ns,
            container: ns,
            health: 'unknown',
            label: `${n.healthy}/${n.total} healthy`,
            detail: '',
            latencyMs: 0,
          },
          '      ',
        ),
      );
    }
  }
  return lines;
}

/**
 * Lines for the "Health" block: header, probe URL, and a verdict line built
 * from the real `/api/health/ready` shape (db/supabase nest under
 * `services`, with a top-level `services`/`database`/`supabase` fallback for
 * older payload shapes).
 *
 * @param {{url: string, ok: boolean, status?: number|null, latencyMs: number, data?: object|null, error?: string}} remoteHealth
 * @returns {string[]}
 */
function formatHealthLines(remoteHealth) {
  const lines = [];
  lines.push(c.bold('Health'));
  lines.push(`  ${c.dim(remoteHealth.url)}`);
  if (remoteHealth.ok) {
    const data = remoteHealth.data;
    let details = '';
    if (data && typeof data === 'object') {
      const parts = [];
      const db = data.services?.database ?? data.database;
      const supabase = data.services?.supabase ?? data.supabase;
      if (db) parts.push(`db: ${db}`);
      if (supabase) parts.push(`supabase: ${supabase}`);
      if (data.status) parts.push(data.status);
      if (parts.length > 0) details = c.dim(`  (${parts.join(', ')})`);
    }
    lines.push(
      `  ${c.success('●')} ${c.success('healthy')}  ${c.dim(`${remoteHealth.latencyMs}ms`)}${details}`,
    );
  } else {
    const errMsg = remoteHealth.error || `HTTP ${remoteHealth.status}`;
    lines.push(`  ${c.error('●')} ${c.error('unhealthy')}  ${c.dim(`(${errMsg})`)}`);
  }
  return lines;
}

/**
 * Summary-block verdict for one environment: the public probe failed, or
 * any server's containers are not fully healthy.
 * @param {{checks?: {remoteHealth?: {ok?: boolean}, containers?: object}}} entry
 */
function isEnvironmentUnhealthy(entry) {
  const checks = entry?.checks || {};
  if (checks.remoteHealth && !checks.remoteHealth.ok) return true;
  for (const sc of Object.values(checks.containers || {}))
    if (!serverContainersHealthy(sc)) return true;
  return false;
}

function renderEnvironment(envName, envConfig, checks) {
  const lines = [];

  // Provider
  lines.push(`${c.dim('Provider')}       ${providerDisplayName(envConfig)}`);

  // Region — today's code resolves the region description via
  // HetznerProvider unconditionally: it is NOT gated on envConfig.provider
  // at all (verified against the pre-refactor code). resolveEnvProvider
  // reproduces that for every input, including an unregistered provider
  // string (where an unguarded providerFor() would throw instead of
  // falling back).
  if (envConfig.region) {
    const RegionProvider = resolveEnvProvider(envConfig);
    const regionDesc = RegionProvider.REGIONS[envConfig.region] || '';
    const regionDisplay = regionDesc
      ? `${envConfig.region} ${c.dim(`(${regionDesc})`)}`
      : envConfig.region;
    lines.push(`${c.dim('Region')}         ${regionDisplay}`);
  }

  // Domain
  if (envConfig.domain) {
    lines.push(`${c.dim('Domain')}         ${c.info(envConfig.domain)}`);
  }

  // Floating IP
  if (envConfig.floatingIp) {
    lines.push(`${c.dim('Floating IP')}    ${envConfig.floatingIp}`);
  }

  // S3 Bucket
  if (envConfig.s3?.bucket) {
    const s3Region = envConfig.s3.region ? ` ${c.dim(`(${envConfig.s3.region})`)}` : '';
    lines.push(`${c.dim('S3 Bucket')}      ${envConfig.s3.bucket}${s3Region}`);
  }

  // Deployed date
  if (envConfig.deployedAt) {
    const relative = formatRelativeTime(envConfig.deployedAt);
    const dateStr = new Date(envConfig.deployedAt)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z/, ' UTC');
    lines.push(`${c.dim('Deployed')}       ${dateStr} ${c.dim(`(${relative})`)}`);
  }

  // HA
  if (envConfig.ha) {
    const failoverRegion = envConfig.secondaryRegion || envConfig.failoverRegion;
    const haDisplay = failoverRegion
      ? `${c.success('Enabled')} ${c.dim(`(failover: ${failoverRegion})`)}`
      : c.success('Enabled');
    lines.push(`${c.dim('HA')}             ${haDisplay}`);

    // Real replication state (finding #4) — never a hardcoded "streaming".
    if (checks.replication) {
      const r = checks.replication;
      let replDisplay;
      if (r.streaming) {
        const lag =
          r.lagBytes != null ? c.dim(` (lag: ${(r.lagBytes / 1024).toFixed(0)} KiB)`) : '';
        replDisplay = `${c.success('streaming')}${lag}`;
      } else {
        replDisplay = `${c.error(r.state || 'not streaming')}${c.dim(': DR not guaranteed')}`;
      }
      lines.push(`${c.dim('Replication')}    ${replDisplay}`);

      // Task 12 (pilot-light spec) — time-based lag line, additive to the
      // byte-based streaming/DR line above. Colorized red when the standby
      // itself reports it left recovery: DR is not guaranteed regardless of
      // what the primary's pg_stat_replication still shows.
      if (r.lagLine) {
        const lagDisplay = r.lagLine.includes('DR NOT GUARANTEED')
          ? c.error(r.lagLine)
          : c.dim(r.lagLine);
        lines.push(`${c.dim('Repl. Lag')}      ${lagDisplay}`);
      }
    }
  }

  // Servers
  const servers = envConfig.servers || [];
  if (servers.length > 0) {
    lines.push('');
    lines.push(c.bold('Servers'));
    lines.push(...formatServerLines(servers, checks));
  }

  // Remote health
  if (envConfig.domain && checks.remoteHealth) {
    lines.push('');
    lines.push(...formatHealthLines(checks.remoteHealth));
  }

  // Services
  const enabledServices = [];
  if (envConfig.observability) enabledServices.push('observability');
  if (envConfig.n8n) enabledServices.push('n8n');
  if (envConfig.metabase) enabledServices.push('metabase');
  if (envConfig.ha) enabledServices.push('ha');
  if (envConfig.cicd) enabledServices.push('cicd');
  if (envConfig.services) {
    for (const [key, val] of Object.entries(envConfig.services)) {
      if (val && !enabledServices.includes(key)) enabledServices.push(key);
    }
  }
  if (enabledServices.length > 0) {
    lines.push(
      `${c.dim('Services')}       ${enabledServices.map((s) => c.info(s)).join(c.dim(', '))}`,
    );
  }

  // Git sync
  if (checks.gitSync) {
    lines.push('');
    lines.push(c.bold('Git Sync'));
    const gs = checks.gitSync;
    if (gs.deployed?.sha) {
      const shortSha = gs.deployed.sha.substring(0, 7);
      const msg = gs.deployed.message ? ` ${c.dim(`"${gs.deployed.message}"`)}` : '';
      lines.push(`  ${c.dim('Deployed')}   ${c.boldCyan(shortSha)}${msg}`);
    } else {
      lines.push(`  ${c.dim('No deployed commit recorded (redeploy to enable tracking)')}`);
    }
    if (gs.current?.sha && gs.deployed?.sha) {
      const shortSha = gs.current.sha.substring(0, 7);
      const msg = gs.current.message ? ` ${c.dim(`"${gs.current.message}"`)}` : '';
      const ahead =
        gs.commitsAhead !== null && gs.commitsAhead > 0
          ? c.warning(` (+${gs.commitsAhead} commit${gs.commitsAhead === 1 ? '' : 's'} ahead)`)
          : gs.commitsAhead === 0
            ? c.success(' (up to date)')
            : '';
      lines.push(`  ${c.dim('Current')}    ${c.boldCyan(shortSha)}${msg}${ahead}`);
    }
  }

  p.note(lines.join('\n'), `Environment: ${envName}`);
}

function renderSummary(allData) {
  const lines = [];

  // Environments
  const envCount = Object.keys(allData.environments || {}).length;
  const unhealthyCount = Object.values(allData.environments || {}).filter(
    isEnvironmentUnhealthy,
  ).length;

  if (envCount > 0) {
    const envStr = `${envCount} deployed`;
    const unhealthyStr =
      unhealthyCount > 0
        ? `, ${c.error(`${unhealthyCount} unhealthy`)}`
        : `, ${c.success('0 unhealthy')}`;
    lines.push(`${c.dim('Environments')}   ${envStr}${unhealthyStr}`);
  } else {
    lines.push(`${c.dim('Environments')}   ${c.dim('none deployed')}`);
  }

  // Local dev
  if (allData.localDev) {
    const ld = allData.localDev;
    const parts = [];
    if (ld.api.running) parts.push('API');
    if (ld.vite.running) parts.push('Vite');
    const dockerCounted = ld.docker.filter((s) => s.health !== 'done');
    const dockerHealthy = dockerCounted.filter((s) => s.health === 'healthy').length;
    if (dockerCounted.length > 0) parts.push(`Docker ${dockerHealthy}/${dockerCounted.length}`);

    if (
      parts.length > 0 &&
      ld.api.running &&
      ld.vite.running &&
      dockerHealthy === dockerCounted.length &&
      dockerCounted.length > 0
    ) {
      lines.push(`${c.dim('Local Dev')}      ${c.success('All services running')}`);
    } else if (parts.length > 0) {
      lines.push(`${c.dim('Local Dev')}      ${parts.join(', ')}`);
    } else {
      lines.push(`${c.dim('Local Dev')}      ${c.dim('not running')}`);
    }
  }

  p.note(lines.join('\n'), 'Summary');
}

// ============================================================================
// GLOBAL STATUS (outside a project directory)
// ============================================================================

async function showGlobalStatus(args) {
  cleanStaleProjects();
  const registry = loadGlobalRegistry();

  if (args.json) {
    // Enrich each project with config data
    const enriched = registry.projects.map((entry) => {
      const config = loadProjectConfig(entry.path);
      const envNames = config?.environments ? Object.keys(config.environments) : [];
      return { ...entry, environments: envNames };
    });
    console.log(JSON.stringify({ mode: 'global', projects: enriched }, null, 2));
    return;
  }

  introCommand('status');

  if (registry.projects.length === 0) {
    p.log.info('No registered projects.');
    p.log.info(`Get started: ${c.info('vibecarbon create my-app')}`);
    return;
  }

  p.log.info(
    `${registry.projects.length} registered project${registry.projects.length === 1 ? '' : 's'}`,
  );

  for (const entry of registry.projects) {
    const config = loadProjectConfig(entry.path);
    const envNames = config?.environments ? Object.keys(config.environments) : [];
    const envDisplay = envNames.length > 0 ? envNames.join(', ') : c.dim('none');

    console.log('');
    console.log(`  ${c.bold(entry.name)}`);
    console.log(`    Path          ${c.dim(entry.path)}`);
    console.log(`    Environments  ${envDisplay}`);
    if (entry.updatedAt) {
      console.log(`    Last updated  ${formatRelativeTime(entry.updatedAt)}`);
    }
  }

  console.log('');
  p.log.info(
    `${c.dim('Run')} ${c.info('vibecarbon status')} ${c.dim('from inside a project for detailed info.')}`,
  );
}

// ============================================================================
// MAIN
// ============================================================================

async function main(argv = []) {
  const { values, handled } = parseFlagsOrExit(argv, SPEC);
  if (handled) return;

  // Translate to legacy args shape so the rest of main() doesn't need
  // to change. `noLocal` is now context-sensitive: skip local-dev checks
  // when output is JSON (the consumer is a script, not a human) or when
  // stdout isn't a TTY (CI / piped). Operators who want explicit local
  // checks can still get them by running on a TTY without `-json`.
  const args = {
    env: /** @type {string|null} */ (values.env),
    json: !!values.json,
    noLocal: !!values.json || !process.stdout.isTTY,
  };

  let cwd;
  try {
    cwd = process.cwd();
  } catch {
    if (args.json) {
      console.log(JSON.stringify({ error: 'Current working directory does not exist' }));
    } else {
      console.error(`\n${c.error('Error:')} Current working directory does not exist.`);
    }
    process.exit(1);
  }

  const projectConfig = loadProjectConfig(cwd);
  if (!projectConfig) {
    await showGlobalStatus(args);
    return;
  }

  const environments = projectConfig.environments || {};

  // Filter to specific environment if requested
  let envEntries = Object.entries(environments);
  if (args.env) {
    const filtered = envEntries.filter(([name]) => name === args.env);
    if (filtered.length === 0) {
      if (args.json) {
        console.log(JSON.stringify({ error: `Environment '${args.env}' not found` }));
      } else {
        introCommand('status');
        p.log.error(`Environment '${args.env}' not found`);
        if (envEntries.length > 0) {
          p.log.info(`Available environments: ${envEntries.map(([n]) => n).join(', ')}`);
        }
      }
      process.exit(1);
    }
    envEntries = filtered;
  }

  // Gather all data in parallel
  const allData = {
    projectName: projectConfig.projectName,
    localDev: null,
    environments: {},
  };

  // Local dev check (skipped in JSON / non-TTY contexts — see args above).
  const localDevPromise = args.noLocal
    ? Promise.resolve(null)
    : checkLocalDev(projectConfig.projectName);

  // Environment checks in parallel
  const envChecksPromise = Promise.allSettled(
    envEntries.map(async ([envName, envConfig]) => {
      const checks = {};

      // Remote health check
      if (envConfig.domain) {
        checks.remoteHealth = await checkRemoteHealth(envConfig.domain);
      }

      // Server info from the environment's provider API. Provider resolved
      // once (via resolveEnvProvider — reproducing the old
      // unconditional-Hetzner behavior for unregistered provider strings
      // instead of throwing away this environment's whole checks entry)
      // and reused for both the env-only token gate and the probe itself.
      // Reads through the normalizing reader by the class's TOKEN_ENV rather
      // than calling resolveProviderToken() — the two are behaviorally
      // identical now that token resolution is env-only (see
      // providers/index.js), this just avoids the by-id lookup.
      const servers = envConfig.servers || [];
      const Provider = resolveEnvProvider(envConfig);
      const token = readOperatorVar(Provider.TOKEN_ENV).value;
      if (servers.length > 0 && token) {
        const providerInstance = new Provider(token);
        const serverInfoResults = await Promise.allSettled(
          servers.map((s) => providerInstance.getServerSummary(s.id)),
        );
        checks.serverInfo = {};
        servers.forEach((s, i) => {
          const result = serverInfoResults[i];
          if (result.status === 'fulfilled' && result.value) {
            checks.serverInfo[s.id] = result.value;
          }
        });
      }

      // Git sync
      checks.gitSync = checkGitSync(envName, envConfig);

      // Real replication state for HA envs (best-effort, hard-bounded) and
      // per-server container/pod health (spec: remote-container-health) run
      // concurrently — each is bounded at its own timeout, and stacking them
      // serially would double an HA environment's worst case. Independent of
      // noLocal — that flag is about THIS machine's dev stack.
      // allSettled so a throw in one check can never take the other's result with it.
      const [replicationResult, containersResult] = await Promise.allSettled([
        checkReplication(envName, envConfig, projectConfig.projectName),
        checkRemoteContainers(envName, envConfig, projectConfig.projectName),
      ]);
      checks.replication =
        replicationResult.status === 'fulfilled' ? replicationResult.value : null;
      const containers = containersResult.status === 'fulfilled' ? containersResult.value : null;
      // Omitted, not null, when there is nothing to query (no servers, no
      // project name) — spec §6; consumers key on the key's absence.
      if (containers) checks.containers = containers;

      return { envName, config: envConfig, checks };
    }),
  );

  const [localDevResult, envChecksResults] = await Promise.all([localDevPromise, envChecksPromise]);

  allData.localDev = localDevResult;

  // A rejected entry used to be DROPPED silently: the environment vanished from
  // both the printed table and --json, with nothing saying a check had failed —
  // so an automation consumer reading --json saw a short, confident list. Order
  // is preserved by allSettled, so the env name is recoverable by index even
  // when the callback threw before it could return one.
  envChecksResults.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      const { envName, config, checks } = result.value;
      allData.environments[envName] = { config, checks };
      return;
    }
    const [envName, config] = envEntries[i];
    allData.environments[envName] = {
      config,
      checks: {},
      error: result.reason?.message || String(result.reason),
    };
  });

  // Operator config hygiene: the same shape checks Gate 1 (deploy.js)
  // enforces before it will start provisioning, run here as a passive read
  // (never a refusal) — shown even with no environments deployed (a fresh
  // project still gets its always-known scopes checked). Computed
  // unconditionally, independent of `-json`/TTY, so it lands in both output
  // modes off the same values.
  //
  // JSON placement: `localDev` is null whenever `-json` is set (`noLocal`
  // is forced true above), so nesting this under `allData.localDev` would
  // mean it never actually appears there — it is attached directly to
  // `allData` (top level of the `-json` payload) instead.
  allData.configuration = computeConfigurationCheck(projectConfig, environments, { cwd });

  // Output
  if (args.json) {
    console.log(JSON.stringify(allData, null, 2));
    process.exit(0);
  }

  // Rendered output
  introCommand('status');
  p.log.info(`Project: ${c.bold(projectConfig.projectName)}`);

  // Operator-IP access (H-2). One-line summary: how many CIDRs are in the
  // allowlist. We don't auto-detect here — status is a passive read of
  // local files and HTTP probes; firing api.ipify.org on every status
  // call would be surprising. Pointer to `vibecarbon access` is enough.
  const cidrs = projectConfig.operatorCidrs ?? [];
  if (cidrs.length === 0) {
    p.log.warn(
      `Access: no operator CIDRs configured — run ${c.info('vibecarbon access add <cidr>')} or set ALLOWED_SSH_IPS before deploy.`,
    );
  } else {
    p.log.info(
      `Access: ${cidrs.length} CIDR${cidrs.length === 1 ? '' : 's'} in allowlist — see ${c.info('vibecarbon access')} for details.`,
    );
  }

  // Configuration advisory — same problems array Gate 1 would refuse a
  // deploy over, never a value.
  {
    const { problems, checked } = allData.configuration;
    const configLines = formatConfigurationLines(problems, checked);
    if (problems.length === 0) {
      p.log.info(configLines[0]);
    } else {
      p.log.warn(configLines.join('\n'));
    }
  }

  // Local dev
  if (allData.localDev) {
    renderLocalDev(allData.localDev);
  }

  // Environments
  for (const [envName, envData] of Object.entries(allData.environments)) {
    renderEnvironment(envName, envData.config, envData.checks);
  }

  if (envEntries.length === 0 && !args.env) {
    p.log.info(
      `${c.dim('No environments deployed yet. Run')} ${c.info('vibecarbon deploy')} ${c.dim('to get started.')}`,
    );
  }

  // Summary
  renderSummary(allData);
  p.outro(c.dim(`Status as of ${new Date().toISOString()}`));
}

// ============================================================================
// RUN FUNCTION (called by CLI entry point)
// ============================================================================

export async function run(args) {
  await main(args);
}

// ============================================================================
// EXPORTS FOR TESTING
// ============================================================================

export {
  checkDockerContainers,
  classifyContainer,
  computeConfigurationCheck,
  formatConfigurationLines,
  formatDockerServiceLines,
  formatHealthLines,
  formatServerLines,
  getBranchName,
  isEnvironmentUnhealthy,
  main,
  parseKongHostPort,
  providerDisplayName,
  resolveEnvProvider,
  SPEC,
  VERSION,
};
