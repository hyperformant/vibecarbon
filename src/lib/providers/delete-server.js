/**
 * The deleteServer body four providers share (Hetzner, DigitalOcean, Linode,
 * Vultr): one REST resource per server, DELETEd, then optionally polled
 * until it is gone. Scaleway's delete is a different flow (volumes and
 * flexible IPs) and keeps its own.
 *
 * Each provider passes what is its own: the server's path, how long to wait,
 * how to read a refusal's error body, and whether its no-wait DELETE goes
 * through apiRequest or bare. The transports are each provider's on purpose
 * (see HetznerProvider.deleteServer): apiRequest adds a JSON Content-Type,
 * the wait path's bare fetchWithRetry does not, and the poll probe is a
 * plain, un-retried fetch.
 */

import { fetchWithRetry } from '../fetch-retry.js';
import { pollUntil } from '../retry.js';

/**
 * DELETE a server; refuse unless the answer is ok or a 404 (already gone);
 * with `waitUntilGone`, poll GET until it 404s.
 *
 * @param {{apiToken: string, apiRequest: Function, constructor: {API_BASE: string}}} provider
 * @param {string} path - the server's path under the provider's API_BASE
 * @param {number|string} serverId - named in the poll's description
 * @param {object} how
 * @param {boolean} how.waitUntilGone
 * @param {(body: any) => string|undefined} how.reason - the provider's
 *   refusal text from the error body; 'Unknown error' when it has none
 * @param {number} [how.budgetMs] - how long to wait for the 404 (default 60 s)
 * @param {boolean} [how.bareDelete] - the no-wait DELETE is bare too (Vultr)
 * @returns {Promise<void|boolean>} undefined without waitUntilGone; with it,
 *   true if the server was there at DELETE time, false if already gone
 */
export async function deleteServerAt(
  provider,
  path,
  serverId,
  { waitUntilGone, reason, budgetMs = 60_000, bareDelete = false },
) {
  const url = `${provider.constructor.API_BASE}${path}`;
  const auth = () => ({ Authorization: `Bearer ${provider.apiToken}` });
  const response =
    waitUntilGone || bareDelete
      ? await fetchWithRetry(url, { method: 'DELETE', headers: auth() })
      : await provider.apiRequest(path, { method: 'DELETE' });

  if (!response.ok && response.status !== 404) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Failed to delete server: ${reason(error) || 'Unknown error'}`);
  }
  if (!waitUntilGone) return;

  if (response.status !== 404) {
    // A throwing probe (transient) is treated as falsy and retried; on budget
    // exhaustion we simply stop waiting — the return value below is unaffected.
    await pollUntil(
      async () => {
        const probe = await fetch(url, { headers: auth() });
        return probe.status === 404;
      },
      {
        budgetMs,
        initialDelayMs: 2_000,
        backoffFactor: 1,
        description: `server ${serverId} deletion`,
      },
    ).catch(() => {});
  }

  return response.status !== 404;
}
