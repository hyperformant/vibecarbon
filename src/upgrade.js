/**
 * Vibecarbon Upgrade Command
 * Upgrades infrastructure files in an existing project to match the latest template
 *
 * Usage:
 *   vibecarbon upgrade           # Interactive upgrade
 *   vibecarbon upgrade -dry      # Preview changes without applying
 *   vibecarbon upgrade -force    # Replace all files (creates .upgrade-backup copies)
 *   vibecarbon upgrade -y        # Auto-accept safe replacements, skip merge files
 *   vibecarbon upgrade -h        # Show help
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { runDependencyAudit } from './lib/audit-advisories.js';
import { isBinaryFile } from './lib/binary-files.js';
import { hashContent, hashFile } from './lib/checksum.js';
import { exitCancelled } from './lib/cli/exit-guard.js';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { spinner } from './lib/cli/progress.js';
import { c } from './lib/colors.js';
import { gitSafeEnv, runCommandAsync } from './lib/command.js';
import { resolveDisplayName } from './lib/display-name.js';
import { mergePackageJson } from './lib/merge-package-json.js';
import {
  adaptDockerfileForPackageManager,
  getPackageManagerVersion,
  MIN_PNPM_MAJOR,
  writePnpmWorkspaceSettings,
} from './lib/package-manager.js';
import {
  detectPackageManager,
  loadEnvVariables,
  loadManifest,
  saveManifest,
  setEnvVar,
} from './lib/project.js';
import { assertInProjectDir } from './lib/project-guard.js';
import { generatePassword } from './lib/secrets.js';
import { getFilePolicy, getUpgradeableFiles } from './lib/upgrade-policy.js';
import { VERSION } from './lib/version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATE_DIR = join(__dirname, '..', 'carbon');

// Template variable placeholders (same as create.js)
const PLACEHOLDERS = {
  PROJECT_NAME: '{{PROJECT_NAME}}',
  PROJECT_DISPLAY_NAME: '{{PROJECT_DISPLAY_NAME}}',
  GITHUB_OWNER: '{{GITHUB_OWNER}}',
  DB_PASSWORD: '{{DB_PASSWORD}}',
  JWT_SECRET: '{{JWT_SECRET}}',
  ANON_KEY: '{{ANON_KEY}}',
  SERVICE_ROLE_KEY: '{{SERVICE_ROLE_KEY}}',
  REALTIME_SECRET: '{{REALTIME_SECRET}}',
  LOGFLARE_API_KEY: '{{LOGFLARE_API_KEY}}',
  VAULT_ENC_KEY: '{{VAULT_ENC_KEY}}',
  PG_META_CRYPTO_KEY: '{{PG_META_CRYPTO_KEY}}',
  DB_ENC_KEY: '{{DB_ENC_KEY}}',
  SITE_URL: '{{SITE_URL}}',
  ADMIN_EMAIL: '{{ADMIN_EMAIL}}',
  ADMIN_PASSWORD: '{{ADMIN_PASSWORD}}',
  ADMIN_PASSWORD_HASH: '{{ADMIN_PASSWORD_HASH}}',
};

// Mirrors SECRET_PLACEHOLDERS in src/create.js — placeholders that must never
// be substituted into checked-in files (deploy code patches them at runtime
// from .env.local). Keep in sync with create.js.
const SECRET_PLACEHOLDERS = new Set([
  'DB_PASSWORD',
  'JWT_SECRET',
  'ANON_KEY',
  'SERVICE_ROLE_KEY',
  'REALTIME_SECRET',
  'LOGFLARE_API_KEY',
  'VAULT_ENC_KEY',
  'PG_META_CRYPTO_KEY',
  'DB_ENC_KEY',
  'ADMIN_PASSWORD',
]);

// Files that contain {{PLACEHOLDER}} strings as their own substitution keys
// (not vibecarbon template variables). Must be copied raw without replacement.
const RAW_COPY_FILES = new Set(['scripts/generate-dev-configs.sh']);

// Optional-feature file prefixes — only upgrade these if they already exist in the project.
// These are added by `vibecarbon add` or `vibecarbon deploy`, not during `create`.
const OPTIONAL_FILE_PREFIXES = ['docker-compose.n8n.', 'docker-compose.metabase.'];

// ============================================================================
// COMMAND SPEC — single source of truth for argv parsing AND help output.
// ============================================================================

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'upgrade',
  summary: 'Update infrastructure files to the latest template',
  description: [
    "Compares your project's infrastructure files against the latest template",
    'and applies updates. User source code (src/**, content/**, migrations/**)',
    'is never touched.',
    '',
    'Files are classified into three categories:',
    "  Safe    Auto-replaced if you haven't modified them",
    '  Merge   Always shown for review (docker-compose.yml, package.json, etc.)',
    '  Never   Your code, never touched (src/**, supabase/**, .env, etc.)',
  ].join('\n'),
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
    { name: 'y', boolean: true, description: 'Auto-accept safe replacements, skip merge files' },
    { name: 'dry', boolean: true, description: 'Preview changes without applying' },
    {
      name: 'force',
      boolean: true,
      description: 'Replace all files (creates .upgrade-backup copies)',
    },
  ],
  examples: [
    { command: 'vibecarbon upgrade -dry', description: 'preview what would change' },
    { command: 'vibecarbon upgrade', description: 'interactive upgrade' },
    {
      command: 'vibecarbon upgrade -y',
      description: 'non-interactive: update safe files, skip merge files',
    },
  ],
};

// ============================================================================
// VARIABLE RECONSTRUCTION
// ============================================================================

/**
 * Reconstruct template variables from the project's .env.local
 * Maps environment variable names back to template placeholder names
 *
 * @param {string} cwd - Project directory
 * @returns {object} - Variables keyed by placeholder name (without braces)
 */
