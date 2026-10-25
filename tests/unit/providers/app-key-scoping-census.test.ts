/**
 * Security plan R2: every S3 provider class declares its own `appKeyScoping`,
 * the base class declares none (so a missing declaration fails here instead
 * of inheriting a silent default), each value matches what was measured on
 * real accounts on 2026-10-20, and a `mint` value carries its evidence. A walk,
 * not a hand list, so a new S3 provider is covered for free.
 *
 * Plus the never-account-wide guarantee: with a stubbed HTTP layer, the
 * DigitalOcean mint asks for exactly one `readwrite` grant on the env bucket
 * (never `fullaccess`), and the Linode mint for exactly one `read_write`
 * bucket_access entry. Sentinel values only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { S3CompatibleProvider } from '../../../src/lib/providers/s3-base.js';

/** Measured 2026-10-20 (docs/research/2026-10-object-storage-key-scoping.md). */
const EXPECTED: Record<string, string> = {
  linode: 'mint',
  digitalocean: 'mint',
  hetzner: 'paste-fence',
  scaleway: 'none',
  vultr: 'none',
};

/** Provider id -> the research doc section that proves its key can be minted. */
const APP_KEY_EVIDENCE: Record<string, string> = {
  linode: '## Linode: mint, verified',
  digitalocean: '## DigitalOcean Spaces: mint via API, verified',
};

const ROOT = join(import.meta.dirname, '../../..');
const providersDir = join(ROOT, 'src/lib/providers');
const RESEARCH = join(ROOT, 'docs/research/2026-10-object-storage-key-scoping.md');

type S3Class = {
  name: string;
  appKeyScoping?: unknown;
  mintAppKey?: unknown;
  revokeAppKey?: unknown;
  appKeyExists?: unknown;
  prototype: { ownerId?: unknown };
};

async function s3ClassesFromFiles(): Promise<S3Class[]> {
  const classes: S3Class[] = [];
  for (const file of readdirSync(providersDir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(providersDir, file), 'utf-8');
    const names = [...src.matchAll(/class\s+(\w+)\s+extends\s+S3CompatibleProvider\b/g)].map(
      (m) => m[1],
    );
    if (names.length === 0) continue;
    const mod = await import(join(providersDir, file));
    for (const name of names) classes.push(mod[name]);
  }
  return classes;
}

async function s3ClassesFromRegistry(): Promise<Array<{ id: string; Class: S3Class }>> {
  return Promise.all(
    Object.entries(PROVIDERS).map(async ([id, P]) => ({
      id,
      Class: (await (
        P as unknown as { getObjectStorageProviderClass(): Promise<S3Class> }
      ).getObjectStorageProviderClass()) as S3Class,
    })),
  );
}

const declared = (C: S3Class) =>
  Object.hasOwn(C, 'appKeyScoping') &&
  ['mint', 'paste-fence', 'none'].includes(String(C.appKeyScoping));

