/**
 * Project configuration management
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseDotenv } from './shell.js';

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
  const configPath = join(cwd, '.vibecarbon.json');
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

/**
 * Save project configuration to .vibecarbon.json
 *
 * @param {object} config - Configuration to save
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 */
export function saveProjectConfig(config, cwd = process.cwd()) {
  const configPath = join(cwd, '.vibecarbon.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
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
