/**
 * DESTROY LEAK LEDGER — the one accounting every teardown class reports into,
 * and the exit-code policy derived from it.
 *
 * WHY THIS EXISTS
 * ---------------
 * `vibecarbon destroy` is best-effort per resource by design: one class failing
 * must never abort the teardown, because everything after it (the buckets, the
 * volume sweep, the config update) still needs to run. The cost of that design
 * used to be silence — each failure was an `s.stop('Failed to delete X: ...')`
 * line scrolling past in a spinner, and the process still exited 0. On
 * 2026-07-22, during the prod re-home, a destroy printed
 * `Environment "prod" destroyed.` while the server and both firewalls were
 * still running. No script could tell that apart from a clean teardown, and
 * neither could the operator once the spinner lines had scrolled.
 *
 * Best-effort per resource is kept. What changes is that every best-effort
 * outcome now lands here, and the process exits on the accumulated verdict
 * instead of on "we reached the end".
 *
 * FOUR SEVERITIES, AND WHY EACH ONE EARNS ITS PLACE
 * ------------------------------------------------
 *   leak       — it survived AND we know it is ours. Billing, and it will
 *                collide with the next deploy (a leaked firewall makes
 *                `pulumi up` fail with uniqueness_error). Fails the exit code.
 *
 *   unverified — we could not determine whether it survived: the delete never
 *                confirmed, a provider listing came back incomplete, an
 *                identity capture failed, a whole teardown step threw. This is
 *                PR #236's principle applied to every class: an unreadable
 *                listing cannot produce a clean verdict, because a soft-failed
 *                listing and an empty account are indistinguishable from the
 *                caller's side and only one of them is safe. Fails the exit
 *                code — a destroy that cannot prove it cleaned up has not
 *                proven it cleaned up.
 *
 *   foreign    — it survived and we PROVED it is not ours. The live case is
 *                #236's identity gate: when this environment's own
 *                PersistentVolume list was captured in full, a `pvc-*` volume
 *                absent from that list belongs to somebody else (a parallel
 *                e2e rig, another environment, a customer cluster in the same
 *                region — RCA 2026-07-18 is the receipt for what happens when
 *                you delete on that evidence). Reported, because it is
 *                absolutely somebody's bill, but it must NOT fail our exit
 *                code: turning another tenant's disk into our red build is how
 *                a leak signal gets learned-helplessness'd into noise.
 *
 *   risk       — a configuration mismatch that predicts a leak but is not one
 *                yet (the S3-config/keys mismatch: `envConfig.s3` recorded, S3
 *                env keys absent). Loud, and does not fail the exit code on
 *                its own — see destroyExitCode's note.
 *
 * Entries are de-duplicated on (severity, class, resource, reason) because
 * several call sites legitimately observe the same failure twice (a firewall's
 * `apiError` branch and the surrounding catch, say) and one surviving resource
 * should produce one line.
 */

/** @typedef {'leak'|'unverified'|'foreign'|'risk'} LeakSeverity */

/**
 * @typedef {object} LeakEntry
 * @property {LeakSeverity} severity
 * @property {string} resourceClass - server / firewall / ssh-key / network /
 *   floating-ip / dns-record / health-check / load-balancer / volume / bucket /
 *   pulumi-stack / destroy-step ... Free-form so a new teardown class can
 *   report without a registry edit; rendered in a fixed-width column.
 * @property {string} resource - name and/or id, from describeResource().
 * @property {string} reason - why it survived, in the operator's words.
 * @property {string} [hint] - what to do about it.
 */

import { displayLine } from '../cli/error-line.js';

/** Clean teardown: nothing leaked, every listing read in full. */
export const DESTROY_EXIT_CLEAN = 0;

/**
 * The destroy itself could not run: bad flags, no API token, no such
 * environment, cancelled, or an unhandled throw out of main(). Pre-existing
 * behaviour (`process.exit(1)` at those guards, plus cli.js's catch-all) —
 * named here so callers can tell it apart from a completed-but-leaky teardown.
 */
export const DESTROY_EXIT_FAILED = 1;

