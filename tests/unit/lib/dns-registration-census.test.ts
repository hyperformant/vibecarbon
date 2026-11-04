/**
 * DNS-backend registration census + uniform-contract lock (2026-08-08 DNS
 * seam convergence — the dns-seam-audit plan).
 *
 * Twin of the compute axis's provider-registration-census: a backend module
 * dropped next to the others is INVISIBLE to every command until registered,
 * and a registry row whose module is missing throws at dispatch time. This
 * census makes both directions loud at unit time:
 *
 *  1. File ↔ registry two-way lock: every `src/lib/<id>-dns.js` has a
 *     DNS_PROVIDERS row and vice versa.
 *  2. Uniform contract: every registered module exports the full surface the
 *     converged commands dispatch against (failover's flip, destroy's pair
 *     delete, scale's repoint, deploy's setupSimple/setupHA, prompts' zone
 *     discovery). The two pre-convergence modules had DIVERGENT signatures
 *     for years with nothing enforcing them — that's how the hetzner side
 *     shipped without deleteApexAndWildcard (wildcard-orphan class).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DNS_PROVIDERS, getDnsProvider } from '../../../src/lib/dns-provider.js';

const LIB_DIR = fileURLToPath(new URL('../../../src/lib', import.meta.url));

// The uniform surface every backend must export as functions. Extras
// (verifyToken, deleteHealthCheck, getZone, getRrsets, ...) are allowed —
// consumers reach them by capability sniff or registry flags, never by
// provider-id branches.
const CONTRACT = [
  'getZones',
  'setupSimple',
  'setupHA',
  'upsertApexAndWildcard',
  'createDNSRecord',
  'deleteDNSRecord',
  'deleteApexAndWildcard',
] as const;

describe('DNS backend registration census', () => {
  it('every src/lib/*-dns.js file is registered, and every row resolves to a file', () => {
    const files = readdirSync(LIB_DIR)
      .filter((f) => f.endsWith('-dns.js'))
      .sort();
    const registered = Object.values(DNS_PROVIDERS)
      .map((row) => row.modulePath.replace(/^\.\//, ''))
      .sort();
    expect(files).toEqual(registered);
  });

  it('modulePath convention holds: ./<id>-dns.js for every row', () => {
    for (const [id, row] of Object.entries(DNS_PROVIDERS)) {
      expect(row.modulePath, id).toBe(`./${id}-dns.js`);
    }
  });
});

describe('providers manage A records only', () => {
  it.each(Object.keys(DNS_PROVIDERS))('%s exports no challenge-record reaping', async (id) => {
    const mod = (await getDnsProvider(id)) as Record<string, unknown>;
    expect(mod.deleteChallengeRecords, id).toBeUndefined();
    expect(mod.challengeRecordNames, id).toBeUndefined();
  });

  it('nothing under src/ or carbon/ names an _acme-challenge record or the DNS01_PROVIDERS table', () => {
    const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
    const walk = (dir: string, exts: string[]): string[] =>
      readdirSync(dir).flatMap((name) => {
        if (name === 'node_modules') return [];
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return walk(path, exts);
        return exts.some((e) => path.endsWith(e)) ? [path] : [];
      });
    const src = walk(join(ROOT, 'src'), ['.js']);
    expect(src.length).toBeGreaterThan(100);
    // The template's compose files and scripts: a DNS-01 rationale in a
    // comment there is as stale as one in the CLI.
    const carbon = walk(join(ROOT, 'carbon'), ['.yml', '.yaml', '.js', '.mjs']);
    expect(carbon.length).toBeGreaterThan(5);
    const hits = [...src, ...carbon].filter((f) =>
      /_acme-challenge|DNS01_PROVIDERS/.test(readFileSync(f, 'utf8')),
    );
    expect(hits.map((f) => f.slice(ROOT.length))).toEqual([]);
  });
});

describe('DNS backend uniform contract', () => {
  it.each(Object.keys(DNS_PROVIDERS))('%s exports the full dispatch surface', async (id) => {
    const mod = await getDnsProvider(id);
    for (const fn of CONTRACT) {
      expect(typeof (mod as Record<string, unknown>)[fn], `${id}.${fn}`).toBe('function');
    }
  });

  it('the healthChecks registry flag matches the module capability (deleteHealthCheck export)', async () => {
    for (const [id, row] of Object.entries(DNS_PROVIDERS)) {
      const mod = (await getDnsProvider(id)) as Record<string, unknown>;
      expect(Boolean(row.healthChecks), id).toBe(typeof mod.deleteHealthCheck === 'function');
    }
  });

  it('guidedSetupModulePath rows resolve to a module exporting getApiToken', async () => {
    const { getDnsGuidedSetup } = await import('../../../src/lib/dns-provider.js');
    for (const [id, row] of Object.entries(DNS_PROVIDERS)) {
      if (!row.guidedSetupModulePath) continue;
      const mod = (await getDnsGuidedSetup(id)) as Record<string, unknown>;
      expect(typeof mod.getApiToken, id).toBe('function');
    }
  });
});
