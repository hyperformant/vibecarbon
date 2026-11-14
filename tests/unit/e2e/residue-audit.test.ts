/** The weekly read-only residue audit: classifier, summary, exit code, and the GET-only guarantee. */
import { DeleteBucketCommand, ListBucketsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../../config.js';
import {
  auditExitCode,
  classify,
  FIXTURES,
  type InventoryRow,
  inventory,
  listBucketsOnly,
  RESIDUE_MIN_AGE_MS,
  renderSummary,
} from '../../e2e/utils/residue-audit.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3_600_000;
const row = (o: Partial<InventoryRow>): InventoryRow => ({
  provider: 'digitalocean',
  kind: 'server',
  name: 'x',
  ...o,
});

// A sample name for each fixture whose name is a pattern.
const SAMPLES: Record<string, string> = {
  'bucket:vc-e2e-state': 'vc-e2e-state-ci-abc123',
  'network:default': 'default-nyc3',
};
const sampleName = (f: (typeof FIXTURES)[number]) =>
  typeof f.name === 'string' ? f.name : SAMPLES[`${f.kind}:${f.why.split(' ')[0]}`];

describe('classify', () => {
  it('flags a testapp droplet older than 6 hours', () => {
    const r = row({ name: 'testapp-compose-1731000000000-abc123', createdAt: ago(7 * H) });
    expect(classify(r, NOW)).toBe('residue');
    expect(RESIDUE_MIN_AGE_MS).toBe(21_600_000);
  });

  it('calls a citest server 2 hours old in-flight, not residue', () => {
    const r = row({ name: 'citest-k8s-1731000000000-abc123-master', createdAt: ago(2 * H) });
    expect(classify(r, NOW)).toBe('in-flight');
  });

  it('treats an undated test-shaped row as residue', () => {
    expect(classify(row({ name: 'citest-x-1731000000000-abc123' }), NOW)).toBe('residue');
  });

  it('keeps every fixture out of the residue list', () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
    for (const f of FIXTURES) {
      const name = sampleName(f);
      expect(name, `no sample for fixture ${f.kind} ${f.why}`).toBeTruthy();
      const r = row({ provider: f.provider === '*' ? 'hetzner' : f.provider, kind: f.kind, name });
      expect(classify({ ...r, createdAt: ago(900 * H) }, NOW)).toBe('fixture');
      expect(classify(r, NOW)).toBe('fixture');
    }
  });

  it('counts empty generic tags as expected and run tags as residue', () => {
    for (const t of [
      'role:db',
      'environment:cil1',
      'node-pool:worker-pool',
      'managed-by:vibecarbon',
    ]) {
      expect(classify(row({ kind: 'tag', name: t, count: 0 }), NOW)).toBe('expected');
    }
    expect(
      classify(row({ kind: 'tag', name: 'project:testapp-compose-1731000000000-abc123' }), NOW),
    ).toBe('residue');
    expect(
      classify(row({ kind: 'tag', name: 'cluster:citest-k8s-1731000000000-abc123' }), NOW),
    ).toBe('residue');
  });

  it('flags any stack, lock or backup in an e2e state bucket, but not meta.yaml', () => {
    const k = (name: string, createdAt?: string) =>
      row({ provider: 'hetzner', kind: 'state-object', name, createdAt });
    expect(classify(k('.pulumi/meta.yaml'), NOW)).toBe('fixture');
    expect(classify(k('.pulumi/stacks/testapp-x/e1.json'), NOW)).toBe('residue');
    expect(classify(k('.pulumi/locks/org/proj/e1/abc.json'), NOW)).toBe('residue');
    expect(classify(k('.pulumi/stacks/p/e1.json.bak'), NOW)).toBe('residue');
    expect(classify(k('.pulumi/stacks/p/e1.json', ago(1 * H)), NOW)).toBe('in-flight');
    expect(classify(k('.pulumi/history/p/e1/x.json'), NOW)).toBe('other');
  });

  it('an undated run tag from a run that started 2 hours ago is in-flight', () => {
    const tag = (ms: number) => row({ kind: 'tag', name: `project:testapp-k8s-${ms}-abc123` });
    expect(classify(tag(NOW - 2 * H), NOW)).toBe('in-flight');
    expect(classify(tag(NOW - 7 * H), NOW)).toBe('residue');
  });

  it('an undated test-shaped server with no time in its name is residue', () => {
    expect(classify(row({ name: 'testapp-compose-master' }), NOW)).toBe('residue');
  });

  it('a dated row uses its own date even when its name carries an older start time', () => {
    // The provider's own created-at is a fact about this resource; the name is
    // only a label, so the row's date wins over the start time in the name.
    const name = `testapp-k8s-${NOW - 9 * H}-abc123-master`;
    expect(classify(row({ name, createdAt: ago(1 * H) }), NOW)).toBe('in-flight');
    expect(classify(row({ name, createdAt: ago(8 * H) }), NOW)).toBe('residue');
  });

  it('reads a run start time out of a scratch stack key', () => {
    const young = `.pulumi/stacks/testapp-compose-${NOW - 1 * H}-abc123/e1.json`;
    const old = `.pulumi/stacks/testapp-compose-${NOW - 9 * H}-abc123/e1.json`;
    expect(classify(row({ kind: 'state-object', name: young }), NOW)).toBe('in-flight');
    expect(classify(row({ kind: 'state-object', name: old }), NOW)).toBe('residue');
  });

  it('flags a per-run DNS name in an e2e zone and ignores the zone own records', () => {
    expect(classify(row({ kind: 'dns-record', name: 'e1-abc123.carbonstack.dev' }), NOW)).toBe(
      'residue',
    );
    expect(
      classify(
        row({ kind: 'dns-record', name: '_acme-challenge.cid1-abc123r2.do.appcarbon.dev' }),
        NOW,
      ),
    ).toBe('residue');
    expect(classify(row({ kind: 'dns-record', name: 'www.appcarbon.dev' }), NOW)).toBe('other');
  });

  it('everything else is other', () => {
    expect(classify(row({ name: 'my-real-app' }), NOW)).toBe('other');
  });
});

