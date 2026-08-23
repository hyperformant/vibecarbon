/**
 * Unit tests for the checked-in perf-data layer (docs/perf-data.json) and
 * the surfaces rendered from it.
 *
 * Architecture (2026-08 unified super-table): a green CI run no longer
 * patches README per provider straight from its own db. Instead it merges
 * that provider's numbers into ONE checked-in JSON
 * (`updatePerfDataFromRun`), and every published surface — the unified
 * README table, the inline headline markers, the marketing component's
 * data file — re-renders as a pure function of that JSON. That is what
 * lets a single-provider run refresh a table that shows ALL providers.
 *
 * All tests run against real temp files / in-memory SQLite (`:memory:`) —
 * no fs mocks (repo convention).
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2EDb } from '../../e2e/metrics/db.js';
import {
  collectProviderRunData,
  loadPerfData,
  type PerfData,
  patchInlinePerfMarkers,
  patchReadmeUnifiedPerfTable,
  renderUnifiedPerfTableMd,
  serializePerfData,
  syncCarbonPerfData,
  UNIFIED_PERF_TABLE_MARKERS,
  updatePerfDataFromRun,
} from '../../e2e/metrics/perf-data.js';

// ---------------------------------------------------------------------------
// Test helpers (mirrors perf-table.test.ts's seeding conventions)
// ---------------------------------------------------------------------------

const HETZNER_MODES = ['compose', 'compose-ha', 'k8s', 'k8s-ha'] as const;
const DO_MODES = ['compose', 'compose-ha', 'k8s'] as const;
const CURATED_STEPS = ['deploy', 'warm-deploy', 'backup', 'restore', 'scale', 'destroy'] as const;

function createTestRun(db: E2EDb): string {
  const runId = randomUUID();
  db.createRun({
    id: runId,
    gitSha: 'deadbee',
    gitBranch: 'main',
    vibecarbonVersion: '0.0.0',
    machineInfo: {},
  });
  return runId;
}

function seedScenario(
  db: E2EDb,
  runId: string,
  provider: string,
  mode: string,
  opts: {
    status?: string;
    stepDurationMs?: Partial<Record<string, number>>;
    stepStatus?: Partial<Record<string, string>>;
    missingSteps?: Set<string>;
  } = {},
): void {
  const scenarioId = randomUUID();
  db.createScenario({
    id: scenarioId,
    runId,
    mode,
    dnsProvider: 'manual',
    domain: `${mode}.example.test`,
    features: [],
    projectName: `${provider}-${mode}`,
    envPrefix: 'e1',
    provider,
  });

  for (const step of CURATED_STEPS) {
    if (opts.missingSteps?.has(step)) continue;
    const stepId = randomUUID();
    db.createStep({ id: stepId, scenarioId, name: step, command: step });
    db.startStep(stepId);
    const status = opts.stepStatus?.[step] ?? 'pass';
    const duration = opts.stepDurationMs?.[step] ?? 60_000;
    db.completeStep(stepId, status, duration);
  }

  db.updateScenarioStatus(scenarioId, opts.status ?? 'pass');
}

/** Seed one run with every mode of both Hetzner and DigitalOcean, all green. */
function seedFullGreenRun(
  db: E2EDb,
  opts: { hetznerModes?: readonly string[]; doModes?: readonly string[] } = {},
): { runId: string } {
  const runId = createTestRun(db);
  for (const mode of opts.hetznerModes ?? HETZNER_MODES) seedScenario(db, runId, 'hetzner', mode);
  for (const mode of opts.doModes ?? DO_MODES) seedScenario(db, runId, 'digitalocean', mode);
  db.completeRun(runId, 'pass');
  return { runId };
}

function tempDataPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'vc-perf-data-')), 'perf-data.json');
}

// ---------------------------------------------------------------------------
// loadPerfData / serializePerfData
// ---------------------------------------------------------------------------

