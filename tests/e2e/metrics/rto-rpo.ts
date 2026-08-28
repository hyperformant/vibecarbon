/**
 * RTO/RPO figures renderer — turns a green HA e2e run's failover measurements
 * into the published guarantees block in `docs/technical.md`.
 *
 * Sibling of the README perf-table machinery in reporter.ts and deliberately
 * NOT an extension of it: the README blocks are per-provider mode ×
 * lifecycle-step grids of single wall-clock cells, while the guarantees
 * block needs a failover sub-stage breakdown plus RPO *evidence* (a
 * verification check, not a duration) — and is Hetzner-only (k8s-ha has no
 * DigitalOcean equivalent). Extending PERF_TABLE_ROWS would change that
 * table's shape for a feature this doc doesn't need. Same conventions,
 * separate block: marker pair, machine-readable provenance comment,
 * deterministic output, green-only.
 *
 * Metric mapping (see docs/rto-rpo.md for the full methodology):
 *   - `failover` step duration_ms      → failover command wall-clock
 *                                        (incl. real 0→N worker provisioning)
 *   - perf_substep failover.provisionWorkers → worker provisioning (IaC 0→N)
 *   - perf_substep failover.promoteStandby   → standby db promotion
 *   - remainder (total − provision − promote) → quiesce + WAL catch-up gate +
 *     reseed check + wal-g write-guard move + app-tier scale-up + readiness
 *     gate + DNS flip + CLI overhead (not individually instrumented yet)
 *   - total − provisioning             → planned-switchover outage-side upper
 *                                        bound (provisioning precedes quiesce,
 *                                        so it is outside the outage window)
 *   - `verify-failover` step duration  → independent serving evidence (DNS
 *                                        propagation gate + full check battery)
 *   - verification replication_failover_continuity → planned RPO = 0 evidence
 *     (the marker row written on the old primary pre-failover survived onto
 *     the promoted primary)
 *
 * Publication gate: figures render ONLY from a green scenario whose failover
 * AND verify-failover steps passed and whose continuity check passed. House
 * marketing rule: HA claims stay pinned to the latest green full matrix — a
 * green single-scenario run may render figures, but the output flags it so
 * the publisher confirms the latest matrix is still green before shipping.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2EDb } from './db.js';
import { formatDuration } from './reporter.js';

export const RTO_RPO_BEGIN_MARKER = '<!-- BEGIN:rto-rpo-figures -->';
export const RTO_RPO_END_MARKER = '<!-- END:rto-rpo-figures -->';

/**
 * Keep in sync with the Hetzner registry entry's scenario list
 * (`testConfig.e2e.providers.hetzner.scenarios` in tests/config.ts).
 *
 * The published RTO/RPO guarantees stay HETZNER-SOURCED (see
 * GUARANTEE_PROVIDER below): they are the numbers docs/technical.md's
 * guarantees block advertises, measured on the release-matrix provider's
 * intra-EU pairing. DO's d4 produces its own figures (coast-to-coast
 * nyc3↔sfo3 — a different latency regime) which must never silently replace
 * the published ones; blessing a second provider's figures is a deliberate
 * docs decision, not a db race.
 */
const ALL_MATRIX_MODES = ['compose', 'compose-ha', 'k8s', 'k8s-ha'];

/** The provider whose green runs feed the published guarantees block. */
const GUARANTEE_PROVIDER = 'hetzner';

/** Perf-substep names emitted by src/failover.js (perfTimer call sites). */
export const FAILOVER_SUBSTEP_PROVISION = 'failover.provisionWorkers';
export const FAILOVER_SUBSTEP_PROMOTE = 'failover.promoteStandby';

/** Verification check that evidences planned RPO = 0 (tests/e2e/checks/replication.ts). */
export const CONTINUITY_CHECK = 'replication_failover_continuity';

