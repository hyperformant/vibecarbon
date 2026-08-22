/**
 * Page-walk for Hetzner Cloud API collections.
 *
 * The Cloud API returns `per_page=25` when the parameter is omitted and hides
 * the rest behind `meta.pagination.next_page`. Every consumer of these
 * listings filters CLIENT-side — the destroy sweeps by cluster/label/region,
 * `scripts/sweep-hetzner.js` by scratch-name prefix — so a single un-paginated
 * GET does not merely return fewer rows: it makes the rows it never received
 * unmatchable, and the caller reports "nothing found" with full confidence.
 * That is how six orphaned `pvc-*` CSI volumes sat unnoticed after a green
 * destroy (2026-07-30), and how the audit sweep could print "recheck clean"
 * over real residue.
 *
 * Deliberately dependency-free. `scripts/sweep-hetzner.js` is a standalone
 * node script that avoids hard-importing the CLI's runtime deps (`fetch-retry`
 * pulls in undici + @clack and installs a global dispatcher), so it passes the
 * global `fetch`; HetznerProvider passes `fetchWithRetry`. One walker, two
 * transports — no second implementation.
 */

export const HETZNER_API_BASE = 'https://api.hetzner.cloud/v1';

/**
 * Walk every page of a Hetzner collection endpoint.
 *
 * Soft-fail by design (callers use these listings for best-effort
 * discovery/cleanup, never as a transaction): a non-ok response returns the
 * pages collected so far rather than throwing. `complete` is the honesty
 * signal — false means the walk stopped early (non-ok page, or the page budget
 * ran out with a next-page pointer still set), so an empty/short result must
 * NOT be read as "the account holds nothing else".
 *
 * The query string is assembled as `?per_page=<n>[&<query>]&page=<n>` so the
 * label-selector call sites keep their exact pre-existing wire shape.
 *
 * @param {object} args
 * @param {string} args.path - Collection path, e.g. `/volumes`.
 * @param {string} args.key - Response body key holding the array, e.g. `volumes`.
 * @param {string} args.token - Hetzner Cloud API token.
 * @param {string} [args.query] - Extra query params, already encoded as needed.
 * @param {number} [args.perPage]
 * @param {number} [args.maxPages] - Runaway guard.
 * @param {string} [args.apiBase]
 * @param {typeof fetch} [args.fetchImpl]
 * @returns {Promise<{ items: object[], complete: boolean, status?: number }>}
 */
export async function listHetznerPages({
  path,
  key,
  token,
  query = '',
  perPage = 50,
  maxPages = 20,
  apiBase = HETZNER_API_BASE,
  fetchImpl = fetch,
}) {
  const baseUrl = `${apiBase}${path}?per_page=${perPage}${query ? `&${query}` : ''}`;
  const items = [];
  let page = 1;
  for (let walked = 0; walked < maxPages; walked += 1) {
    const response = await fetchImpl(`${baseUrl}&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return { items, complete: false, status: response.status };
    const data = await response.json();
    if (Array.isArray(data[key])) items.push(...data[key]);
    const next = data.meta?.pagination?.next_page;
    if (!next) return { items, complete: true };
    page = next;
  }
  return { items, complete: false };
}
