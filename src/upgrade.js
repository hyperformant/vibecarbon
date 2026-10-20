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
import { parseDotenv } from './lib/dotenv.js';
import { localComposeEnv, resolveDbImage } from './lib/images.js';
import { mergePackageJson } from './lib/merge-package-json.js';
import {
  adaptDockerfileForPackageManager,
  getPackageManagerVersion,
  MIN_PNPM_MAJOR,
  seedLockfileFromTemplate,
  writePnpmWorkspaceSettings,
} from './lib/package-manager.js';
import {
  detectPackageManager,
  loadEnvVariables,
  loadManifest,
  repairLegacyEnvQuoting,
  saveManifest,
  setEnvVar,
} from './lib/project.js';
import { assertInProjectDir } from './lib/project-guard.js';
import { generatePassword } from './lib/secrets.js';
import { templatePathFor } from './lib/template-paths.js';
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
  SITE_URL: '{{SITE_URL}}',
  ADMIN_EMAIL: '{{ADMIN_EMAIL}}',
  ADMIN_PASSWORD: '{{ADMIN_PASSWORD}}',
};

// Mirrors SECRET_PLACEHOLDERS in src/create.js — placeholders that must never
// be substituted into checked-in files (deploy code patches them at runtime
// from .env.local). Keep in sync with create.js.
const SECRET_PLACEHOLDERS = new Set(['DB_PASSWORD', 'ADMIN_PASSWORD']);

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
  summary: 'Upgrade infrastructure files to the latest template',
  description: [
    "Compares your project's infrastructure files against the latest template",
    'and applies updates. User source code (src/**, content/**, migrations/**)',
    'is never touched.',
    '',
    'Files are classified into three categories:',
    "  Safe    Auto-replaced if you haven't modified them",
    '  Merge   Always shown for review (docker-compose.yml, package.json, etc.)',
    '  Never   Your code, never touched (src/**, db/migrations/**, .env, etc.)',
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
 * Give a project created before auth moved into the app the session signing
 * key it now needs. The app refuses to start in production without
 * BETTER_AUTH_SECRET (docker-compose.prod.yml `:?`, env.ts min 32), so an
 * upgraded project that lacks one could not deploy. Checks BOTH .env.local
 * (local dev) and .env (the file a deploy ships): a valid key in either is
 * copied to the other, never rotated (that would sign everyone out);
 * otherwise a new one is generated. Generating is safe: no session exists
 * that was signed with anything else.
 *
 * @param {string} cwd
 * @param {{dryRun?: boolean}} [opts]
 * @returns {'generated' | 'copied' | null} what was (or, under -dry, would
 *   be) written: a new key ('generated', the sign the project predates
 *   in-app auth), a valid key copied to the file that lacked it ('copied'),
 *   or nothing (null)
 */
export function ensureBetterAuthSecret(cwd, { dryRun = false } = {}) {
  const valid = (v) => typeof v === 'string' && v.length >= 32;
  const local = loadEnvVariables(cwd).BETTER_AUTH_SECRET;
  const basePath = join(cwd, '.env');
  const hasBase = existsSync(basePath);
  const base = hasBase
    ? parseDotenv(readFileSync(basePath, 'utf-8')).BETTER_AUTH_SECRET
    : undefined;
  if (valid(local) && (!hasBase || valid(base))) return null;
  const existing = valid(local) ? local : valid(base) ? base : null;
  if (!dryRun) setEnvVar('BETTER_AUTH_SECRET', existing ?? generatePassword(64), cwd);
  return existing ? 'copied' : 'generated';
}

/**
 * Give a project created before the app had its own database role the
 * password for it, APP_DB_PASSWORD. The app now connects as `app_service`
 * (never as the owner), and compose refuses to start without the password
 * (`:?`). Checks BOTH .env.local and .env, like ensureBetterAuthSecret: a
 * value in either is copied to the other, never rotated; otherwise a new one
 * is generated. Generating is safe: the migrate step sets the role's
 * password from it on every run (locally `npm run db:migrate`, on a server
 * the next deploy). Values are never printed.
 *
 * @param {string} cwd
 * @param {{dryRun?: boolean}} [opts]
 * @returns {'generated' | 'copied' | null}
 */
export function ensureAppDbPassword(cwd, { dryRun = false } = {}) {
  const local = loadEnvVariables(cwd).APP_DB_PASSWORD;
  const basePath = join(cwd, '.env');
  const hasBase = existsSync(basePath);
  const base = hasBase ? parseDotenv(readFileSync(basePath, 'utf-8')).APP_DB_PASSWORD : undefined;
  if (local && (!hasBase || base)) return null;
  const existing = local || base || null;
  if (!dryRun) setEnvVar('APP_DB_PASSWORD', existing ?? generatePassword(), cwd);
  return existing ? 'copied' : 'generated';
}

/**
 * Give every installed add-on the generated secrets its manifest declares
 * (`envVars` with `generate: 'password'`, services/<name>/manifest.json),
 * when the project lacks them. `vibecarbon add` generates them once; a
 * project that added the add-on before the secret existed (Metabase's and
 * n8n's own database passwords, METABASE_DB_PASSWORD / N8N_DB_PASSWORD)
 * would otherwise fail compose's `:?` check and could not start it. Checks
 * BOTH .env.local and .env, like ensureBetterAuthSecret: a value in either is
 * copied to the other, never rotated; otherwise a new one is generated.
 * Values are never printed. Only add-ons listed in .vibecarbon.json count,
 * read from the CLI's bundled services/.
 *
 * @param {string} cwd
 * @param {{dryRun?: boolean, servicesDir?: string}} [opts]
 * @returns {{key: string, status: 'generated' | 'copied'}[]} what was (or,
 *   under -dry, would be) written
 */
export function ensureAddonSecrets(
  cwd,
  { dryRun = false, servicesDir = join(__dirname, '..', 'services') } = {},
) {
  const services = Object.keys(loadManifest(cwd).services ?? {});
  if (services.length === 0) return [];
  const local = loadEnvVariables(cwd);
  const basePath = join(cwd, '.env');
  const base = existsSync(basePath) ? parseDotenv(readFileSync(basePath, 'utf-8')) : null;
  const written = [];
  for (const name of services.sort()) {
    const svcManifest = join(servicesDir, name, 'manifest.json');
    if (!existsSync(svcManifest)) continue;
    const envVars = JSON.parse(readFileSync(svcManifest, 'utf-8')).envVars ?? {};
    for (const [key, config] of Object.entries(envVars)) {
      if (config?.generate !== 'password') continue;
      const inLocal = local[key] || '';
      const inBase = base ? base[key] || '' : inLocal;
      if (inLocal && inBase) continue;
      const existing = inLocal || inBase;
      if (!dryRun) setEnvVar(key, existing || generatePassword(config.length || 24), cwd);
      written.push({ key, status: existing ? 'copied' : 'generated' });
    }
  }
  return written;
}

/**
 * Point the project's .env files at this CLI's database image.
 * docker-compose.yml pulls `${DB_IMAGE}:${DB_IMAGE_TAG}`, so the upgraded
 * template files and the image they run on move together. A project created
 * before the image was pulled has neither key and could not start its db.
 *
 * @param {string} cwd
 * @param {{dryRun?: boolean}} [opts]
 * @returns {boolean} whether either file was (or, under -dry, would be) changed
 */
export function ensureDbImageEnv(cwd, { dryRun = false } = {}) {
  const { image, tag } = resolveDbImage();
  const want = { DB_IMAGE: image, DB_IMAGE_TAG: tag };
  let changed = false;
  for (const file of ['.env.local', '.env']) {
    const path = join(cwd, file);
    if (!existsSync(path)) continue;
    const env = parseDotenv(readFileSync(path, 'utf-8'));
    if (Object.entries(want).some(([k, v]) => env[k] !== v)) changed = true;
  }
  if (changed && !dryRun) {
    for (const [k, v] of Object.entries(want)) setEnvVar(k, v, cwd);
  }
  return changed;
}

/**
 * What `upgrade` tells the user about BETTER_AUTH_SECRET. A generated key
 * means the project predates in-app auth, and a database a server already
 * runs for it can't carry over: sign-in accounts lived in the old auth
 * service and are not migrated, and the old tables' user foreign keys still
 * point at its schema. So that case also warns, with the commands that get
 * a fresh database.
 *
 * @param {'generated' | 'copied' | null} status from ensureBetterAuthSecret
 * @param {{dryRun?: boolean}} [opts]
 * @returns {{info?: string, warn?: string}}
 */
export function betterAuthUpgradeNotes(status, { dryRun = false } = {}) {
  if (!status) return {};
  if (status === 'copied') {
    return {
      info: dryRun
        ? 'Would copy BETTER_AUTH_SECRET into the .env file that lacks it'
        : 'Copied BETTER_AUTH_SECRET into the .env file that lacked it, so local dev and deploys sign sessions with the same key',
    };
  }
  return {
    info: dryRun
      ? 'Would add BETTER_AUTH_SECRET (the app now signs its own sessions)'
      : 'Added BETTER_AUTH_SECRET to .env.local and .env (the app now signs its own sessions)',
    warn:
      'Sign-in now runs inside your app, so a server you already deployed needs a fresh database. ' +
      'Accounts are not carried over, and the old tables still point at the previous auth service. ' +
      'To keep a copy of the old data, run `vibecarbon backup` first. ' +
      'Then `vibecarbon destroy` and `vibecarbon deploy` give you a fresh one. ' +
      'Locally, `vibecarbon down` and say yes to deleting the data volumes, then start again.',
  };
}

/**
 * Reconstruct template variables from the project's .env.local
 * Maps environment variable names back to template placeholder names
 *
 * @param {string} cwd - Project directory
 * @returns {object} - Variables keyed by placeholder name (without braces)
 */
function reconstructVariables(cwd, { dryRun = false } = {}) {
  // Runs BEFORE the env is read below, so the reconstructed variables (and any
  // template rendered from them) see the repaired values. Same hook
  // configure/deploy/scale run at entry (project.js); under `-dry` it reports
  // what it would re-encode and writes nothing.
  repairLegacyEnvQuoting(cwd, { dryRun });
  const authNotes = betterAuthUpgradeNotes(ensureBetterAuthSecret(cwd, { dryRun }), { dryRun });
  if (authNotes.info) p.log.info(authNotes.info);
  if (authNotes.warn) p.log.warn(authNotes.warn);
  const appDb = ensureAppDbPassword(cwd, { dryRun });
  if (appDb) {
    p.log.info(
      `${dryRun ? 'Would set' : appDb === 'generated' ? 'Generated' : 'Copied'} APP_DB_PASSWORD in .env and .env.local` +
        (appDb === 'generated'
          ? ': the app now connects as its own database role, app_service. Run `npm run db:migrate` (or `vibecarbon up`) so the role gets it; a server gets it on the next deploy'
          : ''),
    );
  }
  for (const { key, status } of ensureAddonSecrets(cwd, { dryRun })) {
    const verb = status === 'generated' ? 'Generated' : 'Copied';
    p.log.info(
      `${dryRun ? `Would set` : verb} ${key} in .env and .env.local` +
        (status === 'generated'
          ? ': restart the stack so the add-on role gets it (`vibecarbon up`; on a server, set it with \\password, see docs/security.md)'
          : ''),
    );
  }
  if (ensureDbImageEnv(cwd, { dryRun })) {
    const { ref } = resolveDbImage();
    p.log.info(
      dryRun
        ? `Would set the database image to ${ref} in .env and .env.local`
        : `Set the database image to ${ref} in .env and .env.local`,
    );
  }
  const env = loadEnvVariables(cwd);
  const manifest = loadManifest(cwd);

  const variables = {
    PROJECT_NAME: env.PROJECT_NAME || env.VITE_PROJECT_NAME || '',
    // Projects created before PROJECT_DISPLAY_NAME existed have no record of
    // it; resolveDisplayName falls back to titleizing the slug.
    PROJECT_DISPLAY_NAME: resolveDisplayName(env),
    GITHUB_OWNER: manifest.services?.cicd?.owner || env.PROJECT_NAME || '',
    DB_PASSWORD: env.DB_PASSWORD || env.POSTGRES_PASSWORD || '',
    SITE_URL: env.SITE_URL || 'http://localhost:5173',
    ADMIN_EMAIL: env.ADMIN_EMAIL || '',
    ADMIN_PASSWORD: env.ADMIN_PASSWORD || '',
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
  const fullPath = join(TEMPLATE_DIR, templatePathFor(templateRelPath));
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
      env: localComposeEnv(),
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

  const variables = reconstructVariables(cwd, { dryRun: args.dryRun });
  const upgradeableFiles = getUpgradeableFiles(TEMPLATE_DIR);

  // Classify each file
  const autoUpdated = []; // { path, reason: 'updated' | 'added' }
  const unchanged = []; // files with no diff
  const needsReview = []; // { path, oldContent, newContent }

  for (const relPath of upgradeableFiles) {
    const policy = getFilePolicy(relPath);
    const projectFilePath = join(cwd, relPath);
    const templateFilePath = join(TEMPLATE_DIR, templatePathFor(relPath));
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
        newContent = readFileSync(join(TEMPLATE_DIR, templatePathFor(relPath)), 'utf-8');
      } else {
        newContent = resolveTemplate(relPath, variables);
      }
    } catch {
      // Template file can't be read — skip
      continue;
    }

    // carbon/biome.json ships "root": false — it's a nested config inside THIS
    // monorepo. create.js's makeBiomeConfigRoot() flips that to true for a
    // scaffolded standalone project (no parent config above it, and Biome 2.x
    // silently ignores a non-root config with nothing rooting it, falling back
    // to defaults that scan gitignored dist/ / .claude/ / .vibecarbon/ and
    // break the pre-commit lint hook). Upgrade re-pulls the raw template
    // content above, so without this it would undo that flip on every run.
    if (relPath === 'biome.json') {
      newContent = newContent.replace(/"root"\s*:\s*false/, '"root": true');
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

    // The template's copy is the same one this project was last upgraded to
    // (or created from), so the only difference is the user's own edit and
    // there is no upgrade to apply. Without this, a customized file gets
    // queued as "you modified this" on every run, with Replace as the default
    // — and since replacing re-records the template hash, restoring the
    // customization sets the same trap for the next upgrade. -force still
    // resets everything below, by explicit request.
    if (!args.force && storedHash && newHash === storedHash) {
      unchanged.push(relPath);
      continue;
    }

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

    // npm: start from the template's verified lock rather than re-resolving
    // the bumped subtrees against the project's stale one — that is where
    // ERESOLVE lives, and the Docker `npm ci` dies the same way mid-deploy
    // (see seedLockfileFromTemplate). The install below then only adds what
    // the project carries beyond the template.
    const seeded = pm === 'npm' && seedLockfileFromTemplate(TEMPLATE_DIR, cwd);

    const s2 = spinner();
    s2.start(seeded ? 'Regenerating lockfile from the template’s…' : 'Regenerating lockfile…');
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
