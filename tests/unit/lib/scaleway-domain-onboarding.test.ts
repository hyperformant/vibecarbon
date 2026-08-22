/**
 * Coverage for `onboardDomain` in src/lib/scaleway-guided-setup.js — the flow
 * that keeps a Scaleway operator whose domain lives at another registrar from
 * being stranded on manual DNS with no explanation.
 *
 * Kept in its own file rather than folded into a scaleway-guided-setup suite:
 * this is about DOMAIN onboarding, not credential onboarding, and the two have
 * different subjects (the Domains API vs the IAM triple).
 *
 * THE PROPERTY THAT MATTERS IS ORDER. Register → publish the `_scaleway-challenge`
 * TXT at the domain's CURRENT DNS host → wait for validation → and only THEN
 * move the nameservers. Doing the last step early is a permanent deadlock: the
 * domain delegates to Scaleway, Scaleway refuses to serve an unvalidated zone
 * (403 for the whole `checking` period, confirmed live over a 9-minute poll),
 * so the ownership record can never resolve. Everything below exists to make
 * the flow steer away from that, and name it when an operator is already in it.
 *
 * The second property: `ready: true` requires validated AND delegated. A
 * merely-validated domain would let the deploy write records into a zone
 * nobody is asking, then fail ACME.
 */
import { stripVTControlCharacters } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clackMock = vi.hoisted(() => ({
  password: vi.fn(),
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for('cancel')),
  cancel: vi.fn(),
  note: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), success: vi.fn(), error: vi.fn() },
}));
vi.mock('@clack/prompts', () => clackMock);
// This suite drives the INTERACTIVE flow, so it declares an interactive
// terminal. The off-TTY behaviour (prompts throw rather than hang into a
// silent exit 0) is censused in tests/unit/lib/cli/interactive-prompt-guard.test.ts.
vi.mock('../../../src/lib/cli/tty-guard.js', () => ({ assertInteractiveStdin: vi.fn() }));
vi.mock('../../../src/lib/cli/progress.js', () => ({
  spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
  progressLog: () => {},
}));
vi.mock('../../../src/lib/project.js', () => ({ setEnvVar: vi.fn() }));

// The live NS lookup: every test states the delegation explicitly, because
// the delegation is what the flow branches on.
const resolveNameserversMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/dns-propagation.js', () => ({
  resolveNameservers: resolveNameserversMock,
  waitForDNSPropagation: vi.fn(),
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', fetchMock);

