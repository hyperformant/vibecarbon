/**
 * The HA standby location and size come from the role picker
 * (src/lib/sizing.js), so the wizard decides them after the live catalog is
 * fetched: the standby prompt sits between the API token and the S3 keys,
 * pre-selecting the cheapest same-continent partner where every standby role
 * is orderable (DigitalOcean nyc3 -> tor1 on 2026-10-22, where the static
 * nyc3 -> sfo3 pair sold none of the default sizes).
 *
 * A standby role with nothing orderable in the standby location refuses with
 * the P7 line (ruling B6), naming the cheapest nearby locations other than the
 * primary, before the S3 keys are asked for or anything is created or saved.
 *
 * Harness as in compose-default-size.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedCatalog } from '../helpers/catalog-fixtures.js';

const clackMock = vi.hoisted(() => ({
  select: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(async () => true),
  password: vi.fn(),
  note: vi.fn(),
  intro: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: {
    step: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));
vi.mock('@clack/prompts', () => clackMock);

const disk = vi.hoisted(() => ({ envConfig: {} as Record<string, unknown> }));
vi.mock('../../../src/lib/config.js', () => ({
  loadProjectConfig: () => ({
    projectName: 'standbyapp',
    bucketSalt: 'abc123',
    environments: { prod: disk.envConfig },
  }),
}));
vi.mock('../../../src/lib/licensing/index.js', () => ({
  requireDeployEntitlement: vi.fn(async () => undefined),
}));
vi.mock('../../../src/lib/telemetry/update-check.js', () => ({ printUpdateNotice: vi.fn() }));
vi.mock('../../../src/lib/deploy/delta.js', () => ({
  collectDeployDelta: () => ({}),
  formatDeployDeltaLines: () => [],
}));
vi.mock('../../../src/lib/deploy/preflight.js', () => ({ assertOperatorConfig: vi.fn() }));
vi.mock('../../../src/lib/ci-setup.js', () => ({ ciAvailable: () => false }));

import { gatherDeploymentConfig } from '../../../src/lib/deploy/prompts.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { S3CompatibleProvider } from '../../../src/lib/providers/s3-base.js';

const providerWrites: string[] = [];
const restores: Array<() => void> = [];

function seed(...args: Parameters<typeof seedCatalog>) {
  restores.push(seedCatalog(...args));
}

/** Run the HA wizard for env `prod` with `envConfig` on record. */
function runPrompts({
  provider = 'digitalocean',
  mode = 'compose',
  args = {},
  envConfig = {},
}: {
  provider?: string;
  mode?: 'compose' | 'k8s';
  args?: Record<string, unknown>;
  envConfig?: Record<string, unknown>;
}) {
  disk.envConfig = { provider, ...envConfig };
  return gatherDeploymentConfig({ env: 'prod', provider, [mode]: true, ha: true, ...args });
}

/** The 4 GB and 2 GB sizes DigitalOcean sold in sfo3 on 2026-10-22. */
const DO_SFO3 = {
  fourGb: ['s-2vcpu-4gb-amd', 's-2vcpu-4gb-intel'],
  twoGb: ['s-1vcpu-2gb-amd', 's-1vcpu-2gb-intel'],
};

