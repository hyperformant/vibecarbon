/**
 * Vibecarbon Add Command
 *
 * Adds optional services to an existing Vibecarbon project. Service
 * bundles ship with the CLI and are installed from the packaged
 * `services/` directory by default — the same way `create` scaffolds
 * from the packaged `carbon/` template, so an `add` is version-pinned
 * and works offline. `-online` opts into fetching the latest bundles
 * from GitHub (single-file assets only; directory assets such as `k8s/`
 * still come from the packaged copy).
 *
 * Interactive-by-default: bare `vibecarbon add` prompts for a feature
 * to add. Positional features (`vibecarbon add observability redis`)
 * skip the prompt and queue multiple installs.
 *
 * Form rule: vibecarbon uses single-dash flags only — see
 * memory:feedback_cli_single_dash_flags. -l is gone (the bare-form
 * help body already lists features).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { exitCancelled } from './lib/cli/exit-guard.js';

import { introCommand } from './lib/cli/intro.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { spinner } from './lib/cli/progress.js';
import { requireTTYOrFlags } from './lib/cli/tty-guard.js';
import { isHAConfigured, registerProject } from './lib/config.js';
import { fetchWithRetry } from './lib/fetch-retry.js';
import {
  appendToEnv,
  loadEnvVariables,
  loadManifest,
  saveManifest,
  setEnvVar,
} from './lib/project.js';
import { assertInProjectDir } from './lib/project-guard.js';
import { generatePassword } from './lib/secrets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// GitHub repository for fetching service bundles
const GITHUB_REPO = 'hyperformant/vibecarbon';
const GITHUB_BRANCH = 'main';
const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}`;
const SERVICES_PATH = 'services';

// Packaged services directory — the default install source (shipped in the
// npm package `files`, alongside `carbon/`). `-online` overrides this to fetch
// from GitHub.
const LOCAL_SERVICES_DIR = join(__dirname, '..', SERVICES_PATH);

// Template variable placeholders
const PLACEHOLDERS = {
  PROJECT_NAME: '{{PROJECT_NAME}}',
  DB_PASSWORD: '{{DB_PASSWORD}}',
  ANON_KEY: '{{ANON_KEY}}',
  SERVICE_ROLE_KEY: '{{SERVICE_ROLE_KEY}}',
  N8N_PASSWORD: '{{N8N_PASSWORD}}',
  DOMAIN: '{{DOMAIN}}',
};
// M3 Task 4: k8s manifests (observability's loki/grafana/prometheus PVCs,
// n8n's PVC) ship a `{{K8S_STORAGE_CLASS}}` placeholder instead of
// hardcoding Hetzner's `hcloud-volumes`. It is DELIBERATELY left out of
// PLACEHOLDERS/`variables` above: `add` has no reliable per-environment
// provider signal (provider is resolved and persisted per-ENVIRONMENT at
// `deploy` time — src/lib/deploy/prompts.js's resolveProvider — and this
// command can run before any environment has ever deployed), so
// substituting here could silently bake the wrong provider's StorageClass
// into the copied manifest. The placeholder survives `add` untouched and is
// resolved later by `applyK3sManifests` (src/lib/deploy/k8s/k3s.js), which
// already has the deploy's authoritative resolved `ProviderClass` in scope.

// Map service names to their env flags for dashboard visibility
// client: VITE_* flags for frontend (sidebar links, UI)
// server: flags for backend (services status monitoring)
const SERVICE_ENV_FLAGS = {
  n8n: { client: 'VITE_N8N_ENABLED', server: 'N8N_ENABLED' },
  metabase: { client: 'VITE_METABASE_ENABLED', server: 'METABASE_ENABLED' },
  observability: { client: 'VITE_OBSERVABILITY_ENABLED', server: 'OBSERVABILITY_ENABLED' },
  redis: { client: 'VITE_REDIS_ENABLED', server: 'REDIS_ENABLED' },
};

// ============================================================================
// COMMAND SPEC — single source of truth for argv parsing AND help output.
// ============================================================================

/**
 * The features list is referenced by both the SPEC (so help body
 * shows what's available) and `addService` (the dispatcher). Defined
 * later in the file as `LOCAL_FEATURES`; lazy access via a getter so
 * this module can resolve hoisting cleanly.
 */
