/**
 * First-boot timing for freshly provisioned nodes.
 *
 * A node's ready wait (`deploy.<prefix>.waitForReady`,
 * `deploy.compose.cloudInitReady`, `scale.cloudInitReady`) is one opaque
 * number covering the whole of cloud-init. This module opens it up: it reads
 * each node's own record of that boot over ssh and emits one
 * `[perf] <prefix>.boot.<stage> <ms>ms` line per stage, so the timings reach
 * the perf summary and the e2e `perf_substep` capture through the same stderr
 * parser as every other `[perf]` line.
 *
 * When: a ready wait only QUEUES its nodes (`queueBootTiming`, no I/O).
 * cli.js drains the queue (`flushBootTiming`) once the command is over,
 * after `cli.<command>.total` is recorded, under one bounded budget. So the
 * collection never competes with the boot or deploy it measures, never
 * counts toward `deploy.total` / `cli.deploy.total` or the deploy budget,
 * and its lines always print before the process exits. Nothing is lost by
 * reading late: the marks are absolute timestamps and cloud-init keeps its
 * own log.
 *
 * Sources, all read in one ssh round trip per node (BOOT_TIMING_SCRIPT):
 *
 *   - `cloud-init analyze show`: total cloud-init time and each stage
 *     (init-local, init-network, modules-config, modules-final).
 *   - `cloud-init analyze blame`: the slowest modules.
 *   - BOOT_MARK_LOG: one `<id> <epoch seconds.nanoseconds>` line per major phase, written
 *     by the cloud-init scripts in carbon/cloud-init/ with one-letter ids
 *     (PHASE_IDS; Hetzner caps user data at 32 KiB). A plain mark starts a
 *     sequential phase that runs until the next plain mark (the last one, `e`,
 *     only closes the chain). `<id>.begin` / `<id>.end` bracket a background
 *     span (the compose boot image pull) that overlaps the chain.
 *   - `systemd-analyze`: kernel and userspace boot time.
 *
 * Once per node, cold provisions only: the script reports nothing on a node
 * without the marker log (provisioned before the marks existed, so its boot
 * is not a fresh one) and leaves a sentinel beside the log, so a later run
 * that re-runs the ready wait reports nothing again.
 *
 * Never fails a command: collection only runs when perf tracing is on
 * (VIBECARBON_PERF=1), every path resolves, and a node that cannot be read
 * prints one warning.
 */

import { perfEnabled, perfRecord } from '../perf.js';
import { sshRun } from '../ssh.js';

/** Where the cloud-init scripts append their phase marks. */
export const BOOT_MARK_LOG = '/var/log/vcboot';

/** Written beside the log once a node's boot has been reported. */
export const BOOT_REPORTED_SENTINEL = '/var/log/vcboot.done';

/**
 * The one-letter phase ids the cloud-init scripts write, and the stage names
 * they are reported under. An id not listed here is reported as written.
 */
export const PHASE_IDS = Object.freeze({
  p: 'preamble',
  a: 'apt',
  n: 'network',
  w: 'master.wait',
  k: 'k3s.install',
  r: 'k3s.ready',
  x: 'addons',
  d: 'docker',
  u: 'ufw',
  b: 'bootPull',
  e: 'done',
});

/**
 * Plain words for what the server is doing at each phase id, shown beside the
 * ready wait's spinner. `e` (done) needs no label: the wait ends there. `b`
 * has none either: the boot pull is written as `b.begin` / `b.end`, never as a
 * plain `b` mark.
 */
export const BOOT_STAGE_LABELS = Object.freeze({
  p: 'starting up',
  a: 'installing system packages',
  n: 'setting up the network',
  w: 'waiting for the primary server',
  k: 'installing Kubernetes',
  r: 'waiting for Kubernetes',
  x: 'installing cluster add-ons',
  d: 'starting Docker',
  u: 'setting up the firewall',
});

/**
 * A reader for the boot log's lines as they stream in, for a ready wait's
 * spinner. Calls `onStage(label)` when a `<id> <epoch.fraction>` mark moves
 * the label. Every reconnect replays the whole log, so only a mark newer than
 * the newest one seen may change the label, and an unchanged label is not
 * reported again (a quiet, non-TTY spinner prints a line per report).
 *
 * @param {(label: string) => void} onStage
 * @returns {(line: string) => void}
 */