describe('deploy wizard HA standby', () => {
  beforeEach(() => {
    providerWrites.length = 0;
    vi.spyOn(console, 'clear').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    for (const P of [HetznerProvider, DigitalOceanProvider]) {
      vi.spyOn(P, 'promptApiToken').mockResolvedValue('a'.repeat(64));
      // The seeded catalog stands in for the live fetch.
      vi.spyOn(P, 'fetchServerTypes').mockResolvedValue(undefined as never);
      vi.spyOn(P, 'promptObjectStorageCredentials').mockImplementation(async () => {
        providerWrites.push('s3-credentials-asked');
        return { accessKey: 'ABCDEFGHIJ0123456789', secretKey: 'x'.repeat(40), source: 'prompt' };
      });
    }
    vi.spyOn(DigitalOceanProvider.prototype, 'createServer').mockImplementation(async () => {
      providerWrites.push('createServer');
      return {} as never;
    });
    vi.spyOn(S3CompatibleProvider.prototype, 'createBucket').mockImplementation(async () => {
      providerWrites.push('createBucket');
      return {} as never;
    });
    vi.spyOn(S3CompatibleProvider.prototype, 'validateCredentials').mockResolvedValue({
      valid: true,
    });
  });

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
    vi.restoreAllMocks();
    clackMock.select.mockReset();
    clackMock.log.error.mockClear();
    clackMock.log.info.mockClear();
  });

  it('decides the standby default after the catalog fetch', () => {
    const source = gatherDeploymentConfig.toString();
    const fetchAt = source.indexOf('await Provider.fetchServerTypes(');
    expect(fetchAt).toBeGreaterThan(-1);
    expect(source.indexOf('Provider.getDefaultStandbyRegion(')).toBeGreaterThan(fetchAt);
  });

  it('headless DigitalOcean compose-ha in nyc3 pairs with tor1', async () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const out = await runPrompts({ args: { yes: true, region: 'nyc3' } });
    expect(out.secondaryRegion).toBe('tor1');
  });

  it('headless DigitalOcean k8s-ha in nyc3 pairs with tor1', async () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const out = await runPrompts({ mode: 'k8s', args: { yes: true, region: 'nyc3' } });
    expect(out.secondaryRegion).toBe('tor1');
  });

  it('the interactive standby prompt pre-selects the priced partner', async () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    clackMock.select.mockImplementation(async ({ message, initialValue }) => {
      if (message === 'Standby region (HA failover target):') return initialValue;
      if (message === 'DNS provider:') return 'manual';
      throw new Error(`unexpected select: ${message}`);
    });
    const out = await runPrompts({ args: { region: 'nyc3' } });
    const standbySelect = clackMock.select.mock.calls.find(
      ([o]) => o.message === 'Standby region (HA failover target):',
    );
    expect(standbySelect?.[0].initialValue).toBe('tor1');
    expect(out.secondaryRegion).toBe('tor1');
  });

  it('Review Focus 3: a recorded standby location with nothing orderable refuses, naming tor1, and keeps the record', async () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean', { drop: { sfo3: DO_SFO3.fourGb } });
    const envConfig = {
      provider: 'digitalocean',
      deployMode: 'compose-ha',
      ha: { enabled: true },
      region: 'nyc3',
      secondaryRegion: 'sfo3',
    };
    await expect(runPrompts({ args: { yes: true }, envConfig })).rejects.toThrow(/exit 1/);
    expect(String(clackMock.log.error.mock.calls[0][0])).toBe(
      'no standby compose server with 4 GB+ RAM is orderable in sfo3 right now; ' +
        'orderable nearby: tor1 (s-2vcpu-4gb $24.00/mo)',
    );
    const hint = String(clackMock.log.info.mock.calls.at(-1)?.[0]);
    expect(hint.split('\n').at(-1)).toBe('  vibecarbon deploy prod -standby-region tor1');
    expect(disk.envConfig.secondaryRegion).toBe('sfo3');
    expect(providerWrites).toEqual([]);
  });

  it('k8s-ha: a standby db with nothing orderable refuses before anything is saved or created', async () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean', { drop: { sfo3: DO_SFO3.twoGb } });
    await expect(
      runPrompts({
        mode: 'k8s',
        args: { yes: true, region: 'nyc3', secondaryRegion: 'sfo3' },
      }),
    ).rejects.toThrow(/exit 1/);
    expect(String(clackMock.log.error.mock.calls[0][0])).toBe(
      'no standby k8s database server with 2 GB+ RAM is orderable in sfo3 right now; ' +
        'orderable nearby: tor1 (s-2vcpu-4gb + s-1vcpu-2gb $36.00/mo)',
    );
    expect(providerWrites).toEqual([]);
  });

  it('a stocked standby location passes, with the standby re-picked there', async () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const out = await runPrompts({ args: { yes: true, region: 'nyc3', secondaryRegion: 'sfo3' } });
    expect(out.secondaryRegion).toBe('sfo3');
    expect(out.serverType).toBe('s-2vcpu-4gb');
  });

  it('a compose-ha standby already on record is not re-checked', async () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean', { drop: { sfo3: DO_SFO3.fourGb } });
    const out = await runPrompts({
      args: { yes: true },
      envConfig: {
        provider: 'digitalocean',
        deployMode: 'compose-ha',
        ha: { enabled: true },
        region: 'nyc3',
        secondaryRegion: 'sfo3',
        serverType: 's-2vcpu-4gb',
        servers: [
          { role: 'primary', serverType: 's-2vcpu-4gb', region: 'nyc3' },
          { role: 'standby', serverType: 's-2vcpu-4gb-amd', region: 'sfo3' },
        ],
      },
    });
    expect(out.secondaryRegion).toBe('sfo3');
  });

  it('compose-ha: a fresh standby returns the type resolved for its location, for the skeleton save', async () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const out = await runPrompts({ args: { yes: true, region: 'nyc3', secondaryRegion: 'sfo3' } });
    expect(out.standbyServerTypes).toEqual({ serverType: 's-2vcpu-4gb-amd' });
  });

  it('compose-ha: a standby type on record for that location is kept, so a stocked-out location still passes', async () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean', { drop: { sfo3: DO_SFO3.fourGb } });
    const out = await runPrompts({
      args: { yes: true },
      envConfig: {
        deployMode: 'compose-ha',
        ha: {
          enabled: true,
          pendingStandby: { region: 'sfo3', serverType: 's-2vcpu-4gb-amd' },
        },
        region: 'nyc3',
        secondaryRegion: 'sfo3',
        serverType: 's-2vcpu-4gb',
      },
    });
    expect(out.secondaryRegion).toBe('sfo3');
    expect(out.standbyServerTypes).toBeUndefined();
  });

  it('k8s-ha: standby types on record are kept, so a stocked-out standby location still passes', async () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean', {
      drop: { sfo3: [...DO_SFO3.fourGb, ...DO_SFO3.twoGb] },
    });
    const out = await runPrompts({
      mode: 'k8s',
      args: { yes: true },
      envConfig: {
        deployMode: 'kubernetes',
        ha: {
          enabled: true,
          standby: { masterServerType: 's-2vcpu-4gb-amd', dbServerType: 's-1vcpu-2gb-amd' },
          standbyWorkerSpec: { count: 1, serverType: 's-2vcpu-4gb-amd' },
        },
        region: 'nyc3',
        secondaryRegion: 'sfo3',
      },
    });
    expect(out.secondaryRegion).toBe('sfo3');
    expect(out.standbyServerTypes).toEqual({
      masterServerType: 's-2vcpu-4gb-amd',
      dbServerType: 's-1vcpu-2gb-amd',
      workerServerType: 's-2vcpu-4gb-amd',
    });
  });

  it('k8s-ha: a fresh standby returns the types resolved for its location, for the skeleton save', async () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const out = await runPrompts({
      mode: 'k8s',
      args: { yes: true, region: 'nyc3', secondaryRegion: 'sfo3' },
    });
    expect(out.standbyServerTypes).toEqual({
      masterServerType: 's-2vcpu-4gb-amd',
      dbServerType: 's-1vcpu-2gb-amd',
      workerServerType: 's-2vcpu-4gb-amd',
    });
  });

  describe('k8s-ha: a first-deploy rerun with a different -standby-region', () => {
    // A first deploy that failed after the skeleton save has the standby
    // types it resolved for sfo3 on record, but no standby stack yet.
    const skeleton = (standby: Record<string, unknown> = {}) => ({
      deployMode: 'kubernetes',
      ha: {
        enabled: true,
        standby: {
          masterServerType: 's-2vcpu-4gb-amd',
          dbServerType: 's-1vcpu-2gb-amd',
          ...standby,
        },
        standbyWorkerSpec: { serverType: 's-2vcpu-4gb-amd' },
      },
      region: 'nyc3',
      secondaryRegion: 'sfo3',
    });

    it('re-resolves the standby types for the new location', async () => {
      seed(DigitalOceanProvider, '2026-10-22/digitalocean');
      const out = await runPrompts({
        mode: 'k8s',
        args: { yes: true, secondaryRegion: 'tor1' },
        envConfig: skeleton(),
      });
      expect(out.secondaryRegion).toBe('tor1');
      // tor1 sells none of the sfo3 -amd types.
      expect(out.standbyServerTypes).toEqual({
        masterServerType: 's-2vcpu-4gb',
        dbServerType: 's-1vcpu-2gb',
        workerServerType: 's-2vcpu-4gb',
      });
      expect(out.standbyRetargeted).toBe(true);
    });

    it('a standby that already has a stack keeps its record', async () => {
      seed(DigitalOceanProvider, '2026-10-22/digitalocean');
      const envConfig = skeleton({ stack: 'prod-standby', region: 'sfo3' });
      (envConfig.ha as Record<string, unknown>).primary = { stack: 'prod-primary', region: 'nyc3' };
      const out = await runPrompts({
        mode: 'k8s',
        args: { yes: true, secondaryRegion: 'tor1' },
        envConfig,
      });
      expect(out.standbyServerTypes).toEqual({
        masterServerType: 's-2vcpu-4gb-amd',
        dbServerType: 's-1vcpu-2gb-amd',
        workerServerType: 's-2vcpu-4gb-amd',
      });
      expect(out.standbyRetargeted).toBe(false);
    });

    it('the same -standby-region as on record keeps the record', async () => {
      seed(DigitalOceanProvider, '2026-10-22/digitalocean');
      const out = await runPrompts({
        mode: 'k8s',
        args: { yes: true, secondaryRegion: 'sfo3' },
        envConfig: skeleton(),
      });
      expect(out.standbyServerTypes?.masterServerType).toBe('s-2vcpu-4gb-amd');
      expect(out.standbyRetargeted).toBe(false);
    });
  });

  describe('a primary bigger than every candidate', () => {
    const hetznerHa = (extra: Record<string, unknown> = {}) => ({
      provider: 'hetzner',
      args: { yes: true },
      envConfig: {
        deployMode: 'compose-ha',
        ha: { enabled: true },
        region: 'nbg1',
        serverType: 'cpx32',
        ...extra,
      },
    });

    it('defaults to the partner that stocks it', async () => {
      seed(HetznerProvider, '2026-10-22/hetzner', { drop: { fsn1: ['cpx32'] } });
      const out = await runPrompts(hetznerHa());
      expect(out.secondaryRegion).toBe('hel1');
    });

    it('refuses a recorded standby location without it, never shrinking the standby', async () => {
      seed(HetznerProvider, '2026-10-22/hetzner', { drop: { fsn1: ['cpx32'] } });
      await expect(runPrompts(hetznerHa({ secondaryRegion: 'fsn1' }))).rejects.toThrow(/exit 1/);
      expect(String(clackMock.log.error.mock.calls[0][0])).toBe(
        'no standby compose server with 8 GB+ RAM is orderable in fsn1 right now; ' +
          'orderable nearby: hel1 (cpx32 $42.59/mo)',
      );
      const hint = String(clackMock.log.info.mock.calls.at(-1)?.[0]);
      expect(hint.split('\n').at(-1)).toBe('  vibecarbon deploy prod -standby-region hel1');
      expect(providerWrites).toEqual([]);
    });

    it('with nothing nearby either, says standby and that -server-type sizes both', async () => {
      seed(HetznerProvider, '2026-10-22/hetzner', { drop: { fsn1: ['cpx32'], hel1: ['cpx32'] } });
      await expect(runPrompts(hetznerHa({ secondaryRegion: 'fsn1' }))).rejects.toThrow(/exit 1/);
      const line = String(clackMock.log.error.mock.calls[0][0]);
      expect(line).toBe(
        'no standby compose server with 8 GB+ RAM is orderable in fsn1 right now, ' +
          'and no other standby location on this continent has one either',
      );
      const hint = String(clackMock.log.info.mock.calls.at(-1)?.[0]);
      expect(hint).toContain('-server-type sizes the primary and its standby together');
      expect(hint).not.toContain('\u2014');
      expect(line).not.toContain('\u2014');
      expect(hint.split('\n').at(-1)).toBe('  vibecarbon deploy prod -server-type <type>');
      expect(providerWrites).toEqual([]);
    });
  });
});
