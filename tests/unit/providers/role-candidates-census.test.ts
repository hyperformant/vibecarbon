/**
 * Census over every registered provider: each one declares the x86 server
 * types it will use per role (`ROLE_CANDIDATES`), every candidate is in its
 * offline catalog, and the live defaults in its DEFAULT_REGION meet each
 * role's RAM floor (src/lib/sizing.js ROLE_MIN_RAM_GB).
 *
 * A walk over the registry, not a hand list, so a new provider is covered the
 * day it is registered.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getProviderClass, listProviders } from '../../../src/lib/providers/index.js';
import { ROLE_MIN_RAM_GB } from '../../../src/lib/sizing.js';
import { seedCatalog } from '../helpers/catalog-fixtures.js';

const ROLES_BY_MODE: Record<string, string[]> = {
  compose: ['compose'],
  'compose-ha': ['compose'],
  k8s: ['master', 'db', 'worker'],
  'k8s-ha': ['master', 'db', 'worker'],
};
const DEFAULTS_KEY: Record<string, string> = {
  compose: 'composeType',
  master: 'masterType',
  db: 'dbType',
  worker: 'workerType',
};

describe.each(listProviders().map((p) => p.id))('%s role candidates', (id) => {
  // biome-ignore lint/suspicious/noExplicitAny: provider classes are untyped JS
  const P = getProviderClass(id) as any;
  const roles = [...new Set<string>(P.SUPPORTED_TIERS.flatMap((m: string) => ROLES_BY_MODE[m]))];

  it('(a) declares a non-empty own list for every role its modes use', () => {
    expect(Object.hasOwn(P, 'ROLE_CANDIDATES')).toBe(true);
    for (const r of roles) expect(P.ROLE_CANDIDATES[r]?.length).toBeGreaterThan(0);
  });

  it('(b) no candidate is ARM', () => {
    for (const list of Object.values<string[]>(P.ROLE_CANDIDATES)) {
      for (const t of list) expect(P.isArmServerType(t)).toBe(false);
    }
  });

  it('(c) every candidate is in the offline catalog', () => {
    for (const list of Object.values<string[]>(P.ROLE_CANDIDATES)) {
      for (const t of list) expect(P.FALLBACK_SERVER_TYPES).toHaveProperty(t);
    }
  });

  it('(d) live defaults in DEFAULT_REGION meet each role floor', () => {
    const restore = seedCatalog(P, `2026-10-22/${id}`);
    try {
      const d = P.getRegionDefaults(P.DEFAULT_REGION);
      for (const r of roles) {
        expect(P.SERVER_TYPES[d[DEFAULTS_KEY[r]]].ram).toBeGreaterThanOrEqual(ROLE_MIN_RAM_GB[r]);
      }
    } finally {
      restore();
    }
  });

  it('declares a numeric IPV4_MONTHLY of its own', () => {
    expect(Object.hasOwn(P, 'IPV4_MONTHLY')).toBe(true);
    expect(typeof P.IPV4_MONTHLY).toBe('number');
  });
});

describe('(e) the compose branch of the deploy prompts sizes from composeType', () => {
  it('never reads regionDefaults.dbType', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../../../src/lib/deploy/prompts.js'), 'utf8');
    const start = src.indexOf('if (isComposeDeploy) {');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('} else {', start);
    expect(end).toBeGreaterThan(start);
    const branch = src.slice(start, end);
    expect(branch).toContain('regionDefaults.composeType');
    expect(branch).not.toContain('dbType');
  });
});