describe('test-shaped names', () => {
  it('a real name that merely contains testapp- is not test-shaped', () => {
    const rows = [
      row({ name: 'mytestapp-site' }),
      row({ kind: 'tag', name: 'project:mytestapp-site' }),
      row({ kind: 'dns-record', name: 'x1-abcdef.example.io' }),
    ];
    for (const r of rows) expect(classify(r, NOW)).toBe('other');
    const md = renderSummary(
      rows.map((r) => ({ ...r, verdict: classify(r, NOW) })),
      [],
    );
    expect(md).not.toContain('mytestapp-site');
    expect(md).not.toContain('example.io');
  });

  it('still catches every real name shape', () => {
    const ms = NOW - 9 * H;
    const names: Array<[string, string]> = [
      ['server', `citest-k8s-${ms}-abc123-master`],
      ['server', `testapp-compose-ha-${ms}-abc123-primary`],
      ['volume', `testapp-compose-${ms}-abc123-data`],
      ['bucket', `testapp-compose-${ms}-abc123-storage`],
      ['firewall', `citest-compose-${ms}-abc123-firewall`],
      ['tag', `project:testapp-k8s-${ms}-abc123`],
      ['tag', `cluster:citest-k8s-ha-${ms}-abc123`],
      ['tag', 'environment:testapp-d3'],
      ['dns-record', 'e1-abc123.carbonstack.dev'],
      ['dns-record', 'cil1-abc123r2.linode.appcarbon.dev'],
      ['dns-record', 'api.d2-abc123.do.appcarbon.dev'],
    ];
    for (const [kind, name] of names) {
      expect(classify(row({ kind, name, createdAt: ago(9 * H) }), NOW), name).toBe('residue');
    }
  });
});

