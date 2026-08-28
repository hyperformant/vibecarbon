/**
 * Unit tests for the RTO/RPO figures renderer (tests/e2e/metrics/rto-rpo.ts).
 *
 * The renderer is publication machinery: it must fail CLOSED (refuse to
 * render) whenever a run cannot honestly back a published guarantee, and its
 * arithmetic (provision / promote / remainder / outage bound) feeds the
 * customer-facing guarantees table, so each derivation is pinned here.
 *
 * In-memory SQLite (`:memory:`) keeps each test isolated from on-disk e2e.db
 * state and sibling unit tests (same pattern as perf-substep.test.ts).
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2EDb } from '../../e2e/metrics/db.js';
import {
  CONTINUITY_CHECK,
  collectRtoRpoFigures,
  FAILOVER_SUBSTEP_PROMOTE,
  FAILOVER_SUBSTEP_PROVISION,
  injectRtoRpoIntoDoc,
  RTO_RPO_BEGIN_MARKER,
  RTO_RPO_END_MARKER,
  renderRtoRpoMd,
} from '../../e2e/metrics/rto-rpo.js';

interface SeedOptions {
  mode?: string;
  scenarioStatus?: string;
  failoverStatus?: string;
  failoverDurationMs?: number;
  verifyFailoverStatus?: string;
  continuityStatus?: string | null; // null = don't record the check at all
  provisionMs?: number | null;
  promoteMs?: number | null;
}

/** Seed one run with an HA scenario shaped like a real k8s-ha lifecycle. */
function seed(db: E2EDb, opts: SeedOptions = {}) {
  const {
    mode = 'k8s-ha',
    scenarioStatus = 'pass',
    failoverStatus = 'pass',
    failoverDurationMs = 204_626,
    verifyFailoverStatus = 'pass',
    continuityStatus = 'pass',
    provisionMs = 142_536,
    promoteMs = 8_101,
  } = opts;

  const runId = randomUUID();
  db.createRun({
    id: runId,
    gitSha: '403149a',
    gitBranch: 'main',
    vibecarbonVersion: '0.0.0',
    machineInfo: {},
  });
  const scenarioId = randomUUID();
  db.createScenario({
    id: scenarioId,
    runId,
    mode,
    dnsProvider: 'hetzner',
    domain: 'example.test',
    features: [],
    projectName: `proj-${mode}`,
    envPrefix: 'e1',
  });

  const failoverId = randomUUID();
  db.createStep({ id: failoverId, scenarioId, name: 'failover', coldWarm: 'warm' });
  db.startStep(failoverId);
  db.completeStep(failoverId, failoverStatus, failoverDurationMs);

  const timings: Array<{ name: string; ms: number }> = [];
  if (provisionMs != null) timings.push({ name: FAILOVER_SUBSTEP_PROVISION, ms: provisionMs });
  if (promoteMs != null) timings.push({ name: FAILOVER_SUBSTEP_PROMOTE, ms: promoteMs });
  db.recordPerfSubsteps(failoverId, timings);

  const verifyId = randomUUID();
  db.createStep({ id: verifyId, scenarioId, name: 'verify-failover', coldWarm: 'warm' });
  db.startStep(verifyId);
  db.completeStep(verifyId, verifyFailoverStatus, 433_636);
  if (continuityStatus != null) {
    db.recordVerification({
      stepId: verifyId,
      checkName: CONTINUITY_CHECK,
      status: continuityStatus,
    });
  }

  db.updateScenarioStatus(scenarioId, scenarioStatus);
  db.completeRun(runId, scenarioStatus);
  return { runId, scenarioId };
}

