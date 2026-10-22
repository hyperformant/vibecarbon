#!/usr/bin/env node
/**
 * The README's "What it costs to run" grid: the monthly bill for one
 * environment, per provider and deploy mode, at the sizes and locations a new
 * project gets by default.
 *
 * Usage:
 *   node scripts/cost-grid.js          print the section's markdown
 *   node scripts/cost-grid.js --write  replace README.md's cost-grid section
 *
 * Reads each provider's live catalog with read-only GETs (fetchServerTypes,
 * plus Hetzner's /v1/pricing for the floating IP and volume prices). Hetzner
 * and DigitalOcean need their token in the environment (HETZNER_API_TOKEN,
 * DIGITALOCEAN_API_TOKEN) and are skipped with a one-line note without it;
 * the Vultr, Linode and Scaleway catalogs are public.
 *
 * Every location comes from the functions the deploy wizard uses
 * (cheapestDefaultRegion for the primary, getDefaultStandbyRegion for an HA
 * standby), so the grid always shows what a new customer is offered.
 * Refresh it with --write before a release that changes default sizes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROVIDERS } from '../src/lib/providers/index.js';
import {
  cheapestDefaultRegion,
  cheapestRoleSet,
  formatMonthly,
  ipv4MonthlyAt,
  rankStandbyLocations,
} from '../src/lib/sizing.js';

/** Deploy modes, in grid column order. */
export const MODES = ['compose', 'compose-ha', 'k8s', 'k8s-ha'];

/** Providers, in grid row order. */
export const PROVIDER_ORDER = ['hetzner', 'digitalocean', 'vultr', 'linode', 'scaleway'];

/**
 * Billing extras beyond servers and their billed IPv4 (which the providers
 * state, ipv4MonthlyAt), declared once here with where each price was read.
 * Hetzner's floating IP and volume prices are read live from /v1/pricing when
 * the token is present (parseHetznerExtras); these values are the fallback.
 * What each environment bills: docs/superpowers/plans/2026-10-20-cost-grid-sources.md.
 */
export const BILLING_EXTRAS = {
  hetzner: {
    // The k8s ingress floating IPv4, one per cluster.
    floatingIp: {
      monthly: 3.5,
      source: 'https://api.hetzner.cloud/v1/pricing',
      checked: '2026-10-22',
    },
    // The db PVC (10Gi on hcloud-volumes) bills as an 11 GB volume, one per cluster.
    volume: {
      perGbMonthly: 0.0767,
      gb: 11,
      source: 'https://api.hetzner.cloud/v1/pricing',
      checked: '2026-10-22',
    },
    // Base price, by the account's billing currency.
    objectStorage: {
      byCurrency: { USD: 7.99, EUR: 6.49 },
      source: 'https://www.hetzner.com/storage/object-storage',
      checked: '2026-10-22',
    },
  },
  digitalocean: {
    // The db PVC, 10 GiB on do-block-storage, one per cluster.
    volume: {
      perGbMonthly: 0.1,
      gb: 10,
      source: 'https://docs.digitalocean.com/products/volumes/details/pricing/',
      checked: '2026-10-22',
    },
    // The ingress reserved IP: no charge while assigned.
    reservedIp: {
      monthly: 0,
      source: 'https://docs.digitalocean.com/products/networking/reserved-ips/details/pricing/',
      checked: '2026-10-22',
    },
    objectStorage: {
      text: '$5',
      source: 'https://docs.digitalocean.com/products/spaces/details/pricing/',
      checked: '2026-10-22',
    },
  },
  vultr: {
    objectStorage: {
      text: '$18',
      source: 'https://api.vultr.com/v2/object-storage/tiers',
      checked: '2026-10-22',
    },
  },
  linode: {
    objectStorage: {
      text: '$5',
      source: 'https://api.linode.com/v4/object-storage/types',
      checked: '2026-10-22',
    },
  },
  scaleway: {
    // The 40 GB SBS root volume every compose server boots from.
    rootVolume: {
      perGbHour: 0.000118,
      gb: 40,
      hoursPerMonth: 730,
      source: 'https://www.scaleway.com/en/pricing/storage/',
      checked: '2026-10-22',
    },
    objectStorage: {
      text: 'usage-based (cents at this size)',
      source: 'https://www.scaleway.com/en/pricing/storage/',
      checked: '2026-10-20',
    },
  },
};

const PROVIDER_ID = new Map(Object.entries(PROVIDERS).map(([id, P]) => [P, id]));

