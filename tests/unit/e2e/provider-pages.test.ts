/**
 * The harness page walker (tests/e2e/utils/provider-pages.ts), one dialect
 * at a time: it reads every page, and it never answers `complete: true`
 * unless the provider said there is no next page.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  describeIncomplete,
  type PageDialect,
  walkProviderPages,
} from '../../e2e/utils/provider-pages.js';

type Json = Record<string, unknown>;
type Row = { id: number };

interface Dialect {
  dialect: PageDialect;
  perPage: number;
  /** Page `n` (1-based) of `total`, holding `rows`. */
  page: (rows: Row[], n: number, total: number) => Json;
  /** The URLs a three-page walk of `https://api.test/things` asks for. */
  urls: string[];
}

const rowsFor = (n: number, count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: n * 1000 + i }));

const DIALECTS: Dialect[] = [
  {
    dialect: 'hetzner',
    perPage: 50,
    page: (rows, n, total) => ({
      things: rows,
      meta: { pagination: { next_page: n < total ? n + 1 : null } },
    }),
    urls: [
      'https://api.test/things?per_page=50&page=1',
      'https://api.test/things?per_page=50&page=2',
      'https://api.test/things?per_page=50&page=3',
    ],
  },
  {
    dialect: 'digitalocean',
    perPage: 50,
    page: (rows, n, total) => ({
      things: rows,
      links: n < total ? { pages: { next: 'https://api.test/next' } } : {},
    }),
    urls: [
      'https://api.test/things?per_page=50&page=1',
      'https://api.test/things?per_page=50&page=2',
      'https://api.test/things?per_page=50&page=3',
    ],
  },
  {
    dialect: 'linode',
    perPage: 100,
    page: (rows, n, total) => ({ data: rows, page: n, pages: total }),
    urls: [
      'https://api.test/things?page_size=100&page=1',
      'https://api.test/things?page_size=100&page=2',
      'https://api.test/things?page_size=100&page=3',
    ],
  },
  {
    dialect: 'vultr',
    perPage: 100,
    page: (rows, n, total) => ({
      things: rows,
      meta: { links: { next: n < total ? `cur/${n + 1}` : '' } },
    }),
    urls: [
      'https://api.test/things?per_page=100',
      'https://api.test/things?per_page=100&cursor=cur%2F2',
      'https://api.test/things?per_page=100&cursor=cur%2F3',
    ],
  },
  {
    dialect: 'scaleway',
    perPage: 3,
    page: (rows) => ({ things: rows }),
    urls: [
      'https://api.test/things?per_page=3&page=1',
      'https://api.test/things?per_page=3&page=2',
      'https://api.test/things?per_page=3&page=3',
    ],
  },
  {
    dialect: 'scaleway-page-size',
    perPage: 3,
    page: (rows) => ({ things: rows }),
    urls: [
      'https://api.test/things?page_size=3&page=1',
      'https://api.test/things?page_size=3&page=2',
      'https://api.test/things?page_size=3&page=3',
    ],
  },
];

/** Scaleway ends on a short page, so its non-final pages must be full. */
const isShortPageDialect = (d: Dialect) => d.dialect.startsWith('scaleway');

/**
 * Serves `total` pages. `failAt` answers that page with a status; `throwAt`
 * throws on it; `endless` never ends.
 */
function server(
  d: Dialect,
  total: number,
  opts: { failAt?: number; throwAt?: number; endless?: boolean } = {},
) {
  const urls: string[] = [];
  const inits: Array<RequestInit | undefined> = [];
  let n = 0;
  const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(url));
    inits.push(init);
    n += 1;
    if (opts.throwAt === n) throw new Error('socket hang up\n    at TLSSocket');
    if (opts.failAt === n) return { ok: false, status: 503, json: async () => ({}) };
    const last = !opts.endless && n >= total;
    const count = isShortPageDialect(d) ? (last ? 1 : d.perPage) : 2;
    return {
      ok: true,
      status: 200,
      json: async () => d.page(rowsFor(n, count), n, opts.endless ? n + 1 : total),
    };
  }) as unknown as typeof fetch;
  return { impl, urls, inits };
}