describe('loadPerfData', () => {
  it('returns an empty data set when the file does not exist', () => {
    expect(loadPerfData(join(tmpdir(), 'vc-no-such-dir', 'perf-data.json'))).toEqual({
      providers: {},
    });
  });

  it('round-trips through serializePerfData byte-identically', () => {
    const data: PerfData = {
      providers: {
        hetzner: {
          run: { id: 'abc1234', date: '2026-08-13', origin: 'GitHub-hosted runner' },
          scenarios: { compose: { deploy: 282_000, 'warm-deploy': 29_400 } },
        },
      },
    };
    const file = tempDataPath();
    writeFileSync(file, serializePerfData(data));
    expect(loadPerfData(file)).toEqual(data);
    expect(serializePerfData(loadPerfData(file))).toBe(serializePerfData(data));
  });

  it('serializes as 2-space-indented JSON with a trailing newline (biome-stable)', () => {
    const data: PerfData = { providers: {} };
    const out = serializePerfData(data);
    expect(out).toBe('{\n  "providers": {}\n}\n');
  });
});

// ---------------------------------------------------------------------------
// updatePerfDataFromRun
// ---------------------------------------------------------------------------

describe('updatePerfDataFromRun', () => {
  it('writes every full-green provider of the run into the JSON with ms durations + provenance', () => {
    const db = new E2EDb(':memory:');
    const { runId } = seedFullGreenRun(db);
    const file = tempDataPath();

    const result = updatePerfDataFromRun(file, db, runId, { origin: 'GitHub-hosted runner' });
    expect(result.updated.sort()).toEqual(['digitalocean', 'hetzner']);
    expect(result.skipped).toEqual(['linode', 'vultr', 'scaleway']);

    const data = loadPerfData(file);
    expect(Object.keys(data.providers).sort()).toEqual(['digitalocean', 'hetzner']);
    expect(data.providers.hetzner.run).toMatchObject({
      id: runId.slice(0, 7),
      origin: 'GitHub-hosted runner',
    });
    expect(data.providers.hetzner.run.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // registry mode lists, raw ms values
    expect(Object.keys(data.providers.hetzner.scenarios)).toEqual([...HETZNER_MODES]);
    expect(Object.keys(data.providers.digitalocean.scenarios)).toEqual([...DO_MODES]);
    expect(data.providers.hetzner.scenarios.compose.deploy).toBe(60_000);
    db.close();
  });

  it('preserves other providers already in the JSON when a single-provider run updates', () => {
    const db = new E2EDb(':memory:');
    const runId = createTestRun(db);
    for (const mode of HETZNER_MODES) seedScenario(db, runId, 'hetzner', mode);
    db.completeRun(runId, 'pass');

    const file = tempDataPath();
    const existing: PerfData = {
      providers: {
        vultr: {
          run: { id: 'vvvvvvv', date: '2026-08-12' },
          scenarios: { compose: { deploy: 403_000 } },
        },
      },
    };
    writeFileSync(file, serializePerfData(existing));

    const result = updatePerfDataFromRun(file, db, runId);
    expect(result.updated).toEqual(['hetzner']);

    const data = loadPerfData(file);
    expect(data.providers.vultr).toEqual(existing.providers.vultr);
    expect(data.providers.hetzner.scenarios.compose.deploy).toBe(60_000);
    db.close();
  });

  it('skips a provider with partial registry coverage, leaving its existing entry untouched', () => {
    const db = new E2EDb(':memory:');
    const runId = createTestRun(db);
    for (const mode of ['compose', 'compose-ha', 'k8s']) seedScenario(db, runId, 'hetzner', mode); // no k8s-ha
    db.completeRun(runId, 'pass');

    const file = tempDataPath();
    const existing: PerfData = {
      providers: {
        hetzner: {
          run: { id: 'hhhhhhh', date: '2026-08-01' },
          scenarios: { compose: { deploy: 111_000 } },
        },
      },
    };
    writeFileSync(file, serializePerfData(existing));

    const result = updatePerfDataFromRun(file, db, runId);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toContain('hetzner');
    expect(loadPerfData(file)).toEqual(existing);
    db.close();
  });

  it('skips a provider when any of its scenarios is not green', () => {
    const db = new E2EDb(':memory:');
    const runId = createTestRun(db);
    for (const mode of HETZNER_MODES) {
      seedScenario(db, runId, 'hetzner', mode, mode === 'k8s' ? { status: 'fail' } : {});
    }
    db.completeRun(runId, 'fail');
    const file = tempDataPath();

    const result = updatePerfDataFromRun(file, db, runId);
    expect(result.updated).toEqual([]);
    db.close();
  });

  it('accepts pass_after_retry as green but omits non-green step cells from the entry', () => {
    const db = new E2EDb(':memory:');
    const runId = createTestRun(db);
    seedScenario(db, runId, 'hetzner', 'compose', {
      status: 'pass_after_retry',
      stepStatus: { backup: 'fail' },
      missingSteps: new Set(['scale']),
    });
    for (const mode of ['compose-ha', 'k8s', 'k8s-ha']) seedScenario(db, runId, 'hetzner', mode);
    db.completeRun(runId, 'pass');
    const file = tempDataPath();

    const result = updatePerfDataFromRun(file, db, runId);
    expect(result.updated).toEqual(['hetzner']);
    const compose = loadPerfData(file).providers.hetzner.scenarios.compose;
    expect(compose.deploy).toBe(60_000);
    expect(compose.backup).toBeUndefined();
    expect(compose.scale).toBeUndefined();
    db.close();
  });

  it('opts.excludeProviders vetoes a full-green provider (anomaly-guard wiring)', () => {
    const db = new E2EDb(':memory:');
    const { runId } = seedFullGreenRun(db);
    const file = tempDataPath();

    const result = updatePerfDataFromRun(file, db, runId, { excludeProviders: ['hetzner'] });
    expect(result.updated).toEqual(['digitalocean']);
    expect(result.skipped).toContain('hetzner');
    expect(loadPerfData(file).providers.hetzner).toBeUndefined();
    db.close();
  });

  it('does not touch the file when nothing in the run is green', () => {
    const db = new E2EDb(':memory:');
    const runId = createTestRun(db);
    seedScenario(db, runId, 'hetzner', 'compose', { status: 'fail' });
    db.completeRun(runId, 'fail');

    const file = tempDataPath();
    const existing: PerfData = { providers: {} };
    writeFileSync(file, serializePerfData(existing));
    const before = readFileSync(file, 'utf8');

    const result = updatePerfDataFromRun(file, db, runId);
    expect(result.updated).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    db.close();
  });

  it('is deterministic — same run merged twice yields byte-identical files', () => {
    const db = new E2EDb(':memory:');
    const { runId } = seedFullGreenRun(db);
    const fileA = tempDataPath();
    const fileB = tempDataPath();
    updatePerfDataFromRun(fileA, db, runId, { origin: 'GitHub-hosted runner' });
    updatePerfDataFromRun(fileB, db, runId, { origin: 'GitHub-hosted runner' });
    expect(readFileSync(fileA, 'utf8')).toBe(readFileSync(fileB, 'utf8'));
    db.close();
  });
});

// ---------------------------------------------------------------------------
// renderUnifiedPerfTableMd
// ---------------------------------------------------------------------------

/** Two measured providers (Hetzner full, Vultr compose); DO/Linode/Scaleway pending. */
function fixtureData(): PerfData {
  const steps = (deploy: number) => ({
    deploy,
    'warm-deploy': 29_400,
    backup: 13_300,
    restore: 296_000,
    scale: 281_000,
    destroy: 39_400,
  });
  return {
    providers: {
      hetzner: {
        run: { id: 'abc1234', date: '2026-08-13', origin: 'GitHub-hosted runner' },
        scenarios: {
          compose: steps(282_000),
          'compose-ha': steps(376_000),
          k8s: steps(513_000),
          'k8s-ha': steps(556_000),
        },
      },
      vultr: {
        run: { id: 'def5678', date: '2026-08-12', origin: 'GitHub-hosted runner' },
        scenarios: { compose: steps(403_000) },
      },
    },
  };
}

describe('renderUnifiedPerfTableMd', () => {
  it('renders CLI-command column headers', () => {
    const md = renderUnifiedPerfTableMd(fixtureData());
    expect(md.split('\n')[0]).toBe(
      '| Provider | Scenario | Cold `deploy` | Warm `deploy` | `backup` | `restore` | `scale` | `destroy` | `failover` |',
    );
  });

  it("groups rows by provider in registry order, then that provider's scenarios — exact row layout", () => {
    // Deliberate exact-value pin (provider-expected.ts doctrine): each new
    // provider or tier-parity expansion updates this list consciously.
    const md = renderUnifiedPerfTableMd(fixtureData());
    const firstTwoCells = md
      .split('\n')
      .filter((l) => l.startsWith('|') && !l.startsWith('| :') && !l.startsWith('| Provider'))
      .map((l) => {
        const cells = l.split('|').map((c) => c.trim());
        return [cells[1], cells[2]];
      });
    expect(firstTwoCells).toEqual([
      ['Hetzner Cloud', '`compose`'],
      ['', '`compose-ha`'],
      ['', '`k8s`'],
      ['', '`k8s-ha`'],
      ['DigitalOcean', '`compose`'],
      ['', '`compose-ha`'],
      ['', '`k8s`'],
      ['Linode', '`compose`'],
      ['', '`compose-ha`'],
      ['Vultr', '`compose`'],
      ['', '`compose-ha`'],
      ['Scaleway', '`compose`'],
      ['', '`compose-ha`'],
    ]);
  });

  it('formats measured cells with formatDuration and fills unmeasured scenarios with _pending_', () => {
    const md = renderUnifiedPerfTableMd(fixtureData());
    const lines = md.split('\n');
    expect(lines).toContain(
      '| Hetzner Cloud | `compose` | 4m 42s | 29.4s | 13.3s | 4m 56s | 4m 41s | 39.4s | — |',
    );
    expect(lines).toContain(
      '| Vultr | `compose` | 6m 43s | 29.4s | 13.3s | 4m 56s | 4m 41s | 39.4s | — |',
    );
    expect(lines).toContain(
      '| Linode | `compose` | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |',
    );
  });

  it('renders an em-dash for a step missing from an otherwise measured scenario', () => {
    const data = fixtureData();
    delete data.providers.vultr.scenarios.compose['warm-deploy'];
    const md = renderUnifiedPerfTableMd(data);
    expect(md.split('\n')).toContain(
      '| Vultr | `compose` | 6m 43s | — | 13.3s | 4m 56s | 4m 41s | 39.4s | — |',
    );
  });

  it('appends a provenance footer naming each measured provider run, shared origin once', () => {
    const md = renderUnifiedPerfTableMd(fixtureData());
    expect(md).toContain(
      '_Latest green CI runs: Hetzner Cloud `abc1234` (2026-08-13) · Vultr `def5678` (2026-08-12) · ' +
        'GitHub-hosted runner · methodology: [docs/tests.md](./docs/tests.md)._',
    );
  });

  it('omits the origin clause when no measured provider carries one', () => {
    const data = fixtureData();
    delete data.providers.hetzner.run.origin;
    delete data.providers.vultr.run.origin;
    const md = renderUnifiedPerfTableMd(data);
    expect(md).toContain(
      '_Latest green CI runs: Hetzner Cloud `abc1234` (2026-08-13) · Vultr `def5678` (2026-08-12) · ' +
        'methodology: [docs/tests.md](./docs/tests.md)._',
    );
  });

  it('omits the footer entirely when the data set is empty (all rows pending)', () => {
    const md = renderUnifiedPerfTableMd({ providers: {} });
    expect(md).not.toContain('Latest green CI runs');
    expect(md).toContain('_pending_');
  });

  it('is deterministic — same data yields byte-identical output', () => {
    expect(renderUnifiedPerfTableMd(fixtureData())).toBe(renderUnifiedPerfTableMd(fixtureData()));
  });
});

// ---------------------------------------------------------------------------
// patchReadmeUnifiedPerfTable
// ---------------------------------------------------------------------------

function makeReadmeFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-perf-readme-'));
  const file = join(dir, 'README.md');
  writeFileSync(file, contents);
  return file;
}