function buildSpec() {
  return /** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string, examples?: Array<{ command: string, description?: string }> }} */ ({
    name: 'add',
    summary: 'Add a feature to a Vibecarbon project',
    description: [
      'Available features:',
      ...AVAILABLE_FEATURES.map((f) => `  ${f.name.padEnd(16)} ${f.description}`),
      '',
      'External services (CI/CD, Stripe, OAuth, etc.) live in `vibecarbon configure`.',
    ].join('\n'),
    positional: [
      {
        name: 'features',
        variadic: true,
        optional: true,
        description: 'One or more features to add (skips the feature prompt)',
      },
    ],
    flags: [
      { name: 'h', boolean: true, description: 'Show this help' },
      { name: 'v', boolean: true, description: 'Show version' },
      { name: 'y', boolean: true, description: 'Skip confirmation prompts' },
      {
        name: 'online',
        boolean: true,
        description: 'Fetch the latest bundles from GitHub instead of the packaged copy',
      },
    ],
    examples: [
      { command: 'vibecarbon add', description: 'prompts for a feature to add' },
      { command: 'vibecarbon add observability', description: 'add a specific feature' },
      { command: 'vibecarbon add observability redis', description: 'add multiple features' },
    ],
  });
}

// ============================================================================
// GITHUB FETCHING
// ============================================================================

