import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DO project assignment — the one provider where the cloud's "project" is a
 * post-hoc organizational container (tokens are account-scoped; API-created
 * resources land in the DEFAULT project). These methods let deploy/scale file
 * this project's resources into a dedicated DO project by name.
 *
 * Hetzner and Scaleway have NO counterpart to these methods on purpose:
 * Hetzner tokens are project-scoped (the credential IS the project selector)
 * and Scaleway scopes every call by SCALEWAY_DEFAULT_PROJECT_ID (the request
 * parameter IS the project selector) — the base-class ensureProjectAssignment
 * no-op is their correct implementation, not a missing one (parity rule).
 *
 * Same harness as digitalocean-methods.test.ts: stub `fetchWithRetry` by
 * resolved specifier.
 */

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
}));

import { BaseProvider } from '../../../src/lib/providers/base.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';

const TOKEN = 'tok-do-project';
const BASE = 'https://api.digitalocean.com/v2';

type Resp = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
};

function resp(body: unknown, status = 200): Resp {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Records of `fetchWithRetry(url, init)` calls as `[method, url]` tuples. */
function calls(): Array<[string, string]> {
  return fetchWithRetryMock.mock.calls.map((c) => [
    ((c[1] as { method?: string })?.method ?? 'GET') as string,
    c[0] as string,
  ]);
}

function bodyOf(callIndex: number): unknown {
  return JSON.parse((fetchWithRetryMock.mock.calls[callIndex][1] as { body: string }).body);
}

let provider: DigitalOceanProvider;

beforeEach(() => {
  fetchWithRetryMock.mockReset();
  provider = new DigitalOceanProvider(TOKEN);
  delete process.env.DIGITALOCEAN_PROJECT_ID;
});

afterEach(() => {
  delete process.env.DIGITALOCEAN_PROJECT_ID;
});

describe('findOrCreateProject', () => {
  it('finds an existing project by exact name, walking pagination', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(
        resp({
          projects: [{ id: 'p-other', name: 'other-app' }],
          links: { pages: { next: 'x' } },
        }),
      )
      .mockResolvedValueOnce(resp({ projects: [{ id: 'p-mine', name: 'newapp' }], links: {} }));

    const result = await provider.findOrCreateProject('newapp');

    expect(result).toEqual({ id: 'p-mine', created: false });
    expect(calls()).toEqual([
      ['GET', `${BASE}/projects?per_page=200&page=1`],
      ['GET', `${BASE}/projects?per_page=200&page=2`],
    ]);
  });

  it('does not match on name prefix or case-different names — exact only', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(
        resp({
          projects: [
            { id: 'p-prefix', name: 'newapp-staging' },
            { id: 'p-case', name: 'Newapp' },
          ],
          links: {},
        }),
      )
      .mockResolvedValueOnce(resp({ project: { id: 'p-created' } }, 201));

    const result = await provider.findOrCreateProject('newapp');

    expect(result).toEqual({ id: 'p-created', created: true });
  });

  it('creates the project when absent, with name and a purpose', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(resp({ projects: [], links: {} }))
      .mockResolvedValueOnce(resp({ project: { id: 'p-new' } }, 201));

    const result = await provider.findOrCreateProject('newapp');

    expect(result).toEqual({ id: 'p-new', created: true });
    expect(calls()[1]).toEqual(['POST', `${BASE}/projects`]);
    const body = bodyOf(1) as { name: string; purpose: string };
    expect(body.name).toBe('newapp');
    expect(body.purpose).toBeTruthy();
  });

  it("throws with DO's {id, message} error shape on a failed create", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(resp({ projects: [], links: {} }))
      .mockResolvedValueOnce(resp({ id: 'forbidden', message: 'no project scope' }, 403));

    await expect(provider.findOrCreateProject('newapp')).rejects.toThrow(/no project scope/);
  });

  it('throws on a failed listing rather than treating it as an empty account', async () => {
    fetchWithRetryMock.mockResolvedValueOnce(resp({ id: 'unauthorized', message: 'nope' }, 401));

    await expect(provider.findOrCreateProject('newapp')).rejects.toThrow(/nope|401/);
    // Must NOT fall through to a create POST off a failed listing.
    expect(calls()).toHaveLength(1);
  });
});

