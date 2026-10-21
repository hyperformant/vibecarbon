/**
 * Project configuration management
 */

import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseDotenv } from './dotenv.js';

/**
 * The project config's file name. Only this module builds its path, and only
 * updateProjectConfig writes it (census: tests/unit/config/no-stale-save-census.test.ts).
 */
export const CONFIG_FILE = '.vibecarbon.json';

/** Whether `cwd` has a project config file. */
export function projectConfigExists(cwd = process.cwd()) {
  return existsSync(join(cwd, CONFIG_FILE));
}

/**
 * The project config file as written (no synthesized fields), or null when
 * there is none.
 *
 * @param {string} [cwd]
 * @returns {object|null}
 */
export function readProjectConfigFile(cwd = process.cwd()) {
  const configPath = join(cwd, CONFIG_FILE);
  return existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : null;
}

/**
 * Sanitize a project name to be a valid hostname
 * - Extracts base name from paths (../my-app -> my-app)
 * - Removes invalid characters
 * - Converts to lowercase
 * - Ensures doesn't start/end with hyphen
 *
 * @param {string} name - Project name to sanitize
 * @returns {string} - Valid hostname
 */
function sanitizeHostname(name) {
  if (!name) return 'project';

  // Extract base name from path (handles ../my-app, ./my-app, /path/to/my-app)
  let sanitized = basename(name);

  // Remove any characters that aren't alphanumeric or hyphens
  sanitized = sanitized.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  // Remove consecutive hyphens
  sanitized = sanitized.replace(/-+/g, '-');

  // Remove leading/trailing hyphens
  sanitized = sanitized.replace(/^-+|-+$/g, '');

  // Ensure it's not empty
  if (!sanitized) return 'project';

  // Ensure it doesn't exceed hostname limits (63 chars for labels)
  if (sanitized.length > 63) {
    sanitized = sanitized.substring(0, 63).replace(/-+$/, '');
  }

  return sanitized;
}

/**
 * Load project configuration from multiple sources
 * Priority: .vibecarbon.json > .env.local > package.json
 *
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {object|null} - Project config or null if not found
 */
export function loadProjectConfig(cwd = process.cwd()) {
  // Try to load .vibecarbon.json
  const configPath = join(cwd, CONFIG_FILE);
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));

    // If projectName is missing or empty, try to get it from .env.local or package.json
    if (!config.projectName) {
      const envPath = join(cwd, '.env.local');
      if (existsSync(envPath)) {
        const rawValue = parseDotenv(readFileSync(envPath, 'utf-8')).PROJECT_NAME;
        if (rawValue) {
          config.projectName = sanitizeHostname(rawValue);
        }
      }

      // Fall back to package.json name
      if (!config.projectName) {
        const pkgPath = join(cwd, 'package.json');
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          config.projectName = sanitizeHostname(pkg.name);
        }
      }
    }

    // Final fallback - ensure projectName is always set
    if (!config.projectName) {
      config.projectName = 'project';
    }

    return config;
  }

  // Try to load from .env.local
  const envPath = join(cwd, '.env.local');
  if (existsSync(envPath)) {
    const secrets = parseDotenv(readFileSync(envPath, 'utf-8'));
    const config = {
      projectName: secrets.PROJECT_NAME ? sanitizeHostname(secrets.PROJECT_NAME) : null,
      secrets,
    };

    // Try to get project name from package.json
    const pkgPath = join(cwd, 'package.json');
    if (!config.projectName && existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      config.projectName = sanitizeHostname(pkg.name);
    }

    // Final fallback - ensure projectName is always set
    if (!config.projectName) {
      config.projectName = 'project';
    }

    return config;
  }

  // Try package.json as fallback
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return { projectName: sanitizeHostname(pkg.name), secrets: {} };
  }

  return null;
}

/** How long a writer waits for another process's config write before refusing. */
const CONFIG_LOCK_TIMEOUT_MS = 30_000;
/** A lock file with no readable pid yet is trusted for this long (its writer is mid-create). */
const UNREADABLE_LOCK_GRACE_MS = 5_000;
const CONFIG_LOCK_POLL_MS = 25;
/** A wait this long gets one stderr line, so a queued write never reads as a hang. */
const CONFIG_LOCK_NOTICE_MS = 1_000;

/** Lock paths this process holds right now: a nested call would wait on itself. */
const heldConfigLocks = new Set();

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists under another user, so it is alive.
    return err?.code === 'EPERM';
  }
}

/**
 * The holder of an existing lock file: its pid, the text it holds, and
 * whether it is stale (a dead pid, or no pid long after its create).
 */