/**
 * The teardown RAN TO COMPLETION but leaked, or could not verify a class.
 *
 * Deliberately distinct from 1. Scripted callers need the difference: the e2e
 * lifecycle's mid-run destroy is a DR precondition where a crashed destroy
 * (exit 1) invalidates the restore that follows, while a leaked-but-complete
 * teardown (exit 2) is a real defect to report without pretending the DR chain
 * never ran. A single non-zero code forces every caller to either treat those
 * the same or scrape stdout.
 */
export const DESTROY_EXIT_LEAKED = 2;

/** First line only, whitespace-collapsed — provider errors arrive with stacks. */
function oneLine(text) {
  // A raw command envelope's first line is the useless `…: code: -2`; take
  // its informative line instead (excitingai destroy, 2026-10-16).
  return String(displayLine(String(text ?? '')))
    .split('\n')[0]
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Render a resource identity for the report. Providers hand us names, numeric
 * ids, UUID handles, or nothing at all (a DO reserved IP has no name; an
 * unresolved volume may be known only by the id captured from a PV).
 *
 * @param {{ name?: string|null, id?: string|number|null, region?: string|null }} parts
 * @returns {string}
 */
export function describeResource({ name, id, region } = {}) {
  const hasId = id !== undefined && id !== null && id !== '';
  const qualifiers = [];
  if (hasId && name) qualifiers.push(`id ${id}`);
  if (region) qualifiers.push(region);
  const head = name || (hasId ? `id ${id}` : '');
  if (!head) return '(unidentified)';
  return qualifiers.length > 0 ? `${head} (${qualifiers.join(', ')})` : head;
}

/**
 * Create the per-destroy ledger. One instance rides on the destroy `results`
 * object so every effect, tier helper and sweep reports into the same place.
 *
 * @returns {{
 *   entries: LeakEntry[],
 *   leak: (e: object) => void,
 *   unverified: (e: object) => void,
 *   foreign: (e: object) => void,
 *   risk: (e: object) => void,
 *   counts: () => { leak: number, unverified: number, foreign: number, risk: number, total: number },
 *   isClean: () => boolean,
 *   exitCode: () => number,
 * }}
 */
export function createLeakLedger() {
  /** @type {LeakEntry[]} */
  const entries = [];
  const seen = new Set();

  const record = (severity) => (entry) => {
    const normalized = /** @type {LeakEntry} */ ({
      severity,
      resourceClass: oneLine(entry?.resourceClass) || 'resource',
      resource: oneLine(entry?.resource) || '(unidentified)',
      reason: oneLine(entry?.reason) || 'no reason recorded',
    });
    const hint = entry?.hint ? oneLine(entry.hint) : undefined;
    if (hint) normalized.hint = hint;
    const key = `${severity}\u0000${normalized.resourceClass}\u0000${normalized.resource}\u0000${normalized.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(normalized);
  };

  const counts = () => {
    const tally = { leak: 0, unverified: 0, foreign: 0, risk: 0, total: entries.length };
    for (const entry of entries) tally[entry.severity] += 1;
    return tally;
  };

  return {
    entries,
    leak: record('leak'),
    unverified: record('unverified'),
    foreign: record('foreign'),
    risk: record('risk'),
    counts,
    /** Clean == nothing at all to report, including foreign/at-risk lines. */
    isClean: () => entries.length === 0,
    exitCode: () => destroyExitCode(counts()),
  };
}

/**
 * The exit-code policy, in one place.
 *
 * `leak` and `unverified` fail. `foreign` and `risk` do not, and the reasoning
 * for each is worth stating because both are judgement calls:
 *
 *   foreign — the resource is proven to belong to somebody else. Our teardown
 *     was clean; theirs is the leak. Failing here would turn every k8s destroy
 *     that runs alongside a parallel rig red for a volume we are specifically
 *     forbidden from deleting, and a red build nobody can act on stops being
 *     read.
 *
 *   risk — the S3-config/keys mismatch predicts a leak; it does not observe
 *     one. The effects report the actual outcome for everything they touch (a
 *     bucket delete skipped for missing credentials is a `leak` right there,
 *     and a stack state the destroy could not open is `unverified`), which is
 *     what fails the exit code, so failing on the predictor as well would
 *     double-count, and would fail a destroy whose prompt then got the keys.
 *     The risk line's job is to be seen BEFORE the teardown starts, so the
 *     operator can supply the keys instead of discovering the stranded
 *     bucket or the kept environment afterwards.
 *
 * @param {{ leak: number, unverified: number }} counts
 * @returns {number}
 */
export function destroyExitCode(counts) {
  return (counts.leak ?? 0) + (counts.unverified ?? 0) > 0
    ? DESTROY_EXIT_LEAKED
    : DESTROY_EXIT_CLEAN;
}

const SEVERITY_LABEL = {
  leak: 'LEAK',
  unverified: 'UNVERIFIED',
  foreign: 'FOREIGN',
  risk: 'AT-RISK',
};

const LABEL_WIDTH = 10; // widest label, 'UNVERIFIED'
const CLASS_WIDTH = 14;

/**
 * Build the end-of-destroy leak report: one line per surviving resource, then
 * a summary count. Pure — the caller owns colour and the print channel.
 *
 * @param {ReturnType<typeof createLeakLedger>} ledger
 * @param {{ environment?: string }} [options]
 * @returns {{ clean: boolean, header: string, summary: string, exitCode: number,
 *   lines: Array<{ severity: LeakSeverity, resourceClass: string, text: string, hint?: string }> }}
 */
export function formatLeakReport(ledger, { environment = '' } = {}) {
  const counts = ledger.counts();
  const exitCode = ledger.exitCode();
  const clean = ledger.isClean();
  const envLabel = environment ? ` — environment "${environment}"` : '';

  if (clean) {
    return {
      clean: true,
      header: `Destroy leak report${envLabel}`,
      summary:
        'No leaked resources: every targeted resource was confirmed deleted (or already absent) ' +
        'and every provider listing was read in full.',
      exitCode,
      lines: [],
    };
  }

  const lines = ledger.entries.map((entry) => ({
    severity: entry.severity,
    resourceClass: entry.resourceClass,
    text:
      `${SEVERITY_LABEL[entry.severity].padEnd(LABEL_WIDTH)} ` +
      `${entry.resourceClass.padEnd(CLASS_WIDTH)} ` +
      `${entry.resource}: ${entry.reason}`,
    ...(entry.hint ? { hint: entry.hint } : {}),
  }));

  const parts = [];
  if (counts.leak > 0) parts.push(`${counts.leak} leaked`);
  if (counts.unverified > 0) parts.push(`${counts.unverified} unverifiable`);
  if (counts.foreign > 0) parts.push(`${counts.foreign} foreign`);
  if (counts.risk > 0) parts.push(`${counts.risk} at risk`);

  return {
    clean: false,
    header: `Destroy leak report${envLabel}`,
    summary: `${parts.join(', ')} — exit ${exitCode}.`,
    exitCode,
    lines,
  };
}

/**
 * Does this log line carry a leak-report verdict?
 *
 * The severity token leads every rendered line SO THAT this predicate can
 * exist: scripted callers only get an exit code over the process boundary, and
 * `DESTROY_EXIT_LEAKED` alone tells them a teardown leaked without telling them
 * what. Scraping the report back out of captured stdout is how the e2e runner
 * turns "exit 2" into a step failure that names the surviving resources.
 *
 * Shared (rather than re-written as a regex in the runner) so the renderer and
 * the scraper cannot drift apart — a format change that silently stopped
 * matching would put us right back to an unexplained exit code.
 *
 * destroy prints each verdict through clack's `p.log.message`, which puts its
 * `│` gutter (`|` on terminals without Unicode) in front of the line, so
 * either gutter is allowed as leading indentation. Matching only bare indentation once let a real run scrape zero
 * lines from a two-line report (k8s-ha final-destroy, 2026-10-31).
 *
 * @param {string} line - one line, ANSI already stripped.
 * @returns {boolean}
 */
export function isLeakReportLine(line) {
  return /^[\s│|]*(LEAK|UNVERIFIED|FOREIGN|AT-RISK)\s/.test(line);
}

/**
 * Plain (uncoloured) rendering of a report, for logs, tests, and any caller
 * that just wants greppable text. The severity token leads every line so
 * `grep '^\s*LEAK'` over a destroy log is a complete leak list.
 *
 * @param {ReturnType<typeof formatLeakReport>} report
 * @returns {string[]}
 */
export function renderLeakReportLines(report) {
  const out = [report.header];
  for (const line of report.lines) {
    out.push(`  ${line.text}`);
    if (line.hint) out.push(`    ↳ ${line.hint}`);
  }
  out.push(report.summary);
  return out;
}
