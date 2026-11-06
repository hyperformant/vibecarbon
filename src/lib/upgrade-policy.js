/**
 * Upgrade policy — classifies template files into safe / merge / never categories
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { projectPathFor } from './template-paths.js';

// Files that can be auto-replaced when unmodified by the user
const SAFE_PATTERNS = [
  'Dockerfile',
  'docker-entrypoint.sh',
  '.dockerignore',
  'docker-compose.prod.yml',
  // Every other compose file: the add-ons' (docker-compose.<name>[.prod|
  // .override].yml, refreshed from services/<name>/ through the add-on's
  // manifest, src/lib/addon-upgrade-files.js) and docker-compose.dev-init.yml.
  // docker-compose.yml and docker-compose.override.yml are user-blended:
  // MERGE_PATTERNS is checked first and keeps them there.
  'docker-compose.*.yml',
  'k8s/base/**',
  'k8s/infra/**',
  'k8s/flux/**',
  'cloud-init/**',
  '.github/workflows/**',
  // Node line for the project. Safe to replace: it's a version pin we own,
  // and .github/workflows/vibecarbon-build.yml (also SAFE) reads it via
  // node-version-file — upgrading one without the other breaks CI.
  '.nvmrc',
  'biome.json',
  'tsconfig.json',
  'tsconfig.server.json',
  'components.json',
  'backup/**',
  'scripts/**',
  'volumes/grafana/**',
  'volumes/prometheus/**',
  'volumes/loki/**',
  'volumes/alloy/**',
  'volumes/traefik/**',
  // The dev-only Garage config docker-compose.override.yml mounts. Missing,
  // Docker would mount an empty directory there and the local S3 would not
  // start.
  'volumes/s3/**',
  // The n8n addon's hook and setup scripts docker-compose.n8n.yml mounts.
  'volumes/n8n/**',
  'AGENTS.md',
  'CLAUDE.md',
  'PRODUCTION.md',
  'DEVELOPMENT.md',
  '.windsurfrules',
  '.github/copilot-instructions.md',
  '.cursor/rules/**',
  '.claude/settings.json',
  '.claude/hooks/**',
  '.claude/agents/**',
];

// Template-owned files under a NEVER directory that upgrade must still ship:
// every one is bind-mounted by a shipped compose file or sourced by a
// shipped script, so stranding it pairs a new caller with an old (or
// missing) dependency. tests/unit/lib/upgrade-mount-census.test.ts enforces
// that every mount and every sourced container path resolves to a shipped file.
// - db-guard.sh is the compose db service's entrypoint: missing, Docker
//   mounts an empty directory there and there is no database.
// - walg-env.sh is sourced by compose-backup.sh (safe) and wal-archive.sh:
//   missing, every compose backup exits 1.
// - wal-archive.sh is the archive_command: an old copy reads the
//   WALG_S3_PREFIX the merged docker-compose.yml no longer sets
//   (WALG_S3_PREFIX_BASE now) and archives nothing.
// - metabase-init.sh / n8n-init.sh are the addons' initdb scripts their
//   (safe) compose files mount.
const SAFE_DESPITE_NEVER = [
  'volumes/db/db-guard.sh',
  'volumes/db/walg-env.sh',
  'volumes/db/wal-archive.sh',
  'volumes/db/metabase-init.sh',
  'volumes/db/n8n-init.sh',
];

// Files that always require user review
const MERGE_PATTERNS = [
  'docker-compose.yml',
  'docker-compose.override.yml',
  'package.json',
  'vite.config.ts',
  'k8s/overlays/**',
  '.gitignore',
];

// Files that should never be touched
const NEVER_PATTERNS = [
  'src/**',
  'content/**',
  'db/migrations/**',
  'db/seed.sql',
  '.env',
  '.env.local',
  '.env.example',
  'README.md',
  'volumes/db/**',
  'node_modules/**',
  'dist/**',
  'pnpm-lock.yaml',
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  '.git/**',
  '.claude/agent-memory/**',
];

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports `**` (any path depth) and `*` (any filename chars).
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegex(pattern) {
  const re = pattern
    // Escape regex-special chars except * and /
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // ** matches any number of path segments (including zero)
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    // * matches anything except path separator
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`^${re}$`);
}

/**
 * Test if a path matches any pattern in a list
 *
 * @param {string} filePath
 * @param {string[]} patterns
 * @returns {boolean}
 */
function matchesAny(filePath, patterns) {
  return patterns.some((p) => globToRegex(p).test(filePath));
}

/**
 * Classify a file path into an upgrade policy category
 *
 * @param {string} relativePath - Path relative to project root
 * @returns {'safe' | 'merge' | 'never'}
 */
export function getFilePolicy(relativePath) {
  if (matchesAny(relativePath, SAFE_DESPITE_NEVER)) return 'safe';
  if (matchesAny(relativePath, NEVER_PATTERNS)) return 'never';
  if (matchesAny(relativePath, MERGE_PATTERNS)) return 'merge';
  if (matchesAny(relativePath, SAFE_PATTERNS)) return 'safe';
  // Default: files not explicitly classified are never touched
  return 'never';
}

// The project's own code, data and secrets: never touched by an add-on file
// either. NEVER_PATTERNS without volumes/db/**, which only shields the
// template's database files from a template upgrade.
const ADDON_NEVER_PATTERNS = NEVER_PATTERNS.filter((p) => p !== 'volumes/db/**');

/**
 * Classify a file an add-on ships (src/lib/addon-upgrade-files.js). An
 * add-on's files follow one rule wherever they land: its integration doc
 * (manifest source under `docs/`) is the operator's to keep, the project's
 * own code, data and secrets stay never, a merge path stays merge, and
 * everything else the add-on ships (compose, k8s, mounted volumes, init
 * scripts) is safe, whether or not a template pattern happens to name it.
 *
 * @param {string} relativePath - Path relative to project root
 * @param {string} src - The file's path inside services/<name>/
 * @returns {'safe' | 'merge' | 'never'}
 */
export function getAddonFilePolicy(relativePath, src) {
  if (String(src).startsWith('docs/')) return 'never';
  if (matchesAny(relativePath, ADDON_NEVER_PATTERNS)) return 'never';
  if (matchesAny(relativePath, MERGE_PATTERNS)) return 'merge';
  return 'safe';
}

/**
 * Walk a directory tree and return all file paths relative to rootDir
 *
 * @param {string} rootDir - Root directory to walk
 * @returns {string[]} - Array of relative file paths
 */
function walkDir(rootDir) {
  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules and .git in template
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(fullPath);
      } else {
        results.push(relative(rootDir, fullPath));
      }
    }
  }

  walk(rootDir);
  return results;
}

/**
 * Get all upgradeable files from the template directory
 * Returns files that are classified as 'safe' or 'merge'
 *
 * @param {string} templateDir - Path to the carbon/ template directory
 * @returns {string[]} - Array of relative file paths
 */
export function getUpgradeableFiles(templateDir) {
  const allFiles = walkDir(templateDir).map(projectPathFor);
  return allFiles.filter((f) => {
    const policy = getFilePolicy(f);
    return policy === 'safe' || policy === 'merge';
  });
}
