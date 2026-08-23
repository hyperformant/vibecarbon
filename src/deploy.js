/**
 * Vibecarbon Deploy Command
 * Automates deployment to cloud providers with full environment management
 */

import * as p from '@clack/prompts';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { spinner } from './lib/cli/progress.js';
import { checkDependency, runCommand } from './lib/command.js';
import { loadProjectConfig, saveProjectConfig } from './lib/config.js';
import {
  checkExistingRepo,
  checkGitHubAuth,
  checkGitRemote,
  commitAndPush,
  createGitBranch,
  createGitHubRepository,
  getGitHubUsername,
  monitorDeployment,
  setupGitHubEnvironment,
  setupGitHubIntegration,
} from './lib/deploy/github.js';
import { executeDeployment } from './lib/deploy/orchestrator.js';
import { gatherDeploymentConfig, resolveDeployMode } from './lib/deploy/prompts.js';
// New modular imports
import {
  DEFAULT_WORKER_MAX,
  DEFAULT_WORKER_MIN,
  generateSSHKeyPair,
  getBranchName,
  normalizeEnvName,
  waitForSSH,
} from './lib/deploy/utils.js';
import { withDeployLog } from './lib/deploy-logger.js';
import { ensureLockfile } from './lib/package-manager.js';
import { buildGitAddArgv, detectPackageManager } from './lib/project.js';
import { assertInProjectDir } from './lib/project-guard.js';
import { HetznerS3Provider, sanitizeBucketName } from './lib/providers/hetzner-s3.js';
import { getProvider, getProviderClass, listProviders } from './lib/providers/index.js';
import {
  buildComposeTypeOptions,
  buildK8sProfileOptions,
  COMPOSE_MIN_RAM_GB,
  detectCurrentProfile,
  K8S_PROFILES,
} from './lib/server-types.js';
import { VERSION } from './lib/version.js';

// ============================================================================
// COMMAND SPEC — single source of truth for argv parsing AND help output.
// ============================================================================

const DEPLOY_MODES = ['compose', 'compose-ha', 'k8s', 'k8s-ha'];

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'deploy',
  summary: 'Deploy a Vibecarbon environment to the cloud',
  description: [
    'Most settings (server type, S3, DNS, backup schedule, worker bounds)',
    'come from the interactive prompt or `.vibecarbon.json`. Power users',
    'who want one-shot scripted deploys configure `.vibecarbon.json` once',
    'and re-run with `-y` to skip confirmations.',
  ].join('\n'),
  positional: [
    {
      name: 'env',
      optional: true,
      description: 'Environment to deploy (default: prod)',
    },
  ],
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
    { name: 'y', boolean: true, description: 'Skip confirmation prompts' },
    { name: 'env', value: '<name>', description: 'Environment seed (alternative to positional)' },
    {
      name: 'provider',
      value: '<id>',
      description:
        'Cloud provider for a NEW environment (existing environments keep their binding). Required with -y on a new environment.',
    },
    {
      name: 'region',
      value: '<id>',
      description: 'Primary region (provider-specific, e.g. hel1 on Hetzner, nyc3 on DigitalOcean)',
    },
    {
      name: 'standby-region',
      value: '<id>',
      description: 'HA standby/failover region (defaults to a same-continent partner of -region)',
    },
    {
      name: 'mode',
      value: '<mode>',
      enum: DEPLOY_MODES,
      description: 'Deploy mode',
    },
    {
      name: 'full',
      boolean: true,
      description: 'Clear resume state and redo every step from scratch',
    },
    {
      name: 'restore',
      value: '<latest|timestamp>',
      description:
        'Disaster recovery: seed the fresh DB from the latest wal-g backup in S3 (or PITR to an ISO-8601 timestamp). Skips migrations; the restored DB is authoritative. k8s only.',
    },
    {
      name: 'allow-degraded',
      boolean: true,
      description:
        'HA only: proceed even if the standby is not verifiably streaming (warm-standby / degraded DR). By default an HA deploy FAILS unless replication is confirmed streaming.',
    },
  ],
  examples: [
    { command: 'vibecarbon deploy', description: 'prompts for env (defaults to prod)' },
    { command: 'vibecarbon deploy prod', description: 'env seeded; prompts for the rest' },
    {
      command: 'vibecarbon deploy prod -mode k8s-ha -region hel1 -y',
      description: 'scripted HA k8s deploy to Helsinki',
    },
    {
      command: 'vibecarbon deploy prod -full',
      description: 'redo a previously-failed deploy from scratch',
    },
    {
      command: 'vibecarbon deploy prod -mode k8s -restore latest -y',
      description: 'stand up a fresh cluster and restore the DB from S3 (DR)',
    },
    {
      command: 'vibecarbon deploy prod -mode k8s-ha -allow-degraded',
      description: 'finalize an HA deploy even if the standby is not yet streaming (degraded DR)',
    },
  ],
};