const UNIFIED_SCAFFOLD = `# Vibecarbon

## Performance

Real numbers, not estimates.

${UNIFIED_PERF_TABLE_MARKERS.begin}
_CI baselines pending._
${UNIFIED_PERF_TABLE_MARKERS.end}

## License

FSL-1.1-MIT.
`;

describe('patchReadmeUnifiedPerfTable', () => {
  it('replaces the block content with the rendered table, one blank-free seam per marker', () => {
    const file = makeReadmeFile(UNIFIED_SCAFFOLD);
    const changed = patchReadmeUnifiedPerfTable(file, fixtureData());
    expect(changed).toBe(true);

    const after = readFileSync(file, 'utf8');
    expect(after).toBe(
      UNIFIED_SCAFFOLD.replace(
        `${UNIFIED_PERF_TABLE_MARKERS.begin}\n_CI baselines pending._\n${UNIFIED_PERF_TABLE_MARKERS.end}`,
        `${UNIFIED_PERF_TABLE_MARKERS.begin}\n${renderUnifiedPerfTableMd(fixtureData())}\n${UNIFIED_PERF_TABLE_MARKERS.end}`,
      ),
    );
  });

  it('returns false and leaves the file untouched when the render matches what is on disk', () => {
    const file = makeReadmeFile(UNIFIED_SCAFFOLD);
    patchReadmeUnifiedPerfTable(file, fixtureData());
    const once = readFileSync(file, 'utf8');
    expect(patchReadmeUnifiedPerfTable(file, fixtureData())).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(once);
  });

  it('throws when the README has no unified perf-table markers', () => {
    const file = makeReadmeFile('# Vibecarbon\n\n## Performance\n');
    expect(() => patchReadmeUnifiedPerfTable(file, fixtureData())).toThrow(/marker/i);
  });
});

