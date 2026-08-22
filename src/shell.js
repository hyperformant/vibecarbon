/**
 * `vibecarbon shell [env]`
 *
 * Drops the operator into an interactive bash with KUBECONFIG and the
 * environment's provider CLI token exported (Hetzner: HCLOUD_TOKEN +
 * HCLOUD_NETWORK; a provider whose CCM has no network-identity env var —
 * e.g. DigitalOcean — exports just the token) so kubectl + the provider CLI
 * "just work" against the named environment. Use SSH directly for
 * per-node debug (the master IP + ssh key path are in the welcome
 * banner). Companion to `vibecarbon deploy` — once the cluster is up
 * the operator can iterate against it interactively.
 *
 * Defaults: env = first non-flag arg, falling back to `prod`. The
 * kubeconfig + ssh key paths follow the same convention as the deploy
 * code path:
 *   <cwd>/.vibecarbon/kubeconfig-<env>
 *   <cwd>/.vibecarbon/ssh-<env>
 *
 * Env vars are sourced from the provider's TOKEN_ENV (env or the project's
 * .env.local — see bootstrapOperatorEnv) for CLI_TOKEN_ENV, and from
 * .vibecarbon.json (the network env var, when the provider has one).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { c } from './lib/colors.js';
import { loadProjectConfig } from './lib/config.js';
import { ensureOperatorIpAccessWarn } from './lib/operator-ip.js';
import { assertInProjectDir } from './lib/project-guard.js';
import { providerFor, providerIdFor, resolveProviderToken } from './lib/providers/index.js';

/**
 * Trailing "Try:" hint in the welcome banner (R9). `hcloud server list`
 * only makes sense when the environment's compute provider is Hetzner —
 * conditionally dropped so a non-Hetzner shell doesn't recommend a CLI
 * tool that isn't relevant. Exported (pure, id-in/string-out) so it's
 * testable without spawning the actual shell.
 * @param {string} providerId
 * @returns {string}
 */
export function buildShellTryHint(providerId) {
  const parts = ['kubectl get nodes -o wide', 'ssh root@<ip> journalctl -u k3s'];
  if (providerId === 'hetzner') parts.push('hcloud server list');
  return `Try: ${parts.join('   |   ')}`;
}

// Static help text (SPEC is built once, at module load, before any argv is
// parsed — no envConfig exists yet to know the target env's provider). Falls
// back to the same sanctioned `?? 'hetzner'` default providerFor() uses
// everywhere else (R9) — mirrors destroy.js's identical SPEC-at-module-load
// pattern (see destroySpecProviderName there).
const shellSpecProvider = providerFor(undefined);

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string }} */
const SPEC = {
  name: 'shell',
  summary: 'Drop into an interactive shell with cluster context',
  description: [
    'Drops you into an interactive bash with KUBECONFIG, VC_SSH_KEY,',
    `${shellSpecProvider.CLI_TOKEN_ENV}, ${shellSpecProvider.K8S_ASSETS.networkEnvVar}, and VC_ENV exported so kubectl + hcloud`,
    'work against the named environment. Use SSH directly for per-node debug',
    '(master IP + ssh key path are in the welcome banner).',
    '',
    'Exports:',
    '  KUBECONFIG       <cwd>/.vibecarbon/kubeconfig-<env>',
    '  VC_SSH_KEY       <cwd>/.vibecarbon/ssh-<env>',
    `  ${shellSpecProvider.CLI_TOKEN_ENV}     From ${shellSpecProvider.TOKEN_ENV} (env or .env.local)`,
    `  ${shellSpecProvider.K8S_ASSETS.networkEnvVar}   From .vibecarbon.json (if present)`,
    '  VC_ENV           Environment name (so PS1 can reference it)',
  ].join('\n'),
  positional: [
    {
      name: 'env',
      optional: true,
      description: 'Environment to load (default: prod)',
    },
  ],
  flags: [{ name: 'h', boolean: true, description: 'Show this help' }],
};

function loadHcloudNetwork(envName) {
  return loadProjectConfig()?.environments?.[envName]?.networkId ?? null;
}