export function readBootStage(onStage) {
  let newest = 0;
  let current = '';
  return (line) => {
    const mark = /^([a-z]) (\d+(?:\.\d+)?)$/.exec(String(line).trim());
    const label = mark && Object.hasOwn(BOOT_STAGE_LABELS, mark[1]) && BOOT_STAGE_LABELS[mark[1]];
    if (!label || Number(mark[2]) <= newest) return;
    newest = Number(mark[2]);
    if (label === current) return;
    current = label;
    onStage(label);
  };
}

/** The whole collection's bound, all nodes in parallel. */
export const BOOT_TIMING_BUDGET_MS = 45_000;

/** How many of the slowest cloud-init modules to report. */
const TOP_MODULES = 5;

/**
 * The remote half, fed to `sh -s` on stdin. Prints one `==> <section> <==`
 * header per source, or `==> skip <==` and a reason. By the time it runs the
 * command is over, so cloud-init has long finished; the short wait only
 * covers a node that is somehow still in it.
 */
export const BOOT_TIMING_SCRIPT = `log=${BOOT_MARK_LOG}
sentinel=${BOOT_REPORTED_SENTINEL}
if [ ! -f "$log" ]; then echo '==> skip <=='; echo no-marker-log; exit 0; fi
if [ -f "$sentinel" ]; then echo '==> skip <=='; echo already-reported; exit 0; fi
timeout 10 cloud-init status --wait >/dev/null 2>&1 || true
echo '==> markers <=='
cat "$log"
echo '==> show <=='
cloud-init analyze show 2>/dev/null || true
echo '==> blame <=='
cloud-init analyze blame 2>/dev/null || true
echo '==> systemd <=='
systemd-analyze 2>/dev/null || true
: > "$sentinel" || true
`;

/** @typedef {{ name: string, ms: number }} Timing */
/** @typedef {{ stage: string, ms: number }} StageTiming */

const MARK_LINE = /^(\S+)[ \t]+(\d+(?:\.\d+)?)[ \t]*$/;

/**
 * Parse the marker log.
 *
 * @param {string} text
 * @returns {{ phases: Timing[], spans: Timing[], totalMs: number|null }}
 */
export function parseBootMarkers(text) {
  /** @type {{ name: string, t: number }[]} */
  const chain = [];
  /** @type {Map<string, number>} */
  const begins = new Map();
  /** @type {Timing[]} */
  const spans = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = MARK_LINE.exec(line.trim());
    if (!m) continue;
    const [, name, raw] = m;
    const t = Number(raw);
    if (name.endsWith('.begin')) {
      begins.set(phaseName(name.slice(0, -'.begin'.length)), t);
    } else if (name.endsWith('.end')) {
      const base = phaseName(name.slice(0, -'.end'.length));
      const start = begins.get(base);
      if (start !== undefined && t >= start) spans.push({ name: base, ms: toMs(t - start) });
      begins.delete(base);
    } else {
      chain.push({ name: phaseName(name), t });
    }
  }
  /** @type {Timing[]} */
  const phases = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const d = chain[i + 1].t - chain[i].t;
    if (d >= 0) phases.push({ name: chain[i].name, ms: toMs(d) });
  }
  const span = chain.length >= 2 ? chain[chain.length - 1].t - chain[0].t : -1;
  return { phases, spans, totalMs: span >= 0 ? toMs(span) : null };
}

/** The text of the first `-- Boot Record NN --` block (the provisioning boot). */
function firstBootRecord(text) {
  const blocks = String(text ?? '').split(/^-- Boot Record \d+ --$/m);
  return blocks.length > 1 ? blocks[1] : null;
}

/**
 * Parse `cloud-init analyze show`: the total and each stage of the first boot.
 *
 * @param {string} text
 * @returns {{ totalMs: number|null, stages: Timing[] }|null}
 */
export function parseAnalyzeShow(text) {
  const record = firstBootRecord(text);
  if (record === null) return null;
  /** @type {Timing[]} */
  const stages = [];
  for (const m of record.matchAll(/^Finished stage: \((\S+)\) (\d+(?:\.\d+)?) seconds$/gm)) {
    stages.push({ name: m[1], ms: toMs(Number(m[2])) });
  }
  const total = /^Total Time: (\d+(?:\.\d+)?) seconds$/m.exec(record);
  if (!total && stages.length === 0) return null;
  return { totalMs: total ? toMs(Number(total[1])) : null, stages };
}

/**
 * Parse `cloud-init analyze blame`: the first boot's modules, slowest first.
 * cloud-init sorts the zero-padded strings, which misorders anything past
 * 99 seconds; this sorts by value.
 *
 * @param {string} text
 * @returns {Timing[]}
 */
