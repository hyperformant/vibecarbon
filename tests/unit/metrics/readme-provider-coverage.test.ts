import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../../config.js';
import {
  loadPerfData,
  renderUnifiedPerfTableMd,
  serializePerfData,
  UNIFIED_PERF_TABLE_MARKERS,
} from '../../e2e/metrics/perf-data.js';

/**
 * Census over every published performance surface — the checked-in data
 * file, the unified README table, and the marketing component — pinned to
 * the provider registry and to the CLI's own tier declarations.
 *
 * The published grid must name every provider vibecarbon supports, not
 * only the ones that happen to have a green CI run: the providers most
 * worth disclosing as unproven are the ones with no numbers yet, and a
 * reader comparing clouds cannot tell "not supported" from "not measured"
 * unless both states are rendered. The unified renderer draws the row set
 * from the registry (measured rows get numbers, unmeasured get _pending_),
 * so what THIS census enforces is that the checked-in artifacts are in
 * sync with each other and with the registry — a registered provider that
 * is missing from any surface, or a surface hand-edited out of sync with
 * docs/perf-data.json, fails at unit time.
 *
 * Concrete escape this closes (2026-08-13, pre-unification): Linode and
 * Scaleway were registered providers with e2e scenarios and no README
 * presence at all — the grid advertised three clouds while the CLI
 * supported five. The marketing component had the same gap for Scaleway.
 */

const ROOT = process.cwd();
const README_PATH = join(ROOT, 'README.md');
const DATA_PATH = join(ROOT, 'docs', 'perf-data.json');
const CARBON_DATA_PATH = join(
  ROOT,
  'carbon',
  'src',
  'client',
  'components',
  'sections',
  'vendor-matrix-data.json',
);
const COMPONENT_PATH = join(
  ROOT,
  'carbon',
  'src',
  'client',
  'components',
  'sections',
  'vendor-matrix.tsx',
);

const PROVIDER_IDS = Object.keys(testConfig.e2e.providers) as Array<
  keyof typeof testConfig.e2e.providers
>;

function readmeBlock(): string {
  const content = readFileSync(README_PATH, 'utf8');
  const { begin, end } = UNIFIED_PERF_TABLE_MARKERS;
  const b = content.indexOf(begin);
  const e = content.indexOf(end);
  expect(b, 'README.md is missing the unified perf-table BEGIN marker').toBeGreaterThan(-1);
  expect(e, 'README.md is missing the unified perf-table END marker').toBeGreaterThan(b);
  return content.slice(b + begin.length, e).trim();
}

describe('checked-in perf data', () => {
  it('names only registered providers, and only their registered scenarios', () => {
    const data = loadPerfData(DATA_PATH);
    for (const [id, entry] of Object.entries(data.providers)) {
      expect(
        PROVIDER_IDS as string[],
        `perf-data.json has unregistered provider "${id}"`,
      ).toContain(id);
      const registryModes = testConfig.e2e.providers[
        id as keyof typeof testConfig.e2e.providers
      ].scenarios.map((s: { mode: string }) => s.mode);
      for (const mode of Object.keys(entry.scenarios)) {
        expect(
          registryModes,
          `perf-data.json ${id} has scenario "${mode}" not in the registry`,
        ).toContain(mode);
      }
    }
  });
});

