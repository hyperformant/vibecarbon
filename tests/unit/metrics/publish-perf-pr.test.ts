/**
 * Unit tests for the perf-table PR collector's pure logic: leg-artifact
 * discovery, per-leg db loading, and the patch-decision delegation to the
 * Task 4 reporter functions. The git/gh publish path (`publishPr`) is
 * deliberately not exported/tested here — it's thin shelling, CI-verified
 * by Task 9's post-landing dispatch (matches the repo's existing convention
 * for the sweep/scrub steps in this same workflow).
 *
 * All fixtures are real files on disk (mkdtempSync + file-backed E2EDb) —
 * no fs mocks, matching repo convention (see perf-table.test.ts). Most legs
 * are a real `e2e-results-<provider>/e2e.db` sqlite file (the ≥2-artifact
 * download layout); the `discoverLegArtifacts > flattened layout` and `C-1`
 * tests below build the OTHER real layout instead — a root-level `e2e.db`
 * with no subdirectory, which is what `actions/download-artifact@v8`
 * actually extracts when exactly one artifact matches (the default
 * single-provider dispatch). See task-8-review.md C-1.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2EDb } from '../../e2e/metrics/db.js';
import {
  loadPerfData,
  type PerfData,
  renderUnifiedPerfTableMd,
  serializePerfData,
} from '../../e2e/metrics/perf-data.js';
import {
  collectAndRender,
  discoverLegArtifacts,
  type SurfacePaths,
  updateLeg,
} from '../../e2e/metrics/publish-perf-pr.js';

// ---------------------------------------------------------------------------
// Test helpers — mirrors tests/unit/metrics/perf-table.test.ts's fixtures,
// scoped to a single provider per leg (a leg's db only ever holds one
// provider's rows in the real topology).
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
    const duration = opts.stepDurationMs?.[step] ?? 60_000;
    db.completeStep(stepId, 'pass', duration);
  }

  db.updateScenarioStatus(scenarioId, opts.status ?? 'pass');
}

/** Create a leg's on-disk db at `<rootDir>/e2e-results-<provider>/e2e.db`. */
function makeLegDb(rootDir: string, provider: string): { dbPath: string; db: E2EDb } {
  const legDir = join(rootDir, `e2e-results-${provider}`);
  mkdirSync(legDir, { recursive: true });
  const dbPath = join(legDir, 'e2e.db');
  return { dbPath, db: new E2EDb(dbPath) };
}

/**
 * Build the three surface files the collector writes, IN SYNC with each
 * other (README's unified block already rendered from `initialData`, the
 * carbon copy byte-identical to the data file) — the committed state of the
 * real repo. Starting in sync is what makes "no green legs → no changed
 * files" a meaningful assertion.
 */
function makeSurfacePaths(initialData: PerfData = { providers: {} }): SurfacePaths {
  const dir = mkdtempSync(join(tmpdir(), 'vc-publish-surfaces-'));
  const dataPath = join(dir, 'perf-data.json');
  writeFileSync(dataPath, serializePerfData(initialData));
  const readmePath = join(dir, 'README.md');
  writeFileSync(
    readmePath,
    `# Vibecarbon\n\n## Performance\n\n<!-- BEGIN:perf-table -->\n${renderUnifiedPerfTableMd(initialData)}\n<!-- END:perf-table -->\n\n## License\n`,
  );
  const carbonDataPath = join(dir, 'vendor-matrix-data.json');
  writeFileSync(carbonDataPath, serializePerfData(initialData));
  return { dataPath, readmePath, carbonDataPath };
}

// ---------------------------------------------------------------------------
// discoverLegArtifacts
// ---------------------------------------------------------------------------