export function parseAnalyzeBlame(text) {
  const record = firstBootRecord(text);
  if (record === null) return [];
  /** @type {Timing[]} */
  const modules = [];
  for (const m of record.matchAll(/^\s+(\d+(?:\.\d+)?)s \((\S+)\)\s*$/gm)) {
    modules.push({ name: m[2], ms: toMs(Number(m[1])) });
  }
  return modules.sort((a, b) => b.ms - a.ms);
}

/** `1min 41.336s`, `2.115s`, `811ms` -> ms. */
function systemdSpanMs(text) {
  let ms = 0;
  let matched = false;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(min|ms|s)\b/g)) {
    matched = true;
    const v = Number(m[1]);
    ms += m[2] === 'min' ? v * 60_000 : m[2] === 's' ? v * 1000 : v;
  }
  return matched ? Math.round(ms) : null;
}

/**
 * Parse the first line of `systemd-analyze`. Empty while boot is unfinished.
 *
 * @param {string} text
 * @returns {Timing[]}
 */
export function parseSystemdAnalyze(text) {
  const m = /^Startup finished in (.+?) = (.+?)\s*$/m.exec(String(text ?? ''));
  if (!m) return [];
  /** @type {Timing[]} */
  const out = [];
  for (const part of m[1].split(' + ')) {
    const p = /^(.+) \((\w+)\)$/.exec(part.trim());
    const ms = p ? systemdSpanMs(p[1]) : null;
    if (p && ms !== null) out.push({ name: p[2], ms });
  }
  const total = systemdSpanMs(m[2]);
  if (total !== null) out.push({ name: 'total', ms: total });
  return out;
}

/**
 * Split the remote script's output into its sections.
 *
 * @param {string} raw
 * @returns {{ skipped: string|null, markers: string, show: string, blame: string, systemd: string }}
 */
export function parseBootReport(raw) {
  /** @type {Record<string, string[]>} */
  const sections = {};
  let current = null;
  for (const line of String(raw ?? '').split('\n')) {
    const h = /^==> (\w+) <==$/.exec(line);
    if (h) {
      current = h[1];
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  const text = (name) => (sections[name] ?? []).join('\n').trim();
  return {
    skipped: sections.skip ? text('skip') || 'skipped' : null,
    markers: text('markers'),
    show: text('show'),
    blame: text('blame'),
    systemd: text('systemd'),
  };
}

/** `modules-final/config-scripts_user` -> `scripts_user`. */
function shortModuleName(name) {
  return name
    .split('/')
    .pop()
    .replace(/^config-/, '');
}

/**
 * The stages to emit, in a stable order.
 *
 * @param {ReturnType<typeof parseBootReport>} report
 * @returns {StageTiming[]}
 */
export function summarizeBootTiming(report) {
  if (!report || report.skipped) return [];
  /** @type {StageTiming[]} */
  const out = [];
  const show = parseAnalyzeShow(report.show);
  if (show?.totalMs != null) out.push({ stage: 'cloudInit.total', ms: show.totalMs });
  for (const s of show?.stages ?? []) out.push({ stage: `cloudInit.stage.${s.name}`, ms: s.ms });

  const modules = parseAnalyzeBlame(report.blame);
  const seen = new Set();
  for (const m of modules) {
    if (seen.size >= TOP_MODULES || m.ms <= 0) break;
    const name = shortModuleName(m.name);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ stage: `cloudInit.module.${name}`, ms: m.ms });
  }

  const markers = parseBootMarkers(report.markers);
  if (markers.totalMs !== null) out.push({ stage: 'script.total', ms: markers.totalMs });
  for (const p of markers.phases) out.push({ stage: `script.${p.name}`, ms: p.ms });
  for (const s of markers.spans) out.push({ stage: `script.${s.name}`, ms: s.ms });
  // The part of the user script the marks do not cover: on compose, a
  // provider's docker install spliced in ahead of the first runcmd mark.
  const scriptsUser = modules.find((m) => m.name.endsWith('/config-scripts_user'));
  if (scriptsUser && markers.totalMs !== null && scriptsUser.ms >= markers.totalMs) {
    out.push({ stage: 'script.unmarked', ms: scriptsUser.ms - markers.totalMs });
  }

  for (const s of parseSystemdAnalyze(report.systemd)) {
    out.push({ stage: `systemd.${s.name}`, ms: s.ms });
  }
  return out;
}

/**
 * @param {string} prefix  e.g. `deploy.k3s.standby.master`, `scale.server`
 * @param {string} stage   e.g. `script.apt`
 */
export function bootTimingPerfName(prefix, stage) {
  return `${prefix}.boot.${stage}`;
}

