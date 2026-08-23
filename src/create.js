/**
 * Vibecarbon Create Command
 * Scaffolds a complete Hono + Vite + React 19 + Supabase self-hosted stack
 *
 * Usage:
 *   vibecarbon create my-app            # Create new project
 *   vibecarbon create my-app -y         # Skip prompts, use defaults
 *   vibecarbon create my-app -pm pnpm   # Use pnpm instead of npm
 *   vibecarbon create -h                # Show help
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { isBinaryFile } from './lib/binary-files.js';
import { hashContent } from './lib/checksum.js';
import { exitCancelled } from './lib/cli/exit-guard.js';
import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { c } from './lib/colors.js';
import { gitSafeEnv, runCommand } from './lib/command.js';
import { registerProject } from './lib/config.js';
import { titleizeSlug } from './lib/display-name.js';
import { writeLogoSvgs } from './lib/logo-generator.js';
import {
  adaptDockerfileForPackageManager,
  getPackageManagerVersion,
  MIN_PNPM_MAJOR,
  writePnpmWorkspaceSettings,
  writeTemplateLockfile,
} from './lib/package-manager.js';
import { saveManifest, validateGitignore } from './lib/project.js';
import {
  generateBucketSalt,
  generateJWT,
  generatePassword,
  generateReplPassword,
  hashPassword,
} from './lib/secrets.js';
import { escapeDotenv } from './lib/shell.js';
import { createTracker } from './lib/tracker.js';
import { getUpgradeableFiles } from './lib/upgrade-policy.js';
import {
  validateAdminEmail,
  validateAdminPassword,
  validateDisplayName,
  validateProjectName,
} from './lib/validators.js';
import { VERSION } from './lib/version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATE_DIR = join(__dirname, '..', 'carbon');

// Launch decision (2026-05-06, revised 2026-07-30): hide the interactive
// package-manager prompt and default to npm. Running vibecarbon already
// requires `npx`, so npm is guaranteed present on every machine that can
// scaffold a project — pnpm would be one more thing to install before a
// generated project works at all. The pnpm + bun code paths still work
// (the adapter rewrites the Dockerfile, the lockfile is generated at
// create time) and stay reachable via `-pm pnpm` / `-pm bun`. Flip this
// to `true` to bring the prompt back.
const SHOW_PACKAGE_MANAGER_PROMPT = false;

// Template variable placeholders
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
  REPL_PASSWORD: '{{REPL_PASSWORD}}',
  SITE_URL: '{{SITE_URL}}',
  ADMIN_EMAIL: '{{ADMIN_EMAIL}}',
  ADMIN_PASSWORD: '{{ADMIN_PASSWORD}}',
  ADMIN_PASSWORD_HASH: '{{ADMIN_PASSWORD_HASH}}',
};

// Placeholders that are NEVER substituted into checked-in template files at
// create time. Their values land in `.env.local` (gitignored) via direct
// dotenv writes; the deploy code (src/lib/deploy/**) patches them into k8s
// manifests at deploy time. Substituting them here would bake a high-entropy
// secret into a file that lands in `git ls-files` and trips the preflight
// secret-scan during the next `vibecarbon deploy` — the exact regression
// fixed by this set (k8s/values/supabase.values.yaml ADMIN_PASSWORD).
//
// ADMIN_PASSWORD_HASH is intentionally NOT in this set: volumes/db/super-admin.sql
// is a Postgres init script with no deploy-time substitution layer, so its
// bcrypt hash must be substituted at create time for first-boot admin user
// creation to work. The scanner does not match `password_hash :=` (its regex
// requires `password\s*[:=]`, not `password_hash\s*:=`), so a hash leak there
// is benign for the scanner. If a future template adds a hash to another
// file, treat it as a separate fix.
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
  'REPL_PASSWORD',
  'ADMIN_PASSWORD',
]);

// ============================================================================
// CLI ARGUMENT PARSING
// ============================================================================

// ============================================================================
// COMMAND SPEC — single source of truth for argv parsing AND help output.
// ============================================================================

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'create',
  summary: 'Scaffold a new Vibecarbon project',
  description: [
    "What's included:",
    '  • Hono API server with TypeScript',
    '  • Vite + React 19 SPA',
    '  • Supabase self-hosted (Auth, Database, Storage, Realtime)',
    '  • PostgreSQL with Row Level Security',
    '  • Kong API Gateway + Supabase Studio',
    '  • Docker Compose for local development',
    '  • Kubernetes for production with autoscaling',
    '  • Traefik reverse proxy with automatic HTTPS',
    '  • Shadcn UI component library',
    '  • GitHub Actions CI/CD',
    '  • Automated backups',
  ].join('\n'),
  positional: [
    {
      name: 'projectName',
      optional: true,
      description: 'Project directory name (skips the name prompt)',
    },
  ],
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
    {
      name: 'y',
      boolean: true,
      description: 'Skip prompts (requires -admin-email and -admin-password)',
    },
    {
      name: 'install',
      boolean: true,
      description: "Run the package manager's install during create (default: off)",
    },
    {
      name: 'skip-lockfile',
      boolean: true,
      description:
        'Skip lockfile generation (faster; deploy will need `vibecarbon up` first to install)',
    },
    {
      name: 'pm',
      value: '<name>',
      enum: ['npm', 'pnpm', 'bun'],
      description: 'Package manager to use (default: npm)',
    },
    {
      name: 'admin-email',
      value: '<email>',
      description: 'Admin email for dashboard access (required with -y)',
    },
    {
      name: 'admin-password',
      value: '<pw>',
      description: 'Admin password for dashboard access (required with -y)',
    },
    {
      name: 'display-name',
      value: '<name>',
      description:
        'Human-facing product name shown in browser titles, the PWA manifest, and emails (default: derived from project name)',
    },
  ],
  examples: [
    { command: 'vibecarbon create my-saas', description: 'create a project interactively' },
    {
      command:
        'vibecarbon create my-saas -y -admin-email admin@example.com -admin-password secret123',
      description: 'non-interactive (CI/CD)',
    },
    {
      command: 'vibecarbon create my-saas -install',
      description: 'create + run pm install (git is initialized automatically)',
    },
  ],
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function isCI() {
  return (
    process.env.CI === 'true' ||
    process.env.CONTINUOUS_INTEGRATION === 'true' ||
    process.env.GITHUB_ACTIONS === 'true' ||
    process.env.GITLAB_CI === 'true' ||
    process.env.CIRCLECI === 'true' ||
    process.env.JENKINS_URL !== undefined
  );
}

/**
 * @param {string} [cwd] - Directory to probe for lockfiles (defaults to process.cwd())
 * @returns {'npm'|'pnpm'|'bun'}
 */
function detectPackageManager(cwd = process.cwd()) {
  // Check user agent first (set by npm/pnpm/bun when running npx/pnpx/etc).
  // Someone who ran us through `pnpm dlx` or `bunx` clearly has that manager
  // installed and probably wants it; everyone else gets the npm default.
  const ua = process.env.npm_config_user_agent || '';
  if (ua.startsWith('pnpm')) return 'pnpm';
  if (ua.startsWith('bun')) return 'bun';

  // Check for lockfiles in cwd
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun';
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm';

  return 'npm'; // default
}

function getInstallCommand(pm) {
  switch (pm) {
    case 'pnpm':
      // Use --no-frozen-lockfile for new projects (no lockfile exists yet)
      // This is needed in CI environments where pnpm defaults to frozen-lockfile
      return 'pnpm install --no-frozen-lockfile';
    case 'bun':
      return 'bun install';
    default:
      return 'npm install';
  }
}

// Recommended minimum versions for best experience
const RECOMMENDED_VERSIONS = {
  npm: { min: 10, message: 'npm 10+ recommended for better performance and security' },
  // pnpm 10 is a hard requirement, not a preference — it is the first release
  // that reads the template's security pins from pnpm-workspace.yaml. Enforced
  // as a refusal below; see MIN_PNPM_MAJOR.
  pnpm: { min: MIN_PNPM_MAJOR, message: `pnpm ${MIN_PNPM_MAJOR}+ required (dependency pins)` },
  bun: { min: 1.2, message: 'bun 1.2+ recommended (uses text-based bun.lock)' },
};