/**
 * Regenerate a too-short VAULT_ENC_KEY and WRITE IT BACK to .env.local.
 *
 * Supavisor's Cloak layer uses AES-256-GCM, which rejects any key that is not
 * exactly 32 bytes. `create` before 2026-08 generated 16 chars under a comment
 * claiming "32 hex chars = 16 bytes" — wrong on both counts — so the pooler
 * crash-looped in its tenant seed with "Unknown cipher or invalid key size".
 *
 * #251 fixed `create` and added a heal here, but the heal was INERT: it
 * computed a fresh key inside reconstructVariables, whose only consumer is
 * resolveTemplate — and resolveTemplate skips every key in SECRET_PLACEHOLDERS,
 * VAULT_ENC_KEY among them. Nothing in this file wrote .env.local at all, so
 * the new key was generated, never substituted, never persisted, discarded.
 * Every pre-2026-08 project kept its 16-char key and kept crash-looping;
 * only fresh `create`s were ever fixed. The guard that was supposed to cover
 * it asserted SOURCE TEXT via regex, so it passed against the dead code.
 *
 * Safe to rotate: nothing durable is encrypted under the old key. The pooler
 * tenant is re-seeded at container boot, and it never successfully seeded under
 * a short key in the first place.
 *
 * @param {string} cwd
 * @returns {boolean} true when a key was regenerated
 */
export function healShortVaultEncKey(cwd) {
  const current = loadEnvVariables(cwd).VAULT_ENC_KEY || '';
  if (current.length >= 32) return false;
  setEnvVar('VAULT_ENC_KEY', generatePassword(32), cwd, { localOnly: true });
  return true;
}