export async function run(args) {
  const { positional, handled } = parseFlagsOrExit(args, SPEC);
  if (handled) return;

  // Project guard runs first so an accidental `vibecarbon shell` from a
  // parent directory emits the canonical message instead of confusing
  // "kubeconfig not found" warnings.
  assertInProjectDir();

  const envName = /** @type {string|undefined} */ (positional.env) ?? 'prod';
  const cwd = process.cwd();
  const kubeconfig = join(cwd, '.vibecarbon', `kubeconfig-${envName}`);
  const sshKey = join(cwd, '.vibecarbon', `ssh-${envName}`);

  // Warn but don't bail if either is missing — the operator may be
  // debugging exactly that case (e.g. cluster is half-up, only one of
  // the two artifacts landed). Better to drop them in with what we have.
  if (!existsSync(kubeconfig)) {
    console.error(`${c.warning('!')} kubeconfig not found at ${kubeconfig}`);
    console.error('  kubectl will not work until the cluster is bootstrapped.');
  }
  if (!existsSync(sshKey)) {
    console.error(`${c.warning('!')} ssh key not found at ${sshKey}`);
    console.error('  Per-node ssh debug will not work until deploy has run.');
  }

  const envConfig = loadProjectConfig()?.environments?.[envName];
  // Resolved once per flow — see providerFor() in lib/providers/index.js.
  const Provider = providerFor(envConfig);
  const providerToken = resolveProviderToken(providerIdFor(envConfig)) ?? null;
  if (!providerToken) {
    console.error(
      `${c.warning('!')} ${Provider.TOKEN_ENV} not set — hcloud CLI will be unauthenticated.`,
    );
  }
  const hcloudNetwork = loadHcloudNetwork(envName);

  // Auto-detect operator IP and ensure firewall lets us in. If the IP is
  // already covered by an entry in .vibecarbon.json's operatorCidrs we
  // refresh lastUsedAt and proceed silently.
  const projectConfig = loadProjectConfig();
  await ensureOperatorIpAccessWarn({
    projectConfig,
    environment: envName,
    apiToken: providerToken,
  });

  // Per-env known_hosts file (deploy populates this — see lib/host-keys.js).
  // The ssh wrapper below points at it so reconnects after Hetzner recycles
  // a public IP don't trip TOFU rejections, and host-key checking still
  // works the way the deploy path expects.
  const khPath = join(cwd, '.vibecarbon', `known_hosts_${envName}`);

  const env = {
    ...process.env,
    KUBECONFIG: kubeconfig,
    VC_SSH_KEY: sshKey,
    VC_ENV: envName,
    VC_KNOWN_HOSTS: khPath,
  };
  // Provider-owned env bag — see BaseProvider.buildIacEnv (the census bans
  // hand-writing the CLI_TOKEN_ENV env assignment outside base.js).
  if (providerToken) Object.assign(env, Provider.buildIacEnv(providerToken));
  // networkEnvVar is '' for a provider whose CCM has no injected-env-var
  // network identity (e.g. DO, which discovers VPC membership from droplet
  // metadata) — guard against exporting an env var with an empty name.
  const networkEnvVar = Provider.K8S_ASSETS.networkEnvVar;
  if (networkEnvVar && hcloudNetwork) env[networkEnvVar] = String(hcloudNetwork);

  // Build a custom PS1 that's obviously not the user's normal prompt.
  // --rcfile lets us inherit ~/.bashrc but layer on the prompt, a welcome
  // banner showing what's exported, and an `ssh` shell function that
  // matches the deploy path's options (BatchMode=yes so a missing key
  // doesn't fall back to interactive password prompt; accept-new against
  // VC_KNOWN_HOSTS so first-touch hosts don't y/N the operator).
  const rcLines = [
    '[ -f ~/.bashrc ] && source ~/.bashrc',
    `export PS1='\\[\\033[1;36m\\](vc:${envName})\\[\\033[0m\\] \\w \\$ '`,
    // Wrap ssh + scp so plain `ssh root@<ip>` works without password fall-
    // back. Use a function (not alias) so it composes cleanly with `|` /
    // `<()` and so the user can override per-call (`ssh -o BatchMode=no
    // ...`) — function args come first, then our defaults.
    'ssh()  { command ssh  -i "$VC_SSH_KEY" -o "UserKnownHostsFile=$VC_KNOWN_HOSTS" -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10 "$@"; }',
    'scp()  { command scp  -i "$VC_SSH_KEY" -o "UserKnownHostsFile=$VC_KNOWN_HOSTS" -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10 "$@"; }',
    'export -f ssh scp',
    'echo ""',
    `echo "  vibecarbon shell: env=${envName}"`,
    `echo "  KUBECONFIG=${kubeconfig}"`,
    `echo "  VC_SSH_KEY=${sshKey}"`,
    `echo "  VC_KNOWN_HOSTS=${khPath}"`,
    providerToken
      ? `  echo "  ${Provider.CLI_TOKEN_ENV}=<set>"`
      : `  echo "  ${Provider.CLI_TOKEN_ENV}=<unset>"`,
    // Banner line dropped entirely for a provider with no network env var —
    // see the export guard above for why.
    ...(networkEnvVar
      ? [
          hcloudNetwork
            ? `echo "  ${networkEnvVar}=${hcloudNetwork}"`
            : `echo "  ${networkEnvVar}=<unset>"`,
        ]
      : []),
    'echo ""',
    `echo "${buildShellTryHint(providerIdFor(envConfig))}"`,
    'echo "ssh/scp are pre-configured (BatchMode + per-env known_hosts); no password prompts."',
    'echo "Type \\"exit\\" to leave."',
    'echo ""',
  ];
  const rcContent = rcLines.join('\n');

  // Write rc to a tmpfile that's deleted when the shell closes.
  const { writeFileSync, unlinkSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tmpDir = mkdtempSync(join(tmpdir(), 'vibecarbon-shell-'));
  const rcPath = join(tmpDir, 'bashrc');
  writeFileSync(rcPath, rcContent, { mode: 0o600 });

  const child = spawn('bash', ['--rcfile', rcPath, '-i'], {
    stdio: 'inherit',
    env,
    cwd,
  });

  await new Promise((resolve) => {
    child.on('exit', (code) => {
      try {
        unlinkSync(rcPath);
      } catch {
        // best-effort cleanup
      }
      process.exit(code ?? 0);
      resolve();
    });
  });
}