describe('discoverLegArtifacts', () => {
  it('returns [] when the root directory does not exist', () => {
    expect(discoverLegArtifacts(join(tmpdir(), `vc-no-such-dir-${randomUUID()}`))).toEqual([]);
  });

  it('returns [] for an empty root directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'vc-legs-empty-'));
    expect(discoverLegArtifacts(root)).toEqual([]);
  });

  it('finds a leg with an e2e.db and derives its provider from the directory name', () => {
    const root = mkdtempSync(join(tmpdir(), 'vc-legs-one-'));
    const { dbPath, db } = makeLegDb(root, 'hetzner');
    db.close();

    expect(discoverLegArtifacts(root)).toEqual([{ provider: 'hetzner', dbPath }]);
  });

  it('ignores directories that do not match the e2e-results-<provider> naming', () => {
    const root = mkdtempSync(join(tmpdir(), 'vc-legs-stray-'));
    mkdirSync(join(root, 'some-other-artifact'), { recursive: true });
    writeFileSync(join(root, 'some-other-artifact', 'e2e.db'), '');
    const { db } = makeLegDb(root, 'hetzner');
    db.close();

    const legs = discoverLegArtifacts(root);
    expect(legs.map((l) => l.provider)).toEqual(['hetzner']);
  });

  it('ignores an e2e-results-<provider> directory with no e2e.db inside (leg produced nothing)', () => {
    const root = mkdtempSync(join(tmpdir(), 'vc-legs-nodb-'));
    // Simulates a leg whose "Upload results" step ran (if: always()) but the
    // job died before ever writing tests/results/e2e.db — the log made it,
    // the db didn't.
    mkdirSync(join(root, 'e2e-results-digitalocean'), { recursive: true });
    writeFileSync(join(root, 'e2e-results-digitalocean', 'ci-batch-digitalocean.log'), 'boom\n');
    const { db } = makeLegDb(root, 'hetzner');
    db.close();

    const legs = discoverLegArtifacts(root);
    expect(legs.map((l) => l.provider)).toEqual(['hetzner']);
  });

  it('sorts multiple legs by provider name', () => {
    const root = mkdtempSync(join(tmpdir(), 'vc-legs-sorted-'));
    const hetzner = makeLegDb(root, 'hetzner');
    hetzner.db.close();
    const digitalocean = makeLegDb(root, 'digitalocean');
    digitalocean.db.close();

    const legs = discoverLegArtifacts(root);
    expect(legs.map((l) => l.provider)).toEqual(['digitalocean', 'hetzner']);
  });

  // C-1: actions/download-artifact@v8 extracts a SINGLE matched artifact
  // FLATTENED directly into `path:`, with no `<artifact-name>/` subdirectory
  // — the default single-provider dispatch, and the case where one of two
  // legs died before ever uploading. Every fixture above hand-builds the
  // nested layout; these pin the flattened one, which the original
  // implementation returned `[]` for (task-8-review.md C-1).
  describe('flattened single-artifact layout (root-level e2e.db, no subdirectory)', () => {
    it('finds a root-level e2e.db and recovers the provider from the sibling ci-batch-<provider>.log', () => {
      const root = mkdtempSync(join(tmpdir(), 'vc-legs-flat-log-'));
      const dbPath = join(root, 'e2e.db');
      const db = new E2EDb(dbPath);
      db.close();
      writeFileSync(join(root, 'ci-batch-hetzner.log'), 'ok\n');

      expect(discoverLegArtifacts(root)).toEqual([{ provider: 'hetzner', dbPath }]);
    });

    it("falls back to the db's own scenarios.provider column when no sibling log is present", () => {
      const root = mkdtempSync(join(tmpdir(), 'vc-legs-flat-nolog-'));
      const dbPath = join(root, 'e2e.db');
      const db = new E2EDb(dbPath);
      const runId = createTestRun(db);
      seedScenario(db, runId, 'digitalocean', 'compose');
      db.completeRun(runId, 'pass');
      db.close();
      // No ci-batch-*.log written — e.g. if-no-files-found: warn dropped it.

      expect(discoverLegArtifacts(root)).toEqual([{ provider: 'digitalocean', dbPath }]);
    });

    it("labels the leg 'unknown' when neither a sibling log nor a scenario row exists, but still finds it", () => {
      const root = mkdtempSync(join(tmpdir(), 'vc-legs-flat-blank-'));
      const dbPath = join(root, 'e2e.db');
      const db = new E2EDb(dbPath);
      // A run row with zero scenarios — the process died between createRun
      // and its first createScenario call.
      createTestRun(db);
      db.close();

      expect(discoverLegArtifacts(root)).toEqual([{ provider: 'unknown', dbPath }]);
    });

    it('prefers the nested e2e-results-<provider> layout over the flattened fallback when both a nested leg and a stray root-level e2e.db exist', () => {
      // Not a real download-artifact output (the two layouts are mutually
      // exclusive by construction — see the module doc) but pins the
      // precedence defensively.
      const root = mkdtempSync(join(tmpdir(), 'vc-legs-both-layouts-'));
      const nested = makeLegDb(root, 'hetzner');
      nested.db.close();
      const strayDb = new E2EDb(join(root, 'e2e.db'));
      strayDb.close();

      expect(discoverLegArtifacts(root)).toEqual([{ provider: 'hetzner', dbPath: nested.dbPath }]);
    });
  });
});

// ---------------------------------------------------------------------------
// updateLeg
// ---------------------------------------------------------------------------

