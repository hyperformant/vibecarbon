/**
 * Upgrade policy — classifies template files into safe / merge / never categories
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// Files that can be auto-replaced when unmodified by the user
const SAFE_PATTERNS = [
  'Dockerfile',
  'docker-entrypoint.sh',
  '.dockerignore',
  'docker-compose.prod.yml',
  'docker-compose.observability.yml',
  'docker-compose.observability.prod.yml',
  'docker-compose.observability.override.yml',
  'docker-compose.metabase.yml',
  'docker-compose.metabase.override.yml',
  'docker-compose.n8n.yml',
  'docker-compose.n8n.override.yml',
  'docker-compose.dev-init.yml',
  'k8s/base/**',
  'k8s/infra/**',
  'k8s/flux/**',
  // k8s/values/** and k8s/gitops/** were in NO bucket, and getFilePolicy
  // defaults an unmatched path to 'never' — so both were silently stranded on
  // every existing project. They are the WORST files to strand: each carries a
  // chart-version pin that must move in lockstep with the CLI.
  // k8s/values/supabase.values.yaml is read from the PROJECT copy by
  // installSupabase and its env-list schema is coupled to
  // SUPABASE_HELM_CHART_VERSION (the 0.7.1 bump replaced those lists
  // wholesale), and k8s/gitops/supabase/helm-release.yaml carries the second
  // pin site for the Flux path. Stranded, a chart bump would install the NEW
  // chart against OLD values on every upgraded project — the exact map-vs-list
  // break — with no CLI command able to repair it.
  'k8s/values/**',
  'k8s/gitops/**',
  // Live on every managed-DNS compose deploy (acme.js exports it as
  // DNS01_OVERRIDE_FILE; scale.js adds it to the -f set) but absent from this
  // list, so ACME/Traefik fixes reached new projects only.
  'docker-compose.dns01.prod.yml',
  // Siblings of the metabase/n8n entries below; their .prod.yml variants were
  // omitted while .yml and .override.yml were listed — an oversight, not a
  // decision. Parked addons today, so no live impact.
  'docker-compose.metabase.prod.yml',
  'docker-compose.n8n.prod.yml',
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
  'volumes/kong/**',
  'volumes/grafana/**',
  'volumes/prometheus/**',
  'volumes/loki/**',
  'volumes/promtail/**',
  'volumes/traefik/**',
  'volumes/pooler/**',
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
  'supabase/**',
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
  if (matchesAny(relativePath, NEVER_PATTERNS)) return 'never';
  if (matchesAny(relativePath, MERGE_PATTERNS)) return 'merge';
  if (matchesAny(relativePath, SAFE_PATTERNS)) return 'safe';
  // Default: files not explicitly classified are never touched
  return 'never';
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
  const allFiles = walkDir(templateDir);
  return allFiles.filter((f) => {
    const policy = getFilePolicy(f);
    return policy === 'safe' || policy === 'merge';
  });
}
