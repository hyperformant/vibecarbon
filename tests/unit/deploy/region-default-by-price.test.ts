/**
 * A new project's region prompt shows each location's monthly price and
 * pre-selects the cheapest one on the provider's default continent.
 *
 * The price is the cheapest role set for the deploy mode at that location
 * (compose: `compose`; k8s: `master`, `db`, `worker`) plus the billed IPv4
 * per server, as `rankLocationsByPrice` ranks it, so a label and the
 * pre-selection can never disagree. Ties keep the provider's default region;
 * another continent is never pre-selected. A region on record or given with
 * -region is never moved, and with no live catalog the prompt reads as it
 * always did.
 *
 * The region prompt runs after the API token and the catalog fetch (a live
 * price needs the token) and before the HA standby, whose default reads the
 * region.
 *
 * Harness as in standby-default-prompts.test.ts.
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
    projectName: 'regionapp',
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

const restores: Array<() => void> = [];
function seed(...args: Parameters<typeof seedCatalog>) {
  restores.push(seedCatalog(...args));
}

type SelectCall = {
  message: string;
  initialValue?: string;
  options: Array<{ value: string; label: string }>;
};

/** Run the wizard for env `prod`; interactive selects take their pre-selection. */
async function runPrompts({
  provider = 'hetzner',
  mode = 'compose',
  ha = false,
  args = {},
  envConfig = {},
}: {
  provider?: string;
  mode?: 'compose' | 'k8s';
  ha?: boolean;
  args?: Record<string, unknown>;
  envConfig?: Record<string, unknown>;
}) {
  disk.envConfig = { provider, ...envConfig };
  clackMock.select.mockImplementation(async ({ message, initialValue }: SelectCall) => {
    if (message === 'DNS provider:') return 'manual';
    return initialValue;
  });
  const out = await gatherDeploymentConfig({
    env: 'prod',
    provider,
    [mode]: true,
    ...(ha ? { ha: true } : {}),
    ...args,
  });
  const selectCalls = clackMock.select.mock.calls.map(([o]) => o as SelectCall);
  return { region: out.region, out, selectCalls };
}

function regionSelectOf(selectCalls: SelectCall[]) {
  const found = selectCalls.find((c) => c.message === 'Region:');
  if (!found) throw new Error('no Region: select');
  return found;
}

function labelOf(select: SelectCall, value: string) {
  return select.options.find((o) => o.value === value)?.label;
}

