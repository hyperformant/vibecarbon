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
import { runCommand } from './lib/command.js';
import { cleanStaleProjects, loadGlobalRegistry, loadProjectConfig } from './lib/config.js';
import {
  buildPrimaryLagQuery,
  buildStandbyReplayQuery,
  formatReplicationLagLine,
} from './lib/deploy/replication.js';
import { HetznerProvider } from './lib/providers/hetzner.js';
import { hasProvider, PROVIDERS, providerFor } from './lib/providers/index.js';
import { getPostgresPod, getSSHKeyPath, sshKubectl, sshRun } from './lib/ssh.js';
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

async function checkHttpEndpoint(url, timeout = 2000) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
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

async function checkDockerContainers(projectName) {
  const services = [
    {
      name: 'PostgreSQL',
      container: 'db',
      healthUrl: 'http://localhost:8000/rest/v1/',
      acceptCodes: [200, 401],
    },
    {
      name: 'Kong Gateway',
      container: 'kong',
      healthUrl: 'http://localhost:8000/',
      acceptCodes: [404],
    },
    {
      name: 'Auth (GoTrue)',
      container: 'auth',
      healthUrl: 'http://localhost:8000/auth/v1/health',
      acceptCodes: [200, 401],
    },
    {
      name: 'REST (PostgREST)',
      container: 'rest',
      healthUrl: 'http://localhost:8000/rest/v1/',
      acceptCodes: [200, 401],
    },
    {
      name: 'Realtime',
      container: 'realtime',
      healthUrl: 'http://localhost:8000/realtime/v1/',
      acceptCodes: [200, 401, 403, 426],
    },
    {
      name: 'Storage',
      container: 'storage',
      healthUrl: 'http://localhost:8000/storage/v1/status',
      acceptCodes: [200, 401],
    },
    {
      name: 'Studio',
      container: 'studio',
      healthUrl: 'http://studio.localhost/',
      acceptCodes: [200, 307],
    },
    {
      name: 'Meta',
      container: 'meta',
      healthUrl: 'http://localhost:8000/pg/',
      acceptCodes: [200, 401],
    },
  ];

  // Get list of running containers
  let runningContainers = new Set();
  try {
    const output =
      runCommand(['docker', 'ps', '--format', '{{.Names}}'], {
        silent: true,
        encoding: 'utf-8',
        timeout: 5000,
        ignoreError: true,
      }) || '';
    const prefix = projectName ? `${projectName}-` : null;
    runningContainers = new Set(
      output
        .split('\n')
        .map((name) => name.trim())
        .filter(Boolean)
        .filter((name) => !prefix || name.startsWith(prefix))
        .map((name) => (prefix ? name.slice(prefix.length) : name.replace(/^[^-]+-/, ''))),
    );
  } catch {
    return [];
  }

  if (runningContainers.size === 0) return [];

  // Check port offset from env
  let portOffset = 0;
  try {
    const envFiles = ['.env.local', '.env'];
    for (const file of envFiles) {
      if (existsSync(file)) {
        const content = readFileSync(file, 'utf-8');
        const match = content.match(/^DEV_PORT_OFFSET=["']?(\d+)["']?/m);
        if (match) {
          portOffset = Number.parseInt(match[1], 10);
        }
        break;
      }
    }
  } catch {
    // Use defaults
  }

  // Adjust ports if offset
  if (portOffset > 0) {
    for (const svc of services) {
      svc.healthUrl = svc.healthUrl.replace(':8000', `:${8000 + portOffset}`);
    }
  }

  // Only check services whose containers are running
  const activeServices = services.filter((svc) => runningContainers.has(svc.container));

  const results = await Promise.allSettled(
    activeServices.map(async (svc) => {
      const start = Date.now();
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const response = await fetch(svc.healthUrl, { method: 'GET', signal: controller.signal });
        clearTimeout(timeoutId);
        const latencyMs = Date.now() - start;
        const isHealthy = svc.acceptCodes
          ? svc.acceptCodes.includes(response.status)
          : response.status >= 200 && response.status < 400;

        return {
          name: svc.name,
          container: svc.container,
          health: isHealthy ? 'healthy' : 'unhealthy',
          latencyMs,
        };
      } catch {
        return {
          name: svc.name,
          container: svc.container,
          health: 'unhealthy',
          latencyMs: Date.now() - start,
        };
      }
    }),
  );

  return results.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : { name: '?', container: '?', health: 'unknown', latencyMs: 0 },
  );
}

