/**
 * Vibecarbon Deploy Command
 * Automates deployment to cloud providers with full environment management
 */

import * as p from '@clack/prompts';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { spinner } from './lib/cli/progress.js';
import { checkDependency, runCommand } from './lib/command.js';
import { loadProjectConfig, saveProjectConfig } from './lib/config.js';
import { resolveDockerHubCreds } from './lib/deploy/docker-hub.js';
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
import { assertOperatorConfig, operatorCheckEnvs } from './lib/deploy/preflight.js';
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
import { operatorScopesForProviderAndDns } from './lib/dns-provider.js';
import { resolveEnvSeed } from './lib/env-identity.js';
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
      name: 'server-type',
      value: '<id>',
      description:
        'Server type (provider-specific, e.g. cpx22). Compose: the whole box; k8s: blanket for master/supabase/worker unless .vibecarbon.json sets them per role. Without it a scripted deploy takes the region default.',
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
    {
      command: 'vibecarbon deploy prod -region fsn1 -server-type cpx22 -y',
      description: 'scripted compose deploy at an explicit placement',
    },
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
    // Server type is settable again (2026-09-15): a -y compose deploy with
    // no serverType in the env block took the region's MEDIUM-tier default
    // (cpx32/cx33, ~2x cpx22) and the only override was editing
    // .vibecarbon.json — see the region-move runbook in docs/deploy-hetzner.md.
    // Name matches `failover -server-type`; `scale -type` means "scale TO".
    serverType: values['server-type'] || null,
    // Everything below is not settable via CLI flag; the interactive
    // prompt + `.vibecarbon.json` cover these. Defaults keep
    // gatherDeploymentConfig's `args.X || envConfig.X || …` chains working
    // unchanged.
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
  // single-server Compose deploy is free, and every deploy into a paid mode
  // checks this project's subscription. It can't be gated here pre-dispatch
  // (before the mode is even known, since `deploy` can resolve the
  // architecture interactively). gatherDeploymentConfig() below calls
  // requireDeployEntitlement() immediately after resolveDeployMode(), before
  // any region/DNS/credential prompts.

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

  // 0d. Env-file preflight before any prompt or provisioning work. The deploy
  // ships `.env` to the server; a runtime key that only lives in `.env.local`
  // (hand-migrated env, `configure` never run) deploys as blank. Two tiers:
  // keys compose itself requires stop the deploy here; everything else is a
  // loud warning naming the keys — a key can legitimately be local-first
  // mid-setup (vibecarbon.com 2026-08-22: STRIPE_/SMTP_ shipped empty).
  {
    const { findEnvDrift, findMissingRequiredEnv } = await import('./lib/project.js');
    // 0d-i. HARD STOP for keys the compose stack refuses to start without
    // (`${KEY:?}` in docker-compose.prod.yml — JWT_SECRET, POSTGRES_PASSWORD,
    // …). A missing `.env` is the usual cause: it is gitignored, so a fresh
    // clone or a second worktree has none. Warning here and failing at
    // `start-compose-stack` meant a server was provisioned, the image pushed
    // and DNS repointed first (vibecarbon-web prod move, 2026-09-15). The
    // stack was never going to start; stop before anything is created.
    const missing = findMissingRequiredEnv(process.cwd());
    if (missing.length > 0) {
      p.log.error(
        `The compose stack cannot start: these keys are empty or missing in .env:\n  ${missing.join(', ')}\n` +
          'Deploys ship .env to the server as its runtime baseline (.env.local never leaves ' +
          'this machine). If you are deploying from a fresh clone or another worktree, copy ' +
          '.env (and .vibecarbon/) from the checkout you last deployed from; otherwise run ' +
          '`vibecarbon configure`, which writes both files. Nothing was provisioned.',
      );
      process.exit(1);
    }
    // 0d-ii. Warn about the softer drift: keys set in .env.local but not in
    // .env that the stack CAN start without and the app fails on later.
    const drifted = findEnvDrift(process.cwd()).filter((k) => !missing.includes(k));
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

  // 0e. Gate 1 (operator config hygiene, spec §3): refuse a malformed
  // operator credential before the FIRST network call this command makes.
  // gatherDeploymentConfig below resolves the provider token by verifying
  // it against the LIVE provider API (Provider.promptApiToken →
  // hetzner-guided-setup.js's getApiToken, etc.), then fetches server
  // types, then — for a cross-cloud native DNS pick — looks up zones on the
  // DNS backend. All of that happens before this task's other two gates
  // (2a/2b, inside gatherDeploymentConfig itself) could otherwise catch a
  // bad value, so this is the true first stop.
  //
  // Scopes here are only what's ALREADY KNOWN at this point: a brand-new
  // environment's provider/DNS aren't picked yet (no -provider flag, no
  // persisted binding) — those gate at 2a/2b once resolved. access/tls/state
  // are always checked; their keys are all optional, so a merely-absent one
  // is never a problem, only an actually-malformed one.
  //
  // `presence: false` — a MISSING credential is never refused here, only a
  // MALFORMED one, matching Gate 2a/2b. This is deliberate, not merely
  // consistent: `requireDeployEntitlement` (the license gate for a paid
  // tier) runs inside gatherDeploymentConfig, AFTER mode resolution but
  // BEFORE any credential is read — deliberately, so an unpaid k8s/HA
  // attempt is refused with "License required" rather than a credential
  // complaint, even when both are true at once (see
  // tests/integration/cli/_global/license-gate.test.ts, which pins this
  // exact ordering with every provider credential scrubbed). Gate 1 runs
  // before mode is even known, so it cannot tell a free deploy with no
  // token yet (fine — a prompt or, for -y, a clean "Cannot prompt" refusal
  // is coming) from a paid one that should hear about money first; `presence:
  // false` defers that judgment to the code that already makes it correctly.
  // A malformed value has no such ambiguity — it's wrong regardless of tier
  // or payment status, so it still refuses here, before anything else runs.
  //
  // FILE-AWARE (review residual, PR #112): access/tls/state keys are stored
  // in the project's `.env`/`.env.local` (`where` in config-registry.js) —
  // ACME_CA_SERVER's shipping copy is the FILE's, and bootstrapOperatorEnv
  // never folds runtime-config into process.env — so the gate checks the
  // merged files alongside the shell (`operatorCheckEnvs`: file's problem
  // first, one line per key; a valid shell value never masks a bad file
  // value). `operator shell` keys (registry) stay shell-only.
  {
    const projectConfig = loadProjectConfig();
    if (projectConfig) {
      const environment = normalizeEnvName(args.env || 'prod');
      const { envConfig } = resolveEnvSeed(projectConfig, environment);
      const providerId =
        args.provider ?? envConfig.provider ?? (envConfig.deployMode ? 'hetzner' : null);
      const dnsProvider = args.dnsProvider ?? envConfig.dnsProvider ?? null;

      const { scopes: providerDnsScopes, keys } = operatorScopesForProviderAndDns(
        providerId,
        dnsProvider,
      );
      const scopes = ['access', 'tls', 'state', ...providerDnsScopes];
      if (resolveDockerHubCreds()) scopes.push('registry');

      assertOperatorConfig(scopes, {
        env: operatorCheckEnvs(process.cwd()),
        presence: false,
        keys,
      });
    }
  }

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
  buildLegacyArgs,
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
