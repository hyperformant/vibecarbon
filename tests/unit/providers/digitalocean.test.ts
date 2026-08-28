/**
 * DigitalOceanProvider — statics/catalog contract (Task B2).
 *
 * Generic invariants every provider must satisfy (identity/credentials
 * statics with expected types, catalog-static shapes, IP-extractor
 * null-safety, HA-region subset, DEFAULT_TYPE membership, ...) are already
 * covered by provider-contract.test.ts's `describe.each(PROVIDERS)` loop —
 * registering DigitalOceanProvider automatically pulls it into that suite.
 * This file pins DigitalOcean-specific exact values and behavior the
 * generic loop doesn't (and shouldn't) know about: the literal statics
 * table, the standby-region pairing table, and the public-IP extraction
 * shape (DO's `networks.v4[]` array vs Hetzner's single `public_net.ipv4`
 * object).
 *
 * Instance methods (createServer, deleteServer, ...) are tested separately
 * in tests/unit/providers/digitalocean-methods.test.ts (B3 — exact wire
 * shapes over a mocked fetchWithRetry, mirroring
 * hetzner-destroy-primitives.test.ts); getServerType (M3 Task 1) has its own
 * dedicated file, digitalocean-get-server-type.test.ts, mirroring
 * hetzner-get-server-type.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { getProviderClass, PROVIDERS, providerFor } from '../../../src/lib/providers/index.js';

describe('DigitalOceanProvider — identity/credentials statics (exact values)', () => {
  it('pins NAME/API_BASE', () => {
    expect(DigitalOceanProvider.NAME).toBe('DigitalOcean');
    expect(DigitalOceanProvider.API_BASE).toBe('https://api.digitalocean.com/v2');
  });

  it('pins TOKEN_ENV (ours, env-first) and CLI_TOKEN_ENV (read by @pulumi/digitalocean/doctl) as distinct env vars', () => {
    expect(DigitalOceanProvider.TOKEN_ENV).toBe('DIGITALOCEAN_API_TOKEN');
    expect(DigitalOceanProvider.CLI_TOKEN_ENV).toBe('DIGITALOCEAN_TOKEN');
    expect(DigitalOceanProvider.TOKEN_ENV).not.toBe(DigitalOceanProvider.CLI_TOKEN_ENV);
  });

  it('pins PROVIDER_ID_PREFIX (DO CCM join key — stamped on real nodes now that SUPPORTED_TIERS includes k8s)', () => {
    expect(DigitalOceanProvider.PROVIDER_ID_PREFIX).toBe('digitalocean://');
  });

  it('implements getServerType as its own method (M3 Task 1 — wire-shape tests live in digitalocean-get-server-type.test.ts)', () => {
    expect(DigitalOceanProvider.prototype.getServerType).not.toBe(
      Object.getPrototypeOf(DigitalOceanProvider.prototype).getServerType,
    );
  });

  it('pins DEFAULT_REGION, PRICING_URL, S3_REGION_ENV', () => {
    expect(DigitalOceanProvider.DEFAULT_REGION).toBe('nyc3');
    expect(DigitalOceanProvider.PRICING_URL).toBe('https://www.digitalocean.com/pricing/droplets');
    expect(DigitalOceanProvider.S3_REGION_ENV).toBe('DIGITALOCEAN_STORAGE_REGION');
  });

  it('pins SUPPORTED_TIERS to all four tiers (d4 lift, 2026-08-27)', () => {
    expect(DigitalOceanProvider.SUPPORTED_TIERS).toEqual([
      'compose',
      'compose-ha',
      'k8s',
      'k8s-ha',
    ]);
  });

  it('pins the 10-region REGIONS map (Spaces-capable regions only)', () => {
    expect(Object.keys(DigitalOceanProvider.REGIONS).sort()).toEqual(
      ['atl1', 'ams3', 'blr1', 'fra1', 'lon1', 'nyc3', 'sfo3', 'sgp1', 'syd1', 'tor1'].sort(),
    );
    expect(DigitalOceanProvider.REGIONS.nyc3).toBe('New York 3');
  });

  it('pins HA_REGIONS and DEFAULT_TYPE/DEFAULT_COMPOSE_TYPE', () => {
    expect(DigitalOceanProvider.HA_REGIONS).toEqual(['nyc3', 'sfo3']);
    expect(DigitalOceanProvider.DEFAULT_TYPE).toBe('s-2vcpu-4gb');
    expect(DigitalOceanProvider.DEFAULT_COMPOSE_TYPE).toBe('s-2vcpu-4gb');
  });

  it("overrides CLOUD_INIT_READY_TIMEOUT_MS to 600s — ubuntu-24-04-x64 installs docker-ce from Docker's apt repo INSIDE cloud-init (see digitalocean-compose.js renderDoUserData), realistically 3-5 minutes on small droplets, unlike Hetzner's docker-ce image", () => {
    expect(DigitalOceanProvider.CLOUD_INIT_READY_TIMEOUT_MS).toBe(600_000);
  });

  it("pins COMPOSE_IMAGE to digitalocean-compose.js's buildDigitalOceanComposeProgram `image: 'ubuntu-24-04-x64'` literal exactly", () => {
    expect(DigitalOceanProvider.COMPOSE_IMAGE).toBe('ubuntu-24-04-x64');
  });

  it('pins the real k8s-facing statics (M3 Task 1, live since Task 6 lifted the SUPPORTED_TIERS gate)', () => {
    expect(DigitalOceanProvider.DEFAULT_K8S_NODE_TYPE).toBe('s-2vcpu-4gb');
    expect(DigitalOceanProvider.K8S_ASSETS).toEqual({
      csiNodeDaemonSet: 'daemonset/csi-do-node',
      csiControllerSelector: 'app=csi-do-controller',
      ccmDeployment: 'digitalocean-cloud-controller-manager',
      ccmSelector: 'app=digitalocean-cloud-controller-manager',
      networkEnvVar: '',
    });
    expect(DigitalOceanProvider.K8S_STORAGE_CLASS).toBe('do-block-storage');
  });

  it('SERVER_TYPES is an object map (not an array) with DEFAULT_TYPE present, seeded from FALLBACK_SERVER_TYPES', () => {
    expect(Array.isArray(DigitalOceanProvider.SERVER_TYPES)).toBe(false);
    expect(DigitalOceanProvider.SERVER_TYPES).toHaveProperty(DigitalOceanProvider.DEFAULT_TYPE);
    expect(DigitalOceanProvider.SERVER_TYPES['s-2vcpu-4gb']).toEqual({ vcpu: 2, ram: 4, disk: 80 });
  });

  it('pins FALLBACK_SERVER_TYPES exact specs', () => {
    expect(DigitalOceanProvider.FALLBACK_SERVER_TYPES).toEqual({
      's-1vcpu-2gb': { vcpu: 1, ram: 2, disk: 50 },
      's-2vcpu-2gb': { vcpu: 2, ram: 2, disk: 60 },
      's-2vcpu-4gb': { vcpu: 2, ram: 4, disk: 80 },
      's-4vcpu-8gb': { vcpu: 4, ram: 8, disk: 160 },
    });
  });
});

describe('DigitalOceanProvider.getDefaultStandbyRegion', () => {
  it('pairs nyc3<->sfo3 and fra1<->ams3 and sgp1<->syd1 (conventional pairings)', () => {
    expect(DigitalOceanProvider.getDefaultStandbyRegion('nyc3')).toBe('sfo3');
    expect(DigitalOceanProvider.getDefaultStandbyRegion('sfo3')).toBe('nyc3');
    expect(DigitalOceanProvider.getDefaultStandbyRegion('fra1')).toBe('ams3');
    expect(DigitalOceanProvider.getDefaultStandbyRegion('ams3')).toBe('fra1');
    expect(DigitalOceanProvider.getDefaultStandbyRegion('sgp1')).toBe('syd1');
    expect(DigitalOceanProvider.getDefaultStandbyRegion('syd1')).toBe('sgp1');
  });

  it('falls back to the first other same-continent region for an unpaired region', () => {
    // na continent, key order nyc3, sfo3, tor1, atl1 — tor1/atl1 excluded from
    // themselves resolve to the first other na region (nyc3).
    expect(DigitalOceanProvider.getDefaultStandbyRegion('tor1')).toBe('nyc3');
    expect(DigitalOceanProvider.getDefaultStandbyRegion('atl1')).toBe('nyc3');
    // eu continent — lon1 resolves to the first other eu region (ams3).
    expect(DigitalOceanProvider.getDefaultStandbyRegion('lon1')).toBe('ams3');
    // ap continent — blr1 resolves to the first other ap region (sgp1).
    expect(DigitalOceanProvider.getDefaultStandbyRegion('blr1')).toBe('sgp1');
  });

  it('never returns the primary region itself, for every known region', () => {
    for (const region of Object.keys(DigitalOceanProvider.REGIONS)) {
      expect(DigitalOceanProvider.getDefaultStandbyRegion(region)).not.toBe(region);
    }
  });
});

describe('DigitalOceanProvider.getPublicIP / getPublicIPv6', () => {
  it('extracts the public v4 address from the networks.v4[] array, ignoring private entries', () => {
    const server = {
      networks: {
        v4: [
          { type: 'private', ip_address: '10.0.0.2' },
          { type: 'public', ip_address: '1.2.3.4' },
        ],
      },
    };
    expect(DigitalOceanProvider.getPublicIP(server)).toBe('1.2.3.4');
  });

  it('extracts the public v6 address from the networks.v6[] array', () => {
    const server = {
      networks: {
        v6: [{ type: 'public', ip_address: '2001:db8::1' }],
      },
    };
    expect(DigitalOceanProvider.getPublicIPv6(server)).toBe('2001:db8::1');
  });

  it('returns null (not throw) when no public entry is present', () => {
    expect(DigitalOceanProvider.getPublicIP({ networks: { v4: [] } })).toBeNull();
    expect(
      DigitalOceanProvider.getPublicIP({
        networks: { v4: [{ type: 'private', ip_address: 'x' }] },
      }),
    ).toBeNull();
    expect(DigitalOceanProvider.getPublicIPv6({ networks: { v6: [] } })).toBeNull();
  });
});

describe('DigitalOceanProvider.fetchServerTypes', () => {
  // Runs before any other test in this file touches the live-data path, so
  // DigitalOceanProvider._locationTypes (module-level cache) is still null
  // here — mirrors HetznerProvider.fetchServerTypes's own "already fetched"
  // short-circuit, untested elsewhere in this codebase for either provider.
  it('returns false and leaves SERVER_TYPES on a non-ok response (fallback contract, mirrors hetzner.js:259)', async () => {
    expect(DigitalOceanProvider._locationTypes).toBeNull();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    try {
      const result = await DigitalOceanProvider.fetchServerTypes('bad-token');
      expect(result).toBe(false);
      expect(DigitalOceanProvider.SERVER_TYPES).toHaveProperty(DigitalOceanProvider.DEFAULT_TYPE);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('DigitalOceanProvider.getRegionDefaults', () => {
  it('returns a valid {masterType, supabaseType, workerType} shape for every known region', () => {
    for (const region of Object.keys(DigitalOceanProvider.REGIONS)) {
      const defaults = DigitalOceanProvider.getRegionDefaults(region);
      expect(defaults).toEqual({
        masterType: 's-2vcpu-2gb',
        supabaseType: 's-2vcpu-4gb',
        workerType: 's-2vcpu-2gb',
      });
    }
  });
});

describe('DigitalOceanProvider dispatch statics — declared, lazy', () => {
  it('declares getObjectStorageProviderClass/getComposeProgram/getK8sProgram/promptApiToken/promptObjectStorageCredentials as async functions', () => {
    expect(DigitalOceanProvider.getObjectStorageProviderClass.constructor.name).toBe(
      'AsyncFunction',
    );
    expect(DigitalOceanProvider.getComposeProgram.constructor.name).toBe('AsyncFunction');
    // M3 Task 5: getK8sProgram is now a real dynamic-import dispatch (like
    // getComposeProgram), not a throw — DigitalOcean is a reference
    // provider with `k8s` in SUPPORTED_TIERS since M3 Task 6 (k8s-ha
    // remains Hetzner-only). Dispatch-identity coverage (forwards config
    // verbatim, propagates throws) lives in
    // tests/unit/providers/digitalocean-iac-dispatch.test.ts.
    expect(DigitalOceanProvider.getK8sProgram.constructor.name).toBe('AsyncFunction');
    expect(DigitalOceanProvider.promptApiToken.constructor.name).toBe('AsyncFunction');
    expect(DigitalOceanProvider.promptObjectStorageCredentials.constructor.name).toBe(
      'AsyncFunction',
    );
  });
});

describe('DigitalOceanProvider.getComposeUserData', () => {
  it('is byte-equal to loadDoComposeUserData() — single source of truth with the Pulumi program (no duplicated splice/transliteration)', async () => {
    const { loadDoComposeUserData } = await import(
      '../../../src/lib/iac/programs/digitalocean-compose.js'
    );
    const userData = await DigitalOceanProvider.getComposeUserData();
    expect(userData).toBe(loadDoComposeUserData());
    // Sanity: it really is the rendered (docker-install-spliced, ASCII-only)
    // output, not the raw shared file.
    expect(userData).toContain('docker-ce-cli');
    // ASCII-only (see ASCII_TRANSLITERATION_MAP): every char code <= 0x7f.
    expect([...userData].every((ch) => (ch.codePointAt(0) ?? 0) <= 0x7f)).toBe(true);
  });
});

describe('registry — DigitalOcean is registered (Phase B)', () => {
  it('PROVIDERS includes digitalocean', () => {
    expect(PROVIDERS.digitalocean).toBe(DigitalOceanProvider);
  });

  it('getProviderClass("digitalocean") resolves to DigitalOceanProvider', () => {
    expect(getProviderClass('digitalocean')).toBe(DigitalOceanProvider);
  });

  it('providerFor({ provider: "digitalocean" }) resolves to DigitalOceanProvider', () => {
    expect(providerFor({ provider: 'digitalocean' })).toBe(DigitalOceanProvider);
  });
});
