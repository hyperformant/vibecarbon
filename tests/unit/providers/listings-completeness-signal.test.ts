import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `listServers()` / `listVolumes()` soft-fail to `[]` on a non-ok response.
 * That is fine for best-effort discovery and catastrophic for a VERDICT: the
 * destroy sweep reads an empty volume listing as "nothing to clean" (which is
 * how 2026-07-31's transient 403 produced a clean report over three stranded
 * volumes) and an empty server listing as "the project is quiet" (which is the
 * condition that unlocks deleting volumes on a name pattern).
 *
 * The *Detailed variants keep the page-walk's `complete` flag so those two call
 * sites can tell "nothing there" from "we could not see".
 */

const fetchWithRetryMock = vi.fn();

vi.mock('../../../src/lib/fetch-retry.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  };
});

import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';

const hetzner = new HetznerProvider('tok-hetzner');
const digitalocean = new DigitalOceanProvider('tok-do');
const linode = new LinodeProvider('tok-linode');
const vultr = new VultrProvider('tok-vultr');
const scaleway = new ScalewayProvider('tok-scaleway');

const jsonResp = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  fetchWithRetryMock.mockReset();
});

describe('HetznerProvider — completeness signal', () => {
  it('reports complete: false with the HTTP status when a page 403s', async () => {
    fetchWithRetryMock.mockResolvedValue(jsonResp({}, 403));

    expect(await hetzner.listVolumesDetailed()).toEqual({
      items: [],
      complete: false,
      status: 403,
    });
    expect(await hetzner.listServersDetailed()).toEqual({
      items: [],
      complete: false,
      status: 403,
    });
  });

  it('reports complete: true for a genuinely empty account', async () => {
    fetchWithRetryMock.mockResolvedValue(
      jsonResp({ volumes: [], servers: [], meta: { pagination: { next_page: null } } }),
    );

    expect(await hetzner.listVolumesDetailed()).toEqual({ items: [], complete: true });
    expect(await hetzner.listServersDetailed()).toEqual({ items: [], complete: true });
  });

  it('keeps listVolumes/listServers returning the bare array they always did', async () => {
    fetchWithRetryMock.mockResolvedValue(
      jsonResp({
        volumes: [{ id: 1 }],
        servers: [{ id: 2 }],
        meta: { pagination: { next_page: null } },
      }),
    );

    expect(await hetzner.listVolumes()).toEqual([{ id: 1 }]);
    expect(await hetzner.listServers()).toEqual([{ id: 2 }]);
  });

  it('still applies the label selector on the detailed server walk', async () => {
    fetchWithRetryMock.mockResolvedValue(
      jsonResp({ servers: [], meta: { pagination: { next_page: null } } }),
    );

    await hetzner.listServersDetailed({ project: 'testapp' });

    expect(fetchWithRetryMock.mock.calls[0][0]).toContain(
      `label_selector=${encodeURIComponent('project=testapp')}`,
    );
  });
});

describe('DigitalOceanProvider — completeness signal', () => {
  it('reports complete: false with the HTTP status when a page 500s', async () => {
    fetchWithRetryMock.mockResolvedValue(jsonResp({}, 500));

    expect(await digitalocean.listVolumesDetailed()).toEqual({
      items: [],
      complete: false,
      status: 500,
    });
    expect(await digitalocean.listServersDetailed()).toEqual({
      items: [],
      complete: false,
      status: 500,
    });
  });

  it('reports complete: true for a genuinely empty account', async () => {
    fetchWithRetryMock.mockResolvedValue(jsonResp({ volumes: [], droplets: [], links: {} }));

    expect(await digitalocean.listVolumesDetailed()).toEqual({ items: [], complete: true });
    expect(await digitalocean.listServersDetailed()).toEqual({ items: [], complete: true });
  });

  it('reports complete: false when a mid-walk page fails, keeping what it read', async () => {
    let call = 0;
    fetchWithRetryMock.mockImplementation(async () => {
      call += 1;
      return call === 1
        ? jsonResp({ droplets: [{ id: 1 }], links: { pages: { next: 'p2' } } })
        : jsonResp({}, 503);
    });

    expect(await digitalocean.listServersDetailed()).toEqual({
      items: [{ id: 1 }],
      complete: false,
      status: 503,
    });
  });

  it('keeps the multi-label client-side filter on the detailed walk', async () => {
    fetchWithRetryMock.mockResolvedValue(
      jsonResp({
        droplets: [
          { id: 1, tags: ['project:testapp', 'environment:prod'] },
          { id: 2, tags: ['project:testapp'] },
        ],
        links: {},
      }),
    );

    const { items } = await digitalocean.listServersDetailed({
      project: 'testapp',
      environment: 'prod',
    });

    expect(items.map((d: { id: number }) => d.id)).toEqual([1]);
  });
});

