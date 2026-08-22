/**
 * Deployment Utilities
 * Shared helper functions for all deployment modes
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCommand, runCommandAsync } from '../command.js';
import { buildHostKeyOpts } from '../host-keys.js';
import { getProviderClass } from '../providers/index.js';
import { escapeDotenv } from '../shell.js';
import { scpWithRetry } from '../ssh.js';

/**
 * Build the SSH `-o` options string for compose provisioning, pinned to the
 * per-env known_hosts file derived from the deploy key. NEVER disables host-key
 * verification (no `UserKnownHostsFile=/dev/null` + `StrictHostKeyChecking=no`).
 *
 * `accept-new` pins the host key on first connect (provisioning is trust-on-
 * first-use for ephemeral cloud VMs) then strict-checks on reuse;
 * `GlobalKnownHostsFile=/dev/null` ignores the system-wide file so a recycled
 * Hetzner IP with a stale entry doesn't spuriously reject. Callers that need a
 * stronger pin should `seedKnownHosts()` the IP first (compose/ha.js does).
 *
 * Paths are UNQUOTED on purpose: callers `.split(' ')` this string and spread it
 * into a spawn() argv (no shell), so each token is passed literally — wrapping
 * the path in quotes would make ssh look for a file literally named `"…"` and
 * silently ignore the key/known_hosts. `.vibecarbon/` paths under the project
 * root contain no spaces.
 *
 * @param {string} sshKeyPath
 * @returns {string} space-joined ssh/scp option string
 */
export function pinnedSshOptsString(sshKeyPath) {
  return `-i ${sshKeyPath} ${buildHostKeyOpts(sshKeyPath).join(' ')}`;
}

// Deployment Defaults
// Cluster-autoscaler is enabled by default with a static floor of 1 and a
// bounded ceiling of 3 (CA pool spawns 0..(max-min) workers on top of the
// static floor). See specs/2026-04-25-k3s-pivot-design.md for the design
// decision: autoscaling on by default, bounded ceiling to cap blast radius.
export const DEFAULT_WORKER_MIN = 1;
export const DEFAULT_WORKER_MAX = 3;

/**
 * Get provider configuration from registry
 * @param {string} providerName
 * @returns {object}
 */
export function getProviderConfig(providerName) {
  const ProviderClass = getProviderClass(providerName);
  return {
    name: ProviderClass.NAME,
    regions: ProviderClass.REGIONS,
    serverTypes: ProviderClass.SERVER_TYPES,
    defaultType: ProviderClass.DEFAULT_TYPE,
    haRegions: ProviderClass.HA_REGIONS,
  };
}

/**
 * Normalize environment name: lowercase, and treat "production" as "prod"
 * @param {string} envName
 * @returns {string}
 */
export function normalizeEnvName(envName) {
  const normalized = envName.toLowerCase();
  return normalized === 'production' ? 'prod' : normalized;
}

/**
 * Branch naming: environment name = branch name, except prod uses main
 * @param {string} envName
 * @returns {string}
 */
export function getBranchName(envName) {
  return envName === 'prod' ? 'main' : envName;
}

/**
 * Merge env overrides into the remote .env file by pulling it down,
 * updating in-memory, and SCPing it back.
 *
 * @param {string} host - remote host IP
 * @param {string} sshOpts - space-separated SSH options string
 * @param {string} remoteDir - absolute path to the remote deployment directory
 * @param {Record<string, string>} updates - key/value pairs to set in .env
 */
