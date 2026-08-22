/**
 * Provider contract suite.
 *
 * Runs the same set of invariants against every registered provider class
 * (`describe.each(Object.entries(PROVIDERS))`). At n=1 (Hetzner only) most
 * assertions are trivially true; the point is that when a second provider
 * (e.g. DigitalOcean, Phase B) is registered, these tests immediately catch
 * a class that forgot a static, picked a duplicate TOKEN_ENV, or returned an
 * invalid catalog shape — without hand-writing a parallel test file per
 * provider.
 *
 * Hetzner-specific behavior (e.g. the cax/cpx architecture-fallback RCA
 * cases) stays in hetzner.test.ts — this file only asserts the generic
 * contract every provider must satisfy.
 */
import { describe, expect, it, vi } from 'vitest';
import { BaseProvider } from '../../../src/lib/providers/base.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
// Exact-value table (moved to a shared, non-test module so registry.test.ts
// can also derive its provider-count assertion from it — biome's
// noExportsInTest rule forbids exporting straight from a *.test.ts file).
// Each row pins the literal values a provider's identity/credentials
// statics must hold. This is the "customer-visible contract" surface —
// TOKEN_ENV in particular is pinned externally as a CI secret name (see
// github-environments.test.ts, deploy-workflow-secret-sync.test.ts) and
// must never be silently renamed.
import { EXPECTED } from '../../_shared/provider-expected.js';

describe('Provider registry vs EXPECTED table', () => {
  it('EXPECTED covers exactly the registered providers', () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(Object.keys(EXPECTED).sort());
  });
});

