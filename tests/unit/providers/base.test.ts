import { afterEach, describe, expect, it } from 'vitest';
import { BaseProvider, standbyPairOrNeighbour } from '../../../src/lib/providers/base.js';

describe('BaseProvider', () => {
  describe('constructor', () => {
    it('requires an API token', () => {
      expect(() => new BaseProvider('')).toThrow('API token is required');
      expect(() => new BaseProvider(null as unknown as string)).toThrow('API token is required');
      expect(() => new BaseProvider(undefined as unknown as string)).toThrow(
        'API token is required',
      );
    });

    it('stores the API token', () => {
      const provider = new BaseProvider('test-token');
      expect(provider.apiToken).toBe('test-token');
    });
  });

  describe('abstract methods', () => {
    let provider: BaseProvider;

    beforeEach(() => {
      provider = new BaseProvider('test-token');
    });

    it('createServer throws not implemented', async () => {
      await expect(provider.createServer({})).rejects.toThrow('must be implemented');
    });

    it('deleteServer throws not implemented', async () => {
      await expect(provider.deleteServer('123')).rejects.toThrow('must be implemented');
    });

    it('renameServer throws not implemented', async () => {
      await expect(provider.renameServer('123', 'new-name')).rejects.toThrow('must be implemented');
    });

    it('getServer throws not implemented', async () => {
      await expect(provider.getServer('123')).rejects.toThrow('must be implemented');
    });

    it('waitForServer throws not implemented', async () => {
      await expect(provider.waitForServer('123')).rejects.toThrow('must be implemented');
    });

    it('getServerType throws a "not implemented for <class>" error naming the concrete subclass', async () => {
      await expect(provider.getServerType('cx23')).rejects.toThrow(
        'getServerType() must be implemented by subclass',
      );
    });

    it('createSSHKey throws not implemented', async () => {
      await expect(provider.createSSHKey('name', 'key')).rejects.toThrow('must be implemented');
    });

    it('listServers throws not implemented', async () => {
      await expect(provider.listServers()).rejects.toThrow('must be implemented');
    });

    it('findServersByName throws not implemented', async () => {
      await expect(provider.findServersByName('name')).rejects.toThrow('must be implemented');
    });

    // B3 — cross-cutting replication-firewall rule builder. Pure (no I/O),
    // so unlike its neighbors this is a sync throw, not a rejected promise.
    // Takes the firewall OBJECT (findFirewallByName's shape), not a
    // pre-extracted rules array — see BaseProvider's abstract doc.
    it('buildReplicationFirewallRules throws not implemented', () => {
      expect(() => provider.buildReplicationFirewallRules({}, '1.2.3.4')).toThrow(
        'must be implemented',
      );
    });

    // C10a teardown-primitive stubs (final-review fix wave) — HetznerProvider
    // is today's only implementation; these declare the abstract contract.
    it('deleteFirewallByName throws not implemented', async () => {
      await expect(provider.deleteFirewallByName('name')).rejects.toThrow('must be implemented');
    });

    it('deleteSSHKeyByName throws not implemented', async () => {
      await expect(provider.deleteSSHKeyByName('name')).rejects.toThrow('must be implemented');
    });

    it('listNetworks throws not implemented', async () => {
      await expect(provider.listNetworks()).rejects.toThrow('must be implemented');
    });

    // Not abstract: the base returns listVolumesDetailed's items, so on the
    // bare base class it is that abstract member which throws.
    it('listVolumes reads through the abstract listVolumesDetailed', async () => {
      await expect(provider.listVolumes()).rejects.toThrow(
        'listVolumesDetailed() must be implemented',
      );
      class Listed extends BaseProvider {
        async listVolumesDetailed() {
          return { items: [{ id: 'vol-1' }], complete: true };
        }
      }
      expect(await new Listed('test-token').listVolumes()).toEqual([{ id: 'vol-1' }]);
    });

    it('deleteVolume throws not implemented', async () => {
      await expect(provider.deleteVolume('vol-1')).rejects.toThrow('must be implemented');
    });

    it('listLoadBalancers throws not implemented', async () => {
      await expect(provider.listLoadBalancers()).rejects.toThrow('must be implemented');
    });

    it('deleteLoadBalancer throws not implemented', async () => {
      await expect(provider.deleteLoadBalancer('lb-1')).rejects.toThrow('must be implemented');
    });
  });

  describe('abstract static catalog methods', () => {
    it('fetchServerTypes throws not implemented', async () => {
      await expect(BaseProvider.fetchServerTypes('token')).rejects.toThrow('must be implemented');
    });

    // Not abstract: the same for every provider with no ARM line, reading the
    // calling class's own catalog. Hetzner overrides it.
    describe('getServerTypesForRegion answers for the calling subclass', () => {
      class Catalog extends BaseProvider {
        static SERVER_TYPES = {
          big: { vcpu: 4, ram: 8, disk: 160 },
          small: { vcpu: 2, ram: 4, disk: 80 },
        };
        static FALLBACK_SERVER_TYPES = { offline: { vcpu: 1, ram: 2, disk: 50 } };
      }
      afterEach(() => {
        Catalog._locationTypes = null;
      });

      it('lists the whole offline catalog before a live fetch, each entry x86', () => {
        expect(Catalog.getServerTypesForRegion('home')).toEqual([
          { name: 'offline', vcpu: 1, ram: 2, disk: 50, architecture: 'x86' },
        ]);
      });

      it("lists the region's live types it knows, smallest first", () => {
        Catalog._locationTypes = { home: new Set(['big', 'unknown', 'small']) };
        expect(Catalog.getServerTypesForRegion('home')).toEqual([
          { name: 'small', vcpu: 2, ram: 4, disk: 80, architecture: 'x86' },
          { name: 'big', vcpu: 4, ram: 8, disk: 160, architecture: 'x86' },
        ]);
      });

      it('lists the offline catalog for a region the live catalog does not name', () => {
        Catalog._locationTypes = { home: new Set(['big']) };
        expect(Catalog.getServerTypesForRegion('away').map((t) => t.name)).toEqual(['offline']);
      });

      it('lists nothing on the bare base class', () => {
        expect(BaseProvider.getServerTypesForRegion('region')).toEqual([]);
      });
    });

    describe('resolveServerTypeForRegion answers for the calling subclass', () => {
      class Stocked extends BaseProvider {
        static ROLE_CANDIDATES = { compose: ['small', 'big'] };
        static SERVER_TYPES = {
          small: { vcpu: 2, ram: 4, disk: 80 },
          big: { vcpu: 4, ram: 8, disk: 160 },
        };
      }
      afterEach(() => {
        Stocked._locationTypes = null;
      });

      it('keeps the type offline, where every type is assumed stocked', () => {
        expect(Stocked.resolveServerTypeForRegion('small', 'away', 'compose')).toBe('small');
      });

      it('keeps a type the live catalog stocks there', () => {
        Stocked._locationTypes = { away: new Set(['small', 'big']) };
        expect(Stocked.resolveServerTypeForRegion('small', 'away', 'compose')).toBe('small');
      });

      it("stands in the role's stocked pick of at least its RAM, never smaller", () => {
        Stocked._locationTypes = { away: new Set(['big']) };
        expect(Stocked.resolveServerTypeForRegion('small', 'away', 'compose')).toBe('big');
      });

      it('answers null where the live catalog stocks nothing, for the caller to refuse', () => {
        Stocked._locationTypes = { home: new Set(['small']) };
        expect(Stocked.resolveServerTypeForRegion('small', 'away', 'compose')).toBeNull();
      });
    });

    // Not abstract: the same for every provider, reading the calling class's
    // own candidates and catalog; the bare base class has none.
    it('getRegionDefaults has nothing to pick on the bare base class', () => {
      expect(BaseProvider.getRegionDefaults('region')).toEqual({
        composeType: null,
        masterType: null,
        dbType: null,
        workerType: null,
      });
    });

    it('getDefaultStandbyRegion reads through the abstract conventionalStandbyRegion', () => {
      expect(() => BaseProvider.getDefaultStandbyRegion('region')).toThrow(
        'conventionalStandbyRegion() must be implemented',
      );
    });

    it('getRegionDefaults and getDefaultStandbyRegion answer for the calling subclass', () => {
      class OneRegion extends BaseProvider {
        static ROLE_CANDIDATES = { compose: ['small'] };
        static SERVER_TYPES = { small: { vcpu: 2, ram: 4, disk: 40 } };
        static getServerTypesForRegion() {
          return [{ name: 'small', vcpu: 2, ram: 4, disk: 40 }];
        }
        static conventionalStandbyRegion() {
          return 'pair';
        }
      }
      expect(OneRegion.getRegionDefaults('home').composeType).toBe('small');
      expect(OneRegion.getDefaultStandbyRegion('home')).toBe('pair');
    });

    // The walk each provider's own conventionalStandbyRegion takes before its
    // own last resort.
    it('standbyPairOrNeighbour: the pair, else the first same-continent region, else nothing', () => {
      const continents = { a1: 'eu', a2: 'eu', a3: 'eu', b1: 'us', c1: 'sa' };
      expect(standbyPairOrNeighbour(continents, 'a1', { a1: 'a3' })).toBe('a3');
      expect(standbyPairOrNeighbour(continents, 'a2', { a1: 'a3' })).toBe('a1');
      expect(standbyPairOrNeighbour(continents, 'a1')).toBe('a2');
      expect(standbyPairOrNeighbour(continents, 'c1', { a1: 'a3' })).toBeUndefined();
      expect(standbyPairOrNeighbour(continents, 'nowhere')).toBeUndefined();
    });

    it('conventionalStandbyRegion throws not implemented', () => {
      expect(() => BaseProvider.conventionalStandbyRegion('region')).toThrow(
        'conventionalStandbyRegion() must be implemented by subclass',
      );
    });

    it('getPublicIP throws not implemented', () => {
      expect(() => BaseProvider.getPublicIP({})).toThrow('must be implemented');
    });

    // x86-64 standardization: these two are CONCRETE on the base (not abstract).
    // A provider that sells no ARM at all — DigitalOcean, zero ARM instance
    // types — should inherit them untouched.
    it('isArmServerType defaults to false (providers with no ARM line inherit it)', () => {
      expect(BaseProvider.isArmServerType('s-2vcpu-4gb')).toBe(false);
      expect(BaseProvider.isArmServerType('cax11')).toBe(false);
    });

    it('assertAmd64ServerType is a passthrough while isArmServerType says false', () => {
      expect(BaseProvider.assertAmd64ServerType('s-2vcpu-4gb', '-type')).toBe('s-2vcpu-4gb');
      expect(BaseProvider.assertAmd64ServerType(null)).toBe(null);
    });

    it('armToAmd64Equivalent defaults to DEFAULT_TYPE', () => {
      class NoArmProvider extends BaseProvider {
        static DEFAULT_TYPE = 'x86-small';
      }
      expect(NoArmProvider.armToAmd64Equivalent('anything')).toBe('x86-small');
    });

    it('assertAmd64ServerType throws for whatever the subclass calls ARM', () => {
      class ArmishProvider extends BaseProvider {
        static NAME = 'Armish Cloud';
        static DEFAULT_TYPE = 'x86-small';
        static isArmServerType(t: string) {
          return t.startsWith('arm-');
        }
      }
      expect(() => ArmishProvider.assertAmd64ServerType('arm-large', '-type')).toThrow(
        /-type: 'arm-large' is an ARM \(aarch64\) Armish Cloud server type/,
      );
      // The message has to be actionable: name the constraint AND a way out.
      expect(() => ArmishProvider.assertAmd64ServerType('arm-large', '-type')).toThrow(
        /x86-64 \(amd64\) only.*x86-small/s,
      );
      expect(ArmishProvider.assertAmd64ServerType('x86-small', '-type')).toBe('x86-small');
    });

    it('assertAmd64ServerType quotes the subclass armToAmd64Equivalent, not DEFAULT_TYPE', () => {
      // A same-size substitute is the whole point: a provider whose ARM line
      // outspecs its default must be able to say so, or the "way out" the
      // message offers is a silent downsize.
      class SizedArmProvider extends BaseProvider {
        static NAME = 'Sized Cloud';
        static DEFAULT_TYPE = 'x86-small';
        static isArmServerType(t: string) {
          return t.startsWith('arm-');
        }
        static armToAmd64Equivalent(t: string) {
          return t === 'arm-large' ? 'x86-large' : 'x86-small';
        }
      }
      expect(() => SizedArmProvider.assertAmd64ServerType('arm-large', '-type')).toThrow(
        /e\.g\. x86-large/,
      );
      expect(() => SizedArmProvider.assertAmd64ServerType('arm-large', '-type')).not.toThrow(
        /x86-small/,
      );
    });
  });

  describe('abstract static object-storage dispatch', () => {
    it('getObjectStorageProviderClass throws not implemented', async () => {
      await expect(BaseProvider.getObjectStorageProviderClass()).rejects.toThrow(
        'must be implemented',
      );
    });
  });

  // CD2 — lazy IaC program dispatch statics.
  describe('abstract static IaC program dispatch (CD2)', () => {
    it('getComposeProgram throws not implemented', async () => {
      await expect(BaseProvider.getComposeProgram({})).rejects.toThrow('must be implemented');
    });

    it('getK8sProgram throws not implemented', async () => {
      await expect(BaseProvider.getK8sProgram({})).rejects.toThrow('must be implemented');
    });
  });

  // M3 Task 3 — provider-owned k8s user-data dispatch statics.
  describe('abstract static k8s user-data dispatch (M3 Task 3)', () => {
    it('getK8sMasterUserData throws not implemented', async () => {
      await expect(BaseProvider.getK8sMasterUserData({})).rejects.toThrow('must be implemented');
    });

    it('getK8sWorkerUserData throws not implemented', async () => {
      await expect(BaseProvider.getK8sWorkerUserData({})).rejects.toThrow('must be implemented');
    });
  });

  // C7d — guided-setup delegation statics.
  describe('abstract static guided-setup delegation (C7d)', () => {
    it('promptApiToken throws not implemented', async () => {
      await expect(BaseProvider.promptApiToken('proj')).rejects.toThrow('must be implemented');
    });

    it('promptObjectStorageCredentials throws not implemented', async () => {
      await expect(BaseProvider.promptObjectStorageCredentials('proj')).rejects.toThrow(
        'must be implemented',
      );
    });
  });

  describe('declared-but-abstract identity/credentials statics', () => {
    it('default to empty strings on BaseProvider', () => {
      expect(BaseProvider.TOKEN_ENV).toBe('');
      expect(BaseProvider.CLI_TOKEN_ENV).toBe('');
      expect(BaseProvider.PROVIDER_ID_PREFIX).toBe('');
      expect(BaseProvider.PRICING_URL).toBe('');
      expect(BaseProvider.DEFAULT_REGION).toBe('');
      expect(BaseProvider.S3_REGION_ENV).toBe('');
    });
  });

  // C7b — engine literals hoisted to provider statics (values verbatim).
  describe('declared-but-abstract C7b engine-literal statics', () => {
    it('default to empty string/array on BaseProvider', () => {
      expect(BaseProvider.DEFAULT_COMPOSE_TYPE).toBe('');
      expect(BaseProvider.DEFAULT_K8S_NODE_TYPE).toBe('');
    });
  });

  describe('CLOUD_INIT_READY_TIMEOUT_MS', () => {
    it('defaults to 180s — a REAL (non-abstract) budget, since most providers boot images with Docker preinstalled', () => {
      expect(BaseProvider.CLOUD_INIT_READY_TIMEOUT_MS).toBe(180_000);
    });
  });

  // C7c — k8s asset identity strings hoisted to provider statics (values verbatim).
  describe('declared-but-abstract C7c K8S_ASSETS static', () => {
    it('default to empty strings on BaseProvider', () => {
      expect(BaseProvider.K8S_ASSETS).toEqual({
        csiNodeDaemonSet: '',
        csiControllerSelector: '',
        ccmDeployment: '',
        ccmSelector: '',
        networkEnvVar: '',
      });
    });
  });
});

// Import beforeEach for the tests
import { beforeEach } from 'vitest';