/**
 * Translate the new flag values into the legacy `args` shape that
 * gatherDeploymentConfig + executeDeployment + the orchestrator read.
 * Keeps the orchestration code (hundreds of lines, well-tested)
 * untouched while the front-end parsing/help layer changes.
 */
function buildLegacyArgs(values, positional) {
  const mode = values.mode || null;
  const envSeed = positional.env || values.env || null;
  return {
    env: envSeed,
    provider: values.provider || null,
    region: values.region || null,
    yes: !!values.y,
    full: !!values.full,
    // Mode flags — orchestrator branches on these.
    compose: mode === 'compose' || mode === 'compose-ha',
    k8s: mode === 'k8s' || mode === 'k8s-ha',
    ha: mode === 'compose-ha' || mode === 'k8s-ha',
    // HA standby region — settable via -standby-region, else the interactive
    // prompt / saved config / same-continent default fill it in.
    secondaryRegion: values['standby-region'] || null,
    // Everything below is no longer settable via CLI flag; the
    // interactive prompt + `.vibecarbon.json` cover these. Defaults
    // keep gatherDeploymentConfig's `args.X || envConfig.X || …`
    // chains working unchanged.
    serverType: null,
    masterServerType: null,
    workerServerType: null,
    supabaseServerType: null,
    domain: null,
    dnsProvider: null,
    s3AccessKey: null,
    s3SecretKey: null,
    s3Region: null,
    backupSchedule: null,
    backupRetentionDays: null,
    minWorkers: null,
    maxWorkers: null,
    // direct / push are mutated by the interactive build-mode prompt
    // in lib/deploy/prompts.js when CI/CD is configured. Keep them
    // initialized for the orchestrator's resolveBuildMode read.
    direct: false,
    push: false,
    // DR: seed the fresh DB from S3 via wal-g (k8s only). null = normal deploy.
    restore: values.restore || null,
    // HA gate opt-out: accept a warm/degraded standby instead of failing when
    // replication isn't verifiably streaming. Ignored for non-HA modes.
    allowDegraded: !!values['allow-degraded'],
  };
}

/**
 * Main command function. Args are pre-parsed in run() — parse errors and
 * -h/-v resolve there, BEFORE the deploy log wrapper, so a bare help
 * invocation doesn't create a log file or print the log-path epilogue.
 *
 * @param {Record<string, any>} values - parsed flag values
 * @param {Record<string, any>} positional - parsed positionals
 */