function providerId(Provider) {
  const id = PROVIDER_ID.get(Provider);
  if (!id) throw new Error(`cost-grid: ${Provider.NAME} is not a registered provider`);
  return id;
}

/** The currency symbol the CLI prints for `Provider` (formatMonthly's, without the amount). */
function currencySymbol(Provider) {
  return formatMonthly(Provider, 0).slice(0, -'0.00'.length);
}

/** `$` as USD, `€` as EUR, any other symbol as the code it carries. */
function currencyCode(symbol) {
  return { $: 'USD', '€': 'EUR' }[symbol] ?? symbol.trim();
}

/**
 * The Hetzner floating IP and volume prices from a `/v1/pricing` body. Either
 * is null when the body does not state it, and the declared table stands.
 *
 * @param {unknown} payload
 * @returns {{floatingIpMonthly: Record<string, number>|null, volumePerGbMonthly: number|null}}
 */
export function parseHetznerExtras(payload) {
  const pricing = payload && typeof payload === 'object' ? payload.pricing : null;
  const ipv4 = Array.isArray(pricing?.floating_ips)
    ? pricing.floating_ips.find((ip) => ip?.type === 'ipv4')
    : null;
  let floatingIpMonthly = null;
  for (const entry of ipv4?.prices ?? []) {
    const monthly = Number(entry?.price_monthly?.net);
    if (!entry?.location || !Number.isFinite(monthly)) continue;
    floatingIpMonthly = { ...floatingIpMonthly, [entry.location]: monthly };
  }
  const perGb = Number(pricing?.volume?.price_per_gb_month?.net);
  return {
    floatingIpMonthly,
    volumePerGbMonthly: pricing?.volume && Number.isFinite(perGb) ? perGb : null,
  };
}

/**
 * The extras `computeEnvMonthly` adds for `Provider`: per k8s cluster (an
 * ingress IP and the db volume) and per server (a root volume). `live` is
 * what parseHetznerExtras read, where it read anything.
 *
 * @param {object} Provider
 * @param {{floatingIpMonthly?: Record<string, number>|null, volumePerGbMonthly?: number|null}} [live]
 * @returns {{perCluster: (location: string) => number, perServer: number}}
 */
export function extrasFor(Provider, live = {}) {
  const id = providerId(Provider);
  const table = BILLING_EXTRAS[id] ?? {};
  if (id === 'hetzner') {
    const perGb = live.volumePerGbMonthly ?? table.volume.perGbMonthly;
    return {
      perCluster: (location) =>
        (live.floatingIpMonthly?.[location] ?? table.floatingIp.monthly) + perGb * table.volume.gb,
      perServer: 0,
    };
  }
  if (id === 'digitalocean') {
    return {
      perCluster: () => table.reservedIp.monthly + table.volume.perGbMonthly * table.volume.gb,
      perServer: 0,
    };
  }
  if (id === 'scaleway') {
    const root = table.rootVolume;
    return { perCluster: () => 0, perServer: root.perGbHour * root.gb * root.hoursPerMonth };
  }
  return { perCluster: () => 0, perServer: 0 };
}

/** Servers plus billed IPv4, unrounded, through priceFor and ipv4MonthlyAt. */
function setMonthly(Provider, location, types, mode) {
  const ipv4 = ipv4MonthlyAt(Provider, location);
  let total = 0;
  for (const type of Object.values(types)) {
    const price = Provider.priceFor(type, location);
    if (price === null || ipv4 === null) {
      throw new Error(
        `cost-grid: ${Provider.NAME} ${mode} has no price for ${type} in ${location}`,
      );
    }
    total += price + ipv4;
  }
  return total;
}

/**
 * The monthly bill for one environment of `mode` on `Provider`, at the
 * location a new project pre-selects and, for HA, its default standby
 * partner, with each set's types as the wizard resolves them. Needs a loaded
 * catalog (fetchServerTypes, or seedCatalog in tests). Sums unrounded prices
 * and rounds to cents once, at the end.
 *
 * @param {object} Provider - a provider class
 * @param {string} mode - compose, compose-ha, k8s or k8s-ha
 * @param {ReturnType<typeof extrasFor>} [extras]
 * @returns {{monthly: number, locations: string[]}}
 */
