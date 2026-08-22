import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS module without types
import {
  HETZNER_API_BASE,
  listHetznerPages,
} from '../../../src/lib/providers/hetzner-pagination.js';

/**
 * The one Hetzner page-walker, shared by HetznerProvider's destroy sweeps and
 * scripts/sweep-hetzner.js. The Cloud API returns per_page=25 when the
 * parameter is omitted and pages the rest behind meta.pagination.next_page;
 * every consumer filters CLIENT-side, so a truncated listing does not return
 * fewer rows, it makes the missing rows unmatchable and the caller confidently
 * reports "nothing found" (six orphaned pvc-* CSI volumes, 2026-07-30).
 */

function jsonResp(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('listHetznerPages', () => {
  it('walks every page and reports complete', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResp({ volumes: [{ id: 1 }], meta: { pagination: { next_page: 2 } } }),
      )
      .mockResolvedValueOnce(jsonResp({ volumes: [{ id: 2 }], meta: { pagination: {} } }));

    const out = await listHetznerPages({ path: '/volumes', key: 'volumes', token: 't', fetchImpl });

    expect(out).toEqual({ items: [{ id: 1 }, { id: 2 }], complete: true });
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      `${HETZNER_API_BASE}/volumes?per_page=50&page=1`,
      `${HETZNER_API_BASE}/volumes?per_page=50&page=2`,
    ]);
    expect(fetchImpl.mock.calls[0][1]).toEqual({ headers: { Authorization: 'Bearer t' } });
  });

  it('places an extra query BEFORE the page param (label-selector wire shape)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({ servers: [] }));

    await listHetznerPages({
      path: '/servers',
      key: 'servers',
      token: 't',
      query: 'label_selector=managed-by%3Dvibecarbon',
      fetchImpl,
    });

    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${HETZNER_API_BASE}/servers?per_page=50&label_selector=managed-by%3Dvibecarbon&page=1`,
    );
  });

  it('soft-fails on a non-ok first page: empty, NOT complete, with the status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({}, 503));

    expect(
      await listHetznerPages({ path: '/volumes', key: 'volumes', token: 't', fetchImpl }),
    ).toEqual({ items: [], complete: false, status: 503 });
  });

  it('returns the pages collected so far on a mid-walk failure, marked incomplete', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResp({ volumes: [{ id: 1 }], meta: { pagination: { next_page: 2 } } }),
      )
      .mockResolvedValueOnce(jsonResp({}, 429));

    expect(
      await listHetznerPages({ path: '/volumes', key: 'volumes', token: 't', fetchImpl }),
    ).toEqual({ items: [{ id: 1 }], complete: false, status: 429 });
  });

  it('stops at maxPages and reports incomplete rather than looping forever', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResp({ volumes: [{ id: 1 }], meta: { pagination: { next_page: 99 } } }),
      );

    const out = await listHetznerPages({
      path: '/volumes',
      key: 'volumes',
      token: 't',
      maxPages: 3,
      fetchImpl,
    });

    expect(out.complete).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('tolerates a body whose collection key is missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResp({}));

    expect(
      await listHetznerPages({ path: '/volumes', key: 'volumes', token: 't', fetchImpl }),
    ).toEqual({ items: [], complete: true });
  });
});