async function fetchFromGitHub(path) {
  const url = `${GITHUB_RAW_BASE}/${path}`;
  try {
    const response = await fetchWithRetry(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } catch (error) {
    throw new Error(`Failed to fetch ${url}: ${error.message}`);
  }
}

async function fetchServiceManifest(serviceName, offline = false) {
  if (offline) {
    const manifestPath = join(LOCAL_SERVICES_DIR, serviceName, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error(`Service "${serviceName}" not found in bundled services`);
    }
    return JSON.parse(readFileSync(manifestPath, 'utf-8'));
  }

  try {
    const content = await fetchFromGitHub(`${SERVICES_PATH}/${serviceName}/manifest.json`);
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Service "${serviceName}" not found: ${error.message}`);
  }
}

async function fetchServiceFile(serviceName, filePath, offline = false) {
  if (offline) {
    const localPath = join(LOCAL_SERVICES_DIR, serviceName, filePath);
    if (!existsSync(localPath)) {
      throw new Error(`File not found: ${localPath}`);
    }
    return readFileSync(localPath, 'utf-8');
  }

  return await fetchFromGitHub(`${SERVICES_PATH}/${serviceName}/${filePath}`);
}

// ============================================================================
// FILE OPERATIONS
// ============================================================================

function applyVariables(content, variables) {
  let result = content;
  // Replace predefined placeholders
  for (const [key, placeholder] of Object.entries(PLACEHOLDERS)) {
    if (variables[key] !== undefined) {
      result = result.replaceAll(placeholder, variables[key]);
    }
  }
  // Also replace any {{VARIABLE_NAME}} patterns from dynamic variables
  // This handles service-specific vars like METABASE_PASSWORD, REDIS_PASSWORD, etc.
  for (const [key, value] of Object.entries(variables)) {
    if (value !== undefined) {
      result = result.replaceAll(`{{${key}}}`, value);
    }
  }
  return result;
}

async function installServiceFile(serviceName, srcPath, destPath, variables, offline) {
  const content = await fetchServiceFile(serviceName, srcPath, offline);
  const processedContent = applyVariables(content, variables);

  const fullDestPath = join(process.cwd(), destPath);
  mkdirSync(dirname(fullDestPath), { recursive: true });
  writeFileSync(fullDestPath, processedContent);

  // Make shell scripts executable
  if (destPath.endsWith('.sh')) {
    chmodSync(fullDestPath, 0o755);
  }
}

async function installServiceDirectory(serviceName, srcDir, destDir, variables, offline) {
  // For directories, we need to list files
  // In offline mode, we can read the directory
  // In online mode, we'd need the manifest to list files

  if (offline) {
    const localDir = join(LOCAL_SERVICES_DIR, serviceName, srcDir);
    if (!existsSync(localDir)) {
      return;
    }

    const entries = readdirSync(localDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);

      if (entry.isDirectory()) {
        await installServiceDirectory(serviceName, srcPath, destPath, variables, offline);
      } else {
        await installServiceFile(serviceName, srcPath, destPath, variables, offline);
      }
    }
  } else {
    // Online mode can't enumerate a remote directory (GitHub raw has no
    // listing and we don't hit the contents API). Directory assets such as
    // `k8s/` therefore only install from the packaged copy.
    throw new Error(
      `Cannot fetch directory "${srcDir}" over -online (remote directory listing is not supported). ` +
        'Drop -online to install this feature from the packaged template.',
    );
  }
}

// ============================================================================
// KUBERNETES CONFIGURATION
// ============================================================================

function updateBaseKustomization(kustomizationEntry) {
  if (!kustomizationEntry) {
    return;
  }

  const kustomizationPath = join(process.cwd(), 'k8s', 'base', 'kustomization.yaml');

  if (!existsSync(kustomizationPath)) {
    return;
  }

  let content = readFileSync(kustomizationPath, 'utf-8');
  const entry = `  - ${kustomizationEntry}`;

  if (content.includes(entry)) {
    return;
  }

  // Insert before labels/commonLabels section so entry stays in resources block
  const labelsIndex = content.indexOf('labels:');
  const commonLabelsIndex = content.indexOf('commonLabels:');
  const insertBefore = labelsIndex !== -1 ? labelsIndex : commonLabelsIndex;

  if (insertBefore !== -1) {
    content = `${content.slice(0, insertBefore).trimEnd()}\n${entry}\n\n${content.slice(insertBefore)}`;
  } else {
    content = `${content.trimEnd()}\n${entry}\n`;
  }

  writeFileSync(kustomizationPath, content);
}

function removeFromBaseKustomization(kustomizationEntry) {
  if (!kustomizationEntry) {
    return;
  }

  const kustomizationPath = join(process.cwd(), 'k8s', 'base', 'kustomization.yaml');

  if (!existsSync(kustomizationPath)) {
    return;
  }

  let content = readFileSync(kustomizationPath, 'utf-8');
  const entry = `  - ${kustomizationEntry}`;

  content = content.replace(`${entry}\n\n`, '');
  content = content.replace(`${entry}\n`, '');
  content = content.replace(entry, '');

  writeFileSync(kustomizationPath, content);
}

// ============================================================================
// ADD SERVICE
// ============================================================================

async function addService(serviceName, options) {
  const { project } = options;

  // Parked features ship in `services/` but are turned off for this release.
  // Refuse here — before any manifest fetch — so `add <parked>` can't install
  // something we've hidden from the offering. `remove` is intentionally not
  // guarded, so an existing install can still be cleaned up.
  if (isParked(serviceName)) {
    p.log.warn(`"${serviceName}" is not available in this release.`);
    return false;
  }

  // Default install source is the packaged `services/` dir (mirrors how
  // `create` uses the packaged `carbon/` template). `-online` opts into the
  // GitHub fetch; on network failure we fall back to the packaged copy below.
  let offline = !options.online;

  let manifest;
  try {
    manifest = await fetchServiceManifest(serviceName, offline);
  } catch (error) {
    // If online fetch failed, automatically try offline mode
    if (!offline) {
      try {
        manifest = await fetchServiceManifest(serviceName, true);
        offline = true; // Switch to offline for file fetching
      } catch {
        const suggestion = findClosestFeature(serviceName);
        if (suggestion) {
          p.log.error(`Service "${serviceName}" not found. Did you mean "${suggestion}"?`);
        } else {
          p.log.error(`Service "${serviceName}" not found.`);
        }
        return false;
      }
    } else {
      const suggestion = findClosestFeature(serviceName);
      if (suggestion) {
        p.log.error(`${error.message} Did you mean "${suggestion}"?`);
      } else {
        p.log.error(error.message);
      }
      return false;
    }
  }

  const projectManifest = loadManifest();

  // Check if already added
  if (projectManifest.services?.[serviceName]) {
    p.log.warn(`Service "${serviceName}" is already added to this project.`);
    return false;
  }

  // n8n requires Redis for queue mode — add it automatically if not already present
  if (serviceName === 'n8n' && !projectManifest.services?.redis) {
    p.log.info('n8n requires Redis for queue mode, adding Redis automatically');
    const redisAdded = await addService('redis', { ...options, asDependency: true });
    if (!redisAdded) {
      p.log.error('Failed to add Redis (required by n8n)');
      return false;
    }
  }

  // Informed consent for a standalone Redis add: out of the box the app's only
  // Redis consumer is the distributed rate-limit store, which matters when the
  // app runs multiple replicas (Kubernetes tiers). On single-server Compose
  // the built-in in-memory limiter is equivalent, so a solo Redis mostly costs
  // RAM unless the operator plans to use it from their own code (REDIS_URL is
  // wired into the app). Skipped for dependency installs (n8n) and under -y.
  if (serviceName === 'redis' && !options.asDependency && !options.yes) {
    p.note(
      [
        'Out of the box, Redis backs one thing: distributed rate limiting,',
        'which matters when the app runs multiple replicas (Kubernetes tiers).',
        'On single-server Compose deploys, the built-in in-memory limiter is',
        'equivalent (counters reset on redeploy), and Redis adds ~40MB RAM on',
        'your server. Add it now if you are heading to Kubernetes or plan to',
        'use Redis in your own code (REDIS_URL is wired into the app).',
      ].join('\n'),
      'What Redis does here',
    );
    const proceed = await p.confirm({ message: 'Add Redis?', initialValue: true });
    if (p.isCancel(proceed) || !proceed) {
      p.log.info('Skipped Redis.');
      return false;
    }
  }

  // Load existing env vars
  const envVars = loadEnvVariables();

  // Generate variables for template substitution
  const variables = {
    PROJECT_NAME: project.projectName,
    DB_PASSWORD: envVars.POSTGRES_PASSWORD || envVars.DB_PASSWORD || '',
    ANON_KEY: envVars.SUPABASE_ANON_KEY || '',
    SERVICE_ROLE_KEY: envVars.SUPABASE_SERVICE_ROLE_KEY || '',
    DOMAIN: envVars.DOMAIN || 'localhost',
  };

  // Generate service-specific env vars
  const serviceEnvVars = {};
  for (const [key, config] of Object.entries(manifest.envVars || {})) {
    if (config.generate === 'password') {
      serviceEnvVars[key] = generatePassword(config.length || 24);
      variables[key] = serviceEnvVars[key];
    } else if (config.from && envVars[config.from]) {
      // Inherit from existing env var (e.g., ADMIN_EMAIL)
      serviceEnvVars[key] = envVars[config.from];
      variables[key] = envVars[config.from];
    } else if (config.value !== undefined) {
      serviceEnvVars[key] = config.value;
      variables[key] = config.value;
    } else if (config.default !== undefined) {
      serviceEnvVars[key] = config.default;
      variables[key] = config.default;
    }
  }

  const s = spinner();
  s.start(`Adding ${manifest.name}${offline ? ' (offline)' : ''}...`);

  try {
    // Install files based on manifest mappings
    for (const [src, dest] of Object.entries(manifest.files || {})) {
      if (src.endsWith('/')) {
        // Directory mapping
        await installServiceDirectory(serviceName, src, dest, variables, offline);
      } else {
        // File mapping
        await installServiceFile(serviceName, src, dest, variables, offline);
      }
    }

    // Update the base kustomization if the service declares an entry. Services
    // that isolate into their OWN namespace (observability, H-9) intentionally
    // declare NO `kustomization` entry, so they are NEVER wired into k8s/base —
    // the base `namespace: vibecarbon` transformer would override their namespace
    // and ship them un-isolated on every deploy path. Such a service is applied as
    // a separate isolated kustomization by the direct k3s deploy; the gitops path
    // does not reconcile it yet and warns loudly at deploy time (deployK8sGitOps).
    if (manifest.kustomization?.entry) {
      updateBaseKustomization(manifest.kustomization.entry);
    }

    // Update .env.local with service env vars
    if (Object.keys(serviceEnvVars).length > 0) {
      appendToEnv(serviceName, serviceEnvVars);
    }

    // Patch k8s secrets manifest with service-specific env vars
    const k8sSecretsPath = join(process.cwd(), 'k8s', 'base', 'secrets', 'secrets.yaml');
    if (existsSync(k8sSecretsPath) && Object.keys(serviceEnvVars).length > 0) {
      let secretsContent = readFileSync(k8sSecretsPath, 'utf-8');
      for (const [key, value] of Object.entries(serviceEnvVars)) {
        if (!secretsContent.includes(`  ${key}:`)) {
          // Append under stringData section
          secretsContent = `${secretsContent.trimEnd()}\n  ${key}: "${value}"\n`;
        }
      }
      writeFileSync(k8sSecretsPath, secretsContent);
    }

    // Set env flags for dashboard visibility (client + server)
    const envFlags = SERVICE_ENV_FLAGS[serviceName];
    if (envFlags) {
      if (envFlags.client) setEnvVar(envFlags.client, 'true');
      if (envFlags.server) setEnvVar(envFlags.server, 'true');
    }

    // Update project manifest
    if (!projectManifest.services) {
      projectManifest.services = {};
    }
    projectManifest.services[serviceName] = {
      addedAt: new Date().toISOString(),
      version: manifest.version,
    };
    saveManifest(projectManifest);

    s.stop(`${manifest.name} added successfully`);

    // Show credentials if defined
    if (manifest.credentials) {
      const credentialLines = manifest.credentials.fields.map((field) => {
        const value = field.envVar ? serviceEnvVars[field.envVar] : field.value;
        return `${field.label}: ${value}`;
      });
      p.note(credentialLines.join('\n'), manifest.credentials.title);
    }

    return true;
  } catch (error) {
    s.stop(`Failed to add ${manifest.name}`);
    p.log.error(error.message);
    return false;
  }
}

// ============================================================================
// LIST SERVICES
// ============================================================================

// Features that work locally without external dependencies.
//
// `status: 'parked'` turns a feature off for this release: it's hidden from the
// offering (help body + interactive prompt) and `add` refuses to install it,
// but its packaged bundle under `services/` stays in place so un-parking is a
// one-line flip. Existing installs can still be `vibecarbon remove`d. Broad
// add-on discovery will move to a marketplace later — this list is not the
// permanent catalog.
const LOCAL_FEATURES = [
  { name: 'observability', description: 'Prometheus, Grafana, Loki monitoring stack' },
  { name: 'n8n', description: 'Workflow automation platform', status: 'parked' },
  { name: 'metabase', description: 'Business intelligence and analytics', status: 'parked' },
  { name: 'redis', description: 'In-memory cache and session store' },
];

// External services were previously listed here (CI/CD via GitHub Actions);
// they all moved to `vibecarbon configure` since they wire up off-stack
// providers rather than installing local containers.

const ALL_FEATURES = [...LOCAL_FEATURES];

// Features actually offered to users. Parked features are excluded from the
// help body and the interactive prompt, but remain in ALL_FEATURES so typo
// suggestions and the parked guard can still resolve their names.
const AVAILABLE_FEATURES = LOCAL_FEATURES.filter((f) => f.status !== 'parked');

/**
 * Whether a feature ships but is turned off for this release.
 * @param {string} name
 */
function isParked(name) {
  return LOCAL_FEATURES.some((f) => f.name === name && f.status === 'parked');
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      matrix[i][j] =
        a[i - 1] === b[j - 1]
          ? matrix[i - 1][j - 1]
          : Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + 1);
    }
  }
  return matrix[a.length][b.length];
}

/**
 * Find the closest matching feature name for typo correction
 */
function findClosestFeature(input) {
  const featureNames = ALL_FEATURES.map((f) => f.name);
  let closest = null;
  let minDistance = Infinity;

  for (const name of featureNames) {
    const distance = levenshteinDistance(input.toLowerCase(), name.toLowerCase());
    // Only suggest if the distance is reasonable (less than half the word length)
    if (distance < minDistance && distance <= Math.ceil(name.length / 2)) {
      minDistance = distance;
      closest = name;
    }
  }
  return closest;
}

// ============================================================================
// MAIN
// ============================================================================

async function main(cliArgs) {
  const SPEC = buildSpec();
  const { values, positional, handled } = parseFlagsOrExit(cliArgs, SPEC);
  if (handled) return;

  // Detect project FIRST, before the secret scan. Otherwise an accidental
  // invocation from a parent directory (e.g. ~/repos) would walk every
  // sibling repo and dump real tokens to the operator's scrollback before
  // the friendly "not a project" message ever appears.
  const projectConfig = assertInProjectDir();

  // Refuse to add if the working tree contains likely secrets — `add`
  // mutates files (compose includes, k8s manifests) that get pushed
  // alongside whatever else is in the tree. A leak through `add`
  // looks the same as a leak through `deploy`.
  {
    const { refuseIfSecretsPresent } = await import('./lib/secret-scan.js');
    await refuseIfSecretsPresent('add');
  }

  const project = {
    projectName: projectConfig.projectName,
    haConfigured: isHAConfigured(),
    provider: projectConfig.provider || 'hetzner',
    services: projectConfig.services || {},
  };

  // Resolve which services to add. Positional list wins; otherwise
  // prompt on TTY, fail off-TTY with the canonical message naming the
  // missing positional.
  /** @type {string[]} */
  const seedServices = /** @type {string[]|undefined} */ (positional.features || []).map((s) =>
    s.toLowerCase(),
  );

  if (seedServices.length === 0) {
    requireTTYOrFlags({
      requirements: [
        {
          flag: 'features',
          description: 'name a feature to add (e.g. observability, redis, n8n)',
          satisfied: false,
        },
      ],
    });
  }

  introCommand('add');

  /** @type {string[]} */
  let services = seedServices;
  if (services.length === 0) {
    const choice = await p.select({
      message: 'Which feature do you want to add?',
      options: AVAILABLE_FEATURES.map((f) => ({
        value: f.name,
        label: f.name,
        hint: f.description,
      })),
    });
    if (p.isCancel(choice)) {
      exitCancelled();
    }
    services = [/** @type {string} */ (choice)];
  }

  let success = true;
  for (const serviceName of services) {
    const result = await addService(serviceName, {
      online: !!values.online,
      project,
      yes: !!values.y,
      cliArgs: cliArgs, // Pass raw CLI args for infrastructure services
    });
    if (!result) {
      success = false;
    }
  }

  if (success) {
    registerProject(project.projectName, process.cwd());
    p.note(
      ['# Restart services to apply changes:', 'vibecarbon down && vibecarbon up'].join('\n'),
      'Next steps',
    );
    p.outro('Services added successfully!');
  } else {
    p.outro('Some services could not be added.');
    process.exit(1);
  }
}

export async function run(args) {
  await main(args);
}

// ============================================================================
// EXPORTS FOR TESTING
// ============================================================================

export { fetchServiceManifest, loadManifest, removeFromBaseKustomization, saveManifest };
