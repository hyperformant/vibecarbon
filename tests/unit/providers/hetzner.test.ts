import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// C7d — promptApiToken/promptObjectStorageCredentials lazily import
// hetzner-guided-setup.js and forward verbatim. Mocked here (spread-actual,
// like tests/unit/destroy/state-bucket-delete.test.ts) to assert the
// forwarding without driving real @clack/prompts interaction. The dynamic
// `import('../hetzner-guided-setup.js')` inside hetzner.js still resolves to
// this mock — vi.mock intercepts by resolved specifier, not import site.
const getApiTokenMock = vi.fn();
const getS3CredentialsMock = vi.fn();

vi.mock('../../../src/lib/hetzner-guided-setup.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getApiToken: (...a: unknown[]) => getApiTokenMock(...a),
    getS3Credentials: (...a: unknown[]) => getS3CredentialsMock(...a),
  };
});

import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

describe('HetznerProvider', () => {
  describe('static properties', () => {
    it('has correct NAME', () => {
      expect(HetznerProvider.NAME).toBe('Hetzner Cloud');
    });

    it('has correct API_BASE', () => {
      expect(HetznerProvider.API_BASE).toBe('https://api.hetzner.cloud/v1');
    });

    it('has expected regions', () => {
      const regions = HetznerProvider.REGIONS;

      expect(regions.fsn1).toBe('Falkenstein, Germany');
      expect(regions.nbg1).toBe('Nuremberg, Germany');
      expect(regions.hel1).toBe('Helsinki, Finland');
      expect(regions.ash).toBe('Ashburn, Virginia, USA');
      expect(regions.hil).toBe('Hillsboro, Oregon, USA');
    });

    it('has expected server types', () => {
      const types = HetznerProvider.SERVER_TYPES;

      expect(types.cpx11).toBeDefined();
      expect(types.cpx11.vcpu).toBe(2);
      expect(types.cpx11.ram).toBe(2);
      expect(types.cpx11.disk).toBe(40);

      expect(types.cpx51).toBeDefined();
      expect(types.cpx51.vcpu).toBe(16);
    });

    it('has correct DEFAULT_TYPE', () => {
      // cpx22, not cpx11 (deprecated in every EU location on 2026-01-01) and
      // not cx23 (whole cx*3 line reads available:false in the EU). EU is the
      // default region. Matches DEFAULT_COMPOSE_TYPE/DEFAULT_K8S_NODE_TYPE.
      expect(HetznerProvider.DEFAULT_TYPE).toBe('cpx22');
    });

    it('DEFAULT_TYPE is not a SKU Hetzner has made unorderable in the EU', () => {
      const retiredInEu = ['cpx11', 'cpx21', 'cpx31', 'cpx41', 'cpx51'];
      expect(retiredInEu).not.toContain(HetznerProvider.DEFAULT_TYPE);
    });

    it('has correct HA_REGIONS', () => {
      expect(HetznerProvider.HA_REGIONS).toEqual(['fsn1', 'hel1']);
    });

    it('has correct TOKEN_ENV', () => {
      expect(HetznerProvider.TOKEN_ENV).toBe('HETZNER_API_TOKEN');
    });

    it('has correct CLI_TOKEN_ENV', () => {
      expect(HetznerProvider.CLI_TOKEN_ENV).toBe('HCLOUD_TOKEN');
    });

    it('has correct PROVIDER_ID_PREFIX (matches hcloud-cloud-controller-manager)', () => {
      expect(HetznerProvider.PROVIDER_ID_PREFIX).toBe('hcloud://');
    });

    it('has correct DEFAULT_REGION', () => {
      expect(HetznerProvider.DEFAULT_REGION).toBe('nbg1');
    });

    it('has correct PRICING_URL', () => {
      expect(HetznerProvider.PRICING_URL).toBe('https://www.hetzner.com/cloud/');
    });

    it('has correct S3_REGION_ENV', () => {
      expect(HetznerProvider.S3_REGION_ENV).toBe('HETZNER_STORAGE_REGION');
    });

    it('inherits the BaseProvider CLOUD_INIT_READY_TIMEOUT_MS default (180s) — the docker-ce image has Docker preinstalled, so cloud-init is fast', () => {
      expect(HetznerProvider.CLOUD_INIT_READY_TIMEOUT_MS).toBe(180_000);
    });

    it("pins COMPOSE_IMAGE to hetzner-compose.js's buildHetznerComposeProgram `image: 'docker-ce'` literal exactly", () => {
      expect(HetznerProvider.COMPOSE_IMAGE).toBe('docker-ce');
    });
  });

  describe('getObjectStorageProviderClass', () => {
    it('lazily resolves the real HetznerS3Provider class', async () => {
      const { HetznerS3Provider } = await import('../../../src/lib/providers/hetzner-s3.js');
      const S3Class = await HetznerProvider.getObjectStorageProviderClass();
      expect(S3Class).toBe(HetznerS3Provider);
    });
  });

  describe('getComposeUserData', () => {
    it('returns the same raw shared cloud-init file loadCloudInitScript() reads (single source of truth with hetzner-compose.js)', async () => {
      const { loadCloudInitScript } = await import('../../../src/lib/deploy/compose/index.js');
      const userData = await HetznerProvider.getComposeUserData();
      expect(userData).toBe(loadCloudInitScript());
      expect(userData).toContain('runcmd:');
    });
  });

  // C7d — thin delegation to hetzner-guided-setup.js, args forwarded verbatim.
  describe('promptApiToken / promptObjectStorageCredentials (C7d)', () => {
    afterEach(() => {
      getApiTokenMock.mockReset();
      getS3CredentialsMock.mockReset();
    });

    it('promptApiToken forwards projectName + options verbatim to getApiToken', async () => {
      getApiTokenMock.mockResolvedValue('tok-123');
      const result = await HetznerProvider.promptApiToken('my-project', { save: false });
      expect(getApiTokenMock).toHaveBeenCalledWith('my-project', { save: false });
      expect(result).toBe('tok-123');
    });

    it('promptApiToken forwards a call with no options through unchanged', async () => {
      getApiTokenMock.mockResolvedValue('tok-456');
      await HetznerProvider.promptApiToken('my-project');
      expect(getApiTokenMock).toHaveBeenCalledWith('my-project', undefined);
    });

    it('promptObjectStorageCredentials forwards projectName + options verbatim to getS3Credentials', async () => {
      getS3CredentialsMock.mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' });
      const result = await HetznerProvider.promptObjectStorageCredentials('my-project', {
        save: false,
        force: true,
      });
      expect(getS3CredentialsMock).toHaveBeenCalledWith('my-project', {
        save: false,
        force: true,
      });
      expect(result).toEqual({ accessKey: 'ak', secretKey: 'sk' });
    });
  });

  describe('getDefaultStandbyRegion', () => {
    it('pairs a US primary with the other US region (not across the Atlantic)', () => {
      expect(HetznerProvider.getDefaultStandbyRegion('ash')).toBe('hil');
      expect(HetznerProvider.getDefaultStandbyRegion('hil')).toBe('ash');
    });

    it('keeps the conventional nbg1<->fsn1 EU pairing', () => {
      expect(HetznerProvider.getDefaultStandbyRegion('nbg1')).toBe('fsn1');
      expect(HetznerProvider.getDefaultStandbyRegion('fsn1')).toBe('nbg1');
    });

    it('keeps an EU primary on the EU continent', () => {
      expect(
        HetznerProvider.REGION_CONTINENT[HetznerProvider.getDefaultStandbyRegion('hel1')],
      ).toBe('eu');
    });

    it('never returns the primary region itself', () => {
      for (const r of Object.keys(HetznerProvider.REGIONS)) {
        expect(HetznerProvider.getDefaultStandbyRegion(r)).not.toBe(r);
      }
    });
  });

  describe('resolveServerTypeForRegion (offline / no live catalog)', () => {
    beforeEach(() => {
      // Force the offline-fallback branch.
      (HetznerProvider as unknown as { _locationTypes: unknown })._locationTypes = null;
    });

    it('keeps an x86 (cpx) type as-is for an EU standby — never flips to ARM', () => {
      // RCA 2026-06-23: an x86 primary (ash → cpx11) deployed an EU standby
      // (nbg1) and the resolver wrongly returned cax11 (ARM), causing an
      // arch mismatch + cax capacity exhaustion.
      expect(HetznerProvider.resolveServerTypeForRegion('cpx11', 'nbg1')).toBe('cpx11');
      expect(HetznerProvider.resolveServerTypeForRegion('cpx21', 'fsn1')).toBe('cpx21');
      expect(HetznerProvider.resolveServerTypeForRegion('cpx11', 'hel1')).toBe('cpx11');
    });

    it('keeps x86 as-is for a US region', () => {
      expect(HetznerProvider.resolveServerTypeForRegion('cpx11', 'hil')).toBe('cpx11');
      expect(HetznerProvider.resolveServerTypeForRegion('cpx11', 'ash')).toBe('cpx11');
    });

    it('rescues ARM (cax) to the current x86 generation in EVERY region', () => {
      // vibecarbon is amd64-only. A `cax` type can now only arrive from an
      // environment provisioned before that standardization, so the resolver
      // treats it as a rescue: map to the size-preserving x86 SKU regardless of
      // whether ARM happens to exist in the target region (it does in
      // fsn1/hel1/nbg1, which is exactly why an availability-first walk kept it
      // before).
      //
      // Targets cpx*2, not cpx*1: cax was EU-only, and EU is exactly where the
      // cpx*1 line went unorderable. cpx*2 is also an exact vCPU+RAM match.
      expect(HetznerProvider.resolveServerTypeForRegion('cax11', 'ash')).toBe('cpx22');
      expect(HetznerProvider.resolveServerTypeForRegion('cax21', 'hil')).toBe('cpx32');
      expect(HetznerProvider.resolveServerTypeForRegion('cax11', 'nbg1')).toBe('cpx22');
      expect(HetznerProvider.resolveServerTypeForRegion('cax31', 'fsn1')).toBe('cpx42');
      expect(HetznerProvider.resolveServerTypeForRegion('cax41', 'hel1')).toBe('cpx62');
    });

    it('never returns an ARM type for any input/region pair', () => {
      for (const region of Object.keys(HetznerProvider.REGIONS)) {
        for (const type of ['cpx11', 'cpx21', 'cpx31', 'cx23', 'cx33', 'ccx13', 'cax11', 'cax21']) {
          expect(HetznerProvider.resolveServerTypeForRegion(type, region)).not.toMatch(/^cax/);
        }
      }
    });
  });

  describe('resolveServerTypeForRegion (live catalog)', () => {
    const seed = (locationTypes: Record<string, Set<string>>) => {
      (HetznerProvider as unknown as { _locationTypes: unknown })._locationTypes = locationTypes;
    };
    afterEach(() => {
      (HetznerProvider as unknown as { _locationTypes: unknown })._locationTypes = null;
    });

    it('returns the requested x86 type when the region has it', () => {
      seed({ nbg1: new Set(['cpx11', 'cpx21', 'cax11']) });
      expect(HetznerProvider.resolveServerTypeForRegion('cpx11', 'nbg1')).toBe('cpx11');
    });

    it('NEAR MISS: an unavailable cpx never becomes the cax of the same size', () => {
      // The exact hole this closes: the live-data branch used to try
      // `cax<suffix>` when the requested `cpx<suffix>` was missing, so a region
      // that stocks cax11 but not cpx11 flipped an x86 primary to ARM. The
      // offline branch was hardened after RCA 2026-06-23; this one was missed.
      seed({ nbg1: new Set(['cax11', 'cax21', 'cx23', 'cx33']) });
      const resolved = HetznerProvider.resolveServerTypeForRegion('cpx11', 'nbg1');
      expect(resolved).not.toBe('cax11');
      expect(resolved).not.toMatch(/^cax/);
      // Falls back to the region default at the same role tier, which is x86.
      expect(resolved).toBe(HetznerProvider.getRegionDefaults('nbg1').masterType);
    });

    it('rescues an ARM type to x86 even when the region stocks ARM', () => {
      seed({ nbg1: new Set(['cax11', 'cax21', 'cpx22', 'cpx32']) });
      expect(HetznerProvider.resolveServerTypeForRegion('cax11', 'nbg1')).toBe('cpx22');
      expect(HetznerProvider.resolveServerTypeForRegion('cax21', 'nbg1')).toBe('cpx32');
    });

    it('never returns an ARM type for any input/region pair', () => {
      seed({
        nbg1: new Set(['cax11', 'cax21', 'cax31', 'cax41']),
        fsn1: new Set(['cax11', 'cx23']),
        ash: new Set(['cpx11', 'cpx21']),
      });
      for (const region of ['nbg1', 'fsn1', 'ash']) {
        for (const type of ['cpx11', 'cpx21', 'cpx31', 'cx23', 'cax11', 'cax21', 'cax41']) {
          expect(HetznerProvider.resolveServerTypeForRegion(type, region)).not.toMatch(/^cax/);
        }
      }
    });
  });

  describe('amd64-only catalog + guards', () => {
    afterEach(() => {
      (HetznerProvider as unknown as { _locationTypes: unknown })._locationTypes = null;
    });

    it('the offline fallback catalog carries no cax SKU', () => {
      const names = Object.keys(HetznerProvider.FALLBACK_SERVER_TYPES);
      expect(names.filter((n) => n.startsWith('cax'))).toEqual([]);
      // The x86 lines are still all there.
      expect(names).toContain('cpx11');
      expect(names).toContain('cx23');
      expect(names).toContain('ccx13');
    });

    it('no region prefix list offers the ARM family', () => {
      for (const prefixes of Object.values(HetznerProvider.REGION_TYPE_PREFIXES)) {
        expect(prefixes).not.toContain('cax');
      }
    });

    it('getServerTypesForRegion offers no ARM type, even from a live EU catalog', () => {
      // Live data replaces SERVER_TYPES wholesale, so removing cax from the
      // offline catalog alone would NOT have covered this path.
      (HetznerProvider as unknown as { _locationTypes: unknown })._locationTypes = {
        nbg1: new Set(['cpx11', 'cax11', 'cax21']),
      };
      const before = HetznerProvider.SERVER_TYPES;
      try {
        (HetznerProvider as unknown as { SERVER_TYPES: unknown }).SERVER_TYPES = {
          cpx11: { vcpu: 2, ram: 2, disk: 40, architecture: 'x86' },
          cax11: { vcpu: 2, ram: 4, disk: 40, architecture: 'arm' },
          cax21: { vcpu: 4, ram: 8, disk: 80, architecture: 'arm' },
        };
        const offered = HetznerProvider.getServerTypesForRegion('nbg1');
        // The entries still exist in the raw catalog, but each is tagged with
        // its architecture so the shared prompt builders drop them.
        for (const t of offered) {
          if (t.name.startsWith('cax')) expect(t.architecture).toBe('arm');
        }
        const { filterAmd64Types } = require('../../../src/lib/server-types.js');
        expect(filterAmd64Types(offered).map((t: { name: string }) => t.name)).toEqual(['cpx11']);
      } finally {
        (HetznerProvider as unknown as { SERVER_TYPES: unknown }).SERVER_TYPES = before;
      }
    });

    it('stamps architecture on offline catalog entries too', () => {
      const offered = HetznerProvider.getServerTypesForRegion('nbg1');
      expect(offered.length).toBeGreaterThan(0);
      for (const t of offered) expect(t.architecture).toBe('x86');
    });

    it('isArmServerType recognizes the cax family and nothing else', () => {
      for (const t of ['cax11', 'cax21', 'cax31', 'cax41']) {
        expect(HetznerProvider.isArmServerType(t)).toBe(true);
      }
      for (const t of ['cpx11', 'cx23', 'ccx13', '', undefined as unknown as string]) {
        expect(HetznerProvider.isArmServerType(t)).toBe(false);
      }
    });

    it('assertAmd64ServerType rejects a user-supplied cax type with an actionable reason', () => {
      expect(() => HetznerProvider.assertAmd64ServerType('cax21', '-type')).toThrow(
        /-type: 'cax21' is an ARM \(aarch64\) Hetzner Cloud server type/,
      );
      expect(() => HetznerProvider.assertAmd64ServerType('cax21', '-type')).toThrow(
        /x86-64 \(amd64\) only/,
      );
      // Names a concrete x86 alternative so the operator can act on it — and
      // the SIZE-PRESERVING one, not the catalog default. Suggesting a 2 GB
      // default for a cax21 (8 GB) would talk an operator into a 4x downsize.
      expect(() => HetznerProvider.assertAmd64ServerType('cax21', '-type')).toThrow(/cpx32/);
      expect(() => HetznerProvider.assertAmd64ServerType('cax21', '-type')).not.toThrow(
        /e\.g\. cpx11/,
      );
    });

    it('assertAmd64ServerType passes x86 types and "not specified" through unchanged', () => {
      expect(HetznerProvider.assertAmd64ServerType('cpx21', '-type')).toBe('cpx21');
      expect(HetznerProvider.assertAmd64ServerType('cx23', '-type')).toBe('cx23');
      expect(HetznerProvider.assertAmd64ServerType(null, '-type')).toBe(null);
      expect(HetznerProvider.assertAmd64ServerType(undefined, '-type')).toBe(undefined);
    });
  });

  describe('armToAmd64Equivalent (size-preserving ARM→x86)', () => {
    // Hetzner's ARM specs, recorded here because the cax entries were
    // deliberately removed from FALLBACK_SERVER_TYPES by the x86-64
    // standardization. This table is what makes "size-preserving" checkable.
    const ARM_SPECS: Record<string, { vcpu: number; ram: number; disk: number }> = {
      cax11: { vcpu: 2, ram: 4, disk: 40 },
      cax21: { vcpu: 4, ram: 8, disk: 80 },
      cax31: { vcpu: 8, ram: 16, disk: 160 },
      cax41: { vcpu: 16, ram: 32, disk: 320 },
    };

    it('covers every SKU in Hetzner ARM line', () => {
      expect(Object.keys(HetznerProvider.ARM_TO_AMD64).sort()).toEqual(Object.keys(ARM_SPECS));
    });

    it('never downsizes: the substitute matches or beats vCPU, RAM and disk', () => {
      // The defect this pins: `cax<N> → cpx<N>` (same numeric suffix) looks
      // right and is not — Hetzner's ARM line carries ~2x the RAM of the AMD
      // shared line at the same suffix, so cax11 (4 GB) would land on cpx11
      // (2 GB), silently halving a node and dropping it BELOW
      // COMPOSE_MIN_RAM_GB (4).
      for (const [arm, spec] of Object.entries(ARM_SPECS)) {
        const x86 = HetznerProvider.armToAmd64Equivalent(arm);
        const target = HetznerProvider.FALLBACK_SERVER_TYPES[x86];
        expect(target, `${arm} → ${x86} is not a catalog SKU`).toBeDefined();
        expect(HetznerProvider.isArmServerType(x86)).toBe(false);
        expect(target.vcpu, `${arm} → ${x86} loses vCPU`).toBeGreaterThanOrEqual(spec.vcpu);
        expect(target.ram, `${arm} → ${x86} loses RAM`).toBeGreaterThanOrEqual(spec.ram);
        expect(target.disk, `${arm} → ${x86} loses disk`).toBeGreaterThanOrEqual(spec.disk);
      }
    });

    it('never returns a SKU below COMPOSE_MIN_RAM_GB, including for an unknown cax', () => {
      const { COMPOSE_MIN_RAM_GB } = require('../../../src/lib/server-types.js');
      for (const arm of [...Object.keys(ARM_SPECS), 'cax99']) {
        const x86 = HetznerProvider.armToAmd64Equivalent(arm);
        expect(
          HetznerProvider.FALLBACK_SERVER_TYPES[x86].ram,
          `${arm} → ${x86} is under the supported RAM floor`,
        ).toBeGreaterThanOrEqual(COMPOSE_MIN_RAM_GB);
      }
    });

    it('passes an x86 type straight through', () => {
      expect(HetznerProvider.armToAmd64Equivalent('cpx21')).toBe('cpx21');
      expect(HetznerProvider.armToAmd64Equivalent('cx23')).toBe('cx23');
    });
  });

  describe('getRegionDefaults', () => {
    // Tests cover the offline-fallback branch (no `_locationTypes` seeded).
    // The project standardized on x86 for all nodes — mixing architectures in a
    // cluster complicates Helm charts (many Supabase images are amd64-only).
    //
    // EU and US resolve DIFFERENTLY because Hetzner's catalog forces it: the
    // 2025-10-16 changelog made cpx11/21/31/41/51 unorderable in FSN/NBG/HEL
    // from 2026-01-01, while the replacement cpx*2 generation has not reached
    // ash/hil and the cx line has never existed there. No single shared-vCPU
    // x86 SKU is orderable in all five supported regions. The cx*3 line is not
    // the EU answer either — it reads available:false in all three EU
    // locations, which is why the offline EU default is cpx*2.
    it('returns current-generation cpx defaults for EU regions', () => {
      const eu = { masterType: 'cpx22', supabaseType: 'cpx32', workerType: 'cpx22' };
      expect(HetznerProvider.getRegionDefaults('fsn1')).toEqual(eu);
      expect(HetznerProvider.getRegionDefaults('nbg1')).toEqual(eu);
      expect(HetznerProvider.getRegionDefaults('hel1')).toEqual(eu);
    });

    it('never offers an EU-retired cpx*1 SKU as an EU default', () => {
      const retiredInEu = ['cpx11', 'cpx21', 'cpx31', 'cpx41', 'cpx51'];
      for (const region of HetznerProvider.EU_REGIONS) {
        const d = HetznerProvider.getRegionDefaults(region);
        expect(retiredInEu).not.toContain(d.masterType);
        expect(retiredInEu).not.toContain(d.supabaseType);
        expect(retiredInEu).not.toContain(d.workerType);
      }
    });

    it('every offline default is a known catalog SKU', () => {
      for (const region of [...HetznerProvider.EU_REGIONS, ...HetznerProvider.US_REGIONS]) {
        const d = HetznerProvider.getRegionDefaults(region);
        for (const t of [d.masterType, d.supabaseType, d.workerType]) {
          expect(HetznerProvider.FALLBACK_SERVER_TYPES).toHaveProperty(t);
        }
      }
    });

    it('returns x86 (cpx) defaults for US regions', () => {
      expect(HetznerProvider.getRegionDefaults('ash')).toEqual({
        masterType: 'cpx11',
        supabaseType: 'cpx21',
        workerType: 'cpx11',
      });
      expect(HetznerProvider.getRegionDefaults('hil')).toEqual({
        masterType: 'cpx11',
        supabaseType: 'cpx21',
        workerType: 'cpx11',
      });
    });

    it('returns x86 defaults for unknown regions', () => {
      // Unknown regions are not in US_REGIONS, so they take the EU branch.
      expect(HetznerProvider.getRegionDefaults('unknown')).toEqual({
        masterType: 'cpx22',
        supabaseType: 'cpx32',
        workerType: 'cpx22',
      });
    });
  });

  describe('instance methods', () => {
    let provider: HetznerProvider;

    beforeEach(() => {
      provider = new HetznerProvider('test-api-token');
    });

    it('getName returns Hetzner Cloud', () => {
      expect(provider.getName()).toBe('Hetzner Cloud');
    });

    it('getRegions returns all regions', () => {
      const regions = provider.getRegions();
      expect(Object.keys(regions)).toHaveLength(5);
      expect(regions.fsn1).toBeDefined();
    });

    it('getServerTypes returns all server types', () => {
      const types = provider.getServerTypes();
      // 4 cx*3 + 4 cx*2 (legacy) + 6 cpx*2 + 5 cpx*1 (legacy) + 6 ccx = 25.
      // No cax (ARM) SKUs — dropped when vibecarbon standardized on x86-64.
      expect(Object.keys(types)).toHaveLength(25);
      expect(types.cpx11).toBeDefined();
      expect(types.cx23).toBeDefined();
      expect(types.cax11).toBeUndefined();
    });

    it('catalogs the current shared-vCPU generations Hetzner actually sells', () => {
      const types = provider.getServerTypes();
      // Launched 2025-10-16 alongside the cpx*1 / cx*2 deprecations.
      for (const t of ['cpx12', 'cpx22', 'cpx32', 'cpx42', 'cpx52', 'cpx62']) {
        expect(types).toHaveProperty(t);
      }
      for (const t of ['cx23', 'cx33', 'cx43', 'cx53']) {
        expect(types).toHaveProperty(t);
      }
      // cpx22 is 2 vCPU / 4 GB / 80 GB — it was previously mis-specced as a
      // copy of cpx21 (3 vCPU).
      expect(types.cpx22).toEqual({ vcpu: 2, ram: 4, disk: 80 });
    });

    it('isValidRegion returns true for valid regions', () => {
      expect(provider.isValidRegion('fsn1')).toBe(true);
      expect(provider.isValidRegion('nbg1')).toBe(true);
      expect(provider.isValidRegion('hel1')).toBe(true);
      expect(provider.isValidRegion('ash')).toBe(true);
      expect(provider.isValidRegion('hil')).toBe(true);
    });

    it('isValidRegion returns false for invalid regions', () => {
      expect(provider.isValidRegion('invalid')).toBe(false);
      expect(provider.isValidRegion('nyc1')).toBe(false);
      expect(provider.isValidRegion('')).toBe(false);
    });

    it('isValidServerType returns true for valid types', () => {
      expect(provider.isValidServerType('cpx11')).toBe(true);
      expect(provider.isValidServerType('cpx21')).toBe(true);
      expect(provider.isValidServerType('cpx31')).toBe(true);
      expect(provider.isValidServerType('cpx41')).toBe(true);
      expect(provider.isValidServerType('cpx51')).toBe(true);
    });

    it('isValidServerType returns false for invalid types', () => {
      expect(provider.isValidServerType('invalid')).toBe(false);
      expect(provider.isValidServerType('cx11')).toBe(false);
      expect(provider.isValidServerType('')).toBe(false);
    });

    it('formatRegion returns display name', () => {
      expect(provider.formatRegion('fsn1')).toBe('Falkenstein, Germany');
      expect(provider.formatRegion('hel1')).toBe('Helsinki, Finland');
    });

    it('formatRegion returns ID for unknown region', () => {
      expect(provider.formatRegion('unknown')).toBe('unknown');
    });

    it('formatServerType returns formatted string', () => {
      const formatted = provider.formatServerType('cpx11');
      expect(formatted).toContain('cpx11');
      expect(formatted).toContain('2 vCPU');
      expect(formatted).toContain('2GB RAM');
      expect(formatted).toContain('40GB SSD');
      // Prices are no longer hard-coded — they change too often.
      expect(formatted).not.toContain('/mo');
      expect(formatted).not.toContain('€');
    });
  });

  describe('getPublicIP static method', () => {
    it('extracts IPv4 from server object', () => {
      const server = {
        public_net: {
          ipv4: { ip: '1.2.3.4' },
          ipv6: { ip: '2001:db8::1' },
        },
      };

      expect(HetznerProvider.getPublicIP(server)).toBe('1.2.3.4');
    });

    it('returns null for server without IPv4', () => {
      const server = {
        public_net: {
          ipv6: { ip: '2001:db8::1' },
        },
      };

      expect(HetznerProvider.getPublicIP(server as unknown as HetznerServer)).toBeNull();
    });

    it('returns null for undefined server', () => {
      expect(HetznerProvider.getPublicIP(undefined as unknown as HetznerServer)).toBeNull();
      expect(HetznerProvider.getPublicIP(null as unknown as HetznerServer)).toBeNull();
    });
  });

  describe('getPublicIPv6 static method', () => {
    it('extracts IPv6 from server object', () => {
      const server = {
        public_net: {
          ipv4: { ip: '1.2.3.4' },
          ipv6: { ip: '2001:db8::1' },
        },
      };

      expect(HetznerProvider.getPublicIPv6(server)).toBe('2001:db8::1');
    });
  });

  describe('API methods (mocked)', () => {
    let provider: HetznerProvider;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      provider = new HetznerProvider('test-api-token');
      fetchSpy = vi.spyOn(global, 'fetch');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('createServer sends correct request', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          server: { id: 12345, status: 'initializing' },
        }),
      } as Response);

      const result = await provider.createServer({
        name: 'test-server',
        serverType: 'cpx11',
        region: 'fsn1',
        sshKeyId: 99,
        environment: 'prod',
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.hetzner.cloud/v1/servers',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-token',
          }),
        }),
      );

      expect(result.id).toBe(12345);
    });

    it('createServer forwards userData as user_data in the API body', async () => {
      // The compose deploy path passes a #cloud-config YAML that runs at VPS
      // boot time — this test locks in that the forwarding is lossless.
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ server: { id: 42, status: 'initializing' } }),
      } as Response);

      const cloudInit = '#cloud-config\nruncmd:\n  - [touch, /var/lib/vibecarbon/ready]\n';
      await provider.createServer({
        name: 'test-server',
        serverType: 'cpx11',
        region: 'fsn1',
        sshKeyId: 99,
        userData: cloudInit,
      });

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.user_data).toBe(cloudInit);
    });

    it('createServer includes networks (coerced to Number) when networks is passed', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ server: { id: 44, status: 'initializing' } }),
      } as Response);

      await provider.createServer({
        name: 'test-server',
        serverType: 'cpx11',
        region: 'fsn1',
        sshKeyId: 99,
        networks: ['4242'],
      });

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.networks).toEqual([4242]);
    });

    it('createServer omits networks when not passed', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ server: { id: 45, status: 'initializing' } }),
      } as Response);

      await provider.createServer({
        name: 'test-server',
        serverType: 'cpx11',
        region: 'fsn1',
        sshKeyId: 99,
      });

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body).not.toHaveProperty('networks');
    });

    it('createServer omits user_data when userData is not provided', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ server: { id: 43, status: 'initializing' } }),
      } as Response);

      await provider.createServer({
        name: 'test-server',
        serverType: 'cpx11',
        region: 'fsn1',
        sshKeyId: 99,
      });

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body).not.toHaveProperty('user_data');
    });

    it('createServer throws on API error', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error: { message: 'Server limit reached', code: 'limit_exceeded' },
        }),
      } as Response);

      await expect(
        provider.createServer({
          name: 'test-server',
          serverType: 'cpx11',
          region: 'fsn1',
          sshKeyId: 99,
        }),
      ).rejects.toThrow('Server limit reached');
    });

    it('createSSHKey returns existing key ID if matching', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ssh_keys: [{ id: 123, name: 'test-key', public_key: 'ssh-rsa AAAA test' }],
        }),
      } as Response);

      const result = await provider.createSSHKey('test-key', 'ssh-rsa AAAA test');

      expect(result).toBe(123);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // Only list, no create
    });

    it('createSSHKey creates new key if not exists', async () => {
      // List returns empty
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ssh_keys: [] }),
      } as Response);

      // Create returns new key
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ssh_key: { id: 456 } }),
      } as Response);

      const result = await provider.createSSHKey('new-key', 'ssh-rsa BBBB test');

      expect(result).toBe(456);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('listServers builds correct label selector', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ servers: [] }),
      } as Response);

      await provider.listServers({ 'managed-by': 'vibecarbon', environment: 'prod' });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('label_selector='),
        expect.anything(),
      );
    });
  });
});
