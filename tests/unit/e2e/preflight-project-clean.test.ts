/**
 * Preflight "project clean": the five per-provider checks that count
 * scratch-prefixed leftovers before a run provisions anything.
 *
 * They are private to preflight.ts, so they are driven through runPreflight
 * with the global fetch stubbed. One listing per provider (its firewalls)
 * is served by the test; every other request gets an empty, final page.
 *
 * Each provider is checked for: a leftover (run aborts), a foreign row
 * (clean), HTTP 500 and a thrown fetch (reported as partial, the run goes
 * on), a leftover that is only on PAGE 2, and a listing that never ends.
 * Until 2026-11-17 these checks read one page per resource kind, so the
 * page-2 leftover was never seen and the check said clean.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PreflightCheck, runPreflight } from '../../e2e/utils/preflight.js';

type Json = Record<string, unknown>;
type Row = Record<string, unknown>;

interface Cloud {
  name: string;
  service: string;
  args: Parameters<typeof runPreflight>[0];
  /** The listing the test serves (URL without query). */
  listing: string;
  /** What the check calls this resource kind in its detail line. */
  label: string;
  /** How a failed listing is named in the `partial:` detail. */
  errorLabel: string;
  row: (name: string) => Row;
  /** A page of rows; `more` says another page follows. */
  page: (rows: Row[], more: boolean) => Json;
  /** Rows a page must hold for the provider to say "more" (Scaleway: a full page). */
  fullPage?: number;
  /** True when this request asks for a page after the first. */
  isLaterPage: (url: URL) => boolean;
  leakWording: RegExp;
}

const off = { needsHetzner: false, needsCloudflare: false } as const;
const laterByPageNumber = (u: URL) => Number(u.searchParams.get('page') ?? '1') > 1;

const CLOUDS: Cloud[] = [
  {
    name: 'Hetzner',
    service: 'hetzner-clean',
    args: { hetznerToken: 'fake-token', needsCloudflare: false },
    listing: 'https://api.hetzner.cloud/v1/firewalls',
    label: 'firewall',
    errorLabel: 'firewall',
    row: (name) => ({ id: 1, name }),
    page: (rows, more) => ({
      firewalls: rows,
      meta: { pagination: { next_page: more ? 2 : null } },
    }),
    isLaterPage: laterByPageNumber,
    leakWording: /1 testapp-\* resource\(s\) leaked from prior run \(firewall=1\)/,
  },
  {
    name: 'DigitalOcean',
    service: 'digitalocean-clean',
    args: { ...off, needsDigitalOcean: true, digitaloceanToken: 'fake-token' },
    listing: 'https://api.digitalocean.com/v2/firewalls',
    label: 'firewall',
    errorLabel: 'firewall',
    row: (name) => ({ id: 'f1', name }),
    page: (rows, more) => ({
      firewalls: rows,
      links: more ? { pages: { next: 'https://api.digitalocean.com/v2/firewalls?page=2' } } : {},
    }),
    isLaterPage: laterByPageNumber,
    leakWording: /1 testapp-\* resource\(s\) leaked from prior run \(firewall=1\)/,
  },
  {
    name: 'Linode',
    service: 'linode-clean',
    args: { ...off, needsLinode: true, linodeToken: 'fake-token' },
    listing: 'https://api.linode.com/v4/networking/firewalls',
    label: 'firewall',
    errorLabel: 'firewall',
    row: (name) => ({ id: 1, label: name }),
    // `pages` is the total: more than the page asked for means another follows.
    page: (rows, more) => ({ data: rows, pages: more ? 999 : 1 }),
    isLaterPage: laterByPageNumber,
    leakWording: /1 testapp-\* resource\(s\) leaked from prior run \(firewall=1\)/,
  },
  {
    name: 'Vultr',
    service: 'vultr-clean',
    args: { ...off, needsVultr: true, vultrToken: 'fake-token' },
    listing: 'https://api.vultr.com/v2/firewalls',
    label: 'firewall',
    errorLabel: 'firewall',
    // A Vultr firewall group's identity field is `description`.
    row: (name) => ({ id: 'f1', description: name }),
    page: (rows, more) => ({ firewall_groups: rows, meta: { links: { next: more ? 'c2' : '' } } }),
    isLaterPage: (u) => u.searchParams.has('cursor'),
    leakWording: /1 testapp-\* resource\(s\) leaked from prior run \(firewall=1\)/,
  },
  {
    name: 'Scaleway',
    service: 'scaleway-clean',
    args: { ...off, needsScaleway: true, scalewayToken: 'fake-token' },
    listing: 'https://api.scaleway.com/instance/v1/zones/nl-ams-1/security_groups',
    label: 'security_group',
    errorLabel: 'security_group(nl-ams-1)',
    row: (name) => ({ id: 'sg1', name }),
    page: (rows) => ({ security_groups: rows }),
    fullPage: 100,
    isLaterPage: laterByPageNumber,
    leakWording: /1 residual resource\(s\) from prior run \(security_group=1\)/,
  },
];

