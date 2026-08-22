import { afterEach, describe, expect, it, vi } from 'vitest';

// The scratch prefix is namespace-derived AT MODULE IMPORT: E2E_NAMESPACE=ci
// shifts it from `testapp-` to `citest-` when the swept module loads. The
// fixtures below use `testapp-` names, so the namespace must be scrubbed
// BEFORE imports execute — vi.hoisted runs ahead of the hoisted import
// graph; a beforeEach is too late (the prefix is already locked). The CI
// perf-table job exports E2E_NAMESPACE=ci job-wide, and this suite failing
// ONLY there (run 31192597117) while passing on every laptop is how we
// learned both facts.
vi.hoisted(() => {
  delete process.env.E2E_NAMESPACE;
});

import { countAllServers, listScopedResources } from '../../../scripts/sweep-hetzner.js';

/**
 * The audit sweep's own listings were un-paginated: the label-selector scan
 * omitted `per_page` entirely (Cloud API default 25) and the name-prefix scan
 * asked for 50 and ignored `meta.pagination.next_page`. Because the sweep
 * filters CLIENT-side by scratch-name prefix, residue past the first page was
 * not "missed for now" — it was unmatchable, and the tool printed
 * `recheck clean` over it. A blind audit tool is worse than none.
 */

type Body = Record<string, unknown>;

function jsonResp(body: Body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Serve a canned response per URL substring; anything unmatched is an empty page. */
function stubFetch(routes: Array<[test: (url: string) => boolean, body: Body, status?: number]>) {
  const urls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    urls.push(url);
    for (const [test, body, status] of routes) {
      if (test(url)) return jsonResp(body, status);
    }
    return jsonResp({});
  });
  vi.stubGlobal('fetch', impl);
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sweep listScopedResources — pagination', () => {
  it('finds a scratch resource that lives on page 2', async () => {
    const urls = stubFetch([
      [
        (u) => u.includes('page=1'),
        { servers: [{ id: 1, name: 'unrelated-prod' }], meta: { pagination: { next_page: 2 } } },
      ],
      [(u) => u.includes('page=2'), { servers: [{ id: 2, name: 'testapp-k8s-master' }] }],
    ]);

    const { items, complete } = await listScopedResources('servers', 'servers');

    expect(items.map((s: { id: number }) => s.id)).toEqual([2]);
    expect(complete).toBe(true);
    // Both scans (labeled + by-name) walk both pages: 4 requests, all with an
    // explicit per_page — never the API's silent 25 default.
    expect(urls).toHaveLength(4);
    expect(urls.every((u) => u.includes('per_page=50'))).toBe(true);
    expect(urls.filter((u) => u.includes('label_selector=managed-by=vibecarbon'))).toHaveLength(2);
  });

  it('reports incomplete when a page fails, so an empty result cannot certify clean', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch([[(u) => u.includes('page=1'), {}, 503]]);

    const { items, complete } = await listScopedResources('volumes', 'volumes');

    expect(items).toEqual([]);
    expect(complete).toBe(false);
    expect(warn.mock.calls.flat().join('\n')).toContain('incomplete');
    warn.mockRestore();
  });
});

describe('sweep countAllServers — pagination + fail-safe', () => {
  it('counts servers across pages', async () => {
    stubFetch([
      [
        (u) => u.includes('page=1'),
        { servers: [{ id: 1 }, { id: 2 }], meta: { pagination: { next_page: 2 } } },
      ],
      [(u) => u.includes('page=2'), { servers: [{ id: 3 }] }],
    ]);

    expect(await countAllServers()).toBe(3);
  });

  // The CSI-orphan pass only deletes when this returns 0. A truncated or
  // unreadable listing must therefore read as "servers exist" and defer the
  // pass — never under-count its way into deleting a live cluster's volumes.
  it('returns Infinity when the walk is incomplete', async () => {
    stubFetch([[(u) => u.includes('page=1'), {}, 500]]);

    expect(await countAllServers()).toBe(Number.POSITIVE_INFINITY);
  });
});