describe('LinodeProvider — completeness signal', () => {
  it('reports complete: false with the HTTP status when a page 403s', async () => {
    fetchWithRetryMock.mockResolvedValue(jsonResp({}, 403));

    expect(await linode.listVolumesDetailed()).toEqual({
      items: [],
      complete: false,
      status: 403,
    });
    expect(await linode.listServersDetailed()).toEqual({
      items: [],
      complete: false,
      status: 403,
    });
  });

  it('reports complete: true for a genuinely empty account', async () => {
    fetchWithRetryMock.mockResolvedValue(jsonResp({ data: [], page: 1, pages: 1 }));

    expect(await linode.listVolumesDetailed()).toEqual({ items: [], complete: true });
    expect(await linode.listServersDetailed()).toEqual({ items: [], complete: true });
  });

  it('reports complete: false when a mid-walk page fails, keeping what it read', async () => {
    let call = 0;
    fetchWithRetryMock.mockImplementation(async () => {
      call += 1;
      return call === 1 ? jsonResp({ data: [{ id: 1 }], page: 1, pages: 2 }) : jsonResp({}, 503);
    });

    expect(await linode.listServersDetailed()).toEqual({
      items: [{ id: 1 }],
      complete: false,
      status: 503,
    });
  });

  it('keeps the multi-label client-side tag filter on the detailed walk', async () => {
    fetchWithRetryMock.mockResolvedValue(
      jsonResp({
        data: [
          { id: 1, tags: ['project:testapp', 'environment:prod'] },
          { id: 2, tags: ['project:testapp'] },
        ],
        page: 1,
        pages: 1,
      }),
    );

    const { items } = await linode.listServersDetailed({
      project: 'testapp',
      environment: 'prod',
    });

    expect(items.map((d: { id: number }) => d.id)).toEqual([1]);
  });
});

describe('VultrProvider — completeness signal (cursor pagination)', () => {
  it('reports complete: false with the HTTP status when a page 403s', async () => {
    fetchWithRetryMock.mockResolvedValue(jsonResp({}, 403));

    expect(await vultr.listVolumesDetailed()).toEqual({
      items: [],
      complete: false,
      status: 403,
    });
    expect(await vultr.listServersDetailed()).toEqual({
      items: [],
      complete: false,
      status: 403,
    });
  });

  it('reports complete: true for a genuinely empty account (no next cursor)', async () => {
    fetchWithRetryMock.mockResolvedValue(
      jsonResp({ instances: [], blocks: [], meta: { links: { next: '' } } }),
    );

    expect(await vultr.listVolumesDetailed()).toEqual({ items: [], complete: true });
    expect(await vultr.listServersDetailed()).toEqual({ items: [], complete: true });
  });

  it('reports complete: false when a mid-walk cursor page fails, keeping what it read', async () => {
    let call = 0;
    fetchWithRetryMock.mockImplementation(async () => {
      call += 1;
      return call === 1
        ? jsonResp({ instances: [{ id: 'a' }], meta: { links: { next: 'CURSOR2' } } })
        : jsonResp({}, 503);
    });

    expect(await vultr.listServersDetailed()).toEqual({
      items: [{ id: 'a' }],
      complete: false,
      status: 503,
    });
  });

  it('keeps the multi-label client-side tag filter on the detailed walk', async () => {
    fetchWithRetryMock.mockResolvedValue(
      jsonResp({
        instances: [
          { id: 'a', tags: ['project:testapp', 'environment:prod'] },
          { id: 'b', tags: ['project:testapp'] },
        ],
        meta: { links: { next: '' } },
      }),
    );

    const { items } = await vultr.listServersDetailed({
      project: 'testapp',
      environment: 'prod',
    });

    expect(items.map((d: { id: string }) => d.id)).toEqual(['a']);
  });
});