function inspectLock(lockPath) {
  let text;
  let st;
  try {
    st = statSync(lockPath);
    text = readFileSync(lockPath, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { gone: true };
    throw err;
  }
  const pid = /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
  if (pid === null) {
    return { pid: null, text, stale: Date.now() - st.mtimeMs > UNREADABLE_LOCK_GRACE_MS };
  }
  // Our own pid on a lock we do not hold is a leftover of a recycled pid.
  return { pid, text, stale: pid === process.pid || !pidAlive(pid) };
}

/** Create `path` exclusively, holding this pid. False when it already exists. */
function createLockFile(path) {
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Remove a stale lock, one breaker at a time: two waiters that both judged
 * the same lock stale must not have the second remove the fresh lock the
 * first one took after its break. Under `<lock>.break` the lock is re-read
 * and removed only if it still holds the stale text: a fresh lock can only
 * appear once the stale one is gone, and only a breaker removes that.
 */
function breakStaleLock(lockPath, stale) {
  const breakPath = `${lockPath}.break`;
  if (!createLockFile(breakPath)) {
    // Another process is breaking it right now (microseconds), or crashed
    // mid-break: clear a dead breaker's file, otherwise wait and retry.
    const breaker = inspectLock(breakPath);
    if (!breaker.gone && breaker.stale) {
      try {
        unlinkSync(breakPath);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    } else {
      sleepSync(CONFIG_LOCK_POLL_MS);
    }
    return;
  }
  try {
    const now = inspectLock(lockPath);
    if (!now.gone && now.text === stale.text) unlinkSync(lockPath);
  } finally {
    unlinkSync(breakPath);
  }
}

/**
 * Take `.vibecarbon.json.lock` (O_EXCL, so exactly one process wins across
 * terminals), waiting up to `timeoutMs` for a live holder. A lock whose holder
 * pid is dead is broken. Returns the release.
 */
function acquireConfigLock(lockPath, timeoutMs) {
  if (heldConfigLocks.has(lockPath)) {
    throw new Error(
      'updateProjectConfig: nested call while this process holds the config lock; ' +
        'make the change inside the outer mutator',
    );
  }
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let noticed = false;
  for (;;) {
    if (!createLockFile(lockPath)) {
      const holder = inspectLock(lockPath);
      if (holder.gone) continue;
      if (holder.stale) {
        breakStaleLock(lockPath, holder);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${lockPath} is held by pid ${holder.pid ?? 'unknown'} (another vibecarbon command ` +
            `writing the project config); waited ${Math.round(timeoutMs / 1000)}s. ` +
            'If no vibecarbon command is running, delete the lock file and rerun.',
        );
      }
      if (!noticed && Date.now() - startedAt >= CONFIG_LOCK_NOTICE_MS) {
        noticed = true;
        process.stderr.write(
          `waiting for ${lockPath}, held by pid ${holder.pid ?? 'unknown'} ` +
            `(another vibecarbon command is writing the project config)\n`,
        );
      }
      sleepSync(CONFIG_LOCK_POLL_MS);
      continue;
    }
    heldConfigLocks.add(lockPath);
    return () => {
      heldConfigLocks.delete(lockPath);
      try {
        // Only our lock: a breaker can only have removed it if our pid read dead.
        if (readFileSync(lockPath, 'utf-8').trim() === String(process.pid)) unlinkSync(lockPath);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    };
  }
}

/**
 * Write the config atomically: `.vibecarbon.json.tmp` in the same directory,
 * fsync, rename over the file, fsync the directory. A crash at any point
 * leaves either the old file or the new one, never a truncated one. The file
 * keeps its permission bits (set with fchmod, so the umask cannot narrow
 * them). A symlinked .vibecarbon.json is replaced by a regular file holding
 * the new config; the link's target is left as it was.
 * Internal: every write goes through updateProjectConfig.
 */
function saveProjectConfig(config, cwd) {
  const configPath = join(cwd, CONFIG_FILE);
  const tmpPath = `${configPath}.tmp`;
  // Keep the file's mode: the rename replaces the inode.
  const mode = existsSync(configPath) ? statSync(configPath).mode & 0o777 : 0o644;
  const fd = openSync(tmpPath, 'w', mode);
  try {
    fchmodSync(fd, mode);
    writeSync(fd, `${JSON.stringify(config, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmpPath, configPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // the original file is intact either way; the rename error is the cause
    }
    throw err;
  }
  try {
    const dirFd = openSync(cwd, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Directory fsync is unsupported on some filesystems; the rename is atomic regardless.
  }
}

/**
 * The one way to change .vibecarbon.json: under the cross-process config lock,
 * reload the file from disk, apply `mutator`, write it atomically.
 *
 * The mutator receives the freshly read config (the raw file, never the
 * fields loadProjectConfig synthesizes) and either changes it in place or
 * returns a replacement. Patch only the fields you own: whatever another
 * step or another terminal saved since you last read is in `config` and must
 * be kept. A mutator that throws writes nothing. It must be synchronous.
 *
 * @param {(config: object) => object|void} mutator
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @param {{ lockTimeoutMs?: number }} [opts]
 * @returns {object} the config as written
 */
export function updateProjectConfig(
  mutator,
  cwd = process.cwd(),
  { lockTimeoutMs = CONFIG_LOCK_TIMEOUT_MS } = {},
) {
  const configPath = join(cwd, CONFIG_FILE);
  const release = acquireConfigLock(`${configPath}.lock`, lockTimeoutMs);
  try {
    let current = {};
    if (existsSync(configPath)) {
      try {
        current = JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch (err) {
        throw new Error(`${configPath} is not valid JSON (${err.message}); fix it and rerun`);
      }
    }
    const unchanged = JSON.stringify(current);
    const returned = mutator(current);
    if (typeof returned?.then === 'function') {
      throw new Error(
        'updateProjectConfig: the mutator must be synchronous (it runs under the lock)',
      );
    }
    const next = returned ?? current;
    // A no-op mutator writes nothing (and never creates a missing file).
    if (JSON.stringify(next) !== unchanged) saveProjectConfig(next, cwd);
    return next;
  } finally {
    release();
  }
}

/**
 * Load S3 configuration for a specific environment
 *
 * @param {string} envName - Environment name (e.g., 'prod', 'staging')
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {object|null} - S3 config or null if not configured
 */
export function loadS3Config(envName, cwd = process.cwd()) {
  const config = loadProjectConfig(cwd);
  return config?.environments?.[envName]?.s3 || null;
}

/**
 * Load backup S3 configuration for a specific environment.
 * This is the dedicated backup bucket (separate from storage bucket).
 *
 * @param {string} envName - Environment name (e.g., 'prod', 'staging')
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {object|null} - Backup S3 config or null if not configured
 */
export function loadBackupS3Config(envName, cwd = process.cwd()) {
  const config = loadProjectConfig(cwd);
  return config?.environments?.[envName]?.backupS3 || null;
}

// ============================================================================
// GLOBAL PROJECT REGISTRY (~/.vibecarbon/projects.json)
// ============================================================================

const DEFAULT_CONFIG_DIR = join(homedir(), '.vibecarbon');

/**
 * Ensure the global config directory exists with secure permissions
 *
 * @param {string} [configDir] - Config directory (default: ~/.vibecarbon/)
 */
function ensureConfigDir(configDir = DEFAULT_CONFIG_DIR) {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load the global project registry
 *
 * @param {string} [configDir] - Config directory for testability
 * @returns {{ projects: Array<{ name: string, path: string, createdAt: string, updatedAt: string }> }}
 */
export function loadGlobalRegistry(configDir = DEFAULT_CONFIG_DIR) {
  const registryPath = join(configDir, 'projects.json');
  if (!existsSync(registryPath)) {
    return { projects: [] };
  }

  try {
    const content = readFileSync(registryPath, 'utf-8');
    const data = JSON.parse(content);
    if (!Array.isArray(data.projects)) {
      return { projects: [] };
    }
    return data;
  } catch {
    return { projects: [] };
  }
}

/**
 * Register (or update) a project in the global registry.
 * Upserts by resolved absolute path.
 *
 * @param {string} name - Project name
 * @param {string} projectPath - Project directory path
 * @param {string} [configDir] - Config directory for testability
 */
export function registerProject(name, projectPath, configDir = DEFAULT_CONFIG_DIR) {
  ensureConfigDir(configDir);
  const absPath = resolve(projectPath);
  const registry = loadGlobalRegistry(configDir);

  const existing = registry.projects.find((p) => p.path === absPath);
  const now = new Date().toISOString();

  if (existing) {
    existing.name = name;
    existing.updatedAt = now;
  } else {
    registry.projects.push({ name, path: absPath, createdAt: now, updatedAt: now });
  }

  const registryPath = join(configDir, 'projects.json');
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Remove registry entries where the directory no longer exists.
 *
 * @param {string} [configDir] - Config directory for testability
 */
export function cleanStaleProjects(configDir = DEFAULT_CONFIG_DIR) {
  const registry = loadGlobalRegistry(configDir);
  const before = registry.projects.length;
  registry.projects = registry.projects.filter((p) => existsSync(p.path));

  if (registry.projects.length !== before) {
    const registryPath = join(configDir, 'projects.json');
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  }
}

// ============================================================================
// PROJECT DETECTION UTILITIES
// ============================================================================

/**
 * Check if docker-compose.yml exists in the given directory
 *
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {boolean}
 */
export function hasDockerCompose(cwd = process.cwd()) {
  return existsSync(join(cwd, 'docker-compose.yml'));
}

/**
 * Walk up from `startDir` looking for the root of the Vibecarbon project it
 * sits inside, and return that directory (null once the filesystem root is
 * reached). `startDir` itself is checked first.
 *
 * Deliberately stricter than the cwd predicate in `assertInProjectDir`: an
 * ancestor must carry `.vibecarbon.json` itself, not merely satisfy
 * `loadProjectConfig`'s package.json fallback. That fallback is safe for a
 * directory the user deliberately cd'd into and typed a command in. Applied
 * upward it would silently adopt any unrelated Node repo that happens to
 * have a docker-compose.yml as "your project", and point commands like `up`
 * at a foreign tree to start containers in.
 *
 * @param {string} [startDir] - Directory to start from
 * @returns {string|null} - Absolute project root, or null if there is none
 */
export function findProjectRoot(startDir = process.cwd()) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE)) && hasDockerCompose(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Check if K8s HA overlay directories exist
 *
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {boolean}
 */
export function isHAConfigured(cwd = process.cwd()) {
  return (
    existsSync(join(cwd, 'k8s/overlays/production-hel1')) ||
    existsSync(join(cwd, 'k8s/overlays/production-nbg1'))
  );
}