function getPortConfig() {
  const defaults = { vite: 5173, api: 3000 };
  try {
    const envFiles = ['.env.local', '.env'];
    for (const file of envFiles) {
      if (existsSync(file)) {
        const content = readFileSync(file, 'utf-8');
        const getEnvValue = (key) => {
          const match = content.match(new RegExp(`^${key}=["']?([^"'\\n]+)["']?`, 'm'));
          return match ? match[1] : null;
        };

        const portOffset = Number.parseInt(getEnvValue('DEV_PORT_OFFSET') || '0', 10);
        const vitePort = getEnvValue('DEV_VITE_PORT') || String(5173 + portOffset);
        const apiPort = getEnvValue('DEV_API_PORT') || String(3000 + portOffset);

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

async function checkRemoteHealth(domain) {
  const url = `https://${domain}/api/health`;
  const result = await checkHttpEndpoint(url, 5000);
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
  if (data.docker.length > 0) {
    const healthyCount = data.docker.filter((s) => s.health === 'healthy').length;
    const total = data.docker.length;
    const dockerSummary =
      healthyCount === total
        ? c.success(`\u25cf ${healthyCount}/${total} healthy`)
        : c.warning(`\u25cf ${healthyCount}/${total} healthy`);
    lines.push(`${c.dim('Docker Services'.padEnd(30))}${dockerSummary}`);

    for (const svc of data.docker) {
      const icon =
        svc.health === 'healthy'
          ? c.success('\u25cf')
          : svc.health === 'unhealthy'
            ? c.error('\u25cf')
            : c.dim('\u25cb');
      const status = svc.health === 'healthy' ? c.dim('healthy') : c.error(svc.health);
      const latency = svc.latencyMs ? c.dim(`${svc.latencyMs}ms`) : '';
      lines.push(`  ${c.dim(svc.name.padEnd(28))}${icon} ${status}  ${latency}`);
    }
  } else {
    lines.push(`${c.dim('Docker Services'.padEnd(30))}${c.dim('not running')}`);
  }

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
    for (const server of servers) {
      const serverInfo = checks.serverInfo?.[server.id];
      const configType = server.serverType || server.type || null;
      let statusStr;
      if (serverInfo) {
        const icon = serverInfo.status === 'running' ? c.success('\u25cf') : c.error('\u25cf');
        const typeLabel = serverInfo.serverType || configType || '';
        statusStr = `${icon} ${serverInfo.status === 'running' ? c.success('running') : c.error(serverInfo.status)}  ${c.dim(typeLabel)}`;
      } else if (configType) {
        statusStr = c.dim(configType);
      } else {
        statusStr = c.dim('\u2013');
      }
      lines.push(
        `  ${c.info((server.name || '').padEnd(16))} ${(server.ip || '').padEnd(15)} ${statusStr}`,
      );
    }
  }

  // Remote health
  if (envConfig.domain && checks.remoteHealth) {
    lines.push('');
    lines.push(c.bold('Health'));
    lines.push(`  ${c.dim(checks.remoteHealth.url)}`);
    if (checks.remoteHealth.ok) {
      const data = checks.remoteHealth.data;
      let details = '';
      if (data && typeof data === 'object') {
        const parts = [];
        if (data.database) parts.push(`db: ${data.database}`);
        if (data.supabase) parts.push(`supabase: ${data.supabase}`);
        if (data.status) parts.push(data.status);
        if (parts.length > 0) details = c.dim(`  (${parts.join(', ')})`);
      }
      lines.push(
        `  ${c.success('\u25cf')} ${c.success('healthy')}  ${c.dim(`${checks.remoteHealth.latencyMs}ms`)}${details}`,
      );
    } else {
      const errMsg = checks.remoteHealth.error || `HTTP ${checks.remoteHealth.status}`;
      lines.push(`  ${c.error('\u25cf')} ${c.error('unhealthy')}  ${c.dim(`(${errMsg})`)}`);
    }
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
    (e) => e.checks?.remoteHealth && !e.checks.remoteHealth.ok,
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
    const dockerHealthy = ld.docker.filter((s) => s.health === 'healthy').length;
    if (ld.docker.length > 0) parts.push(`Docker ${dockerHealthy}/${ld.docker.length}`);

    if (
      parts.length > 0 &&
      ld.api.running &&
      ld.vite.running &&
      dockerHealthy === ld.docker.length &&
      ld.docker.length > 0
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
      // Reads process.env directly rather than calling resolveProviderToken()
      // — the two are behaviorally identical now that token resolution is
      // env-only (see providers/index.js), this just avoids the extra call.
      const servers = envConfig.servers || [];
      const Provider = resolveEnvProvider(envConfig);
      const token = process.env[Provider.TOKEN_ENV];
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

      // Real replication state for HA envs (best-effort, hard-bounded). null
      // for non-HA or when the primary/key isn't locally reachable.
      checks.replication = await checkReplication(envName, envConfig, projectConfig.projectName);

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

export { getBranchName, main, providerDisplayName, resolveEnvProvider, SPEC, VERSION };