function checkPackageManagerVersion(pm) {
  try {
    const version = runCommand([pm, '--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      // See PM_RUN_CONTEXT_RE in lib/command.js — a wrapper's `npm_execpath`
      // should not decide which binary answers this.
      cleanEnv: true,
    }).trim();
    const parts = version.split('.');
    const major = parseInt(parts[0], 10);
    const minor = parseInt(parts[1] || '0', 10);
    const recommended = RECOMMENDED_VERSIONS[pm];

    if (recommended) {
      const reqMajor = Math.floor(recommended.min);
      const reqMinor = Math.round((recommended.min - reqMajor) * 10);
      if (major < reqMajor || (major === reqMajor && minor < reqMinor)) {
        return {
          current: version,
          isOutdated: true,
          message: recommended.message,
        };
      }
    }
    return { current: version, isOutdated: false };
  } catch {
    return { current: null, isOutdated: false };
  }
}

const INSTALL_INSTRUCTIONS = {
  pnpm: 'npm install -g pnpm',
  bun: 'curl -fsSL https://bun.sh/install | bash',
};

function isPackageManagerInstalled(pm) {
  try {
    // See PM_RUN_CONTEXT_RE in lib/command.js — a wrapper's run context should
    // not shape this probe.
    execFileSync(pm, ['--version'], { stdio: ['pipe', 'pipe', 'pipe'], env: gitSafeEnv() });
    return true;
  } catch {
    return false;
  }
}

async function ensurePackageManagerInstalled(pm, skipPrompts = false) {
  if (isPackageManagerInstalled(pm)) return pm;

  const installCmd = INSTALL_INSTRUCTIONS[pm];
  if (installCmd) {
    p.log.warn(`${c.bold(pm)} is not installed. To install it, run:\n\n  ${c.info(installCmd)}\n`);
  } else {
    p.log.warn(`${c.bold(pm)} is not installed.`);
  }

  if (skipPrompts) {
    p.log.info(`Falling back to ${c.bold('npm')}.`);
    return 'npm';
  }

  const fallback = await p.select({
    message: 'Choose a package manager',
    options: [
      { value: 'npm', label: 'npm', hint: 'already installed with Node.js' },
      { value: 'pnpm', label: 'pnpm' },
      { value: 'bun', label: 'bun' },
    ].filter((opt) => opt.value !== pm),
  });

  if (p.isCancel(fallback)) {
    exitCancelled();
  }

  // Recurse in case the fallback isn't installed either
  return ensurePackageManagerInstalled(fallback);
}

function copyTemplate(templatePath, destPath, variables) {
  const fullTemplatePath = join(TEMPLATE_DIR, templatePath);

  if (!existsSync(fullTemplatePath)) {
    return false;
  }

  // Binary assets (icons, fonts, images) copy byte-for-byte — the UTF-8
  // round-trip below would corrupt them, and they carry no placeholders.
  if (isBinaryFile(templatePath)) {
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(fullTemplatePath, destPath);
    return true;
  }

  let content = readFileSync(fullTemplatePath, 'utf-8');

  for (const [key, placeholder] of Object.entries(PLACEHOLDERS)) {
    if (SECRET_PLACEHOLDERS.has(key)) continue;
    if (variables[key] !== undefined) {
      // Function replacement: a plain string here would expand $-patterns ($&, $`)
      content = content.replaceAll(placeholder, () => variables[key]);
    }
  }

  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, content);
  return true;
}

/**
 * Promote a copied `biome.json` to a root config (`"root": true`).
 *
 * carbon/biome.json ships `"root": false` because inside THIS monorepo it is a
 * nested config beneath the repo-root biome.json. A scaffolded standalone
 * project has no parent config, and Biome 2.x silently ignores a non-root config
 * that has no root above it — falling back to defaults that scan gitignored
 * dist/ / .claude/ / .vibecarbon/ output and break the generated pre-commit
 * hook. Flip it in the generated project only; carbon/biome.json stays `false`.
 *
 * Targeted string replace (not JSON re-serialize) to preserve formatting.
 * Idempotent: a no-op if the key is absent or already true.
 */
function makeBiomeConfigRoot(biomeJsonPath) {
  if (!existsSync(biomeJsonPath)) return;
  const content = readFileSync(biomeJsonPath, 'utf-8');
  const updated = content.replace(/"root"\s*:\s*false/, '"root": true');
  if (updated !== content) writeFileSync(biomeJsonPath, updated);
}

function copyTemplateDir(templateSubdir, destDir, variables, exclude = [], rawCopy = []) {
  const fullTemplatePath = join(TEMPLATE_DIR, templateSubdir);

  if (!existsSync(fullTemplatePath)) {
    return;
  }

  const entries = readdirSync(fullTemplatePath, { withFileTypes: true });

  for (const entry of entries) {
    const destPath = join(destDir, entry.name);

    if (exclude.includes(entry.name)) continue;

    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyTemplateDir(join(templateSubdir, entry.name), destPath, variables, exclude, rawCopy);
    } else if (rawCopy.includes(entry.name)) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(join(fullTemplatePath, entry.name), destPath);
    } else {
      copyTemplate(join(templateSubdir, entry.name), destPath, variables);
    }
  }
}

/**
 * Validate that no unreplaced {{PLACEHOLDER}} patterns remain in generated files.
 * Only checks for placeholders that should have been replaced during creation
 * (those in PLACEHOLDERS minus SECRET_PLACEHOLDERS — the latter are intentionally
 * left as placeholders for deploy-time substitution). Deploy-only placeholders
 * like {{DOMAIN}}, {{ACME_EMAIL}} etc. are also expected to remain.
 *
 * Returns an array of { file, placeholders } objects for files with issues.
 */
function validatePlaceholders(projectDir, exclude = []) {
  const issues = [];

  // Build pattern to match only creation-time placeholders (secrets are
  // deploy-time substituted, so they're expected to remain unreplaced).
  const creationPlaceholders = Object.keys(PLACEHOLDERS).filter(
    (key) => !SECRET_PLACEHOLDERS.has(key),
  );
  const placeholderPattern = new RegExp(`\\{\\{(${creationPlaceholders.join('|')})\\}\\}`, 'g');

  // Files/directories to skip (binary files, lockfiles, etc.)
  const skipPatterns = [
    'node_modules',
    '.git',
    'pnpm-lock.yaml',
    'package-lock.json',

    'bun.lock',
    'bun.lockb',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
  ];

  function scanDir(dir) {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = fullPath.replace(`${projectDir}/`, '');

      // Skip excluded paths
      if (exclude.includes(entry.name)) continue;
      if (skipPatterns.some((p) => entry.name.includes(p) || entry.name.endsWith(p))) continue;

      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else {
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const matches = content.match(placeholderPattern);
          if (matches) {
            // Get unique placeholders
            const uniquePlaceholders = [...new Set(matches)];
            issues.push({ file: relativePath, placeholders: uniquePlaceholders });
          }
        } catch {
          // Skip files that can't be read as text (binary files)
        }
      }
    }
  }

  scanDir(projectDir);
  return issues;
}

// Helper to allow UI updates between operations
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 400));
}

// ============================================================================
// MAIN BOOTSTRAP FUNCTION
// ============================================================================

