/**
 * scripts/cost-grid.js: the README's "What it costs to run" grid.
 *
 * renderCostGrid and replaceSection are pure. computeEnvMonthly and
 * providerEntry run on the 2026-10-22 catalog fixtures (seedCatalog), never
 * the network, and must give the grid the cost-grid sources quote
 * (docs/superpowers/plans/2026-10-20-cost-grid-sources.md), with each
 * location picked as the deploy wizard picks it for a new project.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  BILLING_EXTRAS,
  computeEnvMonthly,
  parseHetznerExtras,
  providerEntry,
  renderCostGrid,
  replaceSection,
  storageLine,
} from '../../../scripts/cost-grid.js';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';
import { readCatalogFixture, seedCatalog } from '../helpers/catalog-fixtures.js';

const fixture = {
  date: '22 October 2026',
  providers: [
    {
      id: 'hetzner',
      label: 'Hetzner (USD account)',
      currency: '$',
      rows: {
        compose: { monthly: 23.59, locations: ['nbg1'] },
        'compose-ha': { monthly: 47.18, locations: ['nbg1', 'fsn1'] },
        k8s: { monthly: 65.61, locations: ['nbg1'] },
        'k8s-ha': { monthly: 107.64, locations: ['nbg1', 'fsn1'] },
      },
    },
    {
      id: 'scaleway',
      label: 'Scaleway',
      currency: '€',
      rows: {
        compose: { monthly: 21.84, locations: ['fr-par-1'] },
        'compose-ha': { monthly: 43.68, locations: ['fr-par-1', 'nl-ams-1'] },
        k8s: 'unsupported' as const,
        'k8s-ha': 'unsupported' as const,
      },
    },
  ],
  storage: { hetzner: '$7.99', scaleway: 'usage-based (cents at this size)' },
};

describe('renderCostGrid', () => {
  it('renders the Hetzner row', () => {
    expect(renderCostGrid(fixture)).toContain(
      '| Hetzner (USD account) | $23.59 (nbg1) | $47.18 (nbg1 + fsn1) | $65.61 (nbg1) | $107.64 (nbg1 + fsn1) |',
    );
    expect(renderCostGrid(fixture)).toContain(
      '| Scaleway | €21.84 (fr-par-1) | €43.68 (fr-par-1 + nl-ams-1) | not yet | not yet |',
    );
  });

  it('copy rules: no em dash, no "free" near servers, dated', () => {
    const md = renderCostGrid(fixture);
    expect(md).not.toMatch(/—/);
    expect(md).not.toMatch(/\bfree\b(\W+\w+){0,3}\W+(server|infrastructure|deploy)/i);
    expect(md).toMatch(/on 22 October 2026/);
  });

  it('whole amounts drop the cents, as the providers list them', () => {
    const md = renderCostGrid({
      date: '22 October 2026',
      providers: [
        {
          id: 'vultr',
          label: 'Vultr',
          currency: '$',
          rows: {
            compose: { monthly: 20, locations: ['ewr'] },
            'compose-ha': { monthly: 40, locations: ['ewr', 'ord'] },
            k8s: 'unsupported',
            'k8s-ha': 'unsupported',
          },
        },
      ],
      storage: { vultr: '$18' },
    });
    expect(md).toContain('| Vultr | $20 (ewr) | $40 (ewr + ord) | not yet | not yet |');
  });

  it('names the account currency in the footnote', () => {
    expect(renderCostGrid(fixture)).toMatch(/Hetzner bills this account in USD/);
    const eur = {
      ...fixture,
      providers: [{ ...fixture.providers[0], label: 'Hetzner (EUR account)', currency: '€' }],
    };
    expect(renderCostGrid(eur)).toMatch(/Hetzner bills this account in EUR/);
  });
});

describe('replaceSection', () => {
  it('--write replaces only the marked section', () => {
    const readme = 'before\n<!-- BEGIN:cost-grid -->\nold\n<!-- END:cost-grid -->\nafter\n';
    expect(replaceSection(readme, 'new')).toBe(
      'before\n<!-- BEGIN:cost-grid -->\nnew\n<!-- END:cost-grid -->\nafter\n',
    );
  });

  it('refuses a README without the markers', () => {
    expect(() => replaceSection('no markers here\n', 'new')).toThrow(/cost-grid/);
  });
});

describe('on the 2026-10-22 catalogs', () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
  });

  const EXPECTED = [
    [
      HetznerProvider,
      'hetzner',
      '| Hetzner (USD account) | $23.59 (nbg1) | $47.18 (nbg1 + fsn1) | $65.61 (nbg1) | $107.64 (nbg1 + fsn1) |',
    ],
    [
      DigitalOceanProvider,
      'digitalocean',
      '| DigitalOcean | $24 (nyc3) | $48 (nyc3 + tor1) | $61 (nyc3) | $98 (nyc3 + tor1) |',
    ],
    [VultrProvider, 'vultr', '| Vultr | $20 (ewr) | $40 (ewr + ord) | not yet | not yet |'],
    [
      LinodeProvider,
      'linode',
      '| Linode | $24 (us-iad) | $48 (us-iad + us-ord) | not yet | not yet |',
    ],
    [
      ScalewayProvider,
      'scaleway',
      '| Scaleway | €21.84 (fr-par-1) | €43.68 (fr-par-1 + nl-ams-1) | not yet | not yet |',
    ],
  ] as const;

  it('computeEnvMonthly gives the brief grid for every provider and supported mode', () => {
    for (const [Provider, id] of EXPECTED) restores.push(seedCatalog(Provider, `2026-10-22/${id}`));
    expect(computeEnvMonthly(HetznerProvider, 'compose')).toEqual({
      monthly: 23.59,
      locations: ['nbg1'],
    });
    expect(computeEnvMonthly(HetznerProvider, 'compose-ha')).toEqual({
      monthly: 47.18,
      locations: ['nbg1', 'fsn1'],
    });
    expect(computeEnvMonthly(HetznerProvider, 'k8s')).toEqual({
      monthly: 65.61,
      locations: ['nbg1'],
    });
    expect(computeEnvMonthly(HetznerProvider, 'k8s-ha')).toEqual({
      monthly: 107.64,
      locations: ['nbg1', 'fsn1'],
    });
    expect(computeEnvMonthly(DigitalOceanProvider, 'compose')).toEqual({
      monthly: 24,
      locations: ['nyc3'],
    });
    expect(computeEnvMonthly(DigitalOceanProvider, 'compose-ha')).toEqual({
      monthly: 48,
      locations: ['nyc3', 'tor1'],
    });
    expect(computeEnvMonthly(DigitalOceanProvider, 'k8s')).toEqual({
      monthly: 61,
      locations: ['nyc3'],
    });
    expect(computeEnvMonthly(DigitalOceanProvider, 'k8s-ha')).toEqual({
      monthly: 98,
      locations: ['nyc3', 'tor1'],
    });
    expect(computeEnvMonthly(VultrProvider, 'compose')).toEqual({
      monthly: 20,
      locations: ['ewr'],
    });
    expect(computeEnvMonthly(VultrProvider, 'compose-ha')).toEqual({
      monthly: 40,
      locations: ['ewr', 'ord'],
    });
    expect(computeEnvMonthly(LinodeProvider, 'compose')).toEqual({
      monthly: 24,
      locations: ['us-iad'],
    });
    expect(computeEnvMonthly(LinodeProvider, 'compose-ha')).toEqual({
      monthly: 48,
      locations: ['us-iad', 'us-ord'],
    });
    expect(computeEnvMonthly(ScalewayProvider, 'compose')).toEqual({
      monthly: 21.84,
      locations: ['fr-par-1'],
    });
    expect(computeEnvMonthly(ScalewayProvider, 'compose-ha')).toEqual({
      monthly: 43.68,
      locations: ['fr-par-1', 'nl-ams-1'],
    });
  });

  it('the rendered grid has every expected row, unsupported modes as "not yet"', () => {
    for (const [Provider, id] of EXPECTED) restores.push(seedCatalog(Provider, `2026-10-22/${id}`));
    const md = renderCostGrid({
      date: '22 October 2026',
      providers: EXPECTED.map(([Provider]) => providerEntry(Provider)),
      storage: Object.fromEntries(EXPECTED.map(([Provider, id]) => [id, storageLine(Provider)])),
    });
    for (const [, , row] of EXPECTED) expect(md).toContain(row);
    expect(md).toContain(
      'Hetzner $7.99 (this USD account; €6.49 on EUR accounts), DigitalOcean $5, Vultr $18, Linode $5, Scaleway usage-based (cents at this size)',
    );
  });

  it('a EUR Hetzner account is labelled and priced in EUR, never as USD', () => {
    restores.push(
      seedCatalog(HetznerProvider, '2026-10-22/hetzner', { pricing: 'hetzner-pricing-eur' }),
    );
    const entry = providerEntry(HetznerProvider);
    expect(entry.label).toBe('Hetzner (EUR account)');
    expect(entry.currency).toBe('€');
    expect(storageLine(HetznerProvider)).toBe('€6.49 (this EUR account; $7.99 on USD accounts)');
  });

  it('the primary is the location the wizard pre-selects, the standby its default partner', () => {
    // nbg1 loses cpx22: the wizard moves a new compose project to fsn1 and
    // pairs it with nbg1's next partner, and the grid follows.
    restores.push(
      seedCatalog(HetznerProvider, '2026-10-22/hetzner', { drop: { nbg1: ['cpx22'] } }),
    );
    expect(computeEnvMonthly(HetznerProvider, 'compose').locations).toEqual(['fsn1']);
    expect(computeEnvMonthly(HetznerProvider, 'compose-ha').locations[0]).toBe('fsn1');
    expect(computeEnvMonthly(HetznerProvider, 'compose-ha').locations[1]).not.toBe('fsn1');
  });
});

describe('billing extras', () => {
  it('every declared extra names its source and the date it was checked', () => {
    for (const [provider, extras] of Object.entries(BILLING_EXTRAS)) {
      for (const [name, extra] of Object.entries(extras as Record<string, unknown>)) {
        expect(extra, `${provider}.${name}`).toMatchObject({
          source: expect.stringMatching(/^https:\/\//),
          checked: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        });
      }
    }
  });

  it('reads the Hetzner floating IP and volume prices from /v1/pricing', () => {
    const extras = parseHetznerExtras({
      pricing: {
        currency: 'USD',
        floating_ips: [
          {
            type: 'ipv4',
            prices: [{ location: 'nbg1', price_monthly: { net: '3.5000', gross: '4.1650' } }],
          },
        ],
        volume: { price_per_gb_month: { net: '0.0767', gross: '0.0913' } },
      },
    });
    expect(extras).toEqual({ floatingIpMonthly: { nbg1: 3.5 }, volumePerGbMonthly: 0.0767 });
    expect(parseHetznerExtras(readCatalogFixture('hetzner-pricing-eur'))).toEqual({
      floatingIpMonthly: null,
      volumePerGbMonthly: null,
    });
    expect(parseHetznerExtras(null)).toEqual({ floatingIpMonthly: null, volumePerGbMonthly: null });
  });
});