describe('README unified performance table', () => {
  it('is byte-identical to the renderer output for the checked-in data (no hand drift)', () => {
    expect(readmeBlock()).toBe(renderUnifiedPerfTableMd(loadPerfData(DATA_PATH)));
  });

  it('shows every registered provider exactly once per registered scenario', () => {
    // The renderer guarantees this from the registry; this pins the
    // CHECKED-IN file so a stale README (e.g. committed before a provider
    // registration) fails here rather than shipping a grid that under-
    // advertises coverage. Provider-first grouping blanks the Provider cell
    // on continuation rows (only the group's first row names it), so a row
    // belongs to whichever provider named it most recently, not to every
    // row containing that name.
    const rows = readmeBlock()
      .split('\n')
      .filter((l) => l.startsWith('|') && !l.includes(':---') && !l.includes('| Provider |'));
    const rowCounts = new Map<string, number>();
    let currentDisplay = '';
    for (const row of rows) {
      const providerCell = row.split('|')[1]?.trim() ?? '';
      if (providerCell) currentDisplay = providerCell;
      rowCounts.set(currentDisplay, (rowCounts.get(currentDisplay) ?? 0) + 1);
    }
    for (const id of PROVIDER_IDS) {
      const { displayName, scenarios } = testConfig.e2e.providers[id];
      expect(
        rowCounts.get(displayName) ?? 0,
        `${id}: expected one row per registered scenario`,
      ).toBe(scenarios.length);
    }
  });

  it('never renders an empty cell where a measurement or pending marker belongs', () => {
    // Each data row has scenario + provider + one cell per curated step;
    // every step cell must carry a duration, an em-dash, or _pending_.
    const rows = readmeBlock()
      .split('\n')
      .filter((l) => l.startsWith('|') && !l.includes(':---') && !l.includes('| Provider |'));
    for (const row of rows) {
      const stepCells = row.split('|').slice(3, -1);
      for (const cell of stepCells) {
        expect(cell.trim().length, `empty step cell in row: ${row}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('marketing component data (carbon vendor-matrix)', () => {
  it('carries a byte-identical copy of docs/perf-data.json', () => {
    const carbon = readFileSync(CARBON_DATA_PATH, 'utf8');
    expect(carbon).toBe(serializePerfData(loadPerfData(DATA_PATH)));
  });

  it('the component lists every registered provider', () => {
    const component = readFileSync(COMPONENT_PATH, 'utf8');
    for (const id of PROVIDER_IDS) {
      expect(component, `vendor-matrix.tsx has no provider entry for "${id}"`).toContain(
        `id: '${id}'`,
      );
    }
  });

  it("the component's tier claims match each provider's CLI SUPPORTED_TIERS", () => {
    // The component mirrors src/lib/providers/*.js SUPPORTED_TIERS by hand;
    // this walk is what turns that comment-enforced sync into a test. A
    // tier the CLI supports must claim availability ('yes'/'beta'), and a
    // tier the CLI does not support must not ('no'/'soon' — 'soon' is the
    // honest roadmap chip, not a support claim).
    const component = readFileSync(COMPONENT_PATH, 'utf8');
    const ALL_TIERS = ['compose', 'compose-ha', 'k8s', 'k8s-ha'];

    for (const id of PROVIDER_IDS) {
      const providerJs = readFileSync(join(ROOT, 'src', 'lib', 'providers', `${id}.js`), 'utf8');
      const tiersMatch = /static SUPPORTED_TIERS = \[([^\]]*)\]/.exec(providerJs);
      expect(tiersMatch, `${id}.js: no SUPPORTED_TIERS literal`).not.toBeNull();
      const supported = (tiersMatch as RegExpExecArray)[1]
        .split(',')
        .map((t) => t.trim().replace(/['"]/g, ''))
        .filter(Boolean);

      const entryMatch = new RegExp(`id: '${id}'[\\s\\S]*?tiers: \\{([^}]*)\\}`, 'm').exec(
        component,
      );
      expect(entryMatch, `vendor-matrix.tsx: no tiers literal for "${id}"`).not.toBeNull();
      const tiersLiteral = (entryMatch as RegExpExecArray)[1];

      for (const tier of ALL_TIERS) {
        const cellMatch = new RegExp(`'?${tier}'?:\\s*'([a-z]+)'`).exec(
          tiersLiteral.replace(/"/g, "'"),
        );
        expect(cellMatch, `vendor-matrix.tsx ${id}: no cell for tier "${tier}"`).not.toBeNull();
        const support = (cellMatch as RegExpExecArray)[1];
        if (supported.includes(tier)) {
          expect(
            ['yes', 'beta'],
            `vendor-matrix.tsx ${id}/${tier}: CLI supports this tier but the component renders '${support}'`,
          ).toContain(support);
        } else {
          expect(
            ['no', 'soon'],
            `vendor-matrix.tsx ${id}/${tier}: component claims support the CLI does not declare`,
          ).toContain(support);
        }
      }
    }
  });
});
