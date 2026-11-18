/**
 * One page walker for the e2e harness, in each provider's pagination dialect.
 *
 * Every harness consumer of a provider listing filters client-side (by
 * scratch-name prefix, by IP, by tag), so a listing that stops early does not
 * return fewer rows: it makes the rows it never read unmatchable, and the
 * caller reports "nothing found". The walk therefore always answers with a
 * `complete` flag, and `complete: true` means exactly one thing: the provider
 * said there is no next page.
 *
 * It is `complete: false` when
 *   - a page answered non-ok (`status` carries the HTTP status);
 *   - a page could not be fetched or parsed and `onThrow` is 'incomplete'
 *     (`error` carries the first line of the message);
 *   - the page guard ran out with a next page still pending (`exhausted`).
 *
 * The rows read before the stop are still returned: a caller that deletes
 * what it finds can act on them, and must treat the rest as unknown.
 *
 * The product has its own walkers (src/lib/providers/*.js). They are private
 * to their modules and retry through fetchWithRetry; the harness needs an
 * injected, unretried fetch, so it keeps this one.
 */

export type PageDialect =
  /** `per_page` + `page`; next page number at `meta.pagination.next_page`. */
  | 'hetzner'
  /** `per_page` + `page`; another page exists while `links.pages.next` is set. */
  | 'digitalocean'
  /** `page_size` + `page`; rows under `data`; ends when `page >= pages`. */
  | 'linode'
  /** `per_page` + `cursor`; next cursor at `meta.links.next` ('' at the end). */
  | 'vultr'
  /** Instance API: `per_page` + `page`; a page shorter than `per_page` ends it. */
  | 'scaleway'
  /** Block, IAM, VPC, Load Balancer APIs: `page_size` + `page`; a short page ends it. */
  | 'scaleway-page-size';

export interface PageWalk<T> {
  items: T[];
  complete: boolean;
  /** HTTP status of the page that answered non-ok. */
  status?: number;
  /** First line of the error from a page that threw (`onThrow: 'incomplete'`). */
  error?: string;
  /** True when the page guard ran out with a next page still pending. */
  exhausted?: boolean;
}

export interface PageWalkOptions {
  /** Response key holding the rows. Not used by 'linode' (always `data`). */
  key?: string;
  /** Rows per page, sent as the dialect's page-size parameter. */
  perPage: number;
  /** Runaway guard. Default 20, the sweeps' long-standing value. */
  maxPages?: number;
  fetchImpl?: typeof fetch;
  /** Request headers. Omitted entirely when not given (an injected fetch may add its own). */
  headers?: Record<string, string>;
  /** Per-request timeout. */
  timeoutMs?: number;
  /**
   * What a fetch or parse error does. 'incomplete' (default) ends the walk
   * with `complete: false`; 'throw' lets it propagate, for a caller whose
   * own retry or error report needs the original error.
   */
  onThrow?: 'incomplete' | 'throw';
}

/** Default page guard: 20 pages, as every sweep walker has used. */
const DEFAULT_MAX_PAGES = 20;

const SIZE_PARAM: Record<PageDialect, string> = {
  hetzner: 'per_page',
  digitalocean: 'per_page',
  linode: 'page_size',
  vultr: 'per_page',
  scaleway: 'per_page',
  'scaleway-page-size': 'page_size',
};

interface Envelope {
  data?: unknown;
  pages?: number;
  meta?: { pagination?: { next_page?: number | null }; links?: { next?: string } };
  links?: { pages?: { next?: string } };
  [key: string]: unknown;
}

/**
 * Walk every page of one collection.
 *
 * @param url - the collection URL, with any query of its own and WITHOUT
 *   pagination parameters; the walker appends them.
 */
export async function walkProviderPages<T>(
  dialect: PageDialect,
  url: string,
  opts: PageWalkOptions,
): Promise<PageWalk<T>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const base = `${url}${url.includes('?') ? '&' : '?'}${SIZE_PARAM[dialect]}=${opts.perPage}`;
  const items: T[] = [];
  let page = 1;
  let cursor = '';
  for (let walked = 0; walked < maxPages; walked++) {
    const pageUrl =
      dialect === 'vultr'
        ? `${base}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
        : `${base}&page=${page}`;
    let body: Envelope;
    try {
      const init: RequestInit = {};
      if (opts.headers) init.headers = opts.headers;
      if (opts.timeoutMs) init.signal = AbortSignal.timeout(opts.timeoutMs);
      const res =
        opts.headers || opts.timeoutMs ? await fetchImpl(pageUrl, init) : await fetchImpl(pageUrl);
      if (!res.ok) return { items, complete: false, status: res.status };
      body = (await res.json()) as Envelope;
    } catch (err) {
      if (opts.onThrow === 'throw') throw err;
      return {
        items,
        complete: false,
        error: err instanceof Error ? err.message.split('\n')[0] : 'unknown',
      };
    }
    const rows = dialect === 'linode' ? body.data : opts.key ? body[opts.key] : undefined;
    const pageItems = Array.isArray(rows) ? (rows as T[]) : [];
    items.push(...pageItems);

    switch (dialect) {
      case 'hetzner': {
        const next = body.meta?.pagination?.next_page;
        if (!next) return { items, complete: true };
        page = next;
        break;
      }
      case 'digitalocean':
        if (!body.links?.pages?.next) return { items, complete: true };
        page++;
        break;
      case 'linode':
        if (!body.pages || page >= body.pages) return { items, complete: true };
        page++;
        break;
      case 'vultr': {
        const next = body.meta?.links?.next;
        if (!next) return { items, complete: true };
        cursor = next;
        break;
      }
      default:
        // Scaleway has no next pointer: a short page is the end.
        if (pageItems.length < opts.perPage) return { items, complete: true };
        page++;
    }
  }
  return { items, complete: false, exhausted: true };
}

/** Why a walk is incomplete, in a few words for a log line. */
export function describeIncomplete(walk: PageWalk<unknown>, maxPages = DEFAULT_MAX_PAGES): string {
  if (walk.status !== undefined) return `HTTP ${walk.status}`;
  if (walk.error !== undefined) return walk.error;
  return `listing did not end within ${maxPages} pages`;
}