export function computeEnvMonthly(Provider, mode, extras = extrasFor(Provider)) {
  if (!Provider.SUPPORTED_TIERS.includes(mode)) {
    throw new Error(`cost-grid: ${Provider.NAME} does not support ${mode}`);
  }
  const k8s = mode.startsWith('k8s');
  const roles = k8s ? ['master', 'db', 'worker'] : ['compose'];
  const primary = cheapestDefaultRegion(Provider, roles);
  const set = cheapestRoleSet(Provider, primary, roles);
  if (!set) throw new Error(`cost-grid: ${Provider.NAME} ${mode} is not orderable in ${primary}`);
  const cluster = (location) => (k8s ? extras.perCluster(location) : 0);
  let monthly =
    setMonthly(Provider, primary, set.types, mode) +
    cluster(primary) +
    roles.length * extras.perServer;
  const locations = [primary];

  if (mode.endsWith('-ha')) {
    // The k8s-ha pilot-light standby places a master and a db, no worker.
    const standbyRoles = k8s ? ['master', 'db'] : ['compose'];
    const primaryTypes = Object.fromEntries(standbyRoles.map((r) => [r, set.types[r]]));
    const standby = Provider.getDefaultStandbyRegion(primary, standbyRoles, primaryTypes);
    const placed = rankStandbyLocations(Provider, [standby], standbyRoles, primaryTypes)[0];
    if (!placed) {
      throw new Error(`cost-grid: ${Provider.NAME} ${mode} standby is not orderable in ${standby}`);
    }
    monthly +=
      setMonthly(Provider, standby, placed.types, mode) +
      cluster(standby) +
      standbyRoles.length * extras.perServer;
    locations.push(standby);
  }
  return { monthly: Math.round(monthly * 100) / 100, locations };
}

/**
 * One provider's grid row: its label, currency and every mode, unsupported
 * modes as 'unsupported'. Hetzner's label names the account's billing
 * currency, read with the catalog.
 *
 * @param {object} Provider
 * @param {ReturnType<typeof extrasFor>} [extras]
 */
export function providerEntry(Provider, extras = extrasFor(Provider)) {
  const id = providerId(Provider);
  const currency = currencySymbol(Provider);
  const label = id === 'hetzner' ? `Hetzner (${currencyCode(currency)} account)` : Provider.NAME;
  const rows = Object.fromEntries(
    MODES.map((mode) => [
      mode,
      Provider.SUPPORTED_TIERS.includes(mode)
        ? computeEnvMonthly(Provider, mode, extras)
        : 'unsupported',
    ]),
  );
  return { id, label, currency, rows };
}

/**
 * The object storage price for `Provider`'s line under the grid. Hetzner's is
 * in the account's billing currency, with the other currency's price beside it.
 */
export function storageLine(Provider) {
  const id = providerId(Provider);
  const table = BILLING_EXTRAS[id].objectStorage;
  if (id !== 'hetzner') return table.text;
  const code = currencyCode(currencySymbol(Provider));
  const { USD, EUR } = table.byCurrency;
  if (code === 'EUR')
    return `€${EUR.toFixed(2)} (this EUR account; $${USD.toFixed(2)} on USD accounts)`;
  return `$${USD.toFixed(2)} (this USD account; €${EUR.toFixed(2)} on EUR accounts)`;
}

function money(currency, monthly) {
  return Number.isInteger(monthly) ? `${currency}${monthly}` : `${currency}${monthly.toFixed(2)}`;
}

const NAMES = {
  hetzner: 'Hetzner',
  digitalocean: 'DigitalOcean',
  vultr: 'Vultr',
  linode: 'Linode',
  scaleway: 'Scaleway',
};

/**
 * The section's markdown: the intro, what each mode runs, the grid, the
 * object storage line and the footnote. Pure.
 *
 * @param {{providers: Array<{id: string, label: string, currency: string, rows: Record<string, {monthly: number, locations: string[]}|'unsupported'>}>, date: string, storage: Record<string, string>}} grid
 * @returns {string}
 */