describe('new-project region default by price', () => {
  beforeEach(() => {
    vi.spyOn(console, 'clear').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    for (const P of [HetznerProvider, DigitalOceanProvider]) {
      vi.spyOn(P, 'promptApiToken').mockResolvedValue('a'.repeat(64));
      // The seeded catalog stands in for the live fetch.
      vi.spyOn(P, 'fetchServerTypes').mockResolvedValue(undefined as never);
      vi.spyOn(P, 'promptObjectStorageCredentials').mockResolvedValue({
        accessKey: 'ABCDEFGHIJ0123456789',
        secretKey: 'x'.repeat(40),
        source: 'prompt',
      } as never);
    }
    vi.spyOn(S3CompatibleProvider.prototype, 'validateCredentials').mockResolvedValue({
      valid: true,
    });
  });

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
    vi.restoreAllMocks();
    clackMock.select.mockReset();
    clackMock.log.error.mockClear();
  });

  it('flux fixture: a new Hetzner compose project preselects hel1 at $7.09', async () => {
    seed(HetznerProvider, 'flux-hetzner-cx23-hel1');
    const { region, selectCalls } = await runPrompts({});
    const regionSelect = regionSelectOf(selectCalls);
    expect(regionSelect.initialValue).toBe('hel1');
    expect(labelOf(regionSelect, 'hel1')).toBe('hel1 - Helsinki, Finland · from $7.09/mo');
    expect(labelOf(regionSelect, 'nbg1')).toBe('nbg1 - Nuremberg, Germany · from $23.59/mo');
    expect(region).toBe('hel1');
  });

  it('flux fixture, k8s: the label prices master, db and worker together', async () => {
    seed(HetznerProvider, 'flux-hetzner-cx23-hel1');
    const { selectCalls } = await runPrompts({ mode: 'k8s' });
    const regionSelect = regionSelectOf(selectCalls);
    expect(regionSelect.initialValue).toBe('hel1');
    expect(labelOf(regionSelect, 'hel1')).toBe('hel1 - Helsinki, Finland · from $21.27/mo');
    expect(labelOf(regionSelect, 'ash')).toBe('ash - Ashburn, Virginia, USA · from $97.27/mo');
  });

  it('2026-10-22: the EU ties, so nbg1 stays the default at $23.59', async () => {
    seed(HetznerProvider, '2026-10-22/hetzner');
    expect((await runPrompts({ args: { yes: true } })).region).toBe('nbg1');
    const { selectCalls } = await runPrompts({});
    const regionSelect = regionSelectOf(selectCalls);
    expect(regionSelect.initialValue).toBe('nbg1');
    expect(labelOf(regionSelect, 'nbg1')).toBe('nbg1 - Nuremberg, Germany · from $23.59/mo');
  });

  it('under -y a new project takes the preselected region', async () => {
    seed(HetznerProvider, 'flux-hetzner-cx23-hel1');
    const { region, selectCalls } = await runPrompts({ args: { yes: true } });
    expect(region).toBe('hel1');
    expect(selectCalls.find((c) => c.message === 'Region:')).toBeUndefined();
  });

  it('persisted and flag regions are never moved', async () => {
    seed(HetznerProvider, 'flux-hetzner-cx23-hel1');
    expect((await runPrompts({ args: { yes: true }, envConfig: { region: 'nbg1' } })).region).toBe(
      'nbg1',
    );
    expect((await runPrompts({ args: { yes: true, region: 'fsn1' } })).region).toBe('fsn1');
    // Interactive too: no region question when one is on record.
    const { region, selectCalls } = await runPrompts({ envConfig: { region: 'nbg1' } });
    expect(region).toBe('nbg1');
    expect(selectCalls.find((c) => c.message === 'Region:')).toBeUndefined();
  });

  it('DigitalOcean keeps nyc3 on a $24 tie', async () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const { region, selectCalls } = await runPrompts({ provider: 'digitalocean' });
    const regionSelect = regionSelectOf(selectCalls);
    expect(regionSelect.initialValue).toBe('nyc3');
    expect(region).toBe('nyc3');
    expect(labelOf(regionSelect, 'nyc3')).toMatch(/^nyc3 - .* · from \$24\.00\/mo$/);
    expect(labelOf(regionSelect, 'tor1')).toMatch(/^tor1 - .* · from \$24\.00\/mo$/);
  });

  it('a location where the set is unorderable says so and stays selectable', async () => {
    seed(DigitalOceanProvider, '2026-10-22/digitalocean');
    const { selectCalls } = await runPrompts({ provider: 'digitalocean' });
    const regionSelect = regionSelectOf(selectCalls);
    const atl1 = regionSelect.options.find((o) => o.value === 'atl1');
    expect(atl1?.label).toMatch(/^atl1 - .* · not orderable right now$/);
  });

  it('never preselects another continent', async () => {
    // Nothing on the compose list is orderable in the EU, so ash is the
    // cheapest (the only) place to put it; the pre-selection stays in the EU.
    const EU_OUT = ['cpx22', 'cx23', 'cpx21'];
    seed(HetznerProvider, '2026-10-22/hetzner', {
      drop: { fsn1: EU_OUT, nbg1: EU_OUT, hel1: EU_OUT },
    });
    // Taking the pre-selection then refuses with the P7 line, which names
    // no nearby EU location either.
    await expect(runPrompts({})).rejects.toThrow(/exit 1/);
    const selectCalls = clackMock.select.mock.calls.map(([o]) => o as SelectCall);
    const regionSelect = regionSelectOf(selectCalls);
    expect(regionSelect.initialValue).toBe('nbg1');
    expect(String(clackMock.log.error.mock.calls[0][0])).toMatch(/orderable in nbg1 right now/);
    expect(labelOf(regionSelect, 'ash')).toBe('ash - Ashburn, Virginia, USA · from $38.09/mo');
    expect(labelOf(regionSelect, 'nbg1')).toBe(
      'nbg1 - Nuremberg, Germany · not orderable right now',
    );
  });

  it('with no live catalog the labels and default read as before', async () => {
    const { region, selectCalls } = await runPrompts({});
    const regionSelect = regionSelectOf(selectCalls);
    expect(regionSelect.initialValue).toBe('nbg1');
    expect(labelOf(regionSelect, 'hel1')).toBe('hel1 - Helsinki, Finland');
    expect(region).toBe('nbg1');
  });

  it('labels carry no em dash', async () => {
    seed(HetznerProvider, 'flux-hetzner-cx23-hel1');
    const { selectCalls } = await runPrompts({});
    for (const o of regionSelectOf(selectCalls).options) expect(o.label).not.toContain('—');
  });

  it('HA: the standby default reads the chosen region', async () => {
    seed(HetznerProvider, 'flux-hetzner-cx23-hel1');
    const { out, selectCalls } = await runPrompts({ ha: true });
    const order = selectCalls.map((c) => c.message);
    expect(order.indexOf('Region:')).toBeLessThan(
      order.indexOf('Standby region (HA failover target):'),
    );
    expect(out.region).toBe('hel1');
    expect(out.secondaryRegion).not.toBe('hel1');
  });
});
