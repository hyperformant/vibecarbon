/**
 * Project detection and manifest management utilities
 * Shared across CLI commands (add.js, s3.js, deploy.js, etc.)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecretFile } from './command.js';
import { operatorSecretKeys } from './config-registry.js';
import { escapeDotenv, parseDotenv } from './shell.js';

// ============================================================================
// PACKAGE MANAGER DETECTION
// ============================================================================

/**
 * Detect the package manager used by a project.
 * Checks lock files first, then package.json packageManager field, falls back to npm.
 *
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {'npm'|'pnpm'|'bun'}
 */
export function detectPackageManager(cwd = process.cwd()) {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun';
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm';

  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.packageManager) {
        const pm = pkg.packageManager.split('@')[0];
        if (['npm', 'pnpm', 'bun'].includes(pm)) return pm;
      }
    } catch {
      // Ignore parse errors
    }
  }

  // npm is the template default and ships with Node, so it is the only safe
  // fallback when a project carries no lockfile and no explicit pin.
  return 'npm';
}

// ============================================================================
// MANIFEST MANAGEMENT (.vibecarbon.json services tracking)
// ============================================================================

/**
 * Whether a project manifest (.vibecarbon.json) exists in cwd. Callers that
 * need to distinguish "no project here" from "project with defaults" (e.g.
 * deciding whether to lazily persist a generated id) should use this rather
 * than re-deriving the manifest path themselves.
 *
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {boolean}
 */
export function manifestExists(cwd = process.cwd()) {
  return existsSync(join(cwd, '.vibecarbon.json'));
}

/**
 * Load the project manifest (.vibecarbon.json)
 * This tracks which services have been added to the project
 *
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {object} - Manifest object with version and services
 */
export function loadManifest(cwd = process.cwd()) {
  const manifestPath = join(cwd, '.vibecarbon.json');
  if (existsSync(manifestPath)) {
    return JSON.parse(readFileSync(manifestPath, 'utf-8'));
  }
  return { version: '1', services: {} };
}