export interface RtoRpoFigures {
  runId: string;
  runShort: string;
  /** YYYY-MM-DD from runs.started_at. */
  runDate: string;
  gitSha: string | null;
  gitBranch: string | null;
  mode: string;
  dnsProvider: string | null;
  /** Whole `vibecarbon failover` invocation, wall-clock. */
  failoverTotalMs: number;
  /** failover.provisionWorkers substep, when recorded (k8s-ha pilot-light). */
  provisionMs: number | null;
  /** failover.promoteStandby substep, when recorded. */
  promoteMs: number | null;
  /** total − provision − promote; null unless both substeps are present. */
  remainderMs: number | null;
  /** total − provision: planned-switchover outage-side upper bound. */
  outageBoundMs: number | null;
  /** verify-failover step wall-clock (DNS propagation gate + check battery). */
  verifyFailoverMs: number | null;
  /** Whether every matrix mode was green in this run (HA-claims pin rule). */
  fullGreenMatrix: boolean;
}

export type CollectResult = { ok: true; figures: RtoRpoFigures } | { ok: false; reason: string };

function isGreenStatus(status: string): boolean {
  const upper = status.toUpperCase();
  return upper === 'PASS' || upper === 'PASS_AFTER_RETRY';
}

/**
 * Collect the RTO/RPO figures for one run + mode, refusing (with a stated
 * reason) whenever the run cannot honestly back a published guarantee:
 * scenario not green, failover or verify-failover not green, or the
 * continuity check absent/failed. Publication machinery must fail closed —
 * a table cell without its evidence is worse than no update.
 */
export function collectRtoRpoFigures(db: E2EDb, runId: string, mode = 'k8s-ha'): CollectResult {
  const details = db.getRunDetails(runId);
  if (!details) return { ok: false, reason: `run ${runId} not found in this db` };

  // Provider-qualified, not mode-only: since d4, a db can hold BOTH a
  // hetzner and a digitalocean k8s-ha row, and the published guarantees must
  // never pick up the wrong provider's latency regime by sort order.
  const scenario = details.scenarios.find(
    (sc) => sc.mode === mode && sc.provider === GUARANTEE_PROVIDER,
  );
  if (!scenario) return { ok: false, reason: `run has no ${GUARANTEE_PROVIDER} ${mode} scenario` };
  if (!isGreenStatus(scenario.status)) {
    return { ok: false, reason: `${mode} scenario status is '${scenario.status}', not green` };
  }

  // Latest green step per name — retries can leave multiple rows with the
  // same name; the green one (last by started_at) is the measurement.
  const stepByName = (name: string) => {
    const green = details.steps.filter(
      (s) => s.scenario_id === scenario.id && s.name === name && isGreenStatus(s.status),
    );
    return green.length > 0 ? green[green.length - 1] : undefined;
  };

  const failover = stepByName('failover');
  if (!failover || failover.duration_ms == null) {
    return { ok: false, reason: `no green 'failover' step with a duration for ${mode}` };
  }
  const verifyFailover = stepByName('verify-failover');
  if (!verifyFailover) {
    return { ok: false, reason: `no green 'verify-failover' step for ${mode} — serving unproven` };
  }

  // RPO = 0 evidence: the continuity check recorded under verify-failover.
  const continuity = details.verifications.find(
    (v) => v.step_id === verifyFailover.id && v.check_name === CONTINUITY_CHECK,
  );
  if (!continuity) {
    return {
      ok: false,
      reason: `verification '${CONTINUITY_CHECK}' missing — cannot evidence RPO = 0`,
    };
  }
  if (continuity.status.toUpperCase() !== 'PASS') {
    return {
      ok: false,
      reason: `verification '${CONTINUITY_CHECK}' is '${continuity.status}' — refusing to publish`,
    };
  }

  const substeps = db.getPerfSubstepsByStep(failover.id);
  const substep = (name: string) => substeps.find((s) => s.name === name)?.duration_ms ?? null;
  const provisionMs = substep(FAILOVER_SUBSTEP_PROVISION);
  const promoteMs = substep(FAILOVER_SUBSTEP_PROMOTE);
  const totalMs = failover.duration_ms;

  const fullGreenMatrix = ALL_MATRIX_MODES.every((m) => {
    const sc = details.scenarios.find((s) => s.mode === m);
    return sc != null && isGreenStatus(sc.status);
  });

  return {
    ok: true,
    figures: {
      runId: details.run.id,
      runShort: details.run.id.slice(0, 7),
      runDate: details.run.started_at ? details.run.started_at.slice(0, 10) : 'unknown',
      gitSha: details.run.git_sha,
      gitBranch: details.run.git_branch,
      mode,
      dnsProvider: scenario.dns_provider,
      failoverTotalMs: totalMs,
      provisionMs,
      promoteMs,
      remainderMs:
        provisionMs != null && promoteMs != null ? totalMs - provisionMs - promoteMs : null,
      outageBoundMs: provisionMs != null ? totalMs - provisionMs : null,
      verifyFailoverMs: verifyFailover.duration_ms,
      fullGreenMatrix,
    },
  };
}