describe('listBucketsOnly', () => {
  it('the bucket listing client refuses any command but ListBuckets', async () => {
    const sent: string[] = [];
    const wrapped = listBucketsOnly({
      send: async (c: { constructor: { name: string } }) => {
        sent.push(c.constructor.name);
        return { Buckets: [] };
      },
    });
    await expect(wrapped.send(new ListBucketsCommand({}))).resolves.toEqual({ Buckets: [] });
    await expect(wrapped.send(new DeleteBucketCommand({ Bucket: 'b' }))).rejects.toThrow(
      /refusing/,
    );
    await expect(wrapped.send(new PutObjectCommand({ Bucket: 'b', Key: 'k' }))).rejects.toThrow(
      /refusing/,
    );
    expect(sent).toEqual(['ListBucketsCommand']);
  });
});

describe('renderSummary', () => {
  it('never names a row that is neither test-shaped nor a fixture', () => {
    const rows = [
      row({ provider: 'cloudflare', kind: 'dns-record', name: 'jellyfin.example.io' }),
      row({ name: 'my-real-app' }),
      row({ name: 'testapp-compose-1731000000000-abc123', createdAt: ago(9 * H) }),
      row({ provider: 'hetzner', kind: 'bucket', name: 'vc-e2e-state-ci-abc123' }),
    ].map((r) => ({ ...r, verdict: classify(r, NOW) }));
    const md = renderSummary(rows, ['scaleway: lb fr-par-1: 503'], ['scaleway ssh-key']);
    expect(md).not.toContain('jellyfin.example.io');
    expect(md).not.toContain('my-real-app');
    expect(md).not.toContain('vc-e2e-state-ci-abc123');
    expect(md).toContain('testapp-compose-1731000000000-abc123');
    expect(md).toContain('scaleway');
    expect(md).toContain('ssh-key');
  });
});

describe('auditExitCode', () => {
  const res = { ...row({}), verdict: 'residue' as const };
  const ok = { ...row({}), verdict: 'other' as const };
  it('exit code is 1 on residue, 2 on an incomplete inventory, 0 when clean', () => {
    expect(auditExitCode([res], [])).toBe(1);
    expect(auditExitCode([res], ['x'])).toBe(1);
    expect(auditExitCode([ok], ['scaleway: down'])).toBe(2);
    expect(auditExitCode([ok], [])).toBe(0);
  });
});

// ---- inventory ------------------------------------------------------------

const ENV: Record<string, string> = {
  VC_E2E_STATE_BUCKET: 'vc-e2e-state-local-abc123',
  CLOUDFLARE_API_TOKEN: 't',
  SCALEWAY_DEFAULT_PROJECT_ID: 'p',
  VULTR_STORAGE_REGION: 'ewr1',
};
for (const e of Object.values(testConfig.e2e.providers))
  for (const v of e.requiredEnv) ENV[v] ??= 'x';