async function bootstrap(cliArgs) {
  const { values, positional, handled } = parseFlagsOrExit(cliArgs, SPEC);
  if (handled) return;

  // Build the legacy `args` shape that the orchestration code reads.
  // Git init always runs when `git` is on PATH; falls back to no-repo silently
  // if git isn't installed. No CLI flag needed either way.
  const args = {
    projectName: positional.projectName || null,
    yes: !!values.y,
    install: !!values.install,
    skipLockfile: !!values['skip-lockfile'],
    packageManager: /** @type {string|null} */ (values.pm),
    adminEmail: /** @type {string|null} */ (values['admin-email']),
    adminPassword: /** @type {string|null} */ (values['admin-password']),
    displayName: /** @type {string|null} */ (values['display-name']),
  };

  // Validate here (not per-branch) so a flag-supplied value is checked in both
  // the interactive and -y paths — the display name is substituted into JS/JSON/
  // HTML sinks, so it must never bypass validation.
  if (args.displayName) {
    const displayErr = validateDisplayName(args.displayName);
    if (displayErr) {
      p.log.error(`Invalid -display-name "${args.displayName}": ${displayErr}`);
      process.exit(1);
    }
  }

  const skipPrompts = args.yes || isCI();

  // Start interactive UI
  introCommand('create');

  // Gather configuration.
  // projectName is the basename; it's also the directory name created in cwd.
  // Legacy behavior allowed paths like '../my-app'; we now require a bare
  // basename so the generated project always lands in a predictable place
  // and can't escape cwd (CVE-class path-traversal).
  let projectName = args.projectName;
  let packageManager = args.packageManager || detectPackageManager();
  let adminEmail = args.adminEmail;
  let adminPassword = args.adminPassword;
  let displayName = args.displayName;

  if (!skipPrompts) {
    // Interactive prompts
    const project = await p.group(
      {
        name: () => {
          if (projectName) return Promise.resolve(projectName);
          return p.text({
            message: 'What is your project name?',
            placeholder: 'my-saas',
            validate: (value) => {
              const err = validateProjectName(value);
              if (err) return err;
              if (existsSync(join(process.cwd(), value))) {
                return `Directory "${value}" already exists`;
              }
            },
          });
        },
        displayName: ({ results }) => {
          if (displayName) return Promise.resolve(displayName);
          return p.text({
            message: 'Display name (shown in browser titles, PWA install, and emails):',
            initialValue: titleizeSlug(results.name ?? projectName ?? ''),
            validate: (value) => {
              const err = validateDisplayName(value);
              if (err) return err;
            },
          });
        },
        adminEmail: () => {
          if (adminEmail) return Promise.resolve(adminEmail);
          return p.text({
            message: 'Admin email (for all dashboard access):',
            placeholder: 'admin@example.com',
            validate: (value) => {
              const err = validateAdminEmail(value);
              if (err) return err;
            },
          });
        },
        adminPassword: () => {
          if (adminPassword) return Promise.resolve(adminPassword);
          return p.password({
            message: 'Admin password (min 8 characters):',
            validate: (value) => {
              const err = validateAdminPassword(value);
              if (err) return err;
            },
          });
        },
        packageManager: () => {
          if (args.packageManager) return Promise.resolve(args.packageManager);
          // Launch decision (2026-05-06, revised 2026-07-30): hide the
          // interactive package-manager prompt and default to npm — it
          // ships with Node, so a generated project works without the
          // user installing anything else first. See the comment on
          // SHOW_PACKAGE_MANAGER_PROMPT for the full rationale; power
          // users can still pick pnpm/bun via the CLI flags.
          if (!SHOW_PACKAGE_MANAGER_PROMPT) return Promise.resolve('npm');
          return p.select({
            message: 'Which package manager?',
            options: [
              { value: 'npm', label: 'npm', hint: 'recommended' },
              { value: 'pnpm', label: 'pnpm' },
              { value: 'bun', label: 'bun' },
            ],
            initialValue: packageManager,
          });
        },
      },
      {
        onCancel: () => {
          exitCancelled();
        },
      },
    );

    projectName = project.name;
    displayName = project.displayName;
    adminEmail = project.adminEmail;
    adminPassword = project.adminPassword;
    packageManager = project.packageManager;
  } else {
    // Non-interactive validation
    if (!projectName) {
      p.log.error('Project name required. Usage: npx create-vibecarbon <project-name> [options]');
      process.exit(1);
    }
    const nameErr = validateProjectName(projectName);
    if (nameErr) {
      p.log.error(`Invalid project name "${projectName}": ${nameErr}`);
      process.exit(1);
    }
    if (existsSync(join(process.cwd(), projectName))) {
      p.log.error(`Directory "${projectName}" already exists.`);
      process.exit(1);
    }
    // Require admin credentials in non-interactive mode
    if (!adminEmail) {
      p.log.error('Admin email required. Use -admin-email you@example.com');
      process.exit(1);
    }
    if (!adminPassword) {
      p.log.error('Admin password required. Use -admin-password yourpassword');
      process.exit(1);
    }
    const emailErr = validateAdminEmail(adminEmail);
    if (emailErr) {
      p.log.error(`Invalid -admin-email "${adminEmail}": ${emailErr}`);
      process.exit(1);
    }
    const pwErr = validateAdminPassword(adminPassword);
    if (pwErr) {
      p.log.error(`Invalid -admin-password: ${pwErr}`);
      process.exit(1);
    }
  }

  // Non-interactive runs (and interactive runs that pre-supplied everything)
  // may not have picked a display name; derive one from the slug.
  if (!displayName) displayName = titleizeSlug(projectName);

  // projectDir is the full path where files are created.
  // projectName is also the directory name since we require basenames only.
  const projectDir = join(process.cwd(), projectName);

  // Show configuration
  p.note(
    [
      `Project:          ${projectName}`,
      `Admin:            ${adminEmail}`,
      `Package manager:  ${packageManager}`,
    ].join('\n'),
    'Configuration',
  );

  // Verify package manager is installed
  packageManager = await ensurePackageManagerInstalled(packageManager, skipPrompts);

  const versionCheck = checkPackageManagerVersion(packageManager);

  // SECURITY: hard gate, checked before the soft warning below so an unusable
  // pnpm exits here instead of printing both. pnpm 9 reads its settings only
  // from package.json's `pnpm` block; pnpm 11 reads them only from
  // pnpm-workspace.yaml. No location satisfies both, so on pnpm 9 the
  // dependency-security floors in `overrides` simply would not apply — and
  // pnpm says nothing about it, it just resolves lower versions. Refuse rather
  // than hand someone a project that looks pinned and isn't.
  if (packageManager === 'pnpm' && versionCheck.current) {
    const pnpmMajor = Number.parseInt(versionCheck.current.split('.')[0], 10);
    if (Number.isFinite(pnpmMajor) && pnpmMajor < MIN_PNPM_MAJOR) {
      p.log.error(
        `pnpm ${versionCheck.current} is too old to enforce this template's dependency-security pins.\n\n` +
          `pnpm ${MIN_PNPM_MAJOR}+ reads them from pnpm-workspace.yaml; pnpm ${pnpmMajor} does not,\n` +
          `and would resolve vulnerable versions of postcss, ip-address, protobufjs and\n` +
          `others without warning.\n\n` +
          `Either upgrade pnpm:\n` +
          `  npm install -g pnpm@latest\n` +
          `or create the project with npm, which needs no install at all:\n` +
          `  vibecarbon create ${projectName} -pm npm`,
      );
      process.exit(1);
    }
  }

  // Check for outdated package manager and warn
  if (versionCheck.isOutdated) {
    p.log.warn(
      `${c.dim(`${packageManager} ${versionCheck.current} detected.`)} ${versionCheck.message}`,
    );
  }

  // Generate secure secrets
  const dbPassword = generatePassword();
  const jwtSecret = generatePassword(64);
  const realtimeSecret = generatePassword(64); // SECRET_KEY_BASE (min 64 chars)
  const logflareApiKey = generatePassword(32);
  // VAULT_ENC_KEY must be exactly 32 BYTES: Supavisor's tenant seed encrypts
  // the manager password with Cloak AES-256-GCM, and :crypto rejects any
  // other key size ("Unknown cipher or invalid key size" crash-loop — RCA
  // kept compose rig e1, 2026-08-06; latent until the tenant seed existed).
  const vaultEncKey = generatePassword(32);
  const pgMetaCryptoKey = generatePassword(32); // PG_META_CRYPTO_KEY (min 32 chars)
  const dbEncKey = generatePassword(16); // DB_ENC_KEY for Realtime aes_128_ecb (must be exactly 16 bytes)
  const replPassword = generateReplPassword();
  const anonKey = generateJWT(jwtSecret, {
    role: 'anon',
    iss: 'supabase',
    ref: projectName,
  });

  const serviceRoleKey = generateJWT(jwtSecret, {
    role: 'service_role',
    iss: 'supabase',
    ref: projectName,
  });

  const variables = {
    PROJECT_NAME: projectName,
    PROJECT_DISPLAY_NAME: displayName,
    GITHUB_OWNER: projectName, // Default to project name; rewritten by `vibecarbon configure` → CI/CD (or by deploy's rewriteOwnerAndRepo fallback)
    DB_PASSWORD: dbPassword,
    JWT_SECRET: jwtSecret,
    ANON_KEY: anonKey,
    SERVICE_ROLE_KEY: serviceRoleKey,
    REALTIME_SECRET: realtimeSecret,
    LOGFLARE_API_KEY: logflareApiKey,
    VAULT_ENC_KEY: vaultEncKey,
    PG_META_CRYPTO_KEY: pgMetaCryptoKey,
    DB_ENC_KEY: dbEncKey,
    REPL_PASSWORD: replPassword,
    SITE_URL: 'http://localhost:5173',
    ADMIN_EMAIL: adminEmail,
    ADMIN_PASSWORD: adminPassword || '',
    ADMIN_PASSWORD_HASH: adminPassword ? hashPassword(adminPassword) : '',
  };

  // Create project
  const tracker = createTracker('create', { project: projectName });
  const s = tracker.spinner();

  s.start('Creating project structure');
  mkdirSync(projectDir, { recursive: true });

  const dirs = [
    'src/server/routes/api',
    'src/server/routes/_internal',
    'src/server/routes/v1',
    'src/server/lib',
    'src/client/components/auth',
    'src/client/components/ui',
    'src/client/pages',
    'src/client/lib',
    'src/shared',
    'supabase/migrations',
    'db',
    'public',
    'backup',
    'volumes/kong',
    'volumes/db',
    'volumes/traefik',
    '.github/workflows',
    'k8s/base/app',
    'k8s/base/backup',
    'k8s/base/config',
    'k8s/base/traefik',
    'k8s/infra/cert-manager-resources',
    'k8s/infra/traefik-crds',
    'k8s/overlays/production',
    'k8s/overlays/local',
    'k8s/flux/clusters/primary',
    'k8s/flux/clusters/standby',
    'k8s/gitops/supabase',
    'k8s/gitops/cert-manager-webhook-hetzner',
    'k8s/values',
  ];
  for (const dir of dirs) {
    mkdirSync(join(projectDir, dir), { recursive: true });
  }
  await tick();

  s.message('Generating configuration files');
  copyTemplate('package.json', join(projectDir, 'package.json'), variables);
  // Node line for the generated project. nvm/fnm/asdf read it locally and the
  // shipped .github/workflows/vibecarbon-build.yml reads it via
  // `node-version-file`, so the project's CI and its developers can't drift.
  // ci-setup.js re-installs it for projects created before it existed.
  // copyTemplate returns false (silently) when the template is missing. For
  // .nvmrc that's not survivable: the generated project's CI resolves its Node
  // version from this exact path via node-version-file, so a missing file
  // fails the first Actions run at setup-node with a far less obvious error.
  // Fail here instead, matching installNodeVersionFile's throw in ci-setup.js.
  if (!copyTemplate('.nvmrc', join(projectDir, '.nvmrc'), variables)) {
    throw new Error(
      `Template .nvmrc not found in ${TEMPLATE_DIR}, vibecarbon install is incomplete`,
    );
  }
  // Lock files are generated by the package manager during install — don't copy stale ones
  copyTemplate('tsconfig.json', join(projectDir, 'tsconfig.json'), variables);
  copyTemplate('tsconfig.server.json', join(projectDir, 'tsconfig.server.json'), variables);
  copyTemplate('vite.config.ts', join(projectDir, 'vite.config.ts'), variables);
  copyTemplate('biome.json', join(projectDir, 'biome.json'), variables);
  // Generated projects are standalone (no parent biome config), so the config
  // must declare itself root — see makeBiomeConfigRoot.
  makeBiomeConfigRoot(join(projectDir, 'biome.json'));
  copyTemplate('components.json', join(projectDir, 'components.json'), variables);

  // Test scaffolding — three-tier vitest setup + helpers + golden seed tests.
  // See carbon/TESTING.md for the tier conventions; the test-maintainer
  // subagent extends from this seed when writing new tests.
  copyTemplate('vitest.config.ts', join(projectDir, 'vitest.config.ts'), variables);
  copyTemplate('tsconfig.test.json', join(projectDir, 'tsconfig.test.json'), variables);
  copyTemplate('TESTING.md', join(projectDir, 'TESTING.md'), variables);
  copyTemplateDir('tests', join(projectDir, 'tests'), variables);
  // Copy .env.example WITHOUT replacing placeholders (it's committed to git as documentation)
  const envExampleContent = readFileSync(join(TEMPLATE_DIR, '.env.example'), 'utf-8');
  writeFileSync(join(projectDir, '.env.example'), envExampleContent);
  const envLocal = generateEnvLocal(projectName, variables);
  writeFileSync(join(projectDir, '.env.local'), envLocal, { mode: 0o600 });
  // Also create .env for docker-compose (reads .env by default)
  writeFileSync(join(projectDir, '.env'), envLocal, { mode: 0o600 });
  await tick();

  s.message('Generating Docker configuration');
  copyTemplate('Dockerfile', join(projectDir, 'Dockerfile'), variables);
  adaptDockerfileForPackageManager(projectDir, packageManager);
  copyTemplate('docker-entrypoint.sh', join(projectDir, 'docker-entrypoint.sh'), variables);
  copyTemplate('.dockerignore', join(projectDir, '.dockerignore'), variables);
  copyTemplate('docker-compose.yml', join(projectDir, 'docker-compose.yml'), variables);
  copyTemplate('docker-compose.prod.yml', join(projectDir, 'docker-compose.prod.yml'), variables);
  // DNS-01 ACME override — applied at deploy only for managed-DNS (cloudflare/hetzner).
  copyTemplate(
    'docker-compose.dns01.prod.yml',
    join(projectDir, 'docker-compose.dns01.prod.yml'),
    variables,
  );
  copyTemplate(
    'docker-compose.override.yml',
    join(projectDir, 'docker-compose.override.yml'),
    variables,
  );
  copyTemplate('PRODUCTION.md', join(projectDir, 'PRODUCTION.md'), variables);
  copyTemplate('DEVELOPMENT.md', join(projectDir, 'DEVELOPMENT.md'), variables);
  // docker-compose.dev-init.yml is deliberately NOT scaffolded: it's the
  // generated (gitignored, npmignored) dev-repo overlay that mounts
  // super-admin.generated.sql, which derived projects never have — shipping
  // it turned that mount into an auto-created directory and broke db:migrate
  // on first `up`. Guarded by tests/unit/create/volume-mount-sources.test.ts.
  chmodSync(join(projectDir, 'docker-entrypoint.sh'), 0o755);

  await tick();

  s.message('Generating backend files');
  copyTemplate('volumes/kong/kong.yml', join(projectDir, 'volumes/kong/kong.yml'), variables);
  copyTemplate(
    'volumes/kong/docker-entrypoint.sh',
    join(projectDir, 'volumes/kong/docker-entrypoint.sh'),
    variables,
  );
  copyTemplate('volumes/db/roles.sql', join(projectDir, 'volumes/db/roles.sql'), variables);
  copyTemplate(
    'volumes/db/set-passwords.sh',
    join(projectDir, 'volumes/db/set-passwords.sh'),
    variables,
  );
  // wal-archive.sh is postgres's archive_command. It was missing from this copy
  // list, so scaffolds shipped no source file — Docker then bind-mounted an
  // empty DIRECTORY at /etc/postgresql/wal-archive.sh and postgres failed
  // archiving with exit 126 ("is a directory"), re-pinning WAL. Copy it (the
  // chmod block below makes it +x; the script has only shell $vars, no {{}}).
  copyTemplate(
    'volumes/db/wal-archive.sh',
    join(projectDir, 'volumes/db/wal-archive.sh'),
    variables,
  );
  copyTemplate('volumes/db/jwt.sql', join(projectDir, 'volumes/db/jwt.sql'), variables);
  // pooler.sql + pooler.exs are bind-mount SOURCES (db init + supavisor
  // tenant seed). Same escape class as wal-archive.sh above: omit them here
  // and Docker mounts an auto-created empty DIRECTORY on the server —
  // "could not read from input file: Is a directory" aborts db init before
  // set-passwords, and every db-connected service crash-loops on SASL auth
  // (RCA: kept compose rig e1, 2026-08-06). Guarded by
  // tests/unit/create/volume-mount-sources.test.ts.
  copyTemplate('volumes/db/pooler.sql', join(projectDir, 'volumes/db/pooler.sql'), variables);
  copyTemplate(
    'volumes/pooler/pooler.exs',
    join(projectDir, 'volumes/pooler/pooler.exs'),
    variables,
  );
  copyTemplate('volumes/db/realtime.sql', join(projectDir, 'volumes/db/realtime.sql'), variables);
  copyTemplate(
    'volumes/db/super-admin.sql',
    join(projectDir, 'volumes/db/super-admin.sql'),
    variables,
  );
  copyTemplate(
    'volumes/db/super-admin.dev.sql',
    join(projectDir, 'volumes/db/super-admin.dev.sql'),
    variables,
  );
  copyTemplate(
    'volumes/traefik/middlewares.yml',
    join(projectDir, 'volumes/traefik/middlewares.yml'),
    variables,
  );
  copyTemplate(
    'volumes/traefik/middlewares.dev.yml',
    join(projectDir, 'volumes/traefik/middlewares.dev.yml'),
    variables,
  );
  copyTemplate(
    'volumes/traefik/vite-dev.yml',
    join(projectDir, 'volumes/traefik/vite-dev.yml'),
    variables,
  );

  // Compose backups run as a host cron (compose-backup.sh). k8s backups are
  // wal-g co-located in the db pod (carbon/db image), so the old standalone
  // backup container (backup.sh + backup/Dockerfile) was removed.
  copyTemplate('backup/compose-backup.sh', join(projectDir, 'backup/compose-backup.sh'), variables);
  chmodSync(join(projectDir, 'backup/compose-backup.sh'), 0o755);
  // CI/CD workflow files are NOT shipped at create time — `vibecarbon
  // configure` → CI/CD installs them from src/lib/ci-setup.js when the user
  // explicitly opts in. Direct deploy is the default; shipping the workflow
  // files in fresh projects would silently flip ciAvailable() and force
  // every deploy through GitHub Actions.
  copyTemplate(
    'supabase/migrations/00001_init.sql',
    join(projectDir, 'supabase/migrations/00001_init.sql'),
    variables,
  );
  copyTemplate('supabase/seed.sql', join(projectDir, 'supabase/seed.sql'), variables);
  // Copy entire src directory (server, client, shared)
  copyTemplateDir('src', join(projectDir, 'src'), variables);

  // Generate a name-specific logo (Space Grotesk wordmark + icon lockup) from
  // the display name, replacing the shipped Vibecarbon wordmark. The hex icon
  // and favicon are left as-is. Cosmetic and deterministic, so on the off chance
  // it fails we keep the default logo rather than block project creation.
  try {
    writeLogoSvgs(variables.PROJECT_DISPLAY_NAME, join(projectDir, 'src', 'client', 'assets'));
  } catch (err) {
    p.log.warn(`Could not generate a custom logo (keeping the default): ${err.message}`);
  }

  // Blog content
  copyTemplateDir('content', join(projectDir, 'content'), variables);

  // Custom database files (WAL-G Dockerfile)
  copyTemplateDir('db', join(projectDir, 'db'), variables);

  // Kubernetes manifests (exclude optional features like n8n - they're added via `vibecarbon add`)
  copyTemplateDir('k8s', join(projectDir, 'k8s'), variables, ['n8n']);

  // Scripts (manifest-based docker/k8s commands)
  // generate-dev-configs.sh contains {{PLACEHOLDER}} tokens as its own substitution keys,
  // so it must be copied verbatim to avoid leaking real secrets into the script.
  copyTemplateDir(
    'scripts',
    join(projectDir, 'scripts'),
    variables,
    [],
    ['generate-dev-configs.sh'],
  );

  // Make shell scripts executable
  const shellScripts = [
    'k8s/test-local.sh',
    'docker-entrypoint.sh',
    'volumes/kong/docker-entrypoint.sh',
    'volumes/db/set-passwords.sh',
    // Postgres execs this directly as its archive_command, so it MUST be +x.
    // copyTemplate (copyFileSync) drops the source's exec bit, and omitting it
    // here shipped a 0644 script → archive_command failed with exit 126 ("not
    // executable") → WAL pinned → disk-fill risk the wrapper exists to prevent.
    'volumes/db/wal-archive.sh',
  ];
  for (const script of shellScripts) {
    const scriptPath = join(projectDir, script);
    if (existsSync(scriptPath)) {
      chmodSync(scriptPath, 0o755);
    }
  }
  await tick();

  // Validate no unreplaced placeholders remain
  s.message('Validating generated files');
  const placeholderIssues = validatePlaceholders(projectDir, ['generate-dev-configs.sh', 'agents']);
  if (placeholderIssues.length > 0) {
    s.stop('Validation warning');
    p.log.warn('Some files contain unreplaced placeholders:');
    for (const issue of placeholderIssues.slice(0, 5)) {
      p.log.warn(`  ${c.dim(issue.file)}: ${issue.placeholders.join(', ')}`);
    }
    if (placeholderIssues.length > 5) {
      p.log.warn(`  ... and ${placeholderIssues.length - 5} more files`);
    }
    p.log.warn('This may indicate a bug in the template. Please report this issue.');
  }
  await tick();

  s.message('Generating documentation and AI rules');
  const readme = generateReadme(projectName, packageManager);
  writeFileSync(join(projectDir, 'README.md'), readme);

  // AI development experience files
  copyTemplate('AGENTS.md', join(projectDir, 'AGENTS.md'), variables);
  copyTemplate('CLAUDE.md', join(projectDir, 'CLAUDE.md'), variables);
  copyTemplate('.windsurfrules', join(projectDir, '.windsurfrules'), variables);
  copyTemplate(
    '.github/copilot-instructions.md',
    join(projectDir, '.github/copilot-instructions.md'),
    variables,
  );
  mkdirSync(join(projectDir, '.cursor', 'rules'), { recursive: true });
  copyTemplate(
    '.cursor/rules/vibecarbon.mdc',
    join(projectDir, '.cursor/rules/vibecarbon.mdc'),
    variables,
  );

  // Claude Code subagents — copy from repo root, stripping auto-generated memory footer
  const agentsSourceDir = join(__dirname, '..', '.claude', 'agents');
  if (existsSync(agentsSourceDir)) {
    const agentsDestDir = join(projectDir, '.claude', 'agents');
    mkdirSync(agentsDestDir, { recursive: true });
    for (const file of readdirSync(agentsSourceDir)) {
      if (!file.endsWith('.md')) continue;
      let content = readFileSync(join(agentsSourceDir, file), 'utf-8');
      // Strip the auto-generated "Persistent Agent Memory" section — Claude Code
      // re-injects it at runtime based on the `memory:` frontmatter field
      content = content.replace(/\n# Persistent Agent Memory[\s\S]*$/, '\n');
      writeFileSync(join(agentsDestDir, file), content);
    }
  }

  // Copy .claude/settings.json (agent team config + hooks)
  const settingsSource = join(TEMPLATE_DIR, '.claude', 'settings.json');
  if (existsSync(settingsSource)) {
    const settingsDest = join(projectDir, '.claude', 'settings.json');
    mkdirSync(dirname(settingsDest), { recursive: true });
    copyTemplate(join('.claude', 'settings.json'), settingsDest, variables);
  }

  // Copy .claude/hooks/
  const hooksSourceDir = join(TEMPLATE_DIR, '.claude', 'hooks');
  if (existsSync(hooksSourceDir)) {
    const hooksDestDir = join(projectDir, '.claude', 'hooks');
    mkdirSync(hooksDestDir, { recursive: true });
    for (const file of readdirSync(hooksSourceDir)) {
      copyTemplate(join('.claude', 'hooks', file), join(hooksDestDir, file), variables);
    }
    for (const file of readdirSync(hooksDestDir)) {
      if (file.endsWith('.sh')) chmodSync(join(hooksDestDir, file), 0o755);
    }
  }

  // Create agent memory directories
  for (const agent of [
    'backend-engineer',
    'frontend-engineer',
    'security-reviewer',
    'test-maintainer',
    'lead-coordinator',
  ]) {
    mkdirSync(join(projectDir, '.claude', 'agent-memory', agent), { recursive: true });
  }

  // Update package.json with project name and package manager.
  const packageJson = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'));
  packageJson.name = projectName;

  // The npm default deliberately ships NO `packageManager` field: npm comes
  // with Node, and pinning it would push the project through corepack —
  // reintroducing the extra install step this default exists to remove.
  // pnpm/bun projects still get the pin, since those DO have to be installed.
  //
  // Stamping the HOST's `pnpm --version` here is safe: pin, lockfile, and
  // config all now come from the host, since the template ships neither a
  // pnpm lockfile nor a `packageManager` field. A `-pm pnpm` project's
  // lockfile is generated below by the very pnpm this line pins, and its
  // settings live in pnpm-workspace.yaml, which pnpm 10.5+ and 11 both read.
  // `create` also refuses pnpm < MIN_PNPM_MAJOR outright.
  if (packageManager === 'npm') {
    delete packageJson.packageManager;
  } else {
    packageJson.packageManager = getPackageManagerVersion(packageManager);
  }

  // Rewrite the template's `npm run <script>` chains for the selected manager
  if (packageManager !== 'npm' && packageJson.scripts) {
    const run = packageManager === 'pnpm' ? 'pnpm' : 'bun run';
    for (const [key, value] of Object.entries(packageJson.scripts)) {
      if (typeof value === 'string' && value.includes('npm run ')) {
        packageJson.scripts[key] = value.replaceAll('npm run ', `${run} `);
      }
    }
  }

  writeFileSync(join(projectDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);

  // SECURITY: pnpm reads neither the top-level `overrides` (npm/bun) nor — as
  // of pnpm 11 — its own `pnpm` block in package.json. Left as-is, a `-pm pnpm`
  // project would resolve with every dependency-security floor silently
  // dropped. Move them to pnpm-workspace.yaml, the one location pnpm 10.5+ and
  // pnpm 11 both honor. See writePnpmWorkspaceSettings for the measurements.
  if (packageManager === 'pnpm') {
    writePnpmWorkspaceSettings(projectDir);
  }

  // Deps are deferred to `vibecarbon up` — it auto-installs on first run if
  // node_modules is missing. Keeps `create` fast (e2e saw ~35s shaved
  // when running many `create` calls in parallel) and avoids running the
  // wrong PM against an empty tree. Opt-in via --install if you want the old
  // behavior.
  if (args.install) {
    // `-install` materializes node_modules now instead of at first `up`. It
    // must still land the SAME tree the default path ships, so on npm it lays
    // down the template lockfile first and replays it with `npm ci` rather than
    // re-resolving the floating ranges — otherwise the one flag that exists to
    // front-load the install would also silently hand out a different (and
    // untested) dependency tree than every other project. `npm ci` is faster
    // here too: it never resolves.
    const replayLockfile =
      packageManager === 'npm' && writeTemplateLockfile(TEMPLATE_DIR, projectDir, projectName);
    const installCmd = replayLockfile
      ? ['npm', 'ci', '--no-audit', '--no-fund']
      : getInstallCommand(packageManager);

    s.message(`Installing dependencies with ${packageManager}`);
    await tick();
    if (!runCommand(installCmd, { cwd: projectDir, cleanEnv: true })) {
      s.stop('Failed to install dependencies');
      p.log.error('Installation failed. You can try running the install command manually.');
      process.exit(1);
    }
    await tick();
  } else if (args.skipLockfile) {
    // Caller opted out of lockfile gen — they'll run `vibecarbon up` (or
    // the install manually) before `deploy`. Used by tests that only
    // verify scaffolding, and by scripted CI flows that install later.
  } else if (
    packageManager === 'npm' &&
    writeTemplateLockfile(TEMPLATE_DIR, projectDir, projectName)
  ) {
    // npm: ship the template's committed lockfile rather than resolving the
    // tree again on the user's machine.
    //
    // `create` never edits `dependencies` / `devDependencies`, so the project's
    // tree IS the template's tree — the old full `npm install` here spent ~1
    // minute (plus an `npm ci --dry-run` convergence loop) recomputing an
    // answer we already had committed, and got a slightly different one every
    // time as the floating ranges drifted. Copying the committed lock is
    // instant, and starts every project on the exact tree CI exercises.
    //
    // node_modules is deliberately NOT materialized here — `vibecarbon up`
    // installs on first run (see src/up.js), and `vibecarbon deploy` builds
    // inside Docker from this lockfile.
    s.message('Writing package-lock.json');
    await tick();
  } else {
    // Generate the lockfile so the Dockerfile's `COPY package.json
    // <lockfile> ./` step has something to copy. Without this, going from
    // `vibecarbon create` straight to `vibecarbon deploy` (skipping `up`)
    // fails the docker build at the COPY step. `vibecarbon up` would
    // generate the lockfile too, but we shouldn't make `up` a hard
    // prerequisite for `deploy`.
    //
    // Reached by pnpm and bun, and by npm only if the template ships no
    // lockfile at all (a packaging fault — tests/unit/template pins that it
    // does). pnpm has a lockfile-only mode that skips node_modules (~2s).
    //
    // npm's equivalent (`npm install --package-lock-only`) is NOT usable here.
    // It resolves the tree without ever materializing it, and the lock it
    // writes is rejected by `npm ci` under the very npm that just wrote it
    // ("Invalid: lock file's ajv-formats@3.0.1 does not satisfy
    // ajv-formats@2.1.1"). This is not npm version skew — the committed
    // template lock verifies clean under npm 10.9, 11.6 and 11.9. Only a real
    // `npm install` produces a lock `npm ci` accepts, which is also how the
    // template's own committed lockfile was produced.
    //
    // Bun has no lockfile-only mode either, but installs fast enough that the
    // cost is acceptable. For bun the work is moved earlier rather than
    // duplicated: `vibecarbon up` sees node_modules present and skips
    // re-install. Callers that only want scaffolding pass -skip-lockfile.
    let lockfileCmd = null;
    let lockfileMsg = null;
    if (packageManager === 'npm') {
      lockfileCmd = ['npm', 'install', '--no-audit', '--no-fund'];
      lockfileMsg = 'Installing dependencies and generating package-lock.json';
    } else if (packageManager === 'pnpm') {
      lockfileCmd = ['pnpm', 'install', '--lockfile-only'];
      lockfileMsg = 'Generating pnpm-lock.yaml (lockfile only)';
    } else if (packageManager === 'bun') {
      lockfileCmd = ['bun', 'install'];
      lockfileMsg = 'Generating bun.lock (full install, bun has no lockfile-only mode)';
    }
    if (lockfileCmd) {
      s.message(lockfileMsg);
      await tick();
      // Non-fatal if this fails — CI will regenerate or the user can install.
      runCommand(lockfileCmd, {
        cwd: projectDir,
        cleanEnv: true,
        ignoreError: true,
      });
      await tick();

      // Both places a generated project installs from — the Dockerfile and the
      // CI workflow we scaffold — run a strict `npm ci`, which replays the
      // lockfile verbatim and never re-resolves. So the lock `create` writes
      // has to be one npm actually accepts, or the user's very first build
      // fails on a project they haven't touched yet.
      //
      // npm's optional-peer subtrees (@emnapi/*, reached through the wasm
      // fallback packages) can need more than one pass to settle, so validate
      // and re-run until `npm ci` is satisfied rather than assuming a fixed
      // pass count. If it never converges, say so HERE, where the user is
      // present and can act — a Docker build is the wrong place to find out.
      if (packageManager === 'npm') {
        const MAX_LOCKFILE_PASSES = 5;
        let accepted = false;
        for (let pass = 1; pass <= MAX_LOCKFILE_PASSES; pass++) {
          // `ignoreError` makes a non-zero exit return null; success returns
          // the captured stdout. `silent` keeps npm's output off the spinner.
          const valid = runCommand(['npm', 'ci', '--dry-run', '--no-audit', '--no-fund'], {
            cwd: projectDir,
            cleanEnv: true,
            ignoreError: true,
            silent: true,
          });
          if (valid !== null) {
            accepted = true;
            break;
          }
          if (pass === MAX_LOCKFILE_PASSES) break;
          s.message(`Reconciling package-lock.json (pass ${pass + 1}/${MAX_LOCKFILE_PASSES})`);
          runCommand(lockfileCmd, { cwd: projectDir, cleanEnv: true, ignoreError: true });
          await tick();
        }
        if (!accepted) {
          s.stop('Could not generate a package-lock.json that `npm ci` accepts');
          p.log.error(
            `Gave up after ${MAX_LOCKFILE_PASSES} passes.\n\n` +
              `Shipping this lockfile would fail your first Docker build and your\n` +
              `first CI run, both install with a strict \`npm ci\` — so stopping here.\n\n` +
              `To see why npm is rejecting it:\n` +
              `  cd ${projectDir}\n` +
              `  npm ci --dry-run\n\n` +
              `The error names the package that won't settle. Removing node_modules\n` +
              `and package-lock.json, then re-running \`npm install\`, usually clears it.\n` +
              `If it doesn't, please report it along with that output.`,
          );
          process.exit(1);
        }
      }
    }
  }

  // Initialize git. Always attempted; skipped silently with a friendly note
  // if the `git` binary isn't on PATH (no flag exposed for opt-out).
  let gitAvailable = true;
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', env: gitSafeEnv() });
  } catch {
    gitAvailable = false;
  }

  if (gitAvailable) {
    s.message('Initializing git repository');
    copyTemplate('.gitignore', join(projectDir, '.gitignore'), variables);

    const missingPatterns = validateGitignore(join(projectDir, '.gitignore'));
    if (missingPatterns.length > 0) {
      p.log.error(
        `Generated .gitignore is missing required patterns: ${missingPatterns.join(', ')}`,
      );
      process.exit(1);
    }

    runCommand('git init', { cwd: projectDir, cleanEnv: true });

    // Install pre-commit hook. Two responsibilities:
    //   1. Lint staged code (catches biome/format issues early).
    //   2. Run vibecarbon's secret scanner against staged files. The
    //      scanner script lives at scripts/secret-scan.mjs (copied from
    //      the template) so this hook works without the vibecarbon CLI
    //      installed globally — every clone of the project gets the
    //      same protection on a fresh `git init`.
    //
    // We don't install lefthook here because most projects already have
    // a pre-commit setup of their own; a plain shell hook is simpler
    // and harder to break. If a contributor wants a richer hook
    // manager, lefthook.yml in the template gives them a starting
    // point — `npx lefthook install` will replace this with that
    // config.
    const hooksDir = join(projectDir, '.git', 'hooks');
    const runCmd =
      packageManager === 'pnpm' ? 'pnpm' : packageManager === 'bun' ? 'bun run' : 'npm run';
    const preCommitHook = `#!/bin/sh
# Pre-commit hook installed by vibecarbon create.
# Edit freely — but please keep the secret-scan step; it's the first
# layer of defense against committing API keys, JWTs, private keys,
# etc. \`vibecarbon deploy\` will refuse to push if it finds them
# anyway, so removing this just delays the failure.

set -e

# 1. Lint
${runCmd} lint

# 2. Secret scan over staged files. Skip if the script is missing
#    (e.g. the user wiped scripts/ during a refactor); the deploy gate
#    will still catch it.
if [ -f scripts/secret-scan.mjs ]; then
  staged=$(git diff --cached --name-only --diff-filter=ACMR)
  if [ -n "$staged" ]; then
    echo "$staged" | node scripts/secret-scan.mjs --stdin
  fi
fi
`;
    writeFileSync(join(hooksDir, 'pre-commit'), preCommitHook);
    chmodSync(join(hooksDir, 'pre-commit'), 0o755);

    // Install pre-push hook. Runs the project's `test:prepush` script —
    // lint + unit + component + integration. Integration mocks externals,
    // so this works without Docker and is fast enough for every push.
    // Bypass via `git push --no-verify` if you understand why your tests
    // are red. The test-maintainer subagent shipped with the project
    // keeps this suite green as code changes.
    const prePushHook = `#!/bin/sh
# Pre-push hook installed by vibecarbon create.
# Runs lint + unit + component + integration tests.
#
# No-ops gracefully if node_modules isn't present yet — a fresh
# \`vibecarbon create\` lands you on a commit that's pushable
# before you've run \`${packageManager} install\`. Once deps land the hook gates
# every subsequent push. Bypass at will with \`git push --no-verify\`.

set -e

if [ ! -d node_modules ]; then
  echo "pre-push: node_modules not present, skipping tests."
  echo "          Run '${packageManager} install' to enable the test gate."
  exit 0
fi

${runCmd} test:prepush
`;
    writeFileSync(join(hooksDir, 'pre-push'), prePushHook);
    chmodSync(join(hooksDir, 'pre-push'), 0o755);
    await tick();
  } else {
    p.log.info(
      "git not found on PATH — skipping repo init. Install git and run 'git init' in this directory to enable version control + pre-commit/pre-push hooks.",
    );
  }

  // Store template version and file checksums for `vibecarbon upgrade`
  s.message('Recording file checksums');
  const upgradeableFiles = getUpgradeableFiles(TEMPLATE_DIR);
  const fileChecksums = {};
  for (const relPath of upgradeableFiles) {
    const filePath = join(projectDir, relPath);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        fileChecksums[relPath] = hashContent(content);
      } catch {
        // Skip files that can't be read as text (binary)
      }
    }
  }
  // ONE write. saveManifest and saveProjectConfig both writeFileSync the WHOLE
  // of .vibecarbon.json with no merge, so calling them in sequence meant the
  // second silently discarded the first: `templateVersion` and every entry of
  // `fileChecksums` were destroyed ~16 lines after being computed, before the
  // initial commit ever saw them. `vibecarbon upgrade` then read
  // `manifest.templateVersion || '0.0.0'` and `manifest.fileChecksums || {}`,
  // took its isBootstrap branch, printed "First upgrade — no stored checksums
  // found" on a project's FIRST EVER upgrade, and classified every file with
  // no baseline to tell a user's edit apart from template drift.
  //
  // bucketSalt is generated exactly once here and never rotated — every derived
  // bucket name embeds it (deriveProjectBucketName), so rotating it would
  // orphan deployed environments' buckets. Written before the initial commit so
  // .vibecarbon.json is part of the baseline the user's first commit captures.
  //
  // stateBucketGeneration is different: it scopes ONLY the Pulumi state bucket
  // and IS rotated — by a verified `destroy` — so a later redeploy derives a
  // fresh state-bucket name instead of recreating the deleted one (same-name
  // bucket recreation can silently lose acked writes; see
  // deriveStateBucketName). Persisted env names win over derivation, so a
  // rotation never moves a live environment.
  saveManifest(
    {
      version: '1',
      projectName,
      bucketSalt: generateBucketSalt(),
      stateBucketGeneration: generateBucketSalt(),
      // Rotated by a verified purge-destroy so a redeploy derives a FRESH
      // storage-bucket name instead of recreating the deleted one (Hetzner's
      // delete→same-name-recreate propagation worst case; registry-500 RCA
      // 2026-08-17 — see deriveProjectBucketName).
      storageBucketGeneration: generateBucketSalt(),
      templateVersion: VERSION,
      fileChecksums,
      services: {},
    },
    projectDir,
  );
  await tick();

  // Create the initial commit so the user starts from a clean, tracked
  // template baseline (not a pile of untracked files). Guarded by the same
  // `gitAvailable` flag as `git init` above — if git isn't on PATH we already
  // logged the skip note and there's no repo to commit into.
  if (gitAvailable) {
    s.message('Creating initial commit');

    // The pre-commit hook we just installed runs `${pm} lint` under `set -e`,
    // and node_modules is absent by default (install is opt-in via -install),
    // so a verified commit would fail. The template is vibecarbon-authored and
    // already clean; the hooks exist to gate the user's *future* commits.
    const commitArgs = ['git', 'commit', '--no-verify', '-m', 'Initial commit from vibecarbon'];

    // `git commit` aborts when no author identity is configured. If neither
    // user.name nor user.email is set, prepend fallback identity via `-c`
    // (command-line `-c` only overrides config files, and is itself overridden
    // by any GIT_AUTHOR_* env — so a real identity, by config or env, always
    // wins; the fallback only fills a total void).
    const name = runCommand(['git', 'config', 'user.name'], {
      cwd: projectDir,
      cleanEnv: true,
      silent: true,
      ignoreError: true,
    });
    const email = runCommand(['git', 'config', 'user.email'], {
      cwd: projectDir,
      cleanEnv: true,
      silent: true,
      ignoreError: true,
    });
    if (!name || !email || !String(name).trim() || !String(email).trim()) {
      commitArgs.splice(
        1,
        0,
        '-c',
        'user.name=vibecarbon',
        '-c',
        'user.email=vibecarbon@users.noreply.github.com',
      );
    }

    const staged = runCommand(['git', 'add', '-A'], {
      cwd: projectDir,
      cleanEnv: true,
      ignoreError: true,
    });
    const committed =
      staged !== null &&
      runCommand(commitArgs, { cwd: projectDir, cleanEnv: true, ignoreError: true }) !== null;

    if (!committed) {
      p.log.warn(
        "Couldn't create the initial commit — run `git add -A && git commit` in the project to capture the baseline.",
      );
    }
    await tick();
  }

  s.stop('Project created successfully');
  registerProject(projectName, projectDir);
  tracker.finish();
  await tick();

  // Next steps
  const nextSteps = [
    '# Change directory:',
    `cd ${projectName}`,
    '',
    '# Run locally:',
    'vibecarbon up',
    '',
    '# Deploy to cloud:',
    'vibecarbon deploy',
  ];

  p.note(nextSteps.join('\n'), 'Next steps');
  await tick();

  p.outro(`Happy building! Admin: ${adminEmail}`);
}

