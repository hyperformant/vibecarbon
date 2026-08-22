/**
 * DESTROY BACKSTOP — the environment-owned server sweep.
 *
 * The compose tiers reap their servers by NAME (destroyComposeTier's
 * `providerServerName` lookup, resolveHaServers' `findServersByName` pair).
 * Name lookups are exact and cheap, but they can only find names somebody
 * thought to list — and for the whole life of `scale`, nobody listed its
 * temporary `-new` replacement (see ./server-naming.js for the full RCA and
 * the 2026-08-10 live receipt).
 *
 * ./server-naming.js closes that specific hole by adding `-new` to the family
 * every lookup walks. This module is the layer that makes the CLASS
 * non-silent: after the tier teardown has done its by-name work, read the
 * provider's server listing ONCE and account for everything still standing
 * that belongs to this environment. Anything found is deleted; a delete that
 * fails is a LEAK; a listing that could not be read in full is UNVERIFIED.
 *
 * The k8s tier has had exactly this sweep since M3 Task 9f (destroy.js's
 * "Checking for orphaned servers"), for exactly this reason — a partial
 * `pulumi up` leaving servers outside the state graph. The compose tiers never
 * got one, which is why their equivalent failure printed a clean report.
 *
 * `listServersDetailed`, never `listServers`: the latter soft-fails to `[]`,
 * and "the account is empty" and "we could not read the account" must not
 * render as the same verdict (PR #236's principle, applied here).
 */

import { describeResource } from './leak-ledger.js';
import { isEnvironmentOwnedServer } from './server-naming.js';

/**
 * Sweep every server still standing that belongs to `environment`.
 *
 * @param {object} args
 * @param {object} args.provider - provider instance (listServersDetailed,
 *   deleteServer, serverLabels, serverRegion)
 * @param {ReturnType<import('./leak-ledger.js').createLeakLedger>} args.leaks
 * @param {string} args.projectName
 * @param {string} args.environment
 * @param {string} [args.deployMode] - selects the environment LABEL family
 *   (compose-ha's Pulumi nodes are labelled with the per-stack env).
 * @param {string[]} [args.roles] - extra role suffixes from persisted config.
 * @param {Array<string|number>} [args.alreadyHandledIds] - ids this destroy has
 *   already deleted. Provider listings lag their own deletes, so a row that is
 *   already accounted for must not be re-deleted (noisy) or reported (false).
 * @param {string} [args.providerName] - display name for hints.
 * @param {(message: string) => void} [args.onProgress]
 * @returns {Promise<{deleted: string[], scanned: boolean}>}
 */
export async function sweepEnvironmentServers({
  provider,
  leaks,
  projectName,
  environment,
  deployMode,
  roles,
  alreadyHandledIds = [],
  providerName = 'provider',
  onProgress = () => {},
}) {
  const scope = `${projectName}-${environment}`;
  const consoleHint =
    `Check the ${providerName} console for servers named ${scope}*; a server left by a killed ` +
    '`vibecarbon scale` is outside Pulumi state, so no destroy retry reaches it, and its name ' +
    'blocks the next deploy with "name is already used".';

  let listing;
  try {
    listing = await provider.listServersDetailed();
  } catch (error) {
    leaks.unverified({
      resourceClass: 'server',
      resource: `environment-server sweep: ${scope}`,
      reason: `server listing failed: ${error.message}, servers left behind by a killed scale or a partial provision cannot be ruled out`,
      hint: consoleHint,
    });
    return { deleted: [], scanned: false };
  }

  const { items = [], complete } = listing ?? {};
  const handled = new Set(alreadyHandledIds.map((id) => String(id)));
  const survivors = items.filter(
    (server) =>
      !handled.has(String(server.id)) &&
      isEnvironmentOwnedServer(
        { name: server.name, labels: provider.serverLabels(server) },
        { projectName, environment, deployMode, roles },
      ),
  );

  if (survivors.length === 0) {
    if (!complete) {
      // An empty result off a truncated walk is not evidence of an empty
      // account — it is the absence of evidence, and the ledger says so.
      leaks.unverified({
        resourceClass: 'server',
        resource: `environment-server sweep: ${scope}`,
        reason:
          'the server listing came back incomplete, so "no surviving servers" could not be established',
        hint: consoleHint,
      });
    }
    return { deleted: [], scanned: Boolean(complete) };
  }

  const deleted = [];
  for (const server of survivors) {
    const label = server.name || `id ${server.id}`;
    onProgress(`Deleting surviving server: ${label}`);
    try {
      await provider.deleteServer(server.id, { waitUntilGone: true });
      deleted.push(server.name ?? String(server.id));
    } catch (error) {
      leaks.leak({
        resourceClass: 'server',
        resource: describeResource({
          name: server.name,
          id: server.id,
          region: provider.serverRegion(server),
        }),
        reason: `surviving environment server: delete failed: ${error.message}`,
        hint: consoleHint,
      });
    }
  }
  return { deleted, scanned: Boolean(complete) };
}