/**
 * Save the project manifest (.vibecarbon.json)
 *
 * @param {object} manifest - Manifest object to save
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 */
export function saveManifest(manifest, cwd = process.cwd()) {
  const manifestPath = join(cwd, '.vibecarbon.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

// ============================================================================
// ENVIRONMENT FILE MANAGEMENT
// ============================================================================

// Single dotenv parser for the whole codebase — lives beside escapeDotenv/
// unescapeDotenv in shell.js (state machine: multi-line single-quoted,
// legacy double-quoted, bare values). Re-exported here so env-file callers
// can import it from project.js; the parser itself lives in shell.js.
export { parseDotenv };

/**
 * Serialize a key-value object into dotenv format using escapeDotenv
 * (single-quoted, safe for dotenv-package parsers).
 */
export function serializeDotenv(obj) {
  return `${Object.entries(obj)
    .map(([k, v]) => `${k}=${escapeDotenv(v)}`)
    .join('\n')}\n`;
}

/**
 * Load environment variables from .env.local
 *
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {object} - Key-value object of environment variables
 */
export function loadEnvVariables(cwd = process.cwd()) {
  const envPath = join(cwd, '.env.local');
  if (!existsSync(envPath)) return {};
  return parseDotenv(readFileSync(envPath, 'utf-8'));
}

/**
 * Find runtime env keys that would silently miss a deploy: set (non-empty)
 * in `.env.local` but empty or absent in `.env`.
 *
 * `vibecarbon deploy` ships `.env` as the server's runtime baseline
 * (renderBundle, deploy/bundle.js), while `.env.local` never leaves the
 * operator's machine. An operator who hand-edits only `.env.local` (e.g.
 * migrating values from another project instead of running `configure`)
 * deploys a server whose STRIPE_/SMTP_/etc. values are blank — the app comes
 * up healthy and fails only when the feature is exercised ("Billing is not
 * configured", vibecarbon.com 2026-08-22).
 *
 * Operator-secret keys (provider credentials) are excluded: those are
 * `.env.local`-only BY DESIGN (see config-registry.js) and stripped from
 * bundles, so their absence from `.env` is correct, not drift.
 *
 * A key non-empty in BOTH files with different values is NOT reported —
 * `.env` is the deploy baseline and a differing `.env.local` value is a
 * local-dev override, not missing production config.
 *
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {string[]} - Sorted key names, empty when there is no drift
 */
export function findEnvDrift(cwd = process.cwd()) {
  const localPath = join(cwd, '.env.local');
  if (!existsSync(localPath)) return [];
  const local = parseDotenv(readFileSync(localPath, 'utf-8'));
  const envPath = join(cwd, '.env');
  const base = existsSync(envPath) ? parseDotenv(readFileSync(envPath, 'utf-8')) : {};
  const operator = new Set(operatorSecretKeys());
  return Object.keys(local)
    .filter((key) => {
      if (operator.has(key)) return false;
      if (!local[key] || local[key].trim() === '') return false;
      const baseVal = base[key];
      return baseVal === undefined || baseVal.trim() === '';
    })
    .sort();
}

/**
 * Append a section of environment variables to .env.local and .env
 *
 * @param {string} sectionName - Name for the section header (e.g., 'N8N', 'S3 STORAGE')
 * @param {object} envVars - Key-value pairs to add
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 */
export function appendToEnv(sectionName, envVars, cwd = process.cwd()) {
  const envFiles = ['.env.local', '.env'];
  for (const filename of envFiles) {
    const envPath = join(cwd, filename);
    if (!existsSync(envPath)) continue;
    const content = readFileSync(envPath, 'utf-8');
    const sectionHeader = `# ${sectionName.toUpperCase()}`;
    if (content.includes(sectionHeader)) continue;
    const body = Object.entries(envVars)
      .map(([k, v]) => `${k}=${escapeDotenv(v)}`)
      .join('\n');
    const newSection = `\n\n# =============================================================================\n# ${sectionName.toUpperCase()}\n# =============================================================================\n\n${body}\n`;
    writeFileSync(envPath, content.trimEnd() + newSection);
  }
}

/**
 * Set or update a single environment variable in .env.local and .env
 *
 * @param {string} key - Variable name
 * @param {string} value - Variable value
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @param {{localOnly?: boolean}} [opts] - `localOnly: true` writes ONLY
 *   `.env.local`, skipping `.env` entirely. Used for operator-secret
 *   credentials (see config-registry.js's 'operator-secret' class): `.env`
 *   is the server-bundle baseline (bundle.js), so a value written there
 *   would ship to every deployed server. Default behavior (both files) is
 *   unchanged for every other caller. `.env.local` is gitignored, so a
 *   fresh clone never has one — `localOnly` CREATES it (owner-only 0o600,
 *   via writeSecretFile — this file holds provider tokens) rather than
 *   silently skipping, which used to make every save path a no-op on a
 *   fresh checkout while still reporting success. The non-localOnly `.env`
 *   half keeps the skip-if-missing behavior: that file is the server-bundle
 *   baseline the template ships with, never something this function should
 *   originate.
 */
export function setEnvVar(key, value, cwd = process.cwd(), { localOnly = false } = {}) {
  const envFiles = localOnly ? ['.env.local'] : ['.env.local', '.env'];
  for (const filename of envFiles) {
    const envPath = join(cwd, filename);
    if (!existsSync(envPath)) {
      if (localOnly && filename === '.env.local') {
        writeSecretFile(envPath, '# Local-only environment overrides (not committed to git)\n');
      } else {
        continue;
      }
    }
    const content = readFileSync(envPath, 'utf-8');
    // Match either legacy KEY="..." or new KEY='...' forms at line start.
    const regex = new RegExp(`^${key}=(?:"[^"]*"|'(?:[^']|'\\\\'')*')`, 'm');
    const replacement = `${key}=${escapeDotenv(value)}`;
    if (regex.test(content)) {
      writeFileSync(envPath, content.replace(regex, replacement));
    } else {
      writeFileSync(envPath, `${content.trimEnd()}\n${replacement}\n`);
    }
  }
}

// ============================================================================
// OPERATOR ENV BOOTSTRAP
// ============================================================================

// Provenance from the most recent bootstrapOperatorEnv() call: the
// operator-secret keys that were loaded from .env.local (as opposed to
// already present in the shell/CI env). Exposed as module state via
// getBootstrappedKeys() — see that function's doc for why.
let bootstrappedKeys = new Set();

/**
 * Fold operator-secret provider credentials (Hetzner/DigitalOcean/Cloudflare
 * tokens, S3/Spaces keys — see operatorSecretKeys()) from the project's
 * .env.local into process.env, so every existing env-first credential
 * resolution site in the codebase picks them up unchanged.
 *
 * Called once at CLI startup (src/cli.js), before command dispatch.
 *
 * Design:
 * - ALLOWLIST ONLY: only keys in operatorSecretKeys() are ever copied out of
 *   .env.local. App secrets (STRIPE_SECRET_KEY, SMTP_PASS, …) never enter
 *   process.env via this path — that confines the blast radius (this process
 *   and everything it spawns: ssh, pulumi, docker) to exactly the provider
 *   credentials the resolution sites read.
 * - REAL ENV WINS: a key already present in process.env (shell export, CI
 *   secret, a value set earlier this same process) is left untouched — this
 *   loader only fills gaps, never overrides.
 * - A missing .env.local is a no-op. A file that doesn't parse cleanly is
 *   also tolerated: parseDotenv() never throws — lines it can't parse are
 *   simply skipped — so there is nothing further to guard here.
 * - In-process coherence: this function runs once at startup, not on every
 *   read. Any code elsewhere that PROMPTS the operator for one of these
 *   tokens and the operator accepts must set process.env[KEY] itself right
 *   after, so later env-first reads in the same process see the freshly
 *   entered value — this loader does not re-run mid-process.
 *
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {Set<string>} - The operator-secret keys this call populated into
 *   process.env (provenance). Also readable via getBootstrappedKeys().
 */
export function bootstrapOperatorEnv(cwd = process.cwd()) {
  const populated = new Set();
  const fileVars = loadEnvVariables(cwd);
  for (const key of operatorSecretKeys()) {
    if (key in fileVars && !(key in process.env)) {
      process.env[key] = fileVars[key];
      populated.add(key);
    }
  }
  bootstrappedKeys = populated;
  return populated;
}

/**
 * The provenance Set from the most recent bootstrapOperatorEnv() call —
 * lets later code (namely `configure`) distinguish "the operator's shell
 * already had this token exported" from "we loaded it from the project's
 * .env.local just now", without threading the Set through every call site.
 * Empty before bootstrapOperatorEnv() has run.
 *
 * @returns {Set<string>}
 */
export function getBootstrappedKeys() {
  return bootstrappedKeys;
}

// ============================================================================
// GIT ADD ALLOWLIST
// ============================================================================

/**
 * Allowlist of paths that vibecarbon knows are safe to commit.
 * Used by add/deploy/push in place of `git add .` to prevent leaking
 * `.vibecarbon/`, `.env.local`, or other untracked secrets.
 */
const PROJECT_GIT_ADD_ALLOWLIST = [
  // Top-level config
  '.gitignore',
  '.dockerignore',
  '.github/',
  '.claude/',
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  'biome.json',
  'tsconfig.json',
  'tsconfig.server.json',
  'vite.config.ts',
  'components.json',
  // Docker
  'Dockerfile',
  'docker-entrypoint.sh',
  'docker-compose.yml',
  'docker-compose.prod.yml',
  'docker-compose.override.yml',
  'docker-compose.metabase.yml',
  'docker-compose.metabase.prod.yml',
  'docker-compose.metabase.override.yml',
  'docker-compose.n8n.yml',
  'docker-compose.n8n.prod.yml',
  'docker-compose.n8n.override.yml',
  'docker-compose.observability.yml',
  'docker-compose.observability.prod.yml',
  'docker-compose.observability.override.yml',
  // Source
  'src/',
  'scripts/',
  'content/',
  'backup/',
  'ha/',
  'k8s/',
  'supabase/',
  'cloud-init/',
  'volumes/',
  // Docs and metadata
  'README.md',
  'LICENSE',
  'AGENTS.md',
  'CLAUDE.md',
  'DEVELOPMENT.md',
  'PRODUCTION.md',
  'CHANGELOG.md',
];

/**
 * Build a `git add` argv limited to template-known paths that exist.
 * The first 3 tokens ('git', 'add', '--') are always included; the rest
 * are filtered by existsSync so missing optional paths don't error.
 *
 * If NO allowlisted path exists in cwd, the result is ['git', 'add', '--']
 * with no trailing paths — git will exit 0 with a "nothing added" message
 * on stderr. Callers pass silent:true + ignoreError:true to make this a no-op.
 *
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @param {string[]} [extras] - Additional paths to include (also filtered by existsSync)
 * @returns {string[]} argv array safe to pass to runCommand
 */
export function buildGitAddArgv(cwd = process.cwd(), extras = []) {
  const paths = [...PROJECT_GIT_ADD_ALLOWLIST, ...extras].filter((p) => existsSync(join(cwd, p)));
  return ['git', 'add', '--', ...paths];
}

// ============================================================================
// GITIGNORE VALIDATION
// ============================================================================

/**
 * Check that a .gitignore file contains the required security patterns.
 * Returns an array of missing patterns (empty array on success).
 *
 * @param {string} gitignorePath - Absolute path to the .gitignore file
 * @returns {string[]} Array of missing patterns
 */
export function validateGitignore(gitignorePath) {
  let content;
  try {
    content = readFileSync(gitignorePath, 'utf-8');
  } catch {
    return ['.gitignore is missing'];
  }
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const required = [
    '.vibecarbon/',
    '.env',
    '.env.local',
    '.env.*.local',
    '*.pem',
    '*.key',
    '*.tfstate',
    '*.tfstate.*',
  ];
  return required.filter((r) => !lines.includes(r));
}