describe('updateLeg', () => {
  it('returns runId: null and a no-op result for a db with no recorded runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'vc-leg-empty-'));
    const { dbPath, db } = makeLegDb(root, 'hetzner');
    db.close();
    const { dataPath } = makeSurfacePaths();
    const before = readFileSync(dataPath, 'utf8');

    const result = updateLeg(dataPath, { provider: 'hetzner', dbPath });
    expect(result).toEqual({ provider: 'hetzner', runId: null, updated: [], skipped: [] });
    expect(readFileSync(dataPath, 'utf8')).toBe(before);
  });

  it("merges only its own provider into the data file (other providers have zero rows in this leg's db)", () => {
    const root = mkdtempSync(join(tmpdir(), 'vc-leg-hetzner-green-'));
    const { dbPath, db } = makeLegDb(root, 'hetzner');
    const runId = createTestRun(db);
    for (const mode of HETZNER_MODES) seedScenario(db, runId, 'hetzner', mode);
    db.completeRun(runId, 'pass');
    db.close();

    const { dataPath } = makeSurfacePaths();
    const result = updateLeg(dataPath, { provider: 'hetzner', dbPath });
    expect(result.runId).toBe(runId);
    expect(result.updated).toEqual(['hetzner']);
    expect(result.skipped).toEqual(['digitalocean', 'linode', 'vultr', 'scaleway']);

    const data = loadPerfData(dataPath);
    expect(Object.keys(data.providers)).toEqual(['hetzner']);
    expect(Object.keys(data.providers.hetzner.scenarios)).toEqual([...HETZNER_MODES]);
  });

  it('a leg with partial registry coverage updates nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'vc-leg-partial-'));
    const { dbPath, db } = makeLegDb(root, 'digitalocean');
    const runId = createTestRun(db);
    seedScenario(db, runId, 'digitalocean', 'compose');
    seedScenario(db, runId, 'digitalocean', 'compose-ha'); // missing k8s
    db.completeRun(runId, 'pass');
    db.close();

    const { dataPath } = makeSurfacePaths();
    const result = updateLeg(dataPath, { provider: 'digitalocean', dbPath });
    expect(result.updated).toEqual([]);
    expect(loadPerfData(dataPath)).toEqual({ providers: {} });
  });
});

// ---------------------------------------------------------------------------
// collectAndRender
// ---------------------------------------------------------------------------