// ---------------------------------------------------------------------------
// patchInlinePerfMarkers (data-driven)
// ---------------------------------------------------------------------------

describe('patchInlinePerfMarkers', () => {
  it('rewrites inline markers from the data set and reports the keys', () => {
    const file = makeReadmeFile(
      'warm redeploys in seconds (<!-- perf:warm-deploy:hetzner/k8s -->0s<!-- /perf --> k8s / ' +
        '<!-- perf:deploy:vultr/compose -->0s<!-- /perf --> compose)\n',
    );
    const updated = patchInlinePerfMarkers(file, fixtureData());
    expect(updated.sort()).toEqual(['deploy:vultr/compose', 'warm-deploy:hetzner/k8s'].sort());

    const after = readFileSync(file, 'utf8');
    expect(after).toContain('<!-- perf:warm-deploy:hetzner/k8s -->29.4s<!-- /perf -->');
    expect(after).toContain('<!-- perf:deploy:vultr/compose -->6m 43s<!-- /perf -->');
  });

  it('leaves a marker untouched when the data has no value for it', () => {
    const file = makeReadmeFile('<!-- perf:deploy:scaleway/compose -->42s<!-- /perf -->\n');
    expect(patchInlinePerfMarkers(file, fixtureData())).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain(
      '<!-- perf:deploy:scaleway/compose -->42s<!-- /perf -->',
    );
  });
});