function reconstructVariables(cwd) {
  // Runs BEFORE the env is read below, so the reconstructed variables (and any
  // template rendered from them) see the healed value rather than the short one.
  healShortVaultEncKey(cwd);
  const env = loadEnvVariables(cwd);
  const manifest = loadManifest(cwd);

  const variables = {
    PROJECT_NAME: env.PROJECT_NAME || env.VITE_PROJECT_NAME || '',
    // Projects created before PROJECT_DISPLAY_NAME existed have no record of
    // it; resolveDisplayName falls back to titleizing the slug.
    PROJECT_DISPLAY_NAME: resolveDisplayName(env),
    GITHUB_OWNER: manifest.services?.cicd?.owner || env.PROJECT_NAME || '',
    DB_PASSWORD: env.DB_PASSWORD || env.POSTGRES_PASSWORD || '',
    JWT_SECRET: env.JWT_SECRET || '',
    ANON_KEY: env.SUPABASE_ANON_KEY || '',
    SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY || '',
    REALTIME_SECRET: env.REALTIME_SECRET || env.SECRET_KEY_BASE || '',
    LOGFLARE_API_KEY: env.LOGFLARE_API_KEY || '',
    // Must be exactly 32 bytes (Supavisor's Cloak AES-256-GCM rejects other
    // sizes). See healShortVaultEncKey — the heal PERSISTS to .env.local before
    // this runs, so by here env.VAULT_ENC_KEY is already the healed value.
    VAULT_ENC_KEY: env.VAULT_ENC_KEY || '',
    PG_META_CRYPTO_KEY: env.PG_META_CRYPTO_KEY || '',
    DB_ENC_KEY: (env.DB_ENC_KEY || '').slice(0, 16), // Realtime aes_128_ecb requires exactly 16 bytes
    SITE_URL: env.SITE_URL || 'http://localhost:5173',
    ADMIN_EMAIL: env.ADMIN_EMAIL || '',
    ADMIN_PASSWORD: env.ADMIN_PASSWORD || '',
    // ADMIN_PASSWORD_HASH can't be reconstructed, but only appears in NEVER files
    ADMIN_PASSWORD_HASH: '',
  };

  return variables;
}

// ============================================================================
// TEMPLATE RESOLUTION
// ============================================================================

/**
 * Read a template file and apply placeholder replacement
 *
 * @param {string} templateRelPath - Relative path within TEMPLATE_DIR
 * @param {object} variables - Template variables
 * @returns {string} - Resolved content
 */
function resolveTemplate(templateRelPath, variables) {
  const fullPath = join(TEMPLATE_DIR, templateRelPath);
  let content = readFileSync(fullPath, 'utf-8');

  for (const [key, placeholder] of Object.entries(PLACEHOLDERS)) {
    if (SECRET_PLACEHOLDERS.has(key)) continue;
    if (variables[key] !== undefined && variables[key] !== '') {
      // Function replacement: a plain string here would expand $-patterns ($&, $`)
      content = content.replaceAll(placeholder, () => variables[key]);
    }
  }

  return content;
}

// ============================================================================
// DIFF DISPLAY
// ============================================================================

/**
 * Generate a simple unified-style diff between two strings
 * Shows only changed lines with context
 *
 * @param {string} oldContent
 * @param {string} newContent
 * @returns {string}
 */
function simpleDiff(oldContent, newContent) {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const output = [];
  const maxLines = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine === undefined) {
      output.push(c.success(`+ ${newLine}`));
    } else if (newLine === undefined) {
      output.push(c.error(`- ${oldLine}`));
    } else if (oldLine !== newLine) {
      output.push(c.error(`- ${oldLine}`));
      output.push(c.success(`+ ${newLine}`));
    }
  }

  // Limit output to avoid flooding terminal
  if (output.length > 40) {
    return `${output.slice(0, 40).join('\n')}\n${c.dim(`... and ${output.length - 40} more lines`)}`;
  }

  return output.join('\n');
}

// ============================================================================
// MAIN UPGRADE LOGIC
// ============================================================================