describe('collectAndRender', () => {
  it('merges two green legs into the data file and re-renders every surface once', () => {
    const root = mkdtempSync(join(tmpdir(), 'vc-legs-both-green-'));

    const hetzner = makeLegDb(root, 'hetzner');
    const hetznerRunId = createTestRun(hetzner.db);
    for (const mode of HETZNER_MODES) seedScenario(hetzner.db, hetznerRunId, 'hetzner', mode);
    hetzner.db.completeRun(hetznerRunId, 'pass');
    hetzner.db.close();

    const digitalocean = makeLegDb(root, 'digitalocean');
    const doRunId = createTestRun(digitalocean.db);
    for (const mode of DO_MODES) seedScenario(digitalocean.db, doRunId, 'digitalocean', mode);
    digitalocean.db.completeRun(doRunId, 'pass');
    digitalocean.db.close();

    const paths = makeSurfacePaths();
    const legs = discoverLegArtifacts(root);
    expect(legs).toHaveLength(2);

    const result = collectAndRender(paths, legs);
    expect(result.changedFiles.sort()).toEqual(
      [paths.dataPath, paths.readmePath, paths.carbonDataPath].sort(),
    );
    expect(result.legs.find((l) => l.provider === 'hetzner')?.updated).toEqual(['hetzner']);
    expect(result.legs.find((l) => l.provider === 'digitalocean')?.updated).toEqual([
      'digitalocean',
    ]);

    // README block re-rendered from the merged data, carbon copy in sync.
    const data = loadPerfData(paths.dataPath);
    expect(readFileSync(paths.readmePath, 'utf8')).toContain(renderUnifiedPerfTableMd(data));
    expect(readFileSync(paths.carbonDataPath, 'utf8')).toBe(serializePerfData(data));
    expect(Object.keys(data.providers).sort()).toEqual(['digitalocean', 'hetzner']);
  });

  it('reports no changed files when no leg has full-green coverage and the surfaces are already in sync', () => {
    const root = mkdtempSync(join(tmpdir(), 'vc-legs-none-green-'));
    const { dbPath, db } = makeLegDb(root, 'hetzner');
    const runId = createTestRun(db);
    seedScenario(db, runId, 'hetzner', 'compose'); // partial: missing 3 modes
    db.completeRun(runId, 'pass');
    db.close();

    const paths = makeSurfacePaths();
    const result = collectAndRender(paths, [{ provider: 'hetzner', dbPath }]);
    expect(result.changedFiles).toEqual([]);
    expect(result.legs[0].updated).toEqual([]);
  });

  it("one leg failing does not block the other leg's numbers from landing", () => {
    const root = mkdtempSync(join(tmpdir(), 'vc-legs-one-fails-'));

    const hetzner = makeLegDb(root, 'hetzner');
    const hetznerRunId = createTestRun(hetzner.db);
    for (const mode of HETZNER_MODES) seedScenario(hetzner.db, hetznerRunId, 'hetzner', mode);
    hetzner.db.completeRun(hetznerRunId, 'pass');
    hetzner.db.close();

    const digitalocean = makeLegDb(root, 'digitalocean');
    const doRunId = createTestRun(digitalocean.db);
    for (const mode of DO_MODES) {
      seedScenario(
        digitalocean.db,
        doRunId,
        'digitalocean',
        mode,
        mode === 'k8s' ? { status: 'fail' } : {},
      );
    }
    digitalocean.db.completeRun(doRunId, 'fail');
    digitalocean.db.close();

    const paths = makeSurfacePaths();
    const result = collectAndRender(paths, discoverLegArtifacts(root));

    expect(result.changedFiles).toContain(paths.dataPath);
    const data = loadPerfData(paths.dataPath);
    expect(Object.keys(data.providers)).toEqual(['hetzner']);
    // DigitalOcean's registered scenarios render as pending, not absent.
    const readme = readFileSync(paths.readmePath, 'utf8');
    expect(readme).toContain('| DigitalOcean | `compose` | _pending_ |');
  });

  it("a new leg's merge preserves providers measured by earlier runs", () => {
    const existing: PerfData = {
      providers: {
        vultr: {
          run: { id: 'vvvvvvv', date: '2026-08-12', origin: 'GitHub-hosted runner' },
          scenarios: { compose: { deploy: 403_000 } },
        },
      },
    };
    const root = mkdtempSync(join(tmpdir(), 'vc-legs-preserve-'));
    const { dbPath, db } = makeLegDb(root, 'hetzner');
    const runId = createTestRun(db);
    for (const mode of HETZNER_MODES) seedScenario(db, runId, 'hetzner', mode);
    db.completeRun(runId, 'pass');
    db.close();

    const paths = makeSurfacePaths(existing);
    collectAndRender(paths, [{ provider: 'hetzner', dbPath }]);

    const data = loadPerfData(paths.dataPath);
    expect(Object.keys(data.providers)).toEqual(['hetzner', 'vultr']);
    const readme = readFileSync(paths.readmePath, 'utf8');
    expect(readme).toContain('| Vultr | `compose` | 6m 43s |');
    expect(readme).toContain('| Hetzner Cloud | `compose` | 1m 0s |');
  });

  it('passes origin through to the provenance footer', () => {
    const root = mkdtempSync(join(tmpdir(), 'vc-legs-origin-'));
    const { dbPath, db } = makeLegDb(root, 'hetzner');
    const runId = createTestRun(db);
    for (const mode of HETZNER_MODES) seedScenario(db, runId, 'hetzner', mode);
    db.completeRun(runId, 'pass');
    db.close();

    const paths = makeSurfacePaths();
    collectAndRender(paths, [{ provider: 'hetzner', dbPath }], {
      origin: 'GitHub-hosted runner',
    });
    expect(readFileSync(paths.readmePath, 'utf8')).toContain('GitHub-hosted runner');
  });

  // C-1, end-to-end: the full discover -> merge -> render pipeline for the
  // DEFAULT single-provider dispatch, which download-artifact@v8 delivers as
  // a flattened root-level e2e.db (see the discoverLegArtifacts describe
  // block above).
  it('C-1: works end-to-end for the flattened single-provider-dispatch layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'vc-legs-flat-e2e-'));
    const dbPath = join(root, 'e2e.db');
    const db = new E2EDb(dbPath);
    const runId = createTestRun(db);
    for (const mode of HETZNER_MODES) seedScenario(db, runId, 'hetzner', mode);
    db.completeRun(runId, 'pass');
    db.close();
    writeFileSync(join(root, 'ci-batch-hetzner.log'), 'ok\n');

    const paths = makeSurfacePaths();
    const legs = discoverLegArtifacts(root);
    expect(legs).toEqual([{ provider: 'hetzner', dbPath }]);

    const result = collectAndRender(paths, legs);
    expect(result.changedFiles).toContain(paths.readmePath);
    expect(readFileSync(paths.readmePath, 'utf8')).toContain(
      '| Hetzner Cloud | `compose` | 1m 0s |',
    );
  });
});