// ---------------------------------------------------------------------------
// syncCarbonPerfData
// ---------------------------------------------------------------------------

describe('syncCarbonPerfData', () => {
  it('writes the canonical serialization to the carbon data file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vc-carbon-data-')), 'vendor-matrix-data.json');
    expect(syncCarbonPerfData(file, fixtureData())).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(serializePerfData(fixtureData()));
  });

  it('is a no-op returning false when the file already matches', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vc-carbon-data-')), 'vendor-matrix-data.json');
    syncCarbonPerfData(file, fixtureData());
    expect(syncCarbonPerfData(file, fixtureData())).toBe(false);
  });
});

describe('published numbers prefer the CLI wall over the step wall (2026-08-23)', () => {
  /**
   * The DO k8s warm-deploy "11x outlier" was the harness, not the product:
   * step wall 123.5s, cli.deploy.total 6.2s — the CLI process lingered after
   * completing, and the step wall booked that tail as product latency. The
   * published grid claims to describe what a CUSTOMER experiences, so when a
   * step recorded the CLI's own wall (perf_substep `cli.<cmd>.total`), that
   * number wins; the step wall stays the fallback for steps with no substeps.
   */
  it('uses cli.*.total when present, step wall otherwise', () => {
    const db = new E2EDb(':memory:');
    const runId = createTestRun(db);
    // The collector requires EVERY configured mode green for the provider.
    let warmK8sStepId = '';
    for (const mode of HETZNER_MODES) {
      const scenarioId = randomUUID();
      db.createScenario({
        id: scenarioId,
        runId,
        mode,
        dnsProvider: 'manual',
        domain: `${mode}.example.test`,
        features: [],
        projectName: `hetzner-${mode}`,
        envPrefix: 'e1',
        provider: 'hetzner',
      });
      for (const step of CURATED_STEPS) {
        const stepId = randomUUID();
        db.createStep({ id: stepId, scenarioId, name: step, command: step });
        db.startStep(stepId);
        db.completeStep(stepId, 'pass', 120_000); // inflated step wall
        if (mode === 'k8s' && step === 'warm-deploy') warmK8sStepId = stepId;
      }
      db.updateScenarioStatus(scenarioId, 'pass');
    }
    db.recordPerfSubsteps(warmK8sStepId, [{ name: 'cli.deploy.total', ms: 6_200 }]);
    db.completeRun(runId, 'pass');

    const data = collectProviderRunData(db, runId, 'hetzner', { origin: 'test' });
    expect(data).not.toBeNull();
    const k8s = data?.scenarios.k8s as Record<string, number>;
    expect(k8s['warm-deploy'], 'cli wall must win when recorded').toBe(6_200);
    expect(k8s.deploy, 'steps without substeps keep the step wall').toBe(120_000);
  });
});