async function main(values, positional) {
  // 0a. Confirm we're inside a Vibecarbon project before anything else.
  // assertInProjectDir() is the documented FIRST action for every
  // project-scoped command (see lib/project-guard.js): an accidental
  // `vibecarbon deploy` from a parent directory (e.g. ~/repos) must print
  // the canonical "not in a project" message and exit non-zero — it must not
  // fall through to the license upsell or a secret-scan that walks sibling
  // repos. This matches scale/backup/restore/failover, which all assert
  // first; deploy previously gated the license first and so exited 0 (the
  // upsell path) outside a project, tripping the not-in-project contract.
  assertInProjectDir();

  // 0b. The license gate for deploy is mode-based, not command-based: a
  // single-server Compose deploy is free, so it can't be gated here
  // pre-dispatch (before the mode is even known — `deploy` can resolve the
  // architecture interactively). gatherDeploymentConfig() below calls
  // requirePaidTier() immediately after resolveDeployMode(), before any
  // region/DNS/credential prompts.

  // 0c. Refuse to deploy if the working tree contains likely secrets.
  // We push the project's tracked files to GitHub during deploy (CI,
  // GitOps, throwaway e2e repos), and a leak there is permanent
  // — GitHub's secret-scanner will email the user even if the repo is
  // deleted seconds later. Block early; tell the operator how to opt
  // out a confirmed false positive via .vibecarbonignore.
  {
    const { refuseIfSecretsPresent } = await import('./lib/secret-scan.js');
    await refuseIfSecretsPresent('deploy');
  }

  // 0d. Warn about env-file drift before any prompt or provisioning work.
  // The deploy ships `.env` to the server; a runtime key that only lives in
  // `.env.local` (hand-migrated env, `configure` never run) deploys as blank
  // and fails at feature-use time, not deploy time. Warning only — a key can
  // legitimately be local-first mid-setup — but it must be loud and name the
  // keys (vibecarbon.com 2026-08-22: STRIPE_/SMTP_ shipped empty this way).
  {
    const { findEnvDrift } = await import('./lib/project.js');
    const drifted = findEnvDrift(process.cwd());
    if (drifted.length > 0) {
      p.log.warn(
        `These keys are set in .env.local but empty or missing in .env:\n  ${drifted.join(', ')}\n` +
          'Deploys ship .env to the server, so the deployed app will NOT see them. ' +
          'If they are app config (not provider credentials), copy them into .env — ' +
          '`vibecarbon configure` writes both files.',
      );
    }
  }

  // Build the legacy `args` struct that gatherDeploymentConfig and the
  // orchestrator both read. Field translations live in buildLegacyArgs;
  // the orchestration code stays untouched.
  const args = buildLegacyArgs(values, positional);

  // 1. Gather configuration
  const gatheredConfig = await gatherDeploymentConfig(args);

  // 1b. Guarantee the lockfile the Dockerfile is about to COPY.
  //
  // The generated Dockerfile does `COPY package.json <lockfile> ./` followed by
  // a strict `npm ci`. Absent the lockfile, the build dies at COPY with a raw
  // BuildKit error — after every prompt is answered and, on the cloud paths,
  // after the infrastructure exists. This runs before executeDeployment, so the
  // failure is still free. A project from `vibecarbon create` always has its
  // lockfile, so the common path is a single existsSync.
  //
  // Deliberately AFTER gatherDeploymentConfig, not among the 0x preflights:
  // gathering is what validates the region and enforces the license gate, and
  // generating a lockfile for a deploy that is about to be refused would spend
  // a minute of the operator's time to reach the same refusal.
  {
    const cwd = process.cwd();
    const pm = detectPackageManager(cwd);
    const s = spinner();
    let started = false;
    const { lockfile, generated, accepted } = ensureLockfile(cwd, pm, {
      onStep: (message) => {
        if (!started) {
          s.start(message);
          started = true;
        } else {
          s.message(message);
        }
      },
    });
    if (started) s.stop(accepted ? `Generated ${lockfile}` : `Could not generate ${lockfile}`);

    if (!accepted) {
      p.log.error(
        `No ${lockfile} that \`${pm}\` accepts could be produced for this project.\n\n` +
          `Your Docker build and the scaffolded CI workflow both install with a\n` +
          `strict lockfile replay, so deploying now would fail there instead: \n` +
          `after the infrastructure exists. Stopping here.\n\n` +
          `To see why:\n  cd ${cwd}\n  ${pm === 'npm' ? 'npm ci --dry-run' : `${pm} install`}\n\n` +
          `Removing node_modules and ${lockfile}, then re-running the install,\n` +
          `usually clears it.`,
      );
      process.exit(1);
    }

    // Stage it. Deploy pushes tracked files to GitHub for CI and GitOps, and
    // commitAndPush only stages the workflow file — an untracked lockfile would
    // be present locally yet missing from the repo the runner builds from.
    if (generated) {
      runCommand(buildGitAddArgv(cwd, [lockfile]), { silent: true, ignoreError: true });
    }
  }

  // 2. Execute deployment
  await executeDeployment(args, gatheredConfig);
}

/**
 * Run function called by CLI
 */
export async function run(args) {
  const { values, positional, handled } = parseFlagsOrExit(args, SPEC);
  if (handled) return;
  // Snoop the env arg (last positional, falls back to "deploy") so the
  // log filename is informative without re-doing full arg parsing here.
  const sniffedEnv = args.find((a) => !a.startsWith('-')) ?? 'deploy';
  try {
    const { logPath } = await withDeployLog(sniffedEnv, () => main(values, positional));
    // Print at the end (and only on success, since errors print their own
    // path via the catch block in withDeployLog).
    console.log(`\nDeploy log saved: ${logPath}`);
  } catch (err) {
    // The logger has already restored stdout/stderr by the time we reach
    // this catch. Print where the log lives so the operator can review.
    const logDirHint = `${process.env.HOME || '~'}/.vibecarbon/logs/`;
    console.error(`\nDeploy log saved under ${logDirHint}`);
    throw err;
  }
}

// Re-exports for testing and backward compatibility
export {
  buildComposeTypeOptions,
  buildK8sProfileOptions,
  COMPOSE_MIN_RAM_GB,
  checkDependency,
  checkExistingRepo,
  checkGitHubAuth,
  checkGitRemote,
  commitAndPush,
  createGitBranch,
  createGitHubRepository,
  DEFAULT_WORKER_MAX,
  DEFAULT_WORKER_MIN,
  detectCurrentProfile,
  detectPackageManager,
  generateSSHKeyPair,
  getBranchName,
  getGitHubUsername,
  getProvider,
  getProviderClass,
  HetznerS3Provider,
  K8S_PROFILES,
  listProviders,
  loadProjectConfig,
  main,
  monitorDeployment,
  normalizeEnvName,
  resolveDeployMode,
  runCommand,
  SPEC,
  sanitizeBucketName,
  saveProjectConfig,
  setupGitHubEnvironment,
  setupGitHubIntegration,
  VERSION,
  waitForSSH,
};