describe('appKeyScoping census', () => {
  it('(a) every S3 provider class declares its own appKeyScoping', async () => {
    const fromFiles = await s3ClassesFromFiles();
    expect(fromFiles.length).toBeGreaterThanOrEqual(5);
    const missing = [
      ...fromFiles.filter((C) => !declared(C)).map((C) => C.name),
      ...(await s3ClassesFromRegistry())
        .filter(({ Class }) => !declared(Class))
        .map(({ id }) => id),
    ];
    expect(missing, 'missing or invalid static appKeyScoping').toEqual([]);
  });

  it('(b) the base class declares none, so there is no implicit default', () => {
    expect(Object.hasOwn(S3CompatibleProvider, 'appKeyScoping')).toBe(false);
  });

  it('(c) each provider declares what was measured', async () => {
    const got = Object.fromEntries(
      (await s3ClassesFromRegistry()).map(({ id, Class }) => [id, Class.appKeyScoping]),
    );
    expect(got).toEqual(EXPECTED);
  });

  it('(d) a mint provider has evidence in the research doc and the three key methods', async () => {
    const doc = readFileSync(RESEARCH, 'utf-8');
    const problems: string[] = [];
    for (const { id, Class } of await s3ClassesFromRegistry()) {
      if (Class.appKeyScoping !== 'mint') continue;
      const section = APP_KEY_EVIDENCE[id];
      if (!section) problems.push(`${id}: no APP_KEY_EVIDENCE entry`);
      else if (!doc.includes(section)) problems.push(`${id}: research doc lacks "${section}"`);
      for (const m of ['mintAppKey', 'revokeAppKey', 'appKeyExists'] as const) {
        if (typeof Class[m] !== 'function') problems.push(`${id}: no static ${m}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('(e) a paste-fence provider can read the project owner id the fence principal needs', async () => {
    const lacking = (await s3ClassesFromRegistry())
      .filter(({ Class }) => Class.appKeyScoping === 'paste-fence')
      .filter(({ Class }) => typeof Class.prototype.ownerId !== 'function')
      .map(({ id }) => id);
    expect(lacking).toEqual([]);
  });

  it('(f) the research doc carries no access-key fragment', () => {
    const doc = readFileSync(RESEARCH, 'utf-8');
    // A Hetzner/Linode/DO access key id is 20 upper-case alphanumerics;
    // the spike notes once quoted four-letter prefixes of two of them.
    expect(doc).not.toMatch(/\b[A-Z0-9]{20}\b/);
    expect(doc).not.toMatch(/`[A-Z0-9]{4}…`/);
  });
});

// ── never account-wide ──────────────────────────────────────────────────────

type Call = { url: string; method: string; body: unknown; raw: string };

function stubHttp(responder: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const raw = typeof init.body === 'string' ? init.body : '';
      calls.push({
        url: String(url),
        method: init.method ?? 'GET',
        body: raw ? JSON.parse(raw) : undefined,
        raw,
      });
      return responder(String(url), init);
    }),
  );
  return calls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the app key is never minted account-wide', () => {
  it('DigitalOcean: exactly one readwrite grant on the env bucket, and fullaccess never appears', async () => {
    const { DigitalOceanSpacesProvider } = await import(
      '../../../src/lib/providers/digitalocean-spaces.js'
    );
    const calls = stubHttp((_url, init) =>
      init.method === 'POST'
        ? json(201, {
            key: { access_key: 'SENTINEL_DO_AK', secret_key: 'SENTINEL_DO_SK', name: 'x' },
          })
        : new Response(null, { status: 204 }),
    );
    const key = await DigitalOceanSpacesProvider.mintAppKey('proj-abc-prod', {
      apiToken: 'SENTINEL_DO_TOKEN',
    });
    await DigitalOceanSpacesProvider.revokeAppKey(key.id, { apiToken: 'SENTINEL_DO_TOKEN' });
    expect(key).toEqual({
      id: 'SENTINEL_DO_AK',
      accessKey: 'SENTINEL_DO_AK',
      secretKey: 'SENTINEL_DO_SK',
    });
    const mint = calls.find((c) => c.method === 'POST');
    expect(mint?.url).toBe('https://api.digitalocean.com/v2/spaces/keys');
    expect(mint?.body).toEqual({
      name: 'vc-app-proj-abc-prod',
      grants: [{ bucket: 'proj-abc-prod', permission: 'readwrite' }],
    });
    for (const c of calls) {
      expect(`${c.url} ${c.raw}`).not.toContain('fullaccess');
    }
  });

  it('Linode: exactly one read_write bucket_access entry on the env bucket, in the endpoint region', async () => {
    const { LinodeObjectStorageProvider } = await import(
      '../../../src/lib/providers/linode-objectstorage.js'
    );
    const calls = stubHttp((url, init) => {
      if (url.includes('/object-storage/endpoints')) {
        return json(200, {
          data: [
            { region: 'us-ord', s3_endpoint: 'us-ord-10.linodeobjects.com' },
            { region: 'us-iad', s3_endpoint: 'us-iad-10.linodeobjects.com' },
          ],
        });
      }
      if (init.method === 'POST') {
        return json(200, {
          id: 4242,
          access_key: 'SENTINEL_LI_AK',
          secret_key: 'SENTINEL_LI_SK',
          limited: true,
        });
      }
      return json(200, {});
    });
    const key = await LinodeObjectStorageProvider.mintAppKey('proj-abc-prod', {
      endpoint: 'https://us-iad-10.linodeobjects.com',
      apiToken: 'SENTINEL_LI_TOKEN',
    });
    expect(key).toEqual({ id: '4242', accessKey: 'SENTINEL_LI_AK', secretKey: 'SENTINEL_LI_SK' });
    const mint = calls.find((c) => c.method === 'POST');
    expect(mint?.url).toBe('https://api.linode.com/v4/object-storage/keys');
    const body = mint?.body as { regions: string[]; bucket_access: unknown[] };
    expect(body.regions).toEqual(['us-iad']);
    expect(body.bucket_access).toEqual([
      { region: 'us-iad', bucket_name: 'proj-abc-prod', permissions: 'read_write' },
    ]);
  });

  it('a refused DigitalOcean mint names the spaces_key scope and never falls back', async () => {
    const { DigitalOceanSpacesProvider } = await import(
      '../../../src/lib/providers/digitalocean-spaces.js'
    );
    stubHttp(() => json(403, { id: 'forbidden', message: 'You are not authorized' }));
    await expect(
      DigitalOceanSpacesProvider.mintAppKey('proj-abc-prod', { apiToken: 'SENTINEL_DO_TOKEN' }),
    ).rejects.toThrow(/spaces_key create and delete scopes/);
  });

  it('a mint is one POST, never retried (a retried create can mint twice)', async () => {
    const { DigitalOceanSpacesProvider } = await import(
      '../../../src/lib/providers/digitalocean-spaces.js'
    );
    const calls = stubHttp(() => json(503, { message: 'unavailable' }));
    await expect(
      DigitalOceanSpacesProvider.mintAppKey('proj-abc-prod', { apiToken: 'SENTINEL_DO_TOKEN' }),
    ).rejects.toThrow(/HTTP 503/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});