export async function mergeRemoteDotenv(host, sshOpts, remoteDir, updates) {
  const dir = mkdtempSync(join(tmpdir(), 'vibecarbon-envmerge-'));
  const local = join(dir, '.env');
  try {
    // Pull remote .env
    try {
      await scpWithRetry([...sshOpts.split(' '), `root@${host}:${remoteDir}/.env`, local]);
    } catch (e) {
      throw new Error(
        `Failed to pull ${remoteDir}/.env from ${host}, is the remote file present and SSH reachable? Underlying error: ${e?.message ?? e}`,
      );
    }
    const existing = readFileSync(local, 'utf-8').split('\n');
    const seen = new Set();
    const merged = existing.map((line) => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
      if (m && updates[m[1]] !== undefined) {
        seen.add(m[1]);
        return `${m[1]}=${escapeDotenv(updates[m[1]])}`;
      }
      return line;
    });
    for (const [k, v] of Object.entries(updates)) {
      if (!seen.has(k)) merged.push(`${k}=${escapeDotenv(v)}`);
    }
    writeFileSync(local, merged.join('\n'));
    // Push merged .env back
    try {
      await scpWithRetry([...sshOpts.split(' '), local, `root@${host}:${remoteDir}/.env`]);
    } catch (e) {
      throw new Error(
        `Failed to push merged .env back to ${host}:${remoteDir}/.env, remote still has the previous contents. Underlying error: ${e?.message ?? e}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Generate SSH key pair for deployment
 * @param {string} keyPath
 * @returns {string} public key content
 */
export function generateSSHKeyPair(keyPath) {
  if (!existsSync(keyPath)) {
    // Ensure parent directory exists
    const keyDir = dirname(keyPath);
    if (!existsSync(keyDir)) {
      mkdirSync(keyDir, { recursive: true });
    }
    runCommand(
      ['ssh-keygen', '-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'vibecarbon-deploy'],
      {
        silent: true,
      },
    );
  }
  // Ensure correct permissions for SSH
  chmodSync(keyPath, 0o600);
  chmodSync(`${keyPath}.pub`, 0o644);
  return readFileSync(`${keyPath}.pub`, 'utf-8').trim();
}

/**
 * Read REPL_PASSWORD — process.env first (CI may export it), then .env.local
 * (where `vibecarbon create` writes it at project-init time). Shared by the
 * compose-HA and k8s-HA replication paths so the parsing lives in one place.
 * Accepts both double-quoted (machine secrets) and single-quoted
 * (escapeDotenv'd user secrets) forms, matching create.js output.
 *
 * @param {string} [cwd] - directory to look for .env.local in
 * @returns {string|null} the password, or null if absent everywhere
 */
export function readReplPassword(cwd = process.cwd()) {
  if (process.env.REPL_PASSWORD) return process.env.REPL_PASSWORD;
  const envLocalPath = join(cwd, '.env.local');
  if (!existsSync(envLocalPath)) return null;
  const content = readFileSync(envLocalPath, 'utf-8');
  const m =
    content.match(/^REPL_PASSWORD="([^"]+)"/m) || content.match(/^REPL_PASSWORD='([^']+)'/m);
  return m ? m[1] : null;
}

/**
 * Wait for SSH to become available on a host
 * @param {string} host
 * @param {string} sshKeyPath
 * @param {number} maxAttempts
 * @returns {Promise<boolean>}
 */
export async function waitForSSH(host, sshKeyPath, maxAttempts = 30) {
  // shell-safety-ignore: pinnedSshOptsString() bakes in BatchMode=yes (validated in its definition)
  const sshOpts = pinnedSshOptsString(sshKeyPath);
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // silent:true → runCommandAsync rejects on failure so the retry loop
      // actually engages (the old sync runCommand returned false without
      // throwing, so this returned true on the first probe regardless).
      await runCommandAsync(
        ['ssh', ...sshOpts.split(' '), '-o', 'ConnectTimeout=5', `root@${host}`, 'echo', 'ok'],
        {
          silent: true,
          timeout: 10000,
        },
      );
      return true;
    } catch {
      if (i === maxAttempts - 1) return false;
      // Adaptive cadence, matching compose/index.js#waitForSSH: SSH is usually
      // live by attempt 3-5, so a fast 1s leg catches it quickly; the 2s/5s tail
      // keeps pacing sane on genuinely slow Hetzner boots. Same early-exit
      // contract — this only shrinks the fresh-VPS wait, never the ceiling.
      const interval = i < 5 ? 1000 : i < 10 ? 2000 : 5000;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  return false;
}

/**
 * Initial server setup - copy project files needed for docker compose
 * @param {string} host - remote host IP
 * @param {string} sshKeyPath - path to the SSH private key
 * @param {string} projectName - name of the project
 * @param {object} options - setup options (observability, n8n, etc.)
 */
export async function setupServerFiles(host, sshKeyPath, projectName, options = {}) {
  const cwd = process.cwd();
  const remoteDir = `/opt/${projectName}`;
  // shell-safety-ignore: pinnedSshOptsString() bakes in BatchMode=yes (validated in its definition)
  const sshOpts = pinnedSshOptsString(sshKeyPath);

  // Create remote directory and required subdirectories
  await runCommandAsync(
    [
      'ssh',
      ...sshOpts.split(' '),
      `root@${host}`,
      'mkdir',
      '-p',
      `${remoteDir}/volumes/db`,
      `${remoteDir}/volumes/kong`,
      `${remoteDir}/supabase/migrations`,
    ],
    { silent: true, ignoreError: true },
  );

  // List of files to copy
  const filesToCopy = [
    'docker-compose.yml',
    'docker-compose.prod.yml',
    'Dockerfile',
    '.dockerignore',
  ];

  // Add optional service compose files if enabled
  if (options.observability) {
    filesToCopy.push('docker-compose.observability.yml', 'docker-compose.observability.prod.yml');
  }
  if (options.n8n) {
    filesToCopy.push('docker-compose.n8n.yml', 'docker-compose.n8n.prod.yml');
  }
  if (options.metabase) {
    filesToCopy.push('docker-compose.metabase.yml', 'docker-compose.metabase.prod.yml');
  }

  // Copy each file that exists
  for (const file of filesToCopy) {
    const localPath = join(cwd, file);
    if (existsSync(localPath)) {
      await scpWithRetry([...sshOpts.split(' '), localPath, `root@${host}:${remoteDir}/`], {
        ignoreError: true,
      });
    }
  }

  // Copy all volumes/db init files (SQL + shell scripts)
  const volumesDbDir = join(cwd, 'volumes', 'db');
  if (existsSync(volumesDbDir)) {
    for (const file of readdirSync(volumesDbDir)) {
      const filePath = join(volumesDbDir, file);
      if (existsSync(filePath)) {
        await scpWithRetry(
          [...sshOpts.split(' '), filePath, `root@${host}:${remoteDir}/volumes/db/`],
          { ignoreError: true },
        );
      }
    }
  }

  // Copy supabase migrations directory
  const migrationsDir = join(cwd, 'supabase', 'migrations');
  if (existsSync(migrationsDir)) {
    await scpWithRetry(
      [
        ...sshOpts.split(' '),
        '-r',
        `${migrationsDir}/*`,
        `root@${host}:${remoteDir}/supabase/migrations/`,
      ],
      { ignoreError: true }, // handle the 2>/dev/null || true semantics
    );
  }

  // Copy kong configuration
  const volumesKongDir = join(cwd, 'volumes', 'kong');
  if (existsSync(volumesKongDir)) {
    for (const file of readdirSync(volumesKongDir)) {
      const filePath = join(volumesKongDir, file);
      if (existsSync(filePath)) {
        await scpWithRetry(
          [...sshOpts.split(' '), filePath, `root@${host}:${remoteDir}/volumes/kong/`],
          { ignoreError: true },
        );
      }
    }
  }

  // Copy local .env file if it exists
  const localEnvPath = join(cwd, '.env');
  if (existsSync(localEnvPath)) {
    await scpWithRetry([...sshOpts.split(' '), localEnvPath, `root@${host}:${remoteDir}/`], {
      ignoreError: true,
    });
  }

  // Override/append production env vars
  const envOverrides = {};
  if (options.githubRepo && options.envName) {
    envOverrides.APP_IMAGE = `ghcr.io/${options.githubRepo}:${options.envName}`;
  }
  if (options.domain) {
    envOverrides.DOMAIN = options.domain;
    envOverrides.ACME_EMAIL = `admin@${options.domain}`;
    // Single public origin (mirror of renderBundle's overrides in bundle.js).
    envOverrides.SITE_URL = `https://${options.domain}`;
    envOverrides.SUPABASE_URL = 'http://kong:8000';
  }

  if (Object.keys(envOverrides).length > 0) {
    await mergeRemoteDotenv(host, sshOpts, remoteDir, envOverrides);
  }

  // Copy prometheus config
  const prometheusDir = join(cwd, 'prometheus');
  if (options.observability && existsSync(prometheusDir)) {
    await runCommandAsync(
      ['ssh', ...sshOpts.split(' '), `root@${host}`, 'mkdir', '-p', `${remoteDir}/prometheus`],
      { silent: true, ignoreError: true },
    );
    await scpWithRetry(
      [...sshOpts.split(' '), '-r', `${prometheusDir}/*`, `root@${host}:${remoteDir}/prometheus/`],
      { ignoreError: true },
    );
  }

  // Copy grafana provisioning
  const grafanaDir = join(cwd, 'grafana');
  if (options.observability && existsSync(grafanaDir)) {
    await scpWithRetry([...sshOpts.split(' '), '-r', grafanaDir, `root@${host}:${remoteDir}/`], {
      ignoreError: true,
    });
  }

  return true;
}