async function main(cliArgs) {
  const { values, handled } = parseFlagsOrExit(cliArgs, SPEC);
  if (handled) return;

  // Build the legacy `args` shape that the orchestration code reads.
  // dryRun (camelCase) is the historical name; preserve it.
  const args = {
    dryRun: !!values.dry,
    force: !!values.force,
    yes: !!values.y,
  };

  // Detect project
  assertInProjectDir();

  const cwd = process.cwd();
  const manifest = loadManifest(cwd);
  const currentTemplateVersion = manifest.templateVersion || '0.0.0';
  const storedChecksums = manifest.fileChecksums || {};
  const isBootstrap = currentTemplateVersion === '0.0.0';

  introCommand('upgrade');

  if (isBootstrap) {
    p.log.info(
      `First upgrade; no stored checksums found. Files will be compared against the current template.`,
    );
  } else {
    p.log.info(`Template: ${c.dim(currentTemplateVersion)} → ${c.bold(VERSION)}`);
  }

  // Warn about dirty git state
  try {
    const { execFileSync } = await import('node:child_process');
    const gitStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      // Reading the HOST repo here would report clean and drop the only guard
      // before upgrade rewrites the project's template files. See gitSafeEnv.
      env: gitSafeEnv(),
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (gitStatus) {
      p.log.warn(
        'You have uncommitted changes. Consider committing first so the upgrade is easily revertable.',
      );
    }
  } catch {
    // Not a git repo or git not available — no warning needed
  }

  // Warn about running containers
  try {
    const { execFileSync } = await import('node:child_process');
    const ps = execFileSync('docker', ['compose', 'ps', '--format', 'json'], {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    if (ps) {
      p.log.warn(
        `Docker containers are running. Consider running ${c.info('vibecarbon down')} first.`,
      );
    }
  } catch {
    // Docker not available or not running — fine
  }

  // Reconstruct template variables
  const s = spinner();
  s.start('Scanning infrastructure files');

  const variables = reconstructVariables(cwd);
  const upgradeableFiles = getUpgradeableFiles(TEMPLATE_DIR);

  // Classify each file
  const autoUpdated = []; // { path, reason: 'updated' | 'added' }
  const unchanged = []; // files with no diff
  const needsReview = []; // { path, oldContent, newContent }

  for (const relPath of upgradeableFiles) {
    const policy = getFilePolicy(relPath);
    const projectFilePath = join(cwd, relPath);
    const templateFilePath = join(TEMPLATE_DIR, relPath);
    const fileExists = existsSync(projectFilePath);

    // Skip optional-feature files that don't exist in the project yet.
    // These are added by `vibecarbon add` or `vibecarbon deploy`, not during upgrade.
    if (!fileExists && OPTIONAL_FILE_PREFIXES.some((prefix) => relPath.startsWith(prefix))) {
      continue;
    }

    // Handle binary files
    if (isBinaryFile(relPath)) {
      if (policy === 'safe' && !fileExists) {
        autoUpdated.push({ path: relPath, reason: 'added' });
        if (!args.dryRun) {
          mkdirSync(dirname(projectFilePath), { recursive: true });
          copyFileSync(templateFilePath, projectFilePath);
        }
      }
      continue;
    }

    // Resolve template with variables (or raw-copy for files with their own {{PLACEHOLDER}} tokens)
    let newContent;
    try {
      if (RAW_COPY_FILES.has(relPath)) {
        newContent = readFileSync(join(TEMPLATE_DIR, relPath), 'utf-8');
      } else {
        newContent = resolveTemplate(relPath, variables);
      }
    } catch {
      // Template file can't be read — skip
      continue;
    }

    // Smart-merge package.json: update template dep versions, add new template deps,
    // preserve user-added deps and fields, merge pnpm config (overrides, etc.)
    if (relPath === 'package.json') {
      try {
        const pm = detectPackageManager(cwd);
        const templatePkg = JSON.parse(newContent);
        const userPkg = fileExists ? JSON.parse(readFileSync(projectFilePath, 'utf-8')) : {};

        const merged = fileExists ? mergePackageJson(userPkg, templatePkg) : templatePkg;

        if (variables.PROJECT_NAME) merged.name = variables.PROJECT_NAME;
        // Mirrors create.js: npm projects carry no `packageManager` pin (npm
        // ships with Node), pnpm/bun projects do.
        //
        // The pin's SOURCE moved with the template migration. It used to be
        // single-sourced from carbon/package.json and upgrade re-took it (PR
        // #213); the npm-based template carries no pin at all, so the host's
        // installed version is now the only thing to pin to — and it is also
        // the version that regenerates the lockfile at the end of this run, so
        // pin, lockfile, and pnpm config still travel together. What does NOT
        // change is PR #214's rule: never move the pin silently. The old value
        // also survives in the package.json.upgrade-backup sidecar.
        const pinBefore = merged.packageManager;
        if (pm === 'npm') {
          delete merged.packageManager;
        } else {
          merged.packageManager = getPackageManagerVersion(pm);
        }
        if (pinBefore !== merged.packageManager) {
          p.log.info(
            `package.json packageManager: ${pinBefore ?? '(none)'} → ${merged.packageManager ?? '(none)'} ` +
              (pm === 'npm'
                ? '(npm projects carry no pin, npm ships with Node; previous value is in ' +
                  'package.json.upgrade-backup)'
                : `(host ${pm} pin, version, lockfile, and config travel together; ` +
                  'previous value is in package.json.upgrade-backup)'),
          );
        }
        if (pm !== 'npm' && merged.scripts) {
          const run = pm === 'pnpm' ? 'pnpm' : 'bun run';
          for (const [key, value] of Object.entries(merged.scripts)) {
            if (typeof value === 'string' && value.includes('npm run ')) {
              merged.scripts[key] = value.replaceAll('npm run ', `${run} `);
            }
          }
        }
        newContent = `${JSON.stringify(merged, null, 2)}\n`;
      } catch {
        // If merge fails, use the raw resolved template content
      }
    }

    const newHash = hashContent(newContent);

    if (!fileExists) {
      // New file in template — add it
      if (policy === 'safe') {
        autoUpdated.push({ path: relPath, reason: 'added' });
        if (!args.dryRun) {
          mkdirSync(dirname(projectFilePath), { recursive: true });
          writeFileSync(projectFilePath, newContent);
          if (relPath.endsWith('.sh')) chmodSync(projectFilePath, 0o755);
        }
      } else if (policy === 'merge') {
        needsReview.push({ path: relPath, oldContent: null, newContent, reason: 'new' });
      }
      continue;
    }

    // File exists — compare
    const currentContent = readFileSync(projectFilePath, 'utf-8');
    const currentHash = hashContent(currentContent);

    // No change needed
    if (currentHash === newHash) {
      unchanged.push(relPath);
      continue;
    }

    const storedHash = storedChecksums[relPath];
    const userModified = storedHash ? currentHash !== storedHash : true;

    if (args.force) {
      // Force mode: replace everything, backup modified files
      if (userModified) {
        if (!args.dryRun) {
          writeFileSync(`${projectFilePath}.upgrade-backup`, currentContent);
        }
      }
      autoUpdated.push({ path: relPath, reason: 'updated' });
      if (!args.dryRun) {
        writeFileSync(projectFilePath, newContent);
        if (relPath.endsWith('.sh')) chmodSync(projectFilePath, 0o755);
      }
      continue;
    }

    if (policy === 'safe') {
      if (!userModified) {
        // Not modified by user — safe to auto-replace
        autoUpdated.push({ path: relPath, reason: 'updated' });
        if (!args.dryRun) {
          writeFileSync(projectFilePath, newContent);
          if (relPath.endsWith('.sh')) chmodSync(projectFilePath, 0o755);
        }
      } else if (isBootstrap) {
        // Bootstrap: can't tell if user modified — compare with template
        // If the current content differs, prompt for safe files too
        needsReview.push({
          path: relPath,
          oldContent: currentContent,
          newContent,
          reason: 'unknown',
        });
      } else {
        // User modified a safe file — still needs review
        needsReview.push({
          path: relPath,
          oldContent: currentContent,
          newContent,
          reason: 'modified',
        });
      }
    } else if (policy === 'merge') {
      // Merge files always need review
      needsReview.push({
        path: relPath,
        oldContent: currentContent,
        newContent,
        reason: 'modified',
      });
    }
  }

  s.stop('Scan complete');

  // Display results
  if (autoUpdated.length > 0) {
    p.log.success(`${c.bold('AUTO-UPDATED')} (unmodified by you):`);
    for (const { path: filePath, reason } of autoUpdated) {
      const icon = reason === 'added' ? '+' : '\u2713';
      console.log(`  ${c.success(icon)} ${filePath}${args.dryRun ? c.dim(' (dry run)') : ''}`);
    }
  }

  if (unchanged.length > 0) {
    p.log.info(`${unchanged.length} files already up to date`);
  }

  // Handle files that need review
  let reviewedCount = 0;
  let skippedReviewCount = 0;
  let packageJsonUpdated = autoUpdated.some((f) => f.path === 'package.json');

  if (needsReview.length > 0 && !args.dryRun) {
    if (args.yes) {
      // Non-interactive: skip all merge/review files
      p.log.info(`${needsReview.length} files need review: skipped (non-interactive mode)`);
      for (const { path: filePath, newContent } of needsReview) {
        const projectFilePath = join(cwd, filePath);
        mkdirSync(dirname(projectFilePath), { recursive: true });
        writeFileSync(`${projectFilePath}.upgrade-new`, newContent);
      }
      p.log.info(
        `New versions saved as ${c.info('.upgrade-new')} files. Review and apply manually.`,
      );
      skippedReviewCount = needsReview.length;
    } else {
      // Interactive: prompt for each file
      p.log.step(`${c.bold('NEEDS REVIEW')} (${needsReview.length} files):`);

      for (const { path: filePath, oldContent, newContent, reason } of needsReview) {
        const projectFilePath = join(cwd, filePath);
        const reasonText =
          reason === 'new'
            ? c.info('new in template')
            : reason === 'unknown'
              ? c.dim('no stored checksum')
              : c.dim('you modified this');

        const action = await p.select({
          message: `${filePath} (${reasonText})`,
          options: [
            { value: 'diff', label: 'View diff first' },
            { value: 'replace', label: 'Replace (backup as .upgrade-backup)' },
            { value: 'new', label: 'Save new version as .upgrade-new' },
            { value: 'skip', label: 'Skip' },
          ],
          // Default to replace (matching the post-diff re-prompt): enter-through
          // applies the upgrade with a .upgrade-backup escape hatch, instead of
          // stranding improvements in .upgrade-new files nobody renames.
          initialValue: 'replace',
        });

        if (p.isCancel(action)) {
          exitCancelled();
        }

        if (action === 'diff') {
          // Show diff, then re-prompt
          if (oldContent) {
            console.log(`\n${c.dim(`--- ${filePath} (current)`)}`);
            console.log(`${c.dim(`+++ ${filePath} (template)`)}`);
            console.log(simpleDiff(oldContent, newContent));
            console.log();
          } else {
            console.log(`\n${c.dim('(new file)')}`);
            const preview = newContent.split('\n').slice(0, 20).join('\n');
            console.log(preview);
            if (newContent.split('\n').length > 20) {
              console.log(c.dim(`... ${newContent.split('\n').length - 20} more lines`));
            }
            console.log();
          }

          // Re-prompt after viewing diff
          const action2 = await p.select({
            message: `${filePath}`,
            options: [
              { value: 'replace', label: 'Replace (backup as .upgrade-backup)' },
              { value: 'new', label: 'Save new version as .upgrade-new' },
              { value: 'skip', label: 'Skip' },
            ],
            initialValue: 'replace',
          });

          if (p.isCancel(action2)) {
            exitCancelled();
          }

          if (action2 === 'replace') {
            if (oldContent) writeFileSync(`${projectFilePath}.upgrade-backup`, oldContent);
            mkdirSync(dirname(projectFilePath), { recursive: true });
            writeFileSync(projectFilePath, newContent);
            if (filePath.endsWith('.sh')) chmodSync(projectFilePath, 0o755);
            if (filePath === 'package.json') packageJsonUpdated = true;
            reviewedCount++;
          } else if (action2 === 'new') {
            mkdirSync(dirname(projectFilePath), { recursive: true });
            writeFileSync(`${projectFilePath}.upgrade-new`, newContent);
            skippedReviewCount++;
          } else {
            skippedReviewCount++;
          }
        } else if (action === 'replace') {
          if (oldContent) writeFileSync(`${projectFilePath}.upgrade-backup`, oldContent);
          mkdirSync(dirname(projectFilePath), { recursive: true });
          writeFileSync(projectFilePath, newContent);
          if (filePath.endsWith('.sh')) chmodSync(projectFilePath, 0o755);
          if (filePath === 'package.json') packageJsonUpdated = true;
          reviewedCount++;
        } else if (action === 'new') {
          mkdirSync(dirname(projectFilePath), { recursive: true });
          writeFileSync(`${projectFilePath}.upgrade-new`, newContent);
          skippedReviewCount++;
        } else {
          skippedReviewCount++;
        }
      }
    }
  } else if (needsReview.length > 0 && args.dryRun) {
    p.log.step(`${c.bold('NEEDS REVIEW')} (${needsReview.length} files):`);
    for (const { path: filePath, reason } of needsReview) {
      const reasonText =
        reason === 'new'
          ? 'new in template'
          : reason === 'unknown'
            ? 'no stored checksum'
            : 'modified by you';
      console.log(`  ${c.dim('?')} ${filePath} ${c.dim(`(${reasonText})`)}`);
    }
  }

  // Re-apply package manager adaptations to upgraded files.
  // The template is always npm-based; pnpm/bun projects need re-adaptation.
  if (!args.dryRun) {
    const pm = detectPackageManager(cwd);
    if (pm !== 'npm') {
      adaptDockerfileForPackageManager(cwd, pm);
    }
    // SECURITY: the upgraded package.json carries the template's `pnpm` block,
    // which pnpm 11 ignores outright. Re-migrate it to pnpm-workspace.yaml or
    // the upgrade would quietly strip an existing project's dependency-security
    // floors. Idempotent, so it is safe to run on every upgrade.
    if (pm === 'pnpm') {
      // ...but only where the destination is actually read. `create` refuses
      // pnpm < MIN_PNPM_MAJOR outright; `upgrade` cannot — the project already
      // exists and the pins are already working, because the `pnpm` block in
      // package.json IS the location an old pnpm reads. Moving them would be
      // the silent strip this migration exists to prevent, just aimed at a
      // different pnpm. So leave them where they work and say why.
      const hostPnpm = getPackageManagerVersion('pnpm').split('@')[1] ?? '';
      const hostMajor = Number.parseInt(hostPnpm.split('.')[0], 10);
      if (Number.isFinite(hostMajor) && hostMajor < MIN_PNPM_MAJOR) {
        p.log.warn(
          `pnpm ${hostPnpm} reads dependency settings from package.json, not pnpm-workspace.yaml, ` +
            `so the \`pnpm\` block was left in place. Upgrade to pnpm ${MIN_PNPM_MAJOR}+ ` +
            '(`npm install -g pnpm@latest`) — pnpm 11 ignores that block entirely and would ' +
            "resolve without this project's dependency-security floors.",
        );
      } else {
        writePnpmWorkspaceSettings(cwd, { warn: (message) => p.log.warn(message) });
      }
    }
  }

  // Regenerate the lockfile so it stays in sync with the updated package.json.
  // Without this, `--frozen-lockfile` in the Dockerfile will fail on deploy.
  if (!args.dryRun && packageJsonUpdated) {
    const pm = detectPackageManager(cwd);
    const installCmd = {
      npm: ['npm', 'install'],
      pnpm: ['pnpm', 'install'],
      bun: ['bun', 'install'],
    }[pm] || ['npm', 'install'];

    const s2 = spinner();
    s2.start('Regenerating lockfile…');
    try {
      // cleanEnv: a wrapper package manager's injected npm_config_* would
      // otherwise reach this install — see PM_RUN_CONTEXT_RE in lib/command.js.
      await runCommandAsync(installCmd, { cwd, silent: true, cleanEnv: true });
      s2.stop(`${c.success('✓')} Lockfile updated`);
    } catch {
      s2.stop('');
      p.log.warn('Failed to regenerate lockfile; run install manually before deploying');
    }
  }

  // Non-fatal dependency advisory check: the upgrade just merged the
  // template's security floors into the user's dependency set — surface any
  // KNOWN CVEs remaining in the result while the operator is already
  // touching versions. Never blocks the upgrade (offline / missing lockfile
  // / unsupported pm degrade to a note).
  if (!args.dryRun) {
    const pm = detectPackageManager(cwd);
    const s3 = spinner();
    s3.start('Checking dependency advisories…');
    const audit = runDependencyAudit(pm, cwd);
    if (audit.status === 'ok') {
      const { critical, high, total } = audit.summary;
      if (critical + high > 0) {
        s3.stop(
          `${c.warning('!')} ${critical} critical / ${high} high dependency advisories (${total} total)`,
        );
        p.log.warn(
          `Run \`${pm} audit\` for details. Template security floors land via package.json overrides, if an advisory has no floor yet, report it upstream.`,
        );
      } else if (total > 0) {
        s3.stop(`${c.success('✓')} No high/critical advisories (${total} lower-severity known)`);
      } else {
        s3.stop(`${c.success('✓')} No known dependency advisories`);
      }
    } else if (audit.status === 'unsupported') {
      s3.stop(`Advisory check not available for ${pm}; run \`${pm} audit\` manually`);
    } else {
      s3.stop('Advisory check skipped (offline or no lockfile)');
    }
  }

  // Update manifest with new checksums and template version (unless dry run)
  if (!args.dryRun) {
    const newChecksums = {};

    // Recompute checksums for all upgradeable files that now exist
    for (const relPath of upgradeableFiles) {
      if (isBinaryFile(relPath)) continue;
      const projectFilePath = join(cwd, relPath);
      if (existsSync(projectFilePath)) {
        try {
          newChecksums[relPath] = hashFile(projectFilePath);
        } catch {
          // Skip files that can't be read
        }
      }
    }

    manifest.templateVersion = VERSION;
    manifest.fileChecksums = newChecksums;
    saveManifest(manifest, cwd);
  }

  // Summary
  const totalUpdated = autoUpdated.length + reviewedCount;
  const totalReview = skippedReviewCount;

  if (args.dryRun) {
    p.outro(
      `Dry run complete, ${autoUpdated.length} would update, ${needsReview.length} need review, ${unchanged.length} unchanged`,
    );
  } else {
    // Single line: clack renders only the first outro line inside the frame —
    // a \n continuation prints below the `└` unaligned.
    p.outro(
      `Upgrade complete (${totalUpdated} updated, ${totalReview} need review, ${unchanged.length} unchanged), template ${currentTemplateVersion} → ${VERSION}`,
    );
  }
}

export async function run(args) {
  await main(args);
}

// ============================================================================
// EXPORTS FOR TESTING
// ============================================================================

export { SPEC };