export interface RtoRpoProvenance {
  /** e.g. "ash→hil" (primary→standby). Not recorded in the db — pass it in. */
  regions?: string;
  /** GitHub Actions run id when the db came from a CI artifact. */
  ghRun?: string;
}

const fmt = (ms: number | null) => (ms == null ? '—' : formatDuration(ms));

/**
 * Render the measured-figures markdown block (excluding the BEGIN/END marker
 * lines — injectRtoRpoIntoDoc adds those back). Deterministic: same figures +
 * provenance → byte-identical markdown.
 */
export function renderRtoRpoMd(figures: RtoRpoFigures, prov: RtoRpoProvenance = {}): string {
  const provParts = [
    `mode=${figures.mode}`,
    `run=${figures.runShort}`,
    `date=${figures.runDate}`,
    ...(prov.regions ? [`regions=${prov.regions}`] : []),
    ...(prov.ghRun ? [`gh-run=${prov.ghRun}`] : []),
  ];

  const rows: string[][] = [
    [
      '`failover` command wall-clock (incl. 0→N worker provisioning)',
      `**${fmt(figures.failoverTotalMs)}**`,
      'Unplanned-failover RTO, command side; planned-switchover operation time',
    ],
    [
      '— worker provisioning (IaC, 0→N)',
      fmt(figures.provisionMs),
      'Before the outage window opens in planned mode; inside it when unplanned',
    ],
    ['— standby database promotion', fmt(figures.promoteMs), 'The point of no return'],
    [
      '— remainder (quiesce, WAL catch-up gate, wal-g write-guard move, app-tier scale-up, readiness gate, DNS flip)',
      fmt(figures.remainderMs),
      'Not individually instrumented yet — see docs/rto-rpo.md',
    ],
    [
      'Planned outage-side upper bound (wall-clock minus provisioning)',
      `**${fmt(figures.outageBoundMs)}**`,
      'Planned-switchover RTO before DNS propagation (≤ 60s record TTL)',
    ],
    [
      '`verify-failover` (DNS propagation gate + full check battery)',
      fmt(figures.verifyFailoverMs),
      'Independent serving + continuity evidence — not part of the outage',
    ],
    [
      `RPO evidence: \`${CONTINUITY_CHECK}\``,
      '**pass**',
      'Pre-failover write survived onto the promoted primary → planned RPO = 0',
    ],
  ];

  const table = [
    '| Measurement | Measured | Maps to |',
    '| :--- | :---: | :--- |',
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ];

  const regionsPart = prov.regions ? `, regions ${prov.regions}` : '';
  const ghPart = prov.ghRun ? ` (GitHub Actions run ${prov.ghRun})` : '';
  const matrixPart = figures.fullGreenMatrix
    ? 'fully-green matrix run'
    : 'green single-scenario run — confirm the latest full matrix is still green before publishing HA claims';

  return [
    '<!-- Auto-generated by `pnpm test:e2e:rto-rpo` — do not edit by hand -->',
    `<!-- rto-rpo-provenance: ${provParts.join(';')} -->`,
    '',
    ...table,
    '',
    `_Provenance: \`${figures.mode}\` scenario${regionsPart}, e2e run \`${figures.runShort}\` on ${figures.runDate}${ghPart}; ${matrixPart}. Methodology: [docs/rto-rpo.md](./rto-rpo.md)._`,
  ].join('\n');
}

/**
 * Replace the content between the rto-rpo marker pair in `docPath` with the
 * new markdown. Marker lines are preserved. Returns true when the file
 * changed; throws when the markers are missing (the doc must opt in).
 */