// ============================================================================
// GENERATOR FUNCTIONS
// ============================================================================

function generateEnvLocal(projectName, variables) {
  // Quote-style policy:
  //   - Machine-generated secrets (JWT_SECRET, ANON_KEY, etc) use double-quoted
  //     form because they are drawn from the base64/base64url alphabet and can
  //     never contain a shell metacharacter.
  //   - User-supplied secrets (ADMIN_PASSWORD, REPL_PASSWORD) use escapeDotenv
  //     (single-quoted, POSIX) so any hostile character round-trips safely.
  return `# =============================================================================
# SUPABASE CONFIGURATION
# Generated by create-vibecarbon - DO NOT COMMIT THIS FILE
# =============================================================================

# Project name (machine slug: container naming, pooler tenant, k8s resources)
PROJECT_NAME="${projectName}"
VITE_PROJECT_NAME="${projectName}"

# Human-facing name (browser titles, PWA manifest, email sender). Substituted
# into template files at create time; recorded here so \`vibecarbon upgrade\`
# can re-substitute it into updated template files.
PROJECT_DISPLAY_NAME=${escapeDotenv(variables.PROJECT_DISPLAY_NAME)}

# Supabase URLs
SUPABASE_URL="http://localhost:8000"
VITE_SUPABASE_URL="http://localhost:8000"

# Supabase Keys
SUPABASE_ANON_KEY="${variables.ANON_KEY}"
VITE_SUPABASE_ANON_KEY="${variables.ANON_KEY}"
SUPABASE_SERVICE_ROLE_KEY="${variables.SERVICE_ROLE_KEY}"

# JWT Secret (for token generation)
JWT_SECRET="${variables.JWT_SECRET}"

# Database
DB_PASSWORD="${variables.DB_PASSWORD}"
POSTGRES_PASSWORD="${variables.DB_PASSWORD}"

# Encryption Keys
REALTIME_SECRET="${variables.REALTIME_SECRET}"
VAULT_ENC_KEY="${variables.VAULT_ENC_KEY}"
PG_META_CRYPTO_KEY="${variables.PG_META_CRYPTO_KEY}"
DB_ENC_KEY="${variables.DB_ENC_KEY}"
LOGFLARE_API_KEY="${variables.LOGFLARE_API_KEY}"

# HA PostgreSQL replication (used by HA deploy modes: -mode compose-ha / k8s-ha)
REPL_PASSWORD=${escapeDotenv(variables.REPL_PASSWORD)}

# =============================================================================
# ADMIN CREDENTIALS
# =============================================================================

# Admin user with dashboard access (created during project setup)
# Note: Password stored here for your reference only. Database stores bcrypt hash.
ADMIN_EMAIL="${variables.ADMIN_EMAIL}"
ADMIN_PASSWORD=${escapeDotenv(variables.ADMIN_PASSWORD)}

# Site URL
SITE_URL="http://localhost:5173"
# Public canonical URL baked into the client (og: tags, sitemap). Overridden at
# deploy with the real apex domain; localhost is correct for local dev.
VITE_PUBLIC_URL="http://localhost:5173"

# =============================================================================
# OAUTH PROVIDERS (optional)
# =============================================================================
# Self-hosted GoTrue reads these from the environment — docker-compose maps them
# to GOTRUE_EXTERNAL_GOOGLE_* / GOTRUE_EXTERNAL_AZURE_*. They are NOT set in
# Supabase Studio. Run \`vibecarbon configure\` (OAuth) to fill them in; deploy
# ships them automatically. In the provider console (Google Cloud / Microsoft
# Entra) set the authorized redirect URI to <SITE_URL>/auth/v1/callback.

GOOGLE_ENABLED="false"
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""

MICROSOFT_ENABLED="false"
MICROSOFT_CLIENT_ID=""
MICROSOFT_CLIENT_SECRET=""
MICROSOFT_TENANT_ID=""

# =============================================================================
# EXTERNAL SERVICES (optional)
# =============================================================================

# Stripe
STRIPE_SECRET_KEY=""
STRIPE_WEBHOOK_SECRET=""

# SMTP Email (shared by Supabase Auth and app transactional emails)
SMTP_HOST=""
SMTP_PORT=587
SMTP_USER=""
SMTP_PASS=""
SMTP_ADMIN_EMAIL=""
SMTP_SENDER_NAME=${escapeDotenv(variables.PROJECT_DISPLAY_NAME)}
# "true" auto-confirms signups WITHOUT a verification email (required while
# SMTP is unset, or every signup errors on the unsendable message).
# If you fill in SMTP_* by hand above, ALSO set GOTRUE_MAILER_AUTOCONFIRM="false"
# so signups get real confirmation emails. \`vibecarbon configure\` -> SMTP
# sets both together automatically.
GOTRUE_MAILER_AUTOCONFIRM="true"

# =============================================================================
# OPTIONAL SERVICES (for admin dashboard visibility)
# =============================================================================
# These control which services appear in the admin dashboard
# Set automatically when using 'vibecarbon add' or manual docker-compose files

VITE_N8N_ENABLED="false"
VITE_OBSERVABILITY_ENABLED="false"

# =============================================================================
# PORT CONFIGURATION (for running multiple projects)
# =============================================================================
# Use DEV_PORT_OFFSET to shift all ports when running multiple projects.
# Example: DEV_PORT_OFFSET=100 shifts Vite to 5273, API to 3100, etc.

DEV_PORT_OFFSET="0"

# Override individual ports (takes precedence over offset):
# DEV_VITE_PORT="5173"
# DEV_API_PORT="3000"
# DEV_KONG_PORT="8000"
# DEV_KONG_SSL_PORT="8443"
# DEV_TRAEFIK_PORT="80"

# =============================================================================
# ENVIRONMENT
# =============================================================================

NODE_ENV="development"
PORT="3000"
`.trim();
}