for (const d of DIALECTS) {
  describe(`walkProviderPages: ${d.dialect}`, () => {
    const walk = (fetchImpl: typeof fetch, extra: object = {}) =>
      walkProviderPages<Row>(d.dialect, 'https://api.test/things', {
        key: 'things',
        perPage: d.perPage,
        fetchImpl,
        ...extra,
      });

    it('reads every page, in its own pagination dialect', async () => {
      const api = server(d, 3);
      const result = await walk(api.impl);
      expect(api.urls).toEqual(d.urls);
      expect(result.complete).toBe(true);
      const perPage = isShortPageDialect(d) ? [d.perPage, d.perPage, 1] : [2, 2, 2];
      expect(result.items).toEqual(perPage.flatMap((count, i) => rowsFor(i + 1, count)));
    });

    it('one final page is a complete walk', async () => {
      const api = server(d, 1);
      const result = await walk(api.impl);
      expect(api.urls).toHaveLength(1);
      expect(result.complete).toBe(true);
    });

    it('a failed middle page is incomplete, keeps the rows read and carries the status', async () => {
      const api = server(d, 3, { failAt: 2 });
      const result = await walk(api.impl);
      expect(result.complete).toBe(false);
      expect(result.status).toBe(503);
      expect(result.items).toEqual(rowsFor(1, isShortPageDialect(d) ? d.perPage : 2));
      expect(describeIncomplete(result)).toBe('HTTP 503');
    });

    it('a page that throws is incomplete by default, with the first line of the error', async () => {
      const api = server(d, 3, { throwAt: 2 });
      const result = await walk(api.impl);
      expect(result.complete).toBe(false);
      expect(result.error).toBe('socket hang up');
      expect(describeIncomplete(result)).toBe('socket hang up');
    });

    it("onThrow: 'throw' lets the error through for a caller that retries", async () => {
      const api = server(d, 3, { throwAt: 1 });
      await expect(walk(api.impl, { onThrow: 'throw' })).rejects.toThrow('socket hang up');
    });

    it('running out of pages with more pending is incomplete, never complete', async () => {
      const api = server(d, 0, { endless: true });
      const result = await walk(api.impl);
      expect(api.urls).toHaveLength(20);
      expect(result.complete).toBe(false);
      expect(result.exhausted).toBe(true);
      expect(describeIncomplete(result)).toBe('listing did not end within 20 pages');
    });

    it('honours a smaller page guard', async () => {
      const api = server(d, 0, { endless: true });
      const result = await walk(api.impl, { maxPages: 4 });
      expect(api.urls).toHaveLength(4);
      expect(result.complete).toBe(false);
    });
  });
}

describe('walkProviderPages: the request', () => {
  const onePage = () =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ things: [] }),
    })) as unknown as typeof fetch;

  it('passes no init when no headers or timeout are given (an injected fetch adds its own)', async () => {
    const impl = onePage();
    await walkProviderPages('digitalocean', 'https://api.test/things', {
      key: 'things',
      perPage: 50,
      fetchImpl: impl,
    });
    expect(impl).toHaveBeenCalledWith('https://api.test/things?per_page=50&page=1');
  });

  it('sends the headers and a timeout signal when given', async () => {
    const impl = onePage();
    await walkProviderPages('digitalocean', 'https://api.test/things', {
      key: 'things',
      perPage: 50,
      fetchImpl: impl,
      headers: { Authorization: 'Bearer fake-token' },
      timeoutMs: 5_000,
    });
    const init = (impl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock
      .calls[0][1];
    expect(init.headers).toEqual({ Authorization: 'Bearer fake-token' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('appends to a URL that already has a query', async () => {
    const impl = onePage();
    await walkProviderPages('hetzner', 'https://api.test/things?label_selector=a%3Db', {
      key: 'things',
      perPage: 50,
      fetchImpl: impl,
    });
    expect(impl).toHaveBeenCalledWith(
      'https://api.test/things?label_selector=a%3Db&per_page=50&page=1',
    );
  });
});