const strip = (s: unknown) => stripVTControlCharacters(String(s));
/** Every note body rendered during a run, concatenated. */
function notes(): string {
  return clackMock.note.mock.calls.map((call) => strip(call[0])).join('\n');
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** GET /domains — the Registrar listing `onboardDomain` reads first. */
function domainsListing(rows: unknown[]): Response {
  return ok({ domains: rows, total_count: rows.length });
}

const OTHER_HOST_NS = ['ns1.digitalocean.com', 'ns2.digitalocean.com'];
const SCALEWAY_NS = ['ns0.dom.scw.cloud', 'ns1.dom.scw.cloud'];

async function freshModule() {
  vi.resetModules();
  return import('../../../src/lib/scaleway-guided-setup.js');
}

beforeEach(() => {
  fetchMock.mockReset();
  resolveNameserversMock.mockReset();
  clackMock.text.mockReset();
  clackMock.confirm.mockReset();
  clackMock.note.mockReset();
  clackMock.log.warn.mockReset();
  clackMock.log.error.mockReset();
  clackMock.text.mockResolvedValue('example.com');
  // Default: the domain still lives at its old host, and no other DNS
  // credential is in the environment, so the manual path runs.
  resolveNameserversMock.mockResolvedValue(OTHER_HOST_NS);
  for (const key of [
    'HETZNER_API_TOKEN',
    'CLOUDFLARE_API_TOKEN',
    'DIGITALOCEAN_API_TOKEN',
    'LINODE_API_TOKEN',
    'VULTR_API_TOKEN',
  ]) {
    vi.stubEnv(key, '');
  }
  vi.stubEnv('SCALEWAY_DEFAULT_PROJECT_ID', 'proj-1');
});

describe('onboardDomain — registering a domain Scaleway does not manage', () => {
  it('suggests the registrable name (last two labels) rather than the deploy subdomain', async () => {
    fetchMock
      .mockResolvedValueOnce(domainsListing([]))
      .mockResolvedValueOnce(ok({ domain: 'example.com', validation_token: 't' }));

    const { onboardDomain } = await freshModule();
    await onboardDomain('secret', 'e1.example.com');

    const [prompt] = clackMock.text.mock.calls[0];
    expect(prompt.initialValue).toBe('example.com');
    // It is a SUGGESTION, not a decision: `app.example.co.uk` needs the Public
    // Suffix List to split correctly, and registering the wrong name is a
    // 14-day account-level commitment.
    expect(strip(prompt.message)).toMatch(/registrable/i);
  });

  it('registers it, then prints the record, the token and an ABSOLUTE expiry', async () => {
    const createdAt = new Date(Date.now() - 3_600_000).toISOString();
    fetchMock
      .mockResolvedValueOnce(domainsListing([]))
      .mockResolvedValueOnce(
        ok({ domain: 'example.com', validation_token: 'tok-abc', created_at: createdAt }),
      );

    const { onboardDomain } = await freshModule();
    const result = await onboardDomain('secret', 'e1.example.com');

    expect(result).toEqual({ ready: false, domain: 'example.com', validationToken: 'tok-abc' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      domain: 'example.com',
      project_id: 'proj-1',
    });

    const note = notes();
    expect(note).toContain('_scaleway-challenge');
    expect(note).toContain('tok-abc');
    // The 48h window as a MOMENT, not a duration — an operator returning
    // tomorrow can act on "by 14:05 UTC", not on "48 hours".
    const expiry = new Date(new Date(createdAt).getTime() + 48 * 3_600_000);
    expect(note).toContain(expiry.toISOString().slice(0, 16).replace('T', ' '));
    expect(note).toMatch(/~47h/);
  });

  it('tells the operator NOT to move nameservers yet, and why', async () => {
    fetchMock
      .mockResolvedValueOnce(domainsListing([]))
      .mockResolvedValueOnce(ok({ domain: 'example.com', validation_token: 'tok-abc' }));

    const { onboardDomain } = await freshModule();
    await onboardDomain('secret', 'e1.example.com');

    const note = notes();
    expect(note).toMatch(/DO NOT change your nameservers yet/i);
    expect(note).toMatch(/deadlock/i);
    // The nameservers themselves must NOT be handed over at this stage — a
    // reader who sees them will use them.
    expect(note).not.toContain('ns0.dom.scw.cloud');
  });

  it('does NOT re-register a domain already awaiting validation — it reprints its token', async () => {
    fetchMock.mockResolvedValueOnce(
      domainsListing([
        {
          domain: 'example.com',
          status: 'checking',
          is_external: true,
          external_domain_registration_status: { validation_token: 'tok-existing' },
        },
      ]),
    );

    const { onboardDomain } = await freshModule();
    const result = await onboardDomain('secret', 'e1.example.com');

    expect(result.validationToken).toBe('tok-existing');
    // One call only — the listing. A second POST would restart the 48h clock.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notes()).toContain('tok-existing');
  });

  it('surfaces a registration failure as ready:false instead of throwing into the deploy', async () => {
    fetchMock
      .mockResolvedValueOnce(domainsListing([]))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'domain is already registered' }), { status: 409 }),
      );

    const { onboardDomain } = await freshModule();
    const result = await onboardDomain('secret', 'e1.example.com');

    expect(result).toEqual({ ready: false, domain: 'example.com', validationToken: null });
    expect(clackMock.note).not.toHaveBeenCalled();
  });

  it('refuses to register without a Project ID, naming the env var that supplies it', async () => {
    vi.stubEnv('SCALEWAY_DEFAULT_PROJECT_ID', '');
    fetchMock.mockResolvedValueOnce(domainsListing([]));

    const { onboardDomain } = await freshModule();
    const result = await onboardDomain('secret', 'e1.example.com');

    expect(result.ready).toBe(false);
    // The POST never happens — the missing Project ID is caught first.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('onboardDomain — delegation order', () => {
  it('reports ready:true only when the domain is validated AND delegated to Scaleway', async () => {
    resolveNameserversMock.mockResolvedValue(SCALEWAY_NS);
    fetchMock.mockResolvedValueOnce(
      domainsListing([{ domain: 'example.com', status: 'active', is_external: true }]),
    );

    const { onboardDomain } = await freshModule();
    const result = await onboardDomain('secret', 'e1.example.com');

    expect(result).toEqual({ ready: true, domain: 'example.com', validationToken: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clackMock.note).not.toHaveBeenCalled();
  });

  it('a validated domain still delegated elsewhere is NOT ready — it gets the nameserver step', async () => {
    // Ready here would march the deploy into writing records nobody resolves,
    // and then an ACME failure.
    fetchMock.mockResolvedValueOnce(
      domainsListing([{ domain: 'example.com', status: 'active', is_external: true }]),
    );

    const { onboardDomain } = await freshModule();
    const result = await onboardDomain('secret', 'e1.example.com');

    expect(result.ready).toBe(false);
    const note = notes();
    // NOW the nameservers are the instruction — and only now.
    expect(note).toContain('ns0.dom.scw.cloud');
    expect(note).toContain('ns1.dom.scw.cloud');
  });

  it('DETECTS THE DEADLOCK: delegated to Scaleway while still checking', async () => {
    resolveNameserversMock.mockResolvedValue(SCALEWAY_NS);
    fetchMock.mockResolvedValueOnce(
      domainsListing([
        {
          domain: 'example.com',
          status: 'checking',
          is_external: true,
          external_domain_registration_status: { validation_token: 'tok-stuck' },
        },
      ]),
    );

    const { onboardDomain } = await freshModule();
    const result = await onboardDomain('secret', 'e1.example.com');

    expect(result.ready).toBe(false);
    expect(strip(clackMock.log.error.mock.calls[0][0])).toMatch(/stuck/i);
    const note = notes();
    // The way out, in order: nameservers BACK, publish, wait, then forward.
    expect(note).toMatch(/point the nameservers .*back/i);
    expect(note).toContain('_scaleway-challenge');
  });

  it('never offers to publish the challenge while the domain is deadlocked', async () => {
    // Publishing anywhere is futile once the delegation has moved: resolvers
    // follow it to the one host that will not answer.
    resolveNameserversMock.mockResolvedValue(SCALEWAY_NS);
    vi.stubEnv('DIGITALOCEAN_API_TOKEN', 'do-tok');
    fetchMock.mockResolvedValueOnce(
      domainsListing([{ domain: 'example.com', status: 'checking', is_external: true }]),
    );

    const { onboardDomain } = await freshModule();
    await onboardDomain('secret', 'e1.example.com');

    expect(clackMock.confirm).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('onboardDomain — publishing the ownership record for the operator', () => {
  /**
   * The common case worth automating: the domain's CURRENT DNS is a backend we
   * already drive, so the CLI can write the `_scaleway-challenge` TXT itself
   * instead of asking a human to. Wired here as DigitalOcean (zone id is the
   * domain name, records live at /v2/domains/{d}/records).
   */
  function withDigitalOceanHosting(afterPublish: Response[]) {
    vi.stubEnv('DIGITALOCEAN_API_TOKEN', 'do-tok');
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const href = String(url);
      // Scaleway: registrar listing, then the registration POST.
      if (href.includes('/domain/v2beta1/domains')) {
        const next = afterPublish.shift();
        return Promise.resolve(next ?? domainsListing([]));
      }
      if (href.includes('/external-domains')) {
        return Promise.resolve(ok({ domain: 'example.com', validation_token: 'tok-abc' }));
      }
      // DigitalOcean: zone listing, record listing, record create.
      if (href.includes('api.digitalocean.com/v2/domains?')) {
        return Promise.resolve(ok({ domains: [{ name: 'example.com' }], links: {}, meta: {} }));
      }
      if (href.includes('/records')) {
        if (init?.method === 'POST') return Promise.resolve(ok({ domain_record: { id: 1 } }));
        return Promise.resolve(ok({ domain_records: [], links: {}, meta: { total: 0 } }));
      }
      return Promise.resolve(ok({}));
    });
  }

  it('offers, then writes the TXT into the backend that serves the domain today', async () => {
    withDigitalOceanHosting([domainsListing([])]);
    clackMock.confirm.mockResolvedValue(true);

    const { onboardDomain } = await freshModule();
    await onboardDomain('secret', 'e1.example.com', { validationTimeoutMs: 0 });

    expect(strip(clackMock.confirm.mock.calls[0][0].message)).toContain('DigitalOcean');

    const created = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes('/records') && init?.method === 'POST',
    );
    expect(created, 'no record was created at the hosting backend').toBeDefined();
    expect(JSON.parse(created?.[1].body)).toMatchObject({
      type: 'TXT',
      name: '_scaleway-challenge',
      data: 'tok-abc',
    });

    // The note becomes a receipt, not an instruction — telling an operator to
    // add a record that already exists invites a duplicate.
    expect(notes()).toMatch(/Done for you/i);
  });

  it('moves straight to the nameserver step when validation lands during the poll', async () => {
    withDigitalOceanHosting([
      domainsListing([]), // first read: unknown
      domainsListing([{ domain: 'example.com', status: 'active', is_external: true }]), // poll
    ]);
    clackMock.confirm.mockResolvedValue(true);

    const { onboardDomain } = await freshModule();
    const result = await onboardDomain('secret', 'e1.example.com', { validationTimeoutMs: 0 });

    expect(result.ready).toBe(false);
    expect(notes()).toContain('ns0.dom.scw.cloud');
  });

  it('falls back to printed instructions when the operator declines', async () => {
    withDigitalOceanHosting([domainsListing([])]);
    clackMock.confirm.mockResolvedValue(false);

    const { onboardDomain } = await freshModule();
    await onboardDomain('secret', 'e1.example.com', { validationTimeoutMs: 0 });

    const created = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes('/records') && init?.method === 'POST',
    );
    expect(created).toBeUndefined();
    expect(notes()).toMatch(/current DNS host/i);
  });

  it('falls back to printed instructions when no account of ours serves the domain', async () => {
    // The default env in beforeEach holds no other DNS credential.
    fetchMock
      .mockResolvedValueOnce(domainsListing([]))
      .mockResolvedValueOnce(ok({ domain: 'example.com', validation_token: 'tok-abc' }));

    const { onboardDomain } = await freshModule();
    await onboardDomain('secret', 'e1.example.com', { validationTimeoutMs: 0 });

    expect(clackMock.confirm).not.toHaveBeenCalled();
    expect(notes()).toMatch(/current DNS host/i);
  });

  it('a failed publish degrades to instructions rather than failing the deploy', async () => {
    vi.stubEnv('DIGITALOCEAN_API_TOKEN', 'do-tok');
    clackMock.confirm.mockResolvedValue(true);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/domain/v2beta1/domains')) return Promise.resolve(domainsListing([]));
      if (href.includes('/external-domains')) {
        return Promise.resolve(ok({ domain: 'example.com', validation_token: 'tok-abc' }));
      }
      if (href.includes('api.digitalocean.com/v2/domains?')) {
        return Promise.resolve(ok({ domains: [{ name: 'example.com' }], links: {}, meta: {} }));
      }
      if (href.includes('/records') && init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ message: 'nope' }), { status: 422 }));
      }
      return Promise.resolve(ok({ domain_records: [], links: {}, meta: { total: 0 } }));
    });

    const { onboardDomain } = await freshModule();
    const result = await onboardDomain('secret', 'e1.example.com', { validationTimeoutMs: 0 });

    expect(result.validationToken).toBe('tok-abc');
    expect(notes()).toMatch(/current DNS host/i);
  });
});