function generateReadme(projectName, packageManager = 'npm') {
  const run = packageManager === 'pnpm' ? 'pnpm' : packageManager === 'bun' ? 'bun run' : 'npm run';
  let readme = `# ${projectName}

A modern web app built with Vibecarbon.

## Stack

- **Hono** - Fast, lightweight web framework
- **Vite** - Next-generation frontend tooling
- **React 19** - UI library (SPA mode)
- **Supabase** - Self-hosted backend (Auth, Database, Storage, Realtime)
- **PostgreSQL** - Database (via Supabase)
- **Tailwind CSS** - Utility-first styling
- **Shadcn UI** - Component library
- **Kubernetes** - Container orchestration & autoscaling
- **Traefik** - Reverse proxy with automatic HTTPS

## Getting Started

Start everything with a single command:

\`\`\`bash
vibecarbon up
\`\`\`

This starts Docker containers, runs database migrations, and launches the dev servers.

## Services

| Service | URL | Description |
|---------|-----|-------------|
| Vite Dev | http://localhost:5173 | Frontend development server |
| Hono API | http://localhost:3000 | Application API |
| Supabase API | http://localhost:8000 | Supabase API Gateway (Kong) |
| Supabase Studio | http://studio.localhost | Database management UI (requires admin login) |
| Traefik Dashboard | http://traefik.localhost | Reverse proxy dashboard (requires admin login) |

## Available Scripts

- \`${run} dev:start\` - Full cold start (Docker + migrations + dev servers)
- \`${run} dev\` - Start both API and frontend dev servers (fast restart)
- \`${run} dev:server\` - Start Hono API server only
- \`${run} dev:client\` - Start Vite dev server only
- \`${run} build\` - Build for production
- \`${run} start\` - Run production build
- \`${run} docker:up\` - Start all services
- \`${run} dev:stop\` - Stop all services
- \`${run} docker:logs\` - View service logs
- \`${run} db:migrate\` - Run database migrations
`;

  readme += `
## Troubleshooting

### Database connection errors

If services fail with "password authentication failed", the database volume was created with different credentials. Reset it:

\`\`\`bash
${run} docker:reset
${run} db:migrate
\`\`\`

> **Note:** This deletes all data. For production, back up first.

### Services not starting

Check logs for specific errors:

\`\`\`bash
${run} docker:logs
\`\`\`

### Port conflicts

If ports 5173, 3000, 3001, or 8000 are in use, stop conflicting services or modify \`docker-compose.yml\`.

## Learn More

- [Supabase Documentation](https://supabase.com/docs)
- [Hono Documentation](https://hono.dev)
- [Vite Documentation](https://vitejs.dev)
`;

  return readme.trim();
}

// ============================================================================
// RUN FUNCTION (called by CLI entry point)
// ============================================================================

export async function run(args) {
  await bootstrap(args);
}

// ============================================================================
// EXPORTS FOR TESTING
// ============================================================================

export {
  bootstrap,
  checkPackageManagerVersion,
  copyTemplate,
  detectPackageManager,
  generateEnvLocal,
  generateJWT,
  generatePassword,
  generateReadme,
  getInstallCommand,
  getPackageManagerVersion,
  isCI,
  PLACEHOLDERS,
  RECOMMENDED_VERSIONS,
  runCommand,
  SPEC,
  TEMPLATE_DIR,
  VERSION,
};
