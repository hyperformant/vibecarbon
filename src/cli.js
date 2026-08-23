#!/usr/bin/env node

/**
 * Vibecarbon CLI
 *
 * A unified CLI for creating and managing Vibecarbon applications.
 *
 * Usage:
 *   vibecarbon create [app-name]      # Create new project
 *   vibecarbon deploy                 # Deploy to cloud
 *   vibecarbon destroy                # Tear down environment
 *   vibecarbon -h                     # Show help
 */

import dns from 'node:dns';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { installUnsettledExitGuard } from './lib/cli/exit-guard.js';
import { c } from './lib/colors.js';
import { shouldGate } from './lib/licensing/gate.js';
import { perfTimer } from './lib/perf.js';
import { bootstrapOperatorEnv } from './lib/project.js';
import { VERSION } from './lib/version.js';

// Prefer IPv4 to avoid timeouts on systems with broken IPv6 connectivity.
// Node.js/undici tries IPv6 first by default, which causes fetch() to hang
// when the host resolves to an AAAA record but IPv6 routing is broken.
dns.setDefaultResultOrder('ipv4first');

// Hard-disable any ssh-askpass / interactive password fallback for every
// child ssh/scp this process spawns. Belt to BatchMode=yes's suspenders:
// individual ssh callsites already pass `-o BatchMode=yes`, but a single
// missed callsite causes ssh to spawn a graphical password dialog that
// hangs the deploy until the operator-run timeout fires (multiple-hour
// recurring footgun observed since project inception — manifested as
// "k3s did not become ready" / "Canceled" timeouts that masked the
// actual cause). With these env vars set process-wide, no ssh under us
// can EVER prompt regardless of what flags it inherits:
//   - SSH_ASKPASS_REQUIRE=never (OpenSSH 8.4+) — refuse askpass entirely.
//   - DISPLAY unset — older sshd/ssh fall back to /bin/false instead of X.
//   - SSH_ASKPASS=/bin/false — if anything still tries, it exits cleanly.
process.env.SSH_ASKPASS_REQUIRE = 'never';
process.env.SSH_ASKPASS = '/bin/false';
delete process.env.DISPLAY;

/**
 * Guard against unsupported platforms. Native Windows is not supported —
 * users should run vibecarbon inside WSL2, which provides a full Linux
 * environment including Docker, SSH, and rsync.
 *
 * @param {NodeJS.Platform} platform - Defaults to process.platform; injectable for testing
 */
export function checkPlatform(platform = process.platform) {
  if (platform === 'win32') {
    console.error('Windows native is not supported. Please run vibecarbon inside WSL2.');
    console.error('See: https://learn.microsoft.com/en-us/windows/wsl/install');
    process.exit(1);
  }
}

/**
 * The Node floor, read from package.json `engines.node` (computed by
 * scripts/sync-node-version.js from the lockfile). Reading it here means there
 * is no second copy to drift.
 *
 * @returns {string|null} the `X.Y.Z` minimum, or null if it can't be parsed
 */
