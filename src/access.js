/**
 * Vibecarbon Access Command
 *
 * Manage the project-level operator-CIDR allowlist that locks SSH (port 22)
 * and the Kubernetes API (port 6443) on all deployed environments' Hetzner
 * firewalls. Most operators won't run this directly — `vibecarbon deploy`,
 * `vibecarbon shell`, etc. auto-add the current operator's IP on first use
 * (interactive flows only). This command exists for explicit management:
 * adding a teammate's CIDR, pruning stale entries, or showing the list.
 *
 * Usage:
 *   vibecarbon access                  # List current CIDRs (default)
 *   vibecarbon access list             # Same as above (explicit)
 *   vibecarbon access add <cidr>       # Add + push to all firewalls
 *   vibecarbon access remove <cidr>    # Remove + push to all firewalls
 *   vibecarbon access prune            # Drop entries older than 90d, push
 *   vibecarbon access -h
 */

import * as p from '@clack/prompts';
import { exitCancelled, exitDeclined } from './lib/cli/exit-guard.js';
import { renderHelp } from './lib/cli/help.js';
import { parseFlagsOrExit } from './lib/cli/parse-flags.js';
import { spinner } from './lib/cli/progress.js';
import { c, printBanner } from './lib/colors.js';
import { saveProjectConfig } from './lib/config.js';
import {
  addCidr,
  applyToFirewall,
  cidrFromIp,
  detectOperatorIp,
  loadOperatorCidrs,
  pruneCidrs,
  removeCidr,
} from './lib/operator-ip.js';
import { assertInProjectDir } from './lib/project-guard.js';
import { providerIdFor, resolveProviderToken } from './lib/providers/index.js';

const VALID_SUBCOMMANDS = new Set(['list', 'add', 'remove', 'prune']);

/** @type {import('./lib/cli/parse-flags.js').CommandSpec & { summary?: string, description?: string, examples?: Array<{ command: string, description?: string }> }} */
const SPEC = {
  name: 'access',
  summary: 'Manage operator-CIDR firewall allowlist',
  description: [
    "Most operators don't need to run this. `vibecarbon deploy` and",
    '`vibecarbon shell` (and other commands that need port 22 or 6443)',
    "auto-add the current operator's IP on first interactive use.",
    '',
    'Use `add` to grant a teammate access, `remove` to revoke, `prune`',
    "to clean up entries from operators who haven't connected in 90+ days.",
    '',
    'SUBCOMMANDS',
    '  list                 Show current allowed CIDRs (default)',
    '  add <cidr>           Add a CIDR to the allowlist + apply to firewalls',
    '  remove <cidr>        Remove a CIDR + apply to firewalls',
    '  prune                Drop entries with lastUsedAt > 90 days, apply',
  ].join('\n'),
  positional: [
    { name: 'subcommand', optional: true, description: 'list | add | remove | prune' },
    { name: 'cidr', optional: true, description: 'CIDR for add/remove (e.g. 1.2.3.4/32)' },
  ],
  flags: [
    { name: 'h', boolean: true, description: 'Show this help' },
    { name: 'v', boolean: true, description: 'Show version' },
  ],
  examples: [
    { command: 'vibecarbon access' },
    { command: 'vibecarbon access add 5.6.7.8/32' },
    { command: 'vibecarbon access remove 5.6.7.8/32' },
    { command: 'vibecarbon access prune' },
  ],
};

// ============================================================================
// HELPERS
// ============================================================================

function isValidCidrFormat(cidr) {
  if (typeof cidr !== 'string') return false;
  const slashIdx = cidr.indexOf('/');
  if (slashIdx < 0) return false;
  const base = cidr.slice(0, slashIdx);
  const bits = Number(cidr.slice(slashIdx + 1));
  if (!Number.isInteger(bits) || bits < 0) return false;
  const isV6 = base.includes(':');
  if (isV6) return bits <= 128 && /^[0-9a-fA-F:]+$/.test(base);
  // IPv4
  if (bits > 32) return false;
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(base)) return false;
  return base.split('.').every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/**
 * Build the list of full env identifiers whose firewalls should be patched.
 * For HA envs, include both -primary and -standby.
 */
function deployedFirewallEnvs(projectConfig) {
  const envs = [];
  const environments = projectConfig?.environments ?? {};
  for (const [name, cfg] of Object.entries(environments)) {
    if (cfg?.ha?.enabled) {
      envs.push(`${name}-primary`, `${name}-standby`);
    } else {
      envs.push(name);
    }
  }
  return envs;
}

