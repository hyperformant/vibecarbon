import { describe, expect, it } from 'vitest';
import {
  assertStorageDns,
  checkStorageDns,
  type DnsGateDeps,
  storageHostFor,
} from '../../e2e/utils/dns-gate.js';

const deps = (local: Record<string, string[]>, pub: Record<string, string[]>): DnsGateDeps => ({
  local: async (h) => local[h] ?? [],
  publicResolver: async (h) => pub[h] ?? [],
});

const SCW = 's3.fr-par.scw.cloud';

describe('storageHostFor', () => {
  it('derives the storage host the CLI would use from the deploy region', async () => {
    expect(await storageHostFor('scaleway', 'fr-par-1')).toBe(SCW);
    expect(await storageHostFor('scaleway', 'nl-ams-2')).toBe('s3.nl-ams.scw.cloud');
    expect(await storageHostFor('hetzner', 'fsn1')).toBe('fsn1.your-objectstorage.com');
  });
});

describe('checkStorageDns', () => {
  const target = [{ provider: 'scaleway', region: 'fr-par-1' }];

  it('passes when the resolvers share an address', async () => {
    const d = deps({ [SCW]: ['1.1.1.1', '2.2.2.2'] }, { [SCW]: ['2.2.2.2', '3.3.3.3'] });
    expect(await checkStorageDns(target, d)).toEqual([]);
  });

  it('refuses a local resolver with no answer (the 2026-11-05 router fault), naming the host', async () => {
    const d = deps({}, { [SCW]: ['51.159.0.1'] });
    const findings = await checkStorageDns(target, d);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ provider: 'scaleway', host: SCW });
    await expect(assertStorageDns(target, d)).rejects.toThrow(new RegExp(`${SCW}.*no A answer`));
  });

  it('refuses disjoint answers', async () => {
    const d = deps({ [SCW]: ['10.0.0.1'] }, { [SCW]: ['51.159.0.1'] });
    await expect(assertStorageDns(target, d)).rejects.toThrow(/10\.0\.0\.1.*51\.159\.0\.1/);
  });

  it('refuses when the public resolver cannot answer, since nothing is checked', async () => {
    const d = deps({ [SCW]: ['51.159.0.1'] }, {});
    expect(await checkStorageDns(target, d)).toHaveLength(1);
  });

  it('refuses a region whose storage host is unknown instead of skipping it', async () => {
    const findings = await checkStorageDns(
      [{ provider: 'scaleway', region: 'nowhere' }],
      deps({}, {}),
    );
    expect(findings).toHaveLength(1);
  });

  it('looks each host up once and names every failing one', async () => {
    const calls: string[] = [];
    const d: DnsGateDeps = {
      local: async (h) => {
        calls.push(h);
        return [];
      },
      publicResolver: async () => ['9.9.9.9'],
    };
    const targets = [
      { provider: 'scaleway', region: 'fr-par-1' },
      { provider: 'scaleway', region: 'fr-par-2' },
      { provider: 'hetzner', region: 'fsn1' },
    ];
    await expect(assertStorageDns(targets, d)).rejects.toThrow(
      new RegExp(`${SCW}.*fsn1\\.your-objectstorage\\.com`),
    );
    expect(calls.sort()).toEqual([SCW, 'fsn1.your-objectstorage.com'].sort());
  });
});

describe('runner wiring', () => {
  it('runs the gate after capacity resolution and before the db is opened', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../e2e/runner.ts', import.meta.url), 'utf8');
    const gate = src.indexOf('await assertStorageDns(');
    expect(gate).toBeGreaterThan(src.indexOf('Resolving capacity'));
    expect(gate).toBeLessThan(src.indexOf('const db = new E2EDb();'));
  });
});