function nodeEnginesFloor() {
  try {
    const require = createRequire(import.meta.url);
    const { engines } = require('../package.json');
    const m = String(engines?.node ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
  } catch {
    return null;
  }
}

/**
 * Guard against Node versions below the engines floor. `engines.node` only
 * produces an npm *warning* on install, so without this a user on Node 20/22
 * gets a working `create` and then a cryptic crash (undici throws on import)
 * at the first deploy/provider command. Fail fast with a clear message instead.
 *
 * @param {string} current - defaults to process.versions.node; injectable for testing
 * @param {string|null} floor - defaults to the package's engines.node minimum
 */
export function checkNodeVersion(current = process.versions.node, floor = nodeEnginesFloor()) {
  if (!floor) return;
  const cur = String(current)
    .replace(/^v/, '')
    .match(/^\d+\.\d+\.\d+/)?.[0];
  if (!cur) return;
  const [a, b] = [cur, floor].map((v) => v.split('.').map(Number));
  const below =
    a[0] < b[0] ||
    (a[0] === b[0] && a[1] < b[1]) ||
    (a[0] === b[0] && a[1] === b[1] && a[2] < b[2]);
  if (below) {
    console.error(`vibecarbon requires Node.js ${floor} or newer; you are running ${current}.`);
    console.error('Upgrade Node (e.g. `nvm install 24 && nvm use 24`) or see https://nodejs.org.');
    process.exit(1);
  }
}

// Ensure Ctrl+C always exits immediately. Without this, SIGINT during execSync
// is caught by retry loops and the process becomes unresponsive.
process.on('SIGINT', () => process.exit(130));

// All registered subcommands — tested in tests/unit/cli/routing.test.ts
export const KNOWN_COMMANDS = [
  'create',
  'add',
  'remove',
  'up',
  'down',
  'reset',
  'deploy',
  'destroy',
  'status',
  'backup',
  'restore',
  'failover',
  'scale',
  'upgrade',
  'configure',
  'activate',
  'deactivate',
  'shell',
  'diagnose',
  'console',
  'access',
];

function showHelp() {
  console.log(`
${c.bold('Vibecarbon CLI')} ${c.dim(`v${VERSION}`)}

${c.bold('USAGE')}
  ${c.info('vibecarbon')} <command> [flags]

${c.bold('DEV COMMANDS')}
  ${c.info('create')} <project-name>    Create a new Vibecarbon project
  ${c.info('up')}                       Start local development environment
  ${c.info('down')}                     Stop local development environment
  ${c.info('status')}                   Show project and deployment status
  ${c.info('reset')}                    Reset local environment (removes all data)
  ${c.info('add')} [feature]            Add features (observability, redis)
  ${c.info('remove')} [feature]         Remove features from a project
  ${c.info('configure')}                Configure external services and project settings (billing, OAuth, SMTP, CI/CD, globalization, etc.)
  ${c.info('upgrade')}                  Upgrade infrastructure files to latest template

${c.bold('DEPLOY COMMANDS')}
  ${c.info('deploy')} [env]             Deploy an environment
  ${c.info('destroy')} [env]            Tear down an existing environment
  ${c.info('backup')} [env]             Create, list, or download database backups
  ${c.info('restore')} [env]            Restore database from backup
  ${c.info('failover')} [env]           Initiate failover to standby region
  ${c.info('scale')} [env]              Scale worker nodes and instance sizes

${c.bold('DEBUG COMMANDS')}
  ${c.info('shell')} [env]              Interactive bash with KUBECONFIG + cloud credentials exported
  ${c.info('diagnose')} [env]           Dump full cluster state (nodes, pods, Flux, network) to ~/.vibecarbon/diag-*
  ${c.info('console')} <node>           Open the cloud provider's web console for a node (last-resort kernel-boot debug)
  ${c.info('access')} [subcommand]      Manage SSH + k8s-API operator-CIDR allowlist

${c.bold('LICENSE COMMANDS')}
  ${c.info('activate')} [key]           Activate a license key
  ${c.info('deactivate')}               Remove the current license

${c.bold('GLOBAL FLAGS')}
  ${c.dim('-h')}    Show help for a command
  ${c.dim('-v')}    Show version number

  ${c.dim('Vibecarbon uses single-dash flags only; no double-dash forms.')}
  ${c.dim('Run any command with -h to see its specific flags.')}

${c.bold('EXAMPLES')}
  ${c.dim('# Create a new project')}
  vibecarbon create my-app
  cd my-app

  ${c.dim('# Local development')}
  vibecarbon up

  ${c.dim('# Add features')}
  vibecarbon add observability

  ${c.dim('# Wire up external services')}
  vibecarbon configure

  ${c.dim('# Deploy to production')}
  vibecarbon deploy prod

  ${c.dim('# Backup and restore')}
  vibecarbon backup prod -l
  vibecarbon restore prod

${c.bold('DOCUMENTATION')}
  https://github.com/hyperformant/vibecarbon
`);
}

function showVersion() {
  console.log(`vibecarbon v${VERSION}`);
}

async function main() {
  checkPlatform();
  checkNodeVersion();

  // Fold operator-secret provider credentials (Hetzner/DO/Cloudflare tokens,
  // S3/Spaces keys) from this project's .env.local into process.env, so
  // every existing env-first credential resolution site picks them up
  // unchanged. Allowlist-only, real env wins — see bootstrapOperatorEnv()
  // in lib/project.js. Outside a project (e.g. `create`, or no .env.local
  // yet) this is a silent no-op. Must run before command dispatch.
  bootstrapOperatorEnv();

  const args = process.argv.slice(2);

  // Handle no arguments
  if (args.length === 0) {
    showHelp();
    process.exit(0);
  }

  const command = args[0];

  // Top-level help / version. Single-dash only — `--help` falls through
  // to the unknown-command branch, matching the per-command flag policy.
  if (command === '-h') {
    showHelp();
    process.exit(0);
  }

  if (command === '-v') {
    showVersion();
    process.exit(0);
  }

  // Route to subcommands. Every command's total wall-clock is logged as
  // `[perf] cli.<command>.total <ms>ms` when VIBECARBON_PERF=1 is set — the
  // e2e runner forces it on so we always have total + sub-step
  // breakdowns per CLI invocation.
  const subcommandArgs = args.slice(1);

  // Central license gate chokepoint: any command classified 'paid' in
  // COMMAND_GATES is gated HERE, pre-dispatch, so it can never ship
  // unguarded (COMMAND_GATES must classify every KNOWN_COMMAND — enforced
  // by tests/unit/licensing/command-gates.test.ts). No command is
  // currently 'paid' — licensing is deploy-mode-based (deploy/backup/
  // restore/failover/scale gate themselves in-flow via requirePaidTier()
  // once their deploy mode is known; see src/lib/licensing/gate.js) — but
  // this chokepoint stays wired up for a future command-wide paid feature.
  // Ordering contract: the canonical "not in a project" refusal must win
  // over the license upsell (all paid commands are project-scoped), and
  // -h/-v invocations are never gated — shouldGate() handles the bypass.
  if (shouldGate(command, subcommandArgs)) {
    const { assertInProjectDir } = await import('./lib/project-guard.js');
    assertInProjectDir();
    const { requireLicense } = await import('./lib/licensing/index.js');
    requireLicense(command);
  }

  const commandTimer = perfTimer(`cli.${command}.total`);

  switch (command) {
    case 'create': {
      // Dynamically import and run the create command
      const createModule = await import('./create.js');
      await createModule.run(subcommandArgs);
      break;
    }

    case 'add': {
      // Dynamically import and run the add command
      const addModule = await import('./add.js');
      await addModule.run(subcommandArgs);
      break;
    }

    case 'remove': {
      // Dynamically import and run the remove command
      const removeModule = await import('./remove.js');
      await removeModule.run(subcommandArgs);
      break;
    }

    case 'up': {
      const upModule = await import('./up.js');
      await upModule.run(subcommandArgs);
      break;
    }

    case 'down': {
      const downModule = await import('./down.js');
      await downModule.run(subcommandArgs);
      break;
    }

    case 'reset': {
      const resetModule = await import('./reset.js');
      await resetModule.run(subcommandArgs);
      break;
    }

    case 'deploy': {
      // Dynamically import and run the deploy command
      const deployModule = await import('./deploy.js');
      await deployModule.run(subcommandArgs);
      break;
    }

    case 'destroy': {
      // Dynamically import and run the destroy command
      const destroyModule = await import('./destroy.js');
      await destroyModule.run(subcommandArgs);
      break;
    }

    case 'status': {
      const statusModule = await import('./status.js');
      await statusModule.run(subcommandArgs);
      break;
    }

    case 'backup': {
      const backupModule = await import('./backup.js');
      await backupModule.run(subcommandArgs);
      break;
    }

    case 'restore': {
      const restoreModule = await import('./restore.js');
      await restoreModule.run(subcommandArgs);
      break;
    }

    case 'failover': {
      const failoverModule = await import('./failover.js');
      await failoverModule.run(subcommandArgs);
      break;
    }

    case 'scale': {
      const scaleModule = await import('./scale.js');
      await scaleModule.run(subcommandArgs);
      break;
    }

    case 'upgrade': {
      const upgradeModule = await import('./upgrade.js');
      await upgradeModule.run(subcommandArgs);
      break;
    }

    case 'configure': {
      const configureModule = await import('./configure.js');
      await configureModule.run(subcommandArgs);
      break;
    }

    case 'activate': {
      const activateModule = await import('./activate.js');
      await activateModule.runActivate(subcommandArgs);
      break;
    }

    case 'deactivate': {
      const activateModule = await import('./activate.js');
      await activateModule.runDeactivate(subcommandArgs);
      break;
    }

    case 'shell': {
      const shellModule = await import('./shell.js');
      await shellModule.run(subcommandArgs);
      break;
    }

    case 'diagnose': {
      const diagnoseModule = await import('./diagnose.js');
      await diagnoseModule.run(subcommandArgs);
      break;
    }

    case 'console': {
      const consoleModule = await import('./console.js');
      await consoleModule.run(subcommandArgs);
      break;
    }

    case 'access': {
      const accessModule = await import('./access.js');
      await accessModule.run(subcommandArgs);
      break;
    }

    default: {
      console.error(c.error(`Unknown command: ${command}`));
      console.log(`\nRun ${c.info('vibecarbon -h')} for usage information.`);
      process.exit(1);
    }
  }

  commandTimer.end();
}

// Only run when executed directly (not when imported by tests).
// realpathSync resolves symlinks on both sides so `vibecarbon` works
// even though process.argv[1] points to the bin symlink, not cli.js itself.
const isEntryPoint = (() => {
  try {
    return (
      process.argv[1] &&
      realpathSync(new URL(import.meta.url).pathname) === realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  // Armed before main() so a command that stalls on an unanswerable prompt
  // (or any other never-settling await) can't drain the event loop into a
  // silent exit 0 — see lib/cli/exit-guard.js for the v1/vultr RCA.
  const command = installUnsettledExitGuard();
  main().then(command.done, (error) => {
    command.done();
    console.error(c.error('Error:'), error.message);
    process.exit(1);
  });
}