describe('assignResourcesToProject', () => {
  it('POSTs the URN batch to the project resources endpoint', async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      resp({ resources: [{ urn: 'do:droplet:1' }, { urn: 'do:droplet:2' }] }),
    );

    await provider.assignResourcesToProject('p-mine', ['do:droplet:1', 'do:droplet:2']);

    expect(calls()).toEqual([['POST', `${BASE}/projects/p-mine/resources`]]);
    expect(bodyOf(0)).toEqual({ resources: ['do:droplet:1', 'do:droplet:2'] });
  });

  it('throws with the DO error message on a non-2xx response', async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      resp({ id: 'not_found', message: 'project gone' }, 404),
    );

    await expect(provider.assignResourcesToProject('p-gone', ['do:droplet:1'])).rejects.toThrow(
      /project gone/,
    );
  });
});

describe('ensureProjectAssignment', () => {
  const droplets = {
    droplets: [
      { id: 11, name: 'newapp-prod' },
      { id: 12, name: 'newapp-prod-standby' },
      { id: 13, name: 'newapp-staging' },
      { id: 14, name: 'newapp-production' }, // prefix trap: NOT `newapp-prod`'s env
      { id: 15, name: 'unrelated' },
    ],
    links: {},
  };

  it('with DIGITALOCEAN_PROJECT_ID set: skips the lookup and assigns only this environment', async () => {
    process.env.DIGITALOCEAN_PROJECT_ID = 'p-env';
    fetchWithRetryMock
      .mockResolvedValueOnce(resp(droplets)) // droplet listing
      .mockResolvedValueOnce(resp({ resources: [] })); // assignment

    const result = await provider.ensureProjectAssignment({
      projectName: 'newapp',
      environment: 'prod',
    });

    expect(result).toEqual({ projectId: 'p-env', created: false, assigned: 2 });
    const made = calls();
    expect(made.some(([, url]) => url.includes('/projects?'))).toBe(false);
    expect(made.at(-1)).toEqual(['POST', `${BASE}/projects/p-env/resources`]);
    // `newapp-prod` + `newapp-prod-standby`; NOT staging, NOT `-production`.
    expect(bodyOf(made.length - 1)).toEqual({
      resources: ['do:droplet:11', 'do:droplet:12'],
    });
  });

  it('without the env var: find-or-creates the project by vibecarbon project name', async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(resp({ projects: [], links: {} }))
      .mockResolvedValueOnce(resp({ project: { id: 'p-new' } }, 201))
      .mockResolvedValueOnce(resp(droplets))
      .mockResolvedValueOnce(resp({ resources: [] }));

    const result = await provider.ensureProjectAssignment({
      projectName: 'newapp',
      environment: 'prod',
    });

    expect(result).toEqual({ projectId: 'p-new', created: true, assigned: 2 });
  });

  it('skips the assignment POST entirely when no droplets match', async () => {
    process.env.DIGITALOCEAN_PROJECT_ID = 'p-env';
    fetchWithRetryMock.mockResolvedValueOnce(resp({ droplets: [], links: {} }));

    const result = await provider.ensureProjectAssignment({
      projectName: 'newapp',
      environment: 'prod',
    });

    expect(result).toEqual({ projectId: 'p-env', created: false, assigned: 0 });
    expect(calls().some(([m]) => m === 'POST')).toBe(false);
  });

  it('throws on an incomplete droplet listing instead of assigning off a partial sweep', async () => {
    // A failed page must not read as "this environment has no droplets" —
    // the caller warns loudly rather than silently under-assigning.
    process.env.DIGITALOCEAN_PROJECT_ID = 'p-env';
    fetchWithRetryMock.mockResolvedValueOnce(resp({ id: 'oops', message: 'listing broke' }, 500));

    await expect(
      provider.ensureProjectAssignment({ projectName: 'newapp', environment: 'prod' }),
    ).rejects.toThrow(/droplet listing/i);
  });
});

describe('BaseProvider.ensureProjectAssignment (the cross-provider contract)', () => {
  it('is a no-op returning null by default — correct for by-credential (Hetzner) and by-parameter (Scaleway) clouds', async () => {
    class FakeProvider extends BaseProvider {}
    const p = new FakeProvider(TOKEN);
    await expect(
      p.ensureProjectAssignment({ projectName: 'x', environment: 'y' }),
    ).resolves.toBeNull();
  });
});