/** What the served listing answers: pages of rows, a status, or a throw. */
type Served = { pages: Row[][]; endless?: boolean } | { status: number } | { throws: string };

function stubFetch(cloud: Cloud, served: Served) {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (`${url.origin}${url.pathname}` !== cloud.listing) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      asked.push(url.search);
      if ('throws' in served) throw new Error(served.throws);
      if ('status' in served) return { ok: false, status: served.status, json: async () => ({}) };
      if (served.endless) {
        return { ok: true, status: 200, json: async () => cloud.page(served.pages[0], true) };
      }
      const later = cloud.isLaterPage(url);
      const rows = served.pages[later ? 1 : 0] ?? [];
      const more = !later && served.pages.length > 1;
      return { ok: true, status: 200, json: async () => cloud.page(rows, more) };
    }),
  );
  return asked;
}

async function check(cloud: Cloud, served: Served): Promise<PreflightCheck & { asked: string[] }> {
  const asked = stubFetch(cloud, served);
  const { checks } = await runPreflight(cloud.args);
  const found = checks.find((c) => c.service === cloud.service);
  if (!found) throw new Error(`no ${cloud.service} check in ${checks.map((c) => c.service)}`);
  return { ...found, asked };
}

/** A first page that makes the provider say "there is more". */
function firstPage(cloud: Cloud): Row[] {
  return Array.from({ length: cloud.fullPage ?? 1 }, (_, i) => cloud.row(`someone-elses-${i}`));
}

beforeEach(() => {
  // The scratch prefix follows E2E_NAMESPACE (`citest-` in CI); pin the default.
  vi.stubEnv('E2E_NAMESPACE', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

for (const cloud of CLOUDS) {
  describe(`${cloud.name} project-clean`, () => {
    it('a scratch-prefixed leftover fails the check and names the kind and count', async () => {
      const result = await check(cloud, { pages: [[cloud.row('testapp-compose-1-firewall')]] });
      expect(result.status).toBe('failed');
      expect(result.detail).toMatch(cloud.leakWording);
      expect(result.detail).toContain('run sweep before matrix');
    });

    it('rows that do not carry the scratch prefix read clean', async () => {
      const result = await check(cloud, {
        pages: [[cloud.row('vibecarbon-web-prod-firewall'), cloud.row('my-testapp-clone')]],
      });
      expect(result.status).toBe('ok');
      expect(result.detail).toBeUndefined();
    });

    it('an HTTP 500 on one listing is reported as partial, not as a failure', async () => {
      const result = await check(cloud, { status: 500 });
      expect(result.status).toBe('slow');
      expect(result.detail).toBe(`partial: ${cloud.errorLabel}: HTTP 500`);
    });

    it('a fetch that throws is reported as partial with the first line of the error', async () => {
      const result = await check(cloud, { throws: 'connect ETIMEDOUT 203.0.113.1:443\n    at x' });
      expect(result.status).toBe('slow');
      expect(result.detail).toBe(`partial: ${cloud.errorLabel}: connect ETIMEDOUT 203.0.113.1:443`);
    });

    it('a leftover that is only on page 2 is found', async () => {
      const result = await check(cloud, {
        pages: [firstPage(cloud), [cloud.row('testapp-compose-1-firewall')]],
      });
      expect(result.asked).toHaveLength(2);
      expect(result.status).toBe('failed');
      expect(result.detail).toMatch(cloud.leakWording);
    });

    it('a listing that never ends is reported as partial, not as clean', async () => {
      const result = await check(cloud, { pages: [firstPage(cloud)], endless: true });
      expect(result.asked).toHaveLength(20);
      expect(result.status).toBe('slow');
      expect(result.detail).toBe(
        `partial: ${cloud.errorLabel}: listing did not end within 20 pages`,
      );
    });
  });
}

describe('project-clean, all providers', () => {
  it('a missing token fails the check without a request', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchSpy);
    const { checks } = await runPreflight({
      needsCloudflare: false,
      needsDigitalOcean: true,
      needsLinode: true,
      needsVultr: true,
      needsScaleway: true,
    });
    for (const cloud of CLOUDS) {
      const found = checks.find((c) => c.service === cloud.service);
      expect(found, cloud.service).toMatchObject({ status: 'failed', detail: 'no token' });
    }
  });
});