describe.each(Object.entries(PROVIDERS))('Provider contract: %s', (id, Provider) => {
  const expected = EXPECTED[id];

  describe('static surface', () => {
    it('declares identity/credentials statics with the expected types', () => {
      expect(typeof Provider.NAME).toBe('string');
      expect(typeof Provider.API_BASE).toBe('string');
      expect(typeof Provider.TOKEN_ENV).toBe('string');
      expect(typeof Provider.CLI_TOKEN_ENV).toBe('string');
      expect(typeof Provider.PROVIDER_ID_PREFIX).toBe('string');
      expect(typeof Provider.PRICING_URL).toBe('string');
      expect(typeof Provider.DEFAULT_REGION).toBe('string');
    });

    it('declares the object-storage dispatch static+method', () => {
      expect(typeof Provider.S3_REGION_ENV).toBe('string');
      expect(typeof Provider.getObjectStorageProviderClass).toBe('function');
    });

    // C7d — guided-setup delegation statics.
    it('declares the C7d guided-setup delegation statics as async functions', () => {
      expect(typeof Provider.promptApiToken).toBe('function');
      expect(Provider.promptApiToken.constructor.name).toBe('AsyncFunction');
      expect(typeof Provider.promptObjectStorageCredentials).toBe('function');
      expect(Provider.promptObjectStorageCredentials.constructor.name).toBe('AsyncFunction');
    });

    it('declares catalog statics with the expected shapes', () => {
      expect(typeof Provider.REGIONS).toBe('object');
      expect(typeof Provider.SERVER_TYPES).toBe('object');
      expect(typeof Provider.DEFAULT_TYPE).toBe('string');
      expect(Array.isArray(Provider.HA_REGIONS)).toBe(true);
      expect(typeof Provider.fetchServerTypes).toBe('function');
      expect(typeof Provider.getServerTypesForRegion).toBe('function');
      expect(typeof Provider.getRegionDefaults).toBe('function');
      expect(typeof Provider.getDefaultStandbyRegion).toBe('function');
      expect(typeof Provider.resolveServerTypeForRegion).toBe('function');
      expect(typeof Provider.getPublicIP).toBe('function');
      expect(typeof Provider.getPublicIPv6).toBe('function');
    });

    // x86-64 standardization (2026-07-30) — every provider must answer "is this
    // SKU ARM?" and be able to reject one, so shared entry-point guards never
    // need to know a provider's SKU naming.
    it('declares the amd64 guard statics', () => {
      expect(typeof Provider.isArmServerType).toBe('function');
      expect(typeof Provider.assertAmd64ServerType).toBe('function');
      expect(typeof Provider.armToAmd64Equivalent).toBe('function');
    });

    it('armToAmd64Equivalent never suggests an ARM type', () => {
      // Whatever a provider offers as the way out of an ARM SKU has to be one
      // the platform can actually run. Also covers the passthrough contract for
      // types that were never ARM.
      for (const t of [...Object.keys(Provider.SERVER_TYPES), Provider.DEFAULT_TYPE, 'nonsense']) {
        expect(Provider.isArmServerType(Provider.armToAmd64Equivalent(t))).toBe(false);
      }
    });

    it('offers no ARM server type in its own default catalog', () => {
      for (const name of Object.keys(Provider.SERVER_TYPES)) {
        expect(Provider.isArmServerType(name)).toBe(false);
      }
      expect(Provider.isArmServerType(Provider.DEFAULT_TYPE)).toBe(false);
      expect(Provider.isArmServerType(Provider.DEFAULT_COMPOSE_TYPE)).toBe(false);
      expect(Provider.isArmServerType(Provider.DEFAULT_K8S_NODE_TYPE)).toBe(false);
    });

    it('never offers an ARM type from getServerTypesForRegion in any region', () => {
      for (const region of Object.keys(Provider.REGIONS)) {
        for (const t of Provider.getServerTypesForRegion(region)) {
          expect(Provider.isArmServerType(t.name)).toBe(false);
          expect(t.architecture ?? 'x86').toBe('x86');
        }
      }
    });

    it('never resolves an ARM type for a standby region', () => {
      for (const region of Object.keys(Provider.REGIONS)) {
        for (const t of Object.keys(Provider.SERVER_TYPES)) {
          expect(Provider.isArmServerType(Provider.resolveServerTypeForRegion(t, region))).toBe(
            false,
          );
        }
      }
    });

    // C7b — engine literals hoisted to provider statics (values verbatim).
    it('declares the C7b engine-literal statics with the expected types', () => {
      expect(typeof Provider.DEFAULT_COMPOSE_TYPE).toBe('string');
      expect(typeof Provider.DEFAULT_K8S_NODE_TYPE).toBe('string');
    });

    // C7c — k8s asset identity strings hoisted to provider statics.
    it('declares the C7c K8S_ASSETS static with the expected shape', () => {
      expect(typeof Provider.K8S_ASSETS).toBe('object');
      expect(typeof Provider.K8S_ASSETS.csiNodeDaemonSet).toBe('string');
      expect(typeof Provider.K8S_ASSETS.csiControllerSelector).toBe('string');
      expect(typeof Provider.K8S_ASSETS.ccmDeployment).toBe('string');
      expect(typeof Provider.K8S_ASSETS.ccmSelector).toBe('string');
      expect(typeof Provider.K8S_ASSETS.networkEnvVar).toBe('string');
    });

    // M3 Task 1 — the StorageClass this provider's CSI driver creates by default.
    it('declares the K8S_STORAGE_CLASS static as a string', () => {
      expect(typeof Provider.K8S_STORAGE_CLASS).toBe('string');
    });

    // M3 Task 2 — the base image slug this provider's k8s Pulumi program
    // provisions nodes with (renderCarbonAutoscalerConfig reads it off
    // ProviderClass instead of hardcoding Hetzner's slug).
    it('declares the K8S_IMAGE static as a string', () => {
      expect(typeof Provider.K8S_IMAGE).toBe('string');
    });

    it('matches the EXPECTED exact-value table', () => {
      expect(expected, `no EXPECTED row for provider "${id}"`).toBeDefined();
      expect(Provider.NAME).toBe(expected.name);
      expect(Provider.TOKEN_ENV).toBe(expected.tokenEnv);
      expect(Provider.CLI_TOKEN_ENV).toBe(expected.cliTokenEnv);
      expect(Provider.PROVIDER_ID_PREFIX).toBe(expected.providerIdPrefix);
      expect(Provider.DEFAULT_REGION).toBe(expected.defaultRegion);
      expect(Provider.PRICING_URL).toBe(expected.pricingUrl);
      expect(Provider.S3_REGION_ENV).toBe(expected.s3RegionEnv);
      expect(Provider.DEFAULT_COMPOSE_TYPE).toBe(expected.defaultComposeType);
      expect(Provider.DEFAULT_K8S_NODE_TYPE).toBe(expected.defaultK8sNodeType);
      expect(Provider.K8S_ASSETS).toEqual(expected.k8sAssets);
      expect(Provider.K8S_STORAGE_CLASS).toBe(expected.k8sStorageClass);
      expect(Provider.K8S_IMAGE).toBe(expected.k8sImage);
    });
  });

  describe('catalog invariants', () => {
    it('DEFAULT_TYPE is a member of SERVER_TYPES', () => {
      expect(Provider.SERVER_TYPES).toHaveProperty(Provider.DEFAULT_TYPE);
    });

    it('HA_REGIONS is a subset of REGIONS', () => {
      for (const region of Provider.HA_REGIONS) {
        expect(Object.keys(Provider.REGIONS)).toContain(region);
      }
    });

    it('getDefaultStandbyRegion never returns the primary region, for every region', () => {
      for (const region of Object.keys(Provider.REGIONS)) {
        expect(Provider.getDefaultStandbyRegion(region)).not.toBe(region);
      }
    });

    it('getRegionDefaults returns a valid {masterType, supabaseType, workerType} shape for every known region', () => {
      for (const region of Object.keys(Provider.REGIONS)) {
        const defaults = Provider.getRegionDefaults(region);
        expect(typeof defaults.masterType).toBe('string');
        expect(defaults.masterType.length).toBeGreaterThan(0);
        expect(typeof defaults.supabaseType).toBe('string');
        expect(defaults.supabaseType.length).toBeGreaterThan(0);
        expect(typeof defaults.workerType).toBe('string');
        expect(defaults.workerType.length).toBeGreaterThan(0);
      }
    });

    it('getRegionDefaults returns a valid shape for an unknown region (no throw)', () => {
      const defaults = Provider.getRegionDefaults('nonexistent-region');
      expect(typeof defaults.masterType).toBe('string');
      expect(defaults.masterType.length).toBeGreaterThan(0);
      expect(typeof defaults.supabaseType).toBe('string');
      expect(defaults.supabaseType.length).toBeGreaterThan(0);
      expect(typeof defaults.workerType).toBe('string');
      expect(defaults.workerType.length).toBeGreaterThan(0);
    });
  });

  describe('IP extractor null-safety', () => {
    it('getPublicIP returns null (not throw) for a server missing public_net', () => {
      expect(Provider.getPublicIP({})).toBeNull();
      expect(Provider.getPublicIP(undefined)).toBeNull();
      expect(Provider.getPublicIP(null)).toBeNull();
    });

    it('getPublicIPv6 returns null (not throw) for a server missing public_net', () => {
      expect(Provider.getPublicIPv6({})).toBeNull();
      expect(Provider.getPublicIPv6(undefined)).toBeNull();
      expect(Provider.getPublicIPv6(null)).toBeNull();
    });
  });
});