describe('collectRtoRpoFigures', () => {
  it('collects totals, substeps, and the derived remainder/outage bound', () => {
    const db = new E2EDb(':memory:');
    const { runId } = seed(db);

    const result = collectRtoRpoFigures(db, runId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const f = result.figures;
    expect(f.failoverTotalMs).toBe(204_626);
    expect(f.provisionMs).toBe(142_536);
    expect(f.promoteMs).toBe(8_101);
    // remainder = total − provision − promote
    expect(f.remainderMs).toBe(204_626 - 142_536 - 8_101);
    // outage bound = total − provision (provisioning precedes the quiesce)
    expect(f.outageBoundMs).toBe(204_626 - 142_536);
    expect(f.verifyFailoverMs).toBe(433_636);
    expect(f.mode).toBe('k8s-ha');
    // single-scenario run — the HA-claims matrix pin must be surfaced
    expect(f.fullGreenMatrix).toBe(false);
  });

  it('handles missing substeps (compose-ha has no provisioning marker)', () => {
    const db = new E2EDb(':memory:');
    const { runId } = seed(db, { mode: 'compose-ha', provisionMs: null, promoteMs: null });

    const result = collectRtoRpoFigures(db, runId, 'compose-ha');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.figures.provisionMs).toBeNull();
    expect(result.figures.remainderMs).toBeNull();
    expect(result.figures.outageBoundMs).toBeNull();
  });

  it('refuses a run without the target-mode scenario', () => {
    const db = new E2EDb(':memory:');
    const { runId } = seed(db, { mode: 'compose-ha' });
    const result = collectRtoRpoFigures(db, runId, 'k8s-ha');
    // Provider-qualified since d4: the guarantees pipeline only accepts the
    // GUARANTEE_PROVIDER's (hetzner's) k8s-ha row, never DO's by sort order.
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no hetzner k8s-ha'),
    });
  });

  it('refuses a non-green scenario', () => {
    const db = new E2EDb(':memory:');
    const { runId } = seed(db, { scenarioStatus: 'fail' });
    const result = collectRtoRpoFigures(db, runId);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('not green') });
  });

  it('refuses a failed failover step even when the scenario is green', () => {
    const db = new E2EDb(':memory:');
    const { runId } = seed(db, { failoverStatus: 'fail' });
    const result = collectRtoRpoFigures(db, runId);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("'failover'") });
  });

  it('refuses when verify-failover is not green (serving unproven)', () => {
    const db = new E2EDb(':memory:');
    const { runId } = seed(db, { verifyFailoverStatus: 'fail' });
    const result = collectRtoRpoFigures(db, runId);
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('verify-failover'),
    });
  });

  it('refuses when the continuity check is missing (RPO=0 unevidenced)', () => {
    const db = new E2EDb(':memory:');
    const { runId } = seed(db, { continuityStatus: null });
    const result = collectRtoRpoFigures(db, runId);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(CONTINUITY_CHECK) });
  });

  it('refuses when the continuity check failed', () => {
    const db = new E2EDb(':memory:');
    const { runId } = seed(db, { continuityStatus: 'fail' });
    const result = collectRtoRpoFigures(db, runId);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('refusing') });
  });

  it('accepts pass_after_retry as green (retry semantics match the perf table)', () => {
    const db = new E2EDb(':memory:');
    const { runId } = seed(db, {
      scenarioStatus: 'pass_after_retry',
      failoverStatus: 'pass_after_retry',
    });
    const result = collectRtoRpoFigures(db, runId);
    expect(result.ok).toBe(true);
  });
});

describe('renderRtoRpoMd', () => {
  function figuresFixture() {
    const db = new E2EDb(':memory:');
    const { runId } = seed(db);
    const result = collectRtoRpoFigures(db, runId);
    if (!result.ok) throw new Error(result.reason);
    return result.figures;
  }

  it('is deterministic and carries provenance + formatted durations', () => {
    const figures = figuresFixture();
    const md = renderRtoRpoMd(figures, { regions: 'ash→hil', ghRun: '29629518169' });
    expect(md).toBe(renderRtoRpoMd(figures, { regions: 'ash→hil', ghRun: '29629518169' }));
    expect(md).toContain('**3m 25s**'); // 204_626 ms total
    expect(md).toContain('2m 23s'); // provisioning
    expect(md).toContain('**1m 2s**'); // outage bound
    expect(md).toContain(`regions=ash→hil`);
    expect(md).toContain('gh-run=29629518169');
    expect(md).toContain(CONTINUITY_CHECK);
    // single-scenario run → the matrix-pin house rule is stated in the footer
    expect(md).toContain('latest full matrix');
  });

  it('renders missing substeps as em-dashes without provenance extras', () => {
    const db = new E2EDb(':memory:');
    const { runId } = seed(db, { mode: 'compose-ha', provisionMs: null, promoteMs: null });
    const result = collectRtoRpoFigures(db, runId, 'compose-ha');
    if (!result.ok) throw new Error(result.reason);
    const md = renderRtoRpoMd(result.figures);
    expect(md).toContain('| — worker provisioning (IaC, 0→N) | — |');
    expect(md).not.toContain('gh-run=');
  });
});

describe('injectRtoRpoIntoDoc', () => {
  it('replaces only the content between the markers and reports change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rto-rpo-test-'));
    const docPath = join(dir, 'doc.md');
    writeFileSync(docPath, `before\n${RTO_RPO_BEGIN_MARKER}\nold\n${RTO_RPO_END_MARKER}\nafter\n`);

    expect(injectRtoRpoIntoDoc(docPath, 'NEW BLOCK')).toBe(true);
    const next = readFileSync(docPath, 'utf8');
    expect(next).toBe(`before\n${RTO_RPO_BEGIN_MARKER}\nNEW BLOCK\n${RTO_RPO_END_MARKER}\nafter\n`);
    // idempotent second write
    expect(injectRtoRpoIntoDoc(docPath, 'NEW BLOCK')).toBe(false);
  });

  it('throws when the marker pair is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rto-rpo-test-'));
    const docPath = join(dir, 'no-markers.md');
    writeFileSync(docPath, 'no markers here\n');
    expect(() => injectRtoRpoIntoDoc(docPath, 'X')).toThrow(/marker pair/);
  });
});