/** The one-letter id a mark is written with -> its stage name. */
function phaseName(id) {
  return Object.hasOwn(PHASE_IDS, id) ? PHASE_IDS[id] : id;
}

/**
 * Read one node's first-boot timing and emit it as `[perf]` lines. Resolves
 * in every case (never rejects).
 *
 * @param {object} args
 * @param {string} args.ip
 * @param {string} args.sshKeyPath
 * @param {string} args.prefix  perf name prefix, e.g. `deploy.compose`
 * @param {number} [args.timeoutMs]  the ssh call's bound
 * @param {AbortSignal} [args.signal]  stops the call when the budget runs out
 * @param {boolean} [args.enabled]  defaults to perfEnabled()
 * @param {typeof sshRun} [args.run]
 * @param {(name: string, ms: number) => void} [args.emit]
 * @param {(message: string) => void} [args.warn]
 * @returns {Promise<{ stages: StageTiming[], skipped?: string }>}
 */
export async function collectBootTiming({
  ip,
  sshKeyPath,
  prefix,
  timeoutMs = BOOT_TIMING_BUDGET_MS,
  signal,
  enabled = perfEnabled(),
  run = sshRun,
  emit = perfRecord,
  warn = (message) => process.stderr.write(`${message}\n`),
}) {
  if (!enabled) return { stages: [] };
  const sayOnce = (reason) => {
    try {
      warn(`[boot-timing] ${prefix}: boot timing not collected (${reason})`);
    } catch {
      // a warning must never fail the command either
    }
  };
  try {
    if (signal?.aborted) throw new Error('out of time');
    const call = Promise.resolve().then(() =>
      run(ip, sshKeyPath, ['sh', '-s'], {
        input: BOOT_TIMING_SCRIPT,
        timeout: timeoutMs,
        transportRetry: false,
        ...(signal && { signal }),
      }),
    );
    // The budget ends this node's wait even if the call ignores the signal.
    const raw = signal
      ? await Promise.race([
          call,
          new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('out of time')), {
              once: true,
            }),
          ),
        ])
      : await call;
    call.catch(() => {});
    const report = parseBootReport(raw);
    if (report.skipped) return { stages: [], skipped: report.skipped };
    const stages = summarizeBootTiming(report);
    if (stages.length === 0) {
      sayOnce('the node reported no timing');
      return { stages };
    }
    for (const { stage, ms } of stages) emit(bootTimingPerfName(prefix, stage), ms);
    return { stages };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sayOnce(message.split('\n')[0].slice(0, 160));
    return { stages: [] };
  }
}

/** @type {{ ip: string, sshKeyPath: string, prefix: string }[]} */
const queue = [];

/**
 * Note nodes whose ready wait just finished on a fresh provision. No I/O: the
 * reading happens in flushBootTiming once the command is over. A no-op when
 * perf tracing is off. Nodes without an address, and an address already
 * queued, are skipped.
 *
 * @param {{ ip?: string|null, prefix: string }[]} nodes
 * @param {string} sshKeyPath
 * @param {{ enabled?: boolean }} [opts]
 */
export function queueBootTiming(nodes, sshKeyPath, { enabled = perfEnabled() } = {}) {
  if (!enabled) return;
  for (const n of nodes) {
    if (!n.ip || queue.some((q) => q.ip === String(n.ip))) continue;
    queue.push({ ip: String(n.ip), sshKeyPath, prefix: n.prefix });
  }
}

/** What is queued (tests). */
export function pendingBootTiming() {
  return queue.map((q) => ({ ...q }));
}

/**
 * Read every queued node's boot timing, in parallel, within one budget, and
 * empty the queue. cli.js calls this after the command's own total is
 * recorded. Resolves in every case, and by the budget at the latest.
 *
 * @param {object} [opts]
 * @param {number} [opts.budgetMs]
 * @param {boolean} [opts.enabled]
 * @param {typeof sshRun} [opts.run]
 * @param {(name: string, ms: number) => void} [opts.emit]
 * @param {(message: string) => void} [opts.warn]
 * @returns {Promise<void>}
 */
export async function flushBootTiming({ budgetMs = BOOT_TIMING_BUDGET_MS, ...deps } = {}) {
  const nodes = queue.splice(0);
  if (nodes.length === 0) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  timer.unref?.();
  try {
    await Promise.all(
      nodes.map((n) =>
        collectBootTiming({
          ...deps,
          ...n,
          timeoutMs: budgetMs,
          signal: controller.signal,
        }),
      ),
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Seconds (float) -> whole ms. */
function toMs(seconds) {
  return Math.round(seconds * 1000);
}