describe('failover is a published column (2026-08-23)', () => {
  /**
   * The site's vendor matrix shipped a failover tab typed and waiting
   * ("Not emitted by CI yet" — vendor-matrix.tsx), and the launch rule pins
   * HA/failover claims to the latest green matrix. The emission side was the
   * only missing piece: `failover` was not a curated PERF_TABLE_ROWS step, so
   * green HA runs measured it and the publisher dropped it.
   */
  it('collects the failover step duration for HA modes', () => {
    const db = new E2EDb(':memory:');
    const runId = createTestRun(db);
    for (const mode of HETZNER_MODES) {
      const scenarioId = randomUUID();
      db.createScenario({
        id: scenarioId,
        runId,
        mode,
        dnsProvider: 'manual',
        domain: `${mode}.example.test`,
        features: [],
        projectName: `hetzner-${mode}`,
        envPrefix: 'e1',
        provider: 'hetzner',
      });
      const steps = mode.endsWith('-ha') ? [...CURATED_STEPS, 'failover'] : [...CURATED_STEPS];
      for (const step of steps) {
        const stepId = randomUUID();
        db.createStep({ id: stepId, scenarioId, name: step, command: step });
        db.startStep(stepId);
        db.completeStep(stepId, 'pass', step === 'failover' ? 95_000 : 60_000);
      }
      db.updateScenarioStatus(scenarioId, 'pass');
    }
    db.completeRun(runId, 'pass');

    const data = collectProviderRunData(db, runId, 'hetzner', { origin: 'test' });
    if (!data) throw new Error('expected provider run data');
    expect((data.scenarios['compose-ha'] as Record<string, number>).failover).toBe(95_000);
    expect((data.scenarios['k8s-ha'] as Record<string, number>).failover).toBe(95_000);
    // Non-HA modes simply have no failover cell — never a zero.
    expect((data.scenarios.compose as Record<string, number>).failover).toBeUndefined();
  });
});