function formatEntry(entry, currentDetectedCidr, now) {
  const labelOwn = currentDetectedCidr === entry.cidr ? c.bold('you') : c.dim('unknown');
  const addedAt = formatRelative(entry.addedAt, now);
  const usedAt = formatRelative(entry.lastUsedAt, now);
  const usedDays = daysBetween(entry.lastUsedAt, now);
  const stale = usedDays >= 90 ? c.warning(' (stale)') : '';
  return `  ${entry.cidr.padEnd(20)} ${labelOwn.padEnd(20)} added ${addedAt}, used ${usedAt}${stale}`;
}

function daysBetween(isoDate, now) {
  const t = new Date(isoDate).getTime();
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

function formatRelative(isoDate, now) {
  const days = daysBetween(isoDate, now);
  if (!Number.isFinite(days)) return 'unknown';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

async function pushToAllFirewalls(projectConfig, list, apiToken, spinner) {
  const envs = deployedFirewallEnvs(projectConfig);
  if (envs.length === 0) {
    spinner?.stop('No deployed environments, nothing to push to.');
    return [];
  }
  if (list.length === 0) {
    throw new Error(
      'Cannot push an empty CIDR list; that would lock everyone out of every environment.',
    );
  }
  spinner?.start(`Updating firewall on ${envs.length} cluster(s)...`);
  const updated = await applyToFirewall({
    projectName: projectConfig.projectName,
    environments: envs,
    operatorCidrs: list,
    apiToken,
    // access pushes to every deployed env from one project-level command.
    // Project-level config has no .provider field (provider is environment-scoped),
    // so applyToFirewall always resolves 'hetzner' here. This entire fan-out
    // assumes a single provider + single apiToken per project; must be reworked
    // before mixed-provider projects can use access.
    envConfig: projectConfig,
  });
  spinner?.stop(`Updated ${updated.length} firewall(s).`);
  return updated;
}

// ============================================================================
// SUBCOMMANDS
// ============================================================================

async function listAction(projectConfig) {
  const list = loadOperatorCidrs(projectConfig);
  if (list.length === 0) {
    p.note(
      'No operator CIDRs configured yet. Run an interactive `vibecarbon deploy` or `vibecarbon shell` to bootstrap, or use `vibecarbon access add <cidr>`.',
      'Empty allowlist',
    );
    return;
  }

  let detectedCidr = null;
  try {
    const { ip, version } = await detectOperatorIp();
    detectedCidr = cidrFromIp(ip, version);
  } catch {
    // detection unavailable — show list without `you` label
  }

  const now = new Date();
  const lines = list.map((entry) => formatEntry(entry, detectedCidr, now));
  p.note(lines.join('\n'), `Operator CIDRs (${list.length})`);
  if (detectedCidr && !list.find((e) => e.cidr === detectedCidr)) {
    p.log.info(
      `Your detected IP (${detectedCidr}) is NOT in the list. ` +
        `Run \`vibecarbon access add ${detectedCidr}\` to grant yourself access, ` +
        `or run any command that needs SSH/k8s API to auto-add it.`,
    );
  }
}

async function addAction(projectConfig, cidr, apiToken) {
  if (!cidr) throw new Error('Missing CIDR. Usage: vibecarbon access add <cidr>');
  if (!isValidCidrFormat(cidr)) {
    throw new Error(`Invalid CIDR format: ${cidr}. Expected e.g. "1.2.3.4/32" or "10.0.0.0/8".`);
  }
  const list = loadOperatorCidrs(projectConfig);
  const existed = list.some((e) => e.cidr === cidr);
  const newList = addCidr(list, cidr);

  saveProjectConfig({ ...projectConfig, operatorCidrs: newList });
  projectConfig.operatorCidrs = newList;

  if (existed) {
    p.log.info(`${cidr} was already in the list, refreshed lastUsedAt.`);
  } else {
    p.log.success(`Added ${cidr} to the operator allowlist.`);
  }

  const s = spinner();
  await pushToAllFirewalls(projectConfig, newList, apiToken, s);
}

async function removeAction(projectConfig, cidr, apiToken) {
  if (!cidr) throw new Error('Missing CIDR. Usage: vibecarbon access remove <cidr>');
  const list = loadOperatorCidrs(projectConfig);
  if (!list.some((e) => e.cidr === cidr)) {
    p.log.warn(`${cidr} is not in the list, nothing to remove.`);
    return;
  }
  if (list.length === 1) {
    throw new Error(
      `Refusing to remove the last CIDR (${cidr}); that would lock everyone out of every environment. Add another entry first, or use \`vibecarbon destroy\` if you want to tear down.`,
    );
  }

  // Self-lockout warning when removing the operator's own current CIDR.
  // Only the detection can fail, so only it belongs in the try. With the
  // prompt inside, a REJECTING p.confirm landed in the bare `catch {}` — the
  // safety question would vanish and the CIDR be removed anyway, which is the
  // outcome the prompt exists to prevent. (A thrown prompt, not the exits: a
  // real process.exit unwinds nothing and was never catchable.) Moving the
  // prompt out also means declining now aborts the command instead of
  // returning into the removal below, as the bare `return` used to.
  let removingOwnCidr = false;
  try {
    const { ip, version } = await detectOperatorIp();
    removingOwnCidr = cidrFromIp(ip, version) === cidr;
  } catch {
    // detection unavailable — proceed without the safety prompt
  }
  if (removingOwnCidr) {
    const ok = await p.confirm({
      message: `${cidr} is your current IP. Removing it will lock you out until you reconnect from a different network or re-add it. Continue?`,
      initialValue: false,
    });
    // Ctrl-C/ESC and an explicit "no" are different answers: one is an
    // interrupt, the other a considered refusal. Both stop the run.
    if (p.isCancel(ok)) {
      exitCancelled();
    }
    if (!ok) {
      exitDeclined();
    }
  }

  const newList = removeCidr(list, cidr);
  saveProjectConfig({ ...projectConfig, operatorCidrs: newList });
  projectConfig.operatorCidrs = newList;
  p.log.success(`Removed ${cidr} from the operator allowlist.`);

  const s = spinner();
  await pushToAllFirewalls(projectConfig, newList, apiToken, s);
}

async function pruneAction(projectConfig, apiToken) {
  const list = loadOperatorCidrs(projectConfig);
  const now = new Date();
  const newList = pruneCidrs(list, now, 90);
  const dropped = list.length - newList.length;
  if (dropped === 0) {
    p.log.info('No stale entries to prune (none older than 90 days).');
    return;
  }
  if (newList.length === 0) {
    throw new Error(
      `Refusing to prune all ${dropped} entries; that would lock everyone out. Run \`vibecarbon access add <cidr>\` first to seed at least one fresh entry, then re-run prune.`,
    );
  }
  saveProjectConfig({ ...projectConfig, operatorCidrs: newList });
  projectConfig.operatorCidrs = newList;
  p.log.success(`Pruned ${dropped} stale entr${dropped === 1 ? 'y' : 'ies'}.`);

  const s = spinner();
  await pushToAllFirewalls(projectConfig, newList, apiToken, s);
}

// ============================================================================
// ENTRY POINT
// ============================================================================

export async function run(args = []) {
  const { positional, handled } = parseFlagsOrExit(args, SPEC);
  if (handled) return;

  // Resolve subcommand: if first positional matches a known verb, use it;
  // otherwise default to `list` and treat the positional as a stray CIDR
  // (which the strict subcommands reject below — list ignores it).
  const sub = /** @type {string|undefined} */ (positional.subcommand);
  let subcommand = 'list';
  let cidr = /** @type {string|undefined} */ (positional.cidr) ?? null;
  if (sub) {
    if (VALID_SUBCOMMANDS.has(sub)) {
      subcommand = sub;
    } else {
      // First positional wasn't a known subcommand — treat it as the CIDR
      // for an implicit `list`, matching the previous parser's behavior.
      cidr = sub;
    }
  }

  // Project guard runs before banner so an accidental `vibecarbon
  // access` from a parent directory emits the canonical message.
  const projectConfig = assertInProjectDir();

  printBanner();

  const apiToken = resolveProviderToken(providerIdFor(projectConfig));
  // The list action doesn't need a token; the others do for the firewall push.
  if (subcommand !== 'list' && !apiToken) {
    p.log.error(
      "Hetzner API token not found. Set HETZNER_API_TOKEN in your shell or the project's .env.local.",
    );
    process.exit(1);
  }

  try {
    switch (subcommand) {
      case 'list':
        await listAction(projectConfig);
        break;
      case 'add':
        await addAction(projectConfig, cidr, apiToken);
        break;
      case 'remove':
        await removeAction(projectConfig, cidr, apiToken);
        break;
      case 'prune':
        await pruneAction(projectConfig, apiToken);
        break;
      default:
        process.stdout.write(renderHelp(SPEC));
        process.exit(1);
    }
  } catch (err) {
    p.log.error(err.message || String(err));
    process.exit(1);
  }
}