export function injectRtoRpoIntoDoc(docPath: string, markdown: string): boolean {
  const original = readFileSync(docPath, 'utf8');
  const beginIdx = original.indexOf(RTO_RPO_BEGIN_MARKER);
  const endIdx = original.indexOf(RTO_RPO_END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(
      `Cannot inject rto-rpo figures: ${docPath} is missing the ${RTO_RPO_BEGIN_MARKER} / ${RTO_RPO_END_MARKER} marker pair.`,
    );
  }
  const before = original.slice(0, beginIdx + RTO_RPO_BEGIN_MARKER.length);
  const after = original.slice(endIdx);
  const next = `${before}\n${markdown}\n${after}`;
  if (next === original) return false;
  writeFileSync(docPath, next);
  return true;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function usage(): void {
  console.log(
    [
      'Usage: pnpm test:e2e:rto-rpo -- --run <id-prefix|latest> [options]',
      '',
      'Options:',
      '  --run <id|latest>   Run id prefix, or "latest" = most recent run with a',
      '                      publishable (green failover + continuity) scenario',
      '  --db <path>         SQLite db (default tests/results/e2e.db; point this at',
      '                      an e2e.db downloaded from a CI run artifact)',
      '  --mode <mode>       HA scenario mode (default k8s-ha)',
      '  --regions <pair>    Region provenance, e.g. "ash→hil" (not stored in the db)',
      '  --gh-run <id>       GitHub Actions run id when the db is a CI artifact',
      '  --write             Patch the block between the rto-rpo markers in --doc',
      '  --doc <path>        Target doc for --write (default docs/technical.md)',
    ].join('\n'),
  );
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }
  const runArg = argValue(args, '--run');
  if (!runArg) {
    usage();
    process.exitCode = 1;
    return;
  }
  const mode = argValue(args, '--mode') ?? 'k8s-ha';
  const dbPath = argValue(args, '--db') ?? path.join(PROJECT_ROOT, 'tests', 'results', 'e2e.db');
  if (!existsSync(dbPath)) {
    // Opening a missing path would CREATE an empty db — fail loud instead.
    console.error(`No e2e metrics db at ${dbPath}. Run the e2e matrix or pass --db <path>.`);
    process.exitCode = 1;
    return;
  }
  const db = new E2EDb(dbPath);

  const resolveLatest = (): CollectResult => {
    for (const run of db.getRecentRuns(50)) {
      const attempt = collectRtoRpoFigures(db, run.id, mode);
      if (attempt.ok) return attempt;
    }
    return {
      ok: false,
      reason: `no recent run has a publishable green ${mode} failover measurement`,
    };
  };
  const resolveByPrefix = (prefix: string): CollectResult => {
    const match = db.getRecentRuns(200).find((r) => r.id.startsWith(prefix));
    if (!match) return { ok: false, reason: `no run id starting with '${prefix}' in this db` };
    return collectRtoRpoFigures(db, match.id, mode);
  };

  try {
    const result = runArg === 'latest' ? resolveLatest() : resolveByPrefix(runArg);

    // `=== false` (not `!result.ok`): tsconfig.e2e.json has strict off, and
    // without strictNullChecks tsc only narrows this union on an explicit
    // literal comparison against the discriminant.
    if (result.ok === false) {
      console.error(`Refusing to render RTO/RPO figures: ${result.reason}`);
      process.exitCode = 1;
      return;
    }

    const markdown = renderRtoRpoMd(result.figures, {
      regions: argValue(args, '--regions'),
      ghRun: argValue(args, '--gh-run'),
    });

    if (args.includes('--write')) {
      const docPath = argValue(args, '--doc') ?? path.join(PROJECT_ROOT, 'docs', 'technical.md');
      const changed = injectRtoRpoIntoDoc(docPath, markdown);
      console.log(
        changed
          ? `${docPath} updated between the rto-rpo markers — review the diff before committing.`
          : `${docPath} already up to date.`,
      );
    } else {
      console.log(markdown);
    }

    if (!result.figures.fullGreenMatrix) {
      console.error(
        '\nNote: this was NOT a fully-green matrix run. House rule: HA claims stay pinned to the latest green matrix — confirm it before publishing.',
      );
    }
  } finally {
    db.close();
  }
}

const isMainModule =
  process.argv[1] === __filename ||
  process.argv[1]?.replace(/\.ts$/, '.js') === __filename.replace(/\.ts$/, '.js');

if (isMainModule) {
  main();
}