export function renderCostGrid({ providers, date, storage }) {
  const cell = (provider, mode) => {
    const row = provider.rows[mode];
    if (!row || row === 'unsupported') return 'not yet';
    return `${money(provider.currency, row.monthly)} (${row.locations.join(' + ')})`;
  };
  const gridRows = providers.map(
    (p) => `| ${p.label} | ${MODES.map((mode) => cell(p, mode)).join(' | ')} |`,
  );
  const storageParts = providers
    .filter((p) => storage[p.id])
    .map((p) => `${NAMES[p.id] ?? p.label} ${storage[p.id]}`);
  const hetzner = providers.find((p) => p.id === 'hetzner');

  const footnote = [
    `Prices and availability from each provider's API on ${date}, excluding VAT.`,
    'Each server has at least twice its measured peak RAM, and compose servers never go below 4 GB.',
    "Totals include billed public IPv4 (Hetzner, Scaleway), the k8s ingress IP and database volume, and Scaleway's 40 GB root volume.",
    "The region in a cell is where a new project deploys by default, the cheapest location on the provider's home continent; HA standbys sit in a second location on the same continent.",
    'Peak RAM was measured on Hetzner with the observability add-on running, so a default install uses less.',
  ];
  if (hetzner) {
    const code = currencyCode(hetzner.currency);
    const other = code === 'EUR' ? 'USD' : 'EUR';
    footnote.push(
      `Hetzner bills this account in ${code}; ${other} accounts are billed in ${other}.`,
      "Hetzner's cheaper cx23 comes and goes from stock in the EU, and new deploys pick it automatically when it is in stock.",
    );
  }

  return [
    'You pay your cloud provider directly, and vibecarbon starts every new project on the cheapest servers you can order today that fit the measured load. This is the monthly bill for one environment at those default sizes.',
    '',
    '**What each mode runs**',
    '',
    '| Mode | Servers | Peak RAM used per server |',
    '|---|---|---|',
    '| compose | 1 | 1.10 GB |',
    '| compose-ha | 2 (primary + standby in a second location) | 1.25 GB |',
    '| k8s | 3 (master, database, worker) | 1.49 GB master, 0.64 GB database, 1.05 GB worker |',
    '| k8s-ha | 5 (3 primary + 2 standby in a second location) | 1.56 GB master, 0.66 GB database |',
    '',
    '**Monthly cost per environment**',
    '',
    `| Provider | ${MODES.join(' | ')} |`,
    `|---|${MODES.map(() => '---').join('|')}|`,
    ...gridRows,
    '',
    `Plus object storage for backups and uploads, billed once per provider account and shared by every project on it: ${storageParts.join(', ')}.`,
    '',
    `<sub>${footnote.join(' ')}</sub>`,
  ].join('\n');
}

const BEGIN = '<!-- BEGIN:cost-grid -->';
const END = '<!-- END:cost-grid -->';

/**
 * `readme` with the text between the cost-grid markers replaced by `section`.
 * Throws when the markers are missing or out of order.
 */
export function replaceSection(readme, section) {
  const start = readme.indexOf(BEGIN);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`cost-grid: README has no ${BEGIN} ... ${END} section`);
  }
  return `${readme.slice(0, start + BEGIN.length)}\n${section}\n${readme.slice(end)}`;
}

/** Today as the footnote writes it, e.g. `22 October 2026` (UTC). */
function today() {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date());
}

/** Read Hetzner's /v1/pricing for the extras; null fields when it can't be read. */
async function fetchHetznerExtras(Provider, token) {
  try {
    const response = await fetch(`${Provider.API_BASE}/pricing`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return parseHetznerExtras(response.ok ? await response.json() : null);
  } catch {
    return parseHetznerExtras(null);
  }
}

/**
 * Load every provider's live catalog and render the section. Writes notes
 * (skipped providers, fallbacks) to `log`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {(line: string) => void} log
 */
export async function buildGrid(env, log) {
  const providers = [];
  const storage = {};
  for (const id of PROVIDER_ORDER) {
    const Provider = PROVIDERS[id];
    const token = env[Provider.TOKEN_ENV];
    const needsToken = id === 'hetzner' || id === 'digitalocean';
    if (needsToken && !token) {
      log(`skipped ${id}: ${Provider.TOKEN_ENV} is not set`);
      continue;
    }
    if (!(await Provider.fetchServerTypes(token))) {
      throw new Error(`cost-grid: ${Provider.NAME}'s live catalog could not be read`);
    }
    let extras = extrasFor(Provider);
    if (id === 'hetzner') {
      const live = await fetchHetznerExtras(Provider, token);
      if (live.floatingIpMonthly === null || live.volumePerGbMonthly === null) {
        log(
          `hetzner: /v1/pricing gave no floating IP or volume price; using the table checked ${BILLING_EXTRAS.hetzner.volume.checked}`,
        );
      }
      extras = extrasFor(Provider, live);
    }
    providers.push(providerEntry(Provider, extras));
    storage[id] = storageLine(Provider);
  }
  if (providers.length === 0) throw new Error('cost-grid: no provider could be priced');
  return renderCostGrid({ providers, date: today(), storage });
}

/** The CLI: print the section, or with --write replace it in README.md. */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const section = await buildGrid(env, (line) => console.error(line));
  if (!argv.includes('--write')) {
    console.log(section);
    return;
  }
  const readmePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md');
  writeFileSync(readmePath, replaceSection(readFileSync(readmePath, 'utf8'), section));
  console.error('updated README.md');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