describe('ScalewayProvider — completeness signal (multi-zone page walks)', () => {
  it('reports complete: false with the HTTP status when a zone walk 403s', async () => {
    fetchWithRetryMock.mockResolvedValue(jsonResp({}, 403));

    expect(await scaleway.listVolumesDetailed()).toEqual({
      items: [],
      complete: false,
      status: 403,
    });
    expect(await scaleway.listServersDetailed()).toEqual({
      items: [],
      complete: false,
      status: 403,
    });
  });

  it('reports complete: true for a genuinely empty account (every zone short-pages)', async () => {
    fetchWithRetryMock.mockResolvedValue(jsonResp({ servers: [], volumes: [] }));

    expect(await scaleway.listVolumesDetailed()).toEqual({ items: [], complete: true });
    expect(await scaleway.listServersDetailed()).toEqual({ items: [], complete: true });
  });

  it("reports complete: false when a LATER zone fails, keeping the earlier zones' items", async () => {
    // Zone-scoped twist on the mid-walk case: Scaleway listings merge one
    // walk per REGIONS zone, so a truncated ZONE hides residue exactly like
    // a truncated page — the merged result must not read complete.
    let call = 0;
    fetchWithRetryMock.mockImplementation(async () => {
      call += 1;
      return call === 1 ? jsonResp({ servers: [{ id: 'a' }] }) : jsonResp({}, 503);
    });

    expect(await scaleway.listServersDetailed()).toEqual({
      items: [{ zone: 'fr-par-1', id: 'a' }],
      complete: false,
      status: 503,
    });
  });

  it('merges the Block Storage API volumes with the Instance API volumes (the SBS leak class)', async () => {
    // Every root volume of our SBS-only types lives in /block/v1, NOT the
    // Instance API's legacy volumes endpoint — a sweep reading only the
    // latter would report "no volumes" over a dead-certain leak.
    fetchWithRetryMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/block/v1/zones/fr-par-1/')) {
        return jsonResp({ volumes: [{ id: 'sbs-1', name: 'testapp-root' }] });
      }
      if (u.includes('/instance/v1/zones/fr-par-1/volumes')) {
        return jsonResp({ volumes: [{ id: 'lssd-1', name: 'testapp-local' }] });
      }
      return jsonResp({ volumes: [] });
    });

    const { items, complete } = await scaleway.listVolumesDetailed();
    expect(complete).toBe(true);
    expect(items.map((v: { id: string }) => v.id).sort()).toEqual(['lssd-1', 'sbs-1']);
  });

  it('keeps the multi-label client-side tag filter on the detailed walk', async () => {
    fetchWithRetryMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/zones/fr-par-1/servers')) {
        return jsonResp({
          servers: [
            { id: 'a', tags: ['project:testapp', 'environment:prod'] },
            { id: 'b', tags: ['project:testapp'] },
          ],
        });
      }
      return jsonResp({ servers: [] });
    });

    const { items } = await scaleway.listServersDetailed({
      project: 'testapp',
      environment: 'prod',
    });

    expect(items.map((d: { id: string }) => d.id)).toEqual(['a']);
  });
});
