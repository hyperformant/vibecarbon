/**
 * `vibecarbon console <node>`
 *
 * Last-resort debug helper: opens the Hetzner web VNC console for a
 * server. Useful when SSH is broken (firewall change, cloud-init
 * failure, kernel panic) and the only way to see what the node is
 * doing is through Hetzner's out-of-band console.
 *
 * The node argument is a substring matched against server names — most
 * common is the project-name+role suffix, e.g. `master`, `supabase`,
 * `worker-1`, or the full server name.
 *
 * Tries `hcloud server request-console` (which prints the noVNC URL
 * directly) when available; otherwise falls back to printing the
 * Hetzner Cloud Console URL and the server ID so the operator can
 * click through. Does NOT auto-open a browser — the operator may be
 * remote/headless; printing the URL is the lowest-friction path.
 */

import { execFileSync } from 'node:child_process';
import { renderHelp } from './lib/cli/help.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { c } from './lib/colors.js';
import { loadProjectConfig } from './lib/config.js';
import { providerFor, providerIdFor, resolveProviderToken } from './lib/providers/index.js';

/**
 * Hetzner-only gate (R9). Console is a project-wide debug helper — it has
 * no `env` positional (the `node` argument is a substring matched across
 * every server in the project), so there's no single envConfig to resolve
 * a provider from. Under the documented single-provider-per-project
 * assumption (see access.js / operator-ip.js), the first configured
 * environment stands in for the whole project.
 *
 * Deliberately checks `providerIdFor` (a plain string read, never throws)
 * rather than `providerFor`/`getProviderClass` — this gate only needs the id
 * to build the message, so reading it directly is simpler and more robust
 * than resolving (and risking a throw from) a provider class it never uses.
 *
 * @param {{provider?: string}|null|undefined} envConfig
 * @returns {string|null} Error message, or null if the gate passes.
 */
export function hetznerOnlyGateError(envConfig) {
  const providerId = providerIdFor(envConfig);
  if (providerId === 'hetzner') return null;
  return `console is Hetzner-only today (VNC via Hetzner Cloud Console). Not supported for ${providerId}.`;
}

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'console',
  summary: "Open Hetzner's web VNC console for a node",
  positional: [
    {
      name: 'node',
      description:
        'Substring of a server name (e.g. "master", "supabase", or a full name like "myproject-prod-master")',
    },
  ],
  flags: [{ name: 'h', boolean: true, description: 'Show this help' }],
  examples: [
    {
      command: 'vibecarbon console master',
      description: 'opens the noVNC URL for the master node (kernel-boot debug)',
    },
  ],
};

export async function run(args) {
  // No-args invocation prints help and exits 1 (the legacy behavior —
  // console requires a node substring; no useful default).
  if (args.length === 0) {
    process.stdout.write(renderHelp(SPEC));
    process.exit(1);
  }

  const { positional, handled } = parseFlagsOrExit(args, SPEC);
  if (handled) return;

  const needle = /** @type {string|undefined} */ (positional.node);
  if (!needle) {
    console.error(c.error('Error: server name or substring is required'));
    process.stdout.write(renderHelp(SPEC));
    process.exit(1);
  }

  // Project-wide command, no `env` positional — the first configured
  // environment stands in for the whole project (see hetznerOnlyGateError's
  // docblock: single-provider-per-project assumption).
  const projectConfig = loadProjectConfig();
  const [firstEnvName] = Object.keys(projectConfig?.environments ?? {});
  const envConfig = projectConfig?.environments?.[firstEnvName];

  const gateError = hetznerOnlyGateError(envConfig);
  if (gateError) {
    console.error(c.error(`Error: ${gateError}`));
    process.exit(1);
  }

  // Gate passed, so providerIdFor(envConfig) is guaranteed 'hetzner' here —
  // providerFor() resolves safely (never hits an unregistered provider id).
  const Provider = providerFor(envConfig);
  const token = resolveProviderToken(providerIdFor(envConfig)) ?? null;
  if (!token) {
    console.error(c.error(`Error: ${Provider.TOKEN_ENV} not set`));
    process.exit(1);
  }

  // Provider-owned env bag — see BaseProvider.buildIacEnv (the census bans
  // hand-writing the CLI_TOKEN_ENV env assignment outside base.js).
  const env = { ...process.env, ...Provider.buildIacEnv(token) };

  // Resolve the node substring → server ID via hcloud CLI.
  let serversJson;
  try {
    serversJson = execFileSync('hcloud', ['server', 'list', '-o', 'json'], {
      env,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error(c.error('Failed to query hcloud server list:'));
    console.error(err.message ?? err);
    process.exit(1);
  }

  let servers;
  try {
    servers = JSON.parse(serversJson);
  } catch {
    console.error(c.error('hcloud returned non-JSON output; is hcloud >= 1.30 installed?'));
    process.exit(1);
  }

  const matches = servers.filter((s) => s.name?.includes(needle));
  if (matches.length === 0) {
    console.error(c.error(`No server matched "${needle}".`));
    console.error('Servers in this project:');
    for (const s of servers) console.error(`  - ${s.name} (${s.id})`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(c.warning(`Ambiguous match — ${matches.length} servers matched "${needle}":`));
    for (const s of matches) console.error(`  - ${s.name} (${s.id})`);
    console.error('Re-run with a more specific substring or the exact name.');
    process.exit(1);
  }

  const server = matches[0];
  console.log(`${c.bold('Server:')}  ${server.name} (id=${server.id})`);

  // Try `hcloud server request-console` first — gives a direct noVNC URL.
  try {
    const consoleOut = execFileSync(
      'hcloud',
      ['server', 'request-console', String(server.id), '-o', 'json'],
      { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const data = JSON.parse(consoleOut);
    console.log(`${c.bold('noVNC URL:')} ${data.wss_url ?? '(none returned)'}`);
    console.log(`${c.bold('Password:')}  ${data.password ?? '(none)'}`);
    console.log('');
    console.log(c.dim('Paste the URL into a noVNC client, or use the Hetzner web console.'));
  } catch {
    // Fallback: print the Hetzner Cloud Console URL.
    console.log(
      `${c.bold('Open in Hetzner Cloud Console:')} https://console.hetzner.cloud/projects/_/servers/${server.id}/graphics`,
    );
    console.log(c.dim('(Replace `_` with your project ID — visible in the URL when logged in.)'));
  }
}