for (const [a, b] of [
  ['HETZNER_ACCESS_KEY', 'HETZNER_SECRET_KEY'],
  ['LINODE_ACCESS_KEY', 'LINODE_SECRET_KEY'],
]) {
  ENV[a] = 'x';
  ENV[b] = 'x';
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function okStore(keys: string[] = ['.pulumi/meta.yaml'], complete = true, located = true) {
  return () => ({
    where: async () => (located ? { bucket: 'b', region: 'r', endpoint: 'e' } : null),
    list: async () => ({ keys, complete }),
    read: async () => null,
    remove: async () => {
      throw new Error('the audit must never remove');
    },
  });
}
const s3Empty = () => ({
  send: async (cmd: unknown) => {
    if (!(cmd instanceof ListBucketsCommand)) throw new Error('only ListBuckets is allowed');
    return { Buckets: [] };
  },
});

describe('inventory', () => {
  it('every registry provider has an inventory', async () => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(String(url));
      return json({});
    }) as unknown as typeof fetch;
    for (const provider of Object.keys(testConfig.e2e.providers)) {
      const out = await inventory(provider, ENV, f, { s3: s3Empty, makeStore: okStore() });
      expect(out.complete, `${provider}: ${out.incomplete.join('; ')}`).toBe(true);
    }
    const cf = await inventory('cloudflare', ENV, f, { s3: s3Empty, makeStore: okStore() });
    expect(cf.complete).toBe(true);
    expect(calls.length).toBeGreaterThan(20);
  });

  it('only ever sends GET (or HEAD), only ever asks the state store to list, and never removes', async () => {
    const methods = new Set<string>();
    const f = (async (_u: string, init?: RequestInit) => {
      methods.add((init?.method ?? 'GET').toUpperCase());
      return json({});
    }) as unknown as typeof fetch;
    for (const provider of [...Object.keys(testConfig.e2e.providers), 'cloudflare']) {
      await inventory(provider, ENV, f, { s3: s3Empty, makeStore: okStore() });
    }
    expect([...methods].filter((m) => m !== 'GET' && m !== 'HEAD')).toEqual([]);
    expect(methods.has('GET')).toBe(true);
  });

  it('looks each e2e zone up by exact name and never lists all zones', async () => {
    const urls: string[] = [];
    const headers: Array<Record<string, string>> = [];
    const f = (async (u: string, init?: RequestInit) => {
      urls.push(String(u));
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return json({});
    }) as unknown as typeof fetch;
    for (const provider of [...Object.keys(testConfig.e2e.providers), 'cloudflare']) {
      await inventory(provider, ENV, f, { s3: s3Empty, makeStore: okStore() });
    }
    const dns = urls.filter((u) => /zones|domains/.test(u) && !/instance|block|lb\/|vpc/.test(u));
    expect(dns).toContain('https://api.hetzner.cloud/v1/zones?name=carbonstack.dev');
    expect(dns).toContain('https://api.cloudflare.com/client/v4/zones?name=appcarbon.dev');
    expect(dns.some((u) => /\/v2\/domains\/do\.appcarbon\.dev\/records/.test(u))).toBe(true);
    expect(dns.some((u) => /\/v2\/domains\/threvidence\.com\/records/.test(u))).toBe(true);
    expect(dns.some((u) => /dns-zones\?domain=threadtrace\.app/.test(u))).toBe(true);
    expect(
      headers.some((h) => h['X-Filter'] === JSON.stringify({ domain: 'linode.appcarbon.dev' })),
    ).toBe(true);
    // No bare listing of every zone or domain.
    for (const u of dns) expect(u).not.toMatch(/\/(zones|domains|dns-zones)\/?(\?per_page=\d+)?$/);
  });

  it('a 5xx, 429, 401 or transport error makes the provider incomplete', async () => {
    for (const status of [500, 503, 429, 401]) {
      const f = (async (u: string) =>
        String(u).includes('/v1/volumes') ? json({}, status) : json({})) as unknown as typeof fetch;
      const out = await inventory('hetzner', ENV, f, { s3: s3Empty, makeStore: okStore() });
      expect(out.complete, String(status)).toBe(false);
      expect(out.incomplete.join(' ')).toContain('volumes');
    }
    const boom = (async (u: string) => {
      if (String(u).includes('/v1/servers')) throw new TypeError('fetch failed');
      return json({});
    }) as unknown as typeof fetch;
    expect(
      (await inventory('hetzner', ENV, boom, { s3: s3Empty, makeStore: okStore() })).complete,
    ).toBe(false);
  });

  it('pagination that ends early makes the provider incomplete', async () => {
    const f = (async (u: string) => {
      if (u.includes('/instance/v1/zones/fr-par-1/servers')) {
        const page = Number(new URL(u).searchParams.get('page') ?? '1');
        return json(
          page === 1
            ? { servers: [{ name: 'a' }, { name: 'b' }], total_count: 3 }
            : { servers: [] },
        );
      }
      return json({});
    }) as unknown as typeof fetch;
    const out = await inventory('scaleway', ENV, f, { s3: s3Empty, makeStore: okStore() });
    expect(out.complete).toBe(false);
    expect(out.incomplete.join(' ')).toMatch(/pagination/);
  });

  it('follows next pages and reads every row', async () => {
    const seen: string[] = [];
    const f = (async (u: string) => {
      if (u.includes('/v1/servers')) {
        const page = Number(new URL(u).searchParams.get('page'));
        seen.push(`${new URL(u).searchParams.get('per_page')}:${page}`);
        return json({
          servers: [{ name: `s${page}` }],
          meta: { pagination: { next_page: page < 3 ? page + 1 : null } },
        });
      }
      return json({});
    }) as unknown as typeof fetch;
    const out = await inventory('hetzner', ENV, f, { s3: s3Empty, makeStore: okStore() });
    expect(seen).toEqual(['50:1', '50:2', '50:3']);
    expect(out.rows.filter((r) => r.kind === 'server').map((r) => r.name)).toEqual([
      's1',
      's2',
      's3',
    ]);
  });

  it('a provider with no e2e zone is incomplete and never requests name=undefined', async () => {
    const domains = testConfig.e2e.domains as Record<string, string>;
    const saved = domains.hetzner;
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(String(u));
      return json({});
    }) as unknown as typeof fetch;
    try {
      delete domains.hetzner;
      const out = await inventory('hetzner', ENV, f, { s3: s3Empty, makeStore: okStore() });
      expect(out.complete).toBe(false);
      expect(out.incomplete.join(' ')).toContain('hetzner: no e2e zone configured');
      expect(urls.some((u) => /undefined|\/zones/.test(u))).toBe(false);
    } finally {
      domains.hetzner = saved;
    }
  });

  it('a 403 on one kind is not covered, not incomplete', async () => {
    const f = (async (u: string) =>
      String(u).includes('/iam/v1alpha1/ssh-keys')
        ? json({}, 403)
        : json({})) as unknown as typeof fetch;
    const out = await inventory('scaleway', ENV, f, { s3: s3Empty, makeStore: okStore() });
    expect(out.complete).toBe(true);
    expect(out.notCovered.join(' ')).toContain('ssh-key');
  });

  it('a provider whose every kind answers 401 or 403 is incomplete', async () => {
    const f = (async () => json({}, 403)) as unknown as typeof fetch;
    const s3Refused = () => ({
      send: async () => {
        throw Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } });
      },
    });
    const out = await inventory('hetzner', ENV, f, { s3: s3Refused, makeStore: okStore() });
    expect(out.complete).toBe(false);
  });

  it('an unreachable or unlocatable state bucket is incomplete, never clean', async () => {
    const f = (async () => json({})) as unknown as typeof fetch;
    const noWhere = await inventory('hetzner', ENV, f, {
      s3: s3Empty,
      makeStore: okStore([], true, false),
    });
    expect(noWhere.complete).toBe(false);
    const partial = await inventory('hetzner', ENV, f, {
      s3: s3Empty,
      makeStore: okStore([], false),
    });
    expect(partial.complete).toBe(false);
    const noCreds = await inventory('hetzner', ENV, f, { s3: s3Empty, makeStore: () => null });
    expect(noCreds.complete).toBe(false);
  });

  it('turns state keys into rows for both namespaces', async () => {
    const f = (async () => json({})) as unknown as typeof fetch;
    const out = await inventory('hetzner', ENV, f, {
      s3: s3Empty,
      makeStore: okStore(['.pulumi/meta.yaml', '.pulumi/stacks/p/e1.json']),
    });
    expect(out.rows.filter((r) => r.kind === 'state-object')).toHaveLength(4);
  });
});