describe('buildIacEnv contract', () => {
  // Companion env vars a provider's buildIacEnv reads off process.env (the
  // multi-credential seam — Scaleway is the only member today). Stubbed so
  // the generic assertion below can run for every provider; the
  // provider-specific suite (scaleway.test.ts) owns the missing-var throw
  // behavior and the exact extra-key values.
  const IAC_ENV_FIXTURES: Record<string, Record<string, string>> = {
    scaleway: {
      SCALEWAY_ACCESS_KEY: 'SCWTESTTESTTESTTEST1',
      SCALEWAY_DEFAULT_PROJECT_ID: '11111111-2222-3333-4444-555555555555',
    },
  };

  it.each(Object.entries(PROVIDERS))(
    '%s buildIacEnv(token) yields a non-empty map carrying the token under CLI_TOKEN_ENV',
    (id, Provider) => {
      for (const [k, v] of Object.entries(IAC_ENV_FIXTURES[id] ?? {})) vi.stubEnv(k, v);
      try {
        const map = Provider.buildIacEnv('tok-contract-value');
        expect(Object.keys(map).length).toBeGreaterThan(0);
        expect(map[Provider.CLI_TOKEN_ENV]).toBe('tok-contract-value');
        // Any extra keys must be real env-var names with defined values —
        // an `undefined` in the bag would clobber a live process.env value
        // when call sites Object.assign it over a spread of process.env.
        for (const [k, v] of Object.entries(map)) {
          expect(k.length, `buildIacEnv returned an empty env-var name`).toBeGreaterThan(0);
          expect(v, `buildIacEnv[${k}] is undefined`).toBeDefined();
        }
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});

describe('Cross-provider uniqueness', () => {
  const entries = Object.entries(PROVIDERS);

  it('TOKEN_ENV is unique across all registered providers', () => {
    const values = entries.map(([, Provider]) => Provider.TOKEN_ENV);
    expect(new Set(values).size).toBe(values.length);
  });

  it('CLI_TOKEN_ENV is unique across all registered providers', () => {
    const values = entries.map(([, Provider]) => Provider.CLI_TOKEN_ENV);
    expect(new Set(values).size).toBe(values.length);
  });

  it('PROVIDER_ID_PREFIX is unique across all registered providers', () => {
    // The providerID prefix is cluster-autoscaler's join key between k8s
    // nodes and cloud instances — a collision would let one provider's
    // autoscaler claim another provider's nodes.
    const values = entries.map(([, Provider]) => Provider.PROVIDER_ID_PREFIX);
    expect(new Set(values).size).toBe(values.length);
  });
});

/**
 * Abstract-surface completeness (2026-08-07 test-architecture audit).
 *
 * Everything above checks STATICS — none of it ever instantiates a provider,
 * so until now a registered provider could inherit every one of
 * BaseProvider's ~30 throwing instance stubs (createServer, deleteServer,
 * the destroy-sweep field accessors...) and this suite stayed green; the
 * miss surfaced at deploy/destroy time on real infra. This block closes
 * that: a provider may not RESOLVE any abstract member to the base stub.
 *
 * "Abstract" is derived from the base class itself (any own method whose
 * source carries the `must be implemented` marker), so a new abstract
 * member added to BaseProvider is automatically demanded from every
 * registered provider with no edit here. typeof checks above stay for
 * shape; THIS is the one that catches a forgotten override, because the
 * inherited stub satisfies typeof.
 */
const ABSTRACT_MARKER = /must be implemented/;

function abstractMemberNames(host: object): string[] {
  return Object.entries(Object.getOwnPropertyDescriptors(host))
    .filter(([name, d]) => name !== 'constructor' && typeof d.value === 'function')
    .filter(([, d]) => ABSTRACT_MARKER.test(String(d.value)))
    .map(([name]) => name);
}

/** Abstract members the class still resolves to a throwing base stub. */
function unimplementedAbstractMembers(ProviderClass: {
  prototype: Record<string, unknown>;
  [key: string]: unknown;
}): string[] {
  const instance = abstractMemberNames(BaseProvider.prototype)
    .filter((n) => ABSTRACT_MARKER.test(String(ProviderClass.prototype[n])))
    .map((n) => `instance ${n}()`);
  const statics = abstractMemberNames(BaseProvider)
    .filter((n) => ABSTRACT_MARKER.test(String(ProviderClass[n])))
    .map((n) => `static ${n}()`);
  return [...instance, ...statics];
}

describe('abstract-surface completeness', () => {
  it('the abstract-member extractor still sees the base surface (not vacuously green)', () => {
    const instance = abstractMemberNames(BaseProvider.prototype);
    const statics = abstractMemberNames(BaseProvider);
    // ~31 instance / 16 static existed when this was written; if BaseProvider
    // drops the `must be implemented` idiom, rework the extractor, not the floor.
    expect(instance.length).toBeGreaterThanOrEqual(25);
    expect(statics.length).toBeGreaterThanOrEqual(12);
    expect(instance).toContain('createServer');
    expect(instance).toContain('serverVolumeIds');
    expect(statics).toContain('fetchServerTypes');
    expect(statics).toContain('getComposeUserData');
  });

  it.each(Object.entries(PROVIDERS))(
    '%s implements every abstract member (no inherited throwing stub)',
    (_id, Provider) => {
      expect(
        unimplementedAbstractMembers(Provider as never),
        "These abstract members still resolve to BaseProvider's throwing stub — the suite " +
          'would previously stay green and the miss surfaced at deploy/destroy time on real ' +
          'infra. Implement them (or, for a genuinely inapplicable member, make the override ' +
          'throw its own provider-specific error explaining why).',
      ).toEqual([]);
    },
  );

  it('the checker flags a provider that forgets overrides (positive control)', () => {
    class IncompleteProvider extends BaseProvider {}
    const missing = unimplementedAbstractMembers(IncompleteProvider as never);
    expect(missing).toContain('instance createServer()');
    expect(missing).toContain('static fetchServerTypes()');
    expect(missing.length).toBeGreaterThanOrEqual(37);
  });

  it('the checker clears an implemented override and still flags the rest (positive control)', () => {
    class PartialProvider extends BaseProvider {
      async createServer() {
        return { id: 'x' };
      }
    }
    const missing = unimplementedAbstractMembers(PartialProvider as never);
    expect(missing).not.toContain('instance createServer()');
    expect(missing).toContain('instance deleteServer()');
  });
});
