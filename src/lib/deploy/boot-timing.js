/**
 * First-boot timing for freshly provisioned nodes.
 *
 * A node's ready wait (`deploy.<prefix>.waitForReady`,
 * `deploy.compose.cloudInitReady`, ...) is one opaque number covering the
 * whole of cloud-init. This module opens it up: once the wait has finished,
 * it reads the node's own record of that boot over ssh and emits one
 * `[perf] deploy.<prefix>.boot.<stage> <ms>ms` line per stage, so the timings
 * reach the perf summary and the e2e `perf_substep` capture through the same
 * stderr parser as every other `[perf]` line.
 *
 * Three sources, all read in one ssh round trip (BOOT_TIMING_SCRIPT):
 *
 *   - `cloud-init analyze show`: total cloud-init time and each stage
 *     (init-local, init-network, modules-config, modules-final).
 *   - `cloud-init analyze blame`: the slowest modules.
 *   - BOOT_MARK_LOG: one `<phase> <epoch seconds>` line per major phase,
 *     written by the cloud-init scripts in carbon/cloud-init/. A plain mark
 *     starts a sequential phase that runs until the next plain mark (the last
 *     one, `done`, only closes the chain). `<name>.begin` / `<name>.end`
 *     bracket a background span (the compose boot image pull) that overlaps
 *     the chain.
 *   - `systemd-analyze`: kernel and userspace boot time, when systemd says
 *     boot has finished.
 *
 * Once per node, cold provisions only: the script reports nothing on a node
 * without the marker log (provisioned before the marks existed, so its boot
 * is not a fresh one) and leaves a sentinel beside the log, so a later deploy
 * that re-runs the ready wait reports nothing again.
 *
 * Never fails a deploy: `collectBootTiming` resolves in every case, prints at
 * most one warning, and is meant to be started without being awaited. It only
 * runs when perf tracing is on (VIBECARBON_PERF=1).
 */

import { perfEnabled, perfRecord } from '../perf.js';
import { sshRun } from '../ssh.js';

/** Where the cloud-init scripts append their phase marks. */
export const BOOT_MARK_LOG = '/var/log/vibecarbon-boot.log';

/** Written beside the log once a node's boot has been reported. */
export const BOOT_REPORTED_SENTINEL = '/var/log/vibecarbon-boot.reported';

/**
 * How long the remote script waits for cloud-init to finish. A master's ready
 * flag lands seconds before cloud-init's final modules finish, and a db or
 * worker node may still be joining when the master turns ready.
 */
const CLOUD_INIT_WAIT_SEC = 180;

/** How long the remote script waits for the detached compose boot pull. */
const BOOT_PULL_WAIT_SEC = 90;

/** The ssh call's own bound: both waits plus the analysis itself. */
const COLLECT_TIMEOUT_MS = (CLOUD_INIT_WAIT_SEC + BOOT_PULL_WAIT_SEC + 30) * 1000;

/** How many of the slowest cloud-init modules to report. */
const TOP_MODULES = 5;

/**
 * The remote half, fed to `sh -s` on stdin. Prints one `==> <section> <==`
 * header per source, or `==> skip <==` and a reason.
 */
export const BOOT_TIMING_SCRIPT = `log=${BOOT_MARK_LOG}
sentinel=${BOOT_REPORTED_SENTINEL}
if [ ! -f "$log" ]; then echo '==> skip <=='; echo no-marker-log; exit 0; fi
if [ -f "$sentinel" ]; then echo '==> skip <=='; echo already-reported; exit 0; fi
timeout ${CLOUD_INIT_WAIT_SEC} cloud-init status --wait >/dev/null 2>&1 || true
i=0
while [ "$(cat /var/lib/vibecarbon/boot-pull/status 2>/dev/null)" = running ] && [ "$i" -lt ${BOOT_PULL_WAIT_SEC} ]; do
  sleep 1
  i=$((i + 1))
done
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
      begins.set(name.slice(0, -'.begin'.length), t);
    } else if (name.endsWith('.end')) {
      const base = name.slice(0, -'.end'.length);
      const start = begins.get(base);
      if (start !== undefined && t >= start) spans.push({ name: base, ms: toMs(t - start) });
      begins.delete(base);
    } else {
      chain.push({ name, t });
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
 * @param {string} prefix  e.g. `k3s.standby.master`, `compose`
 * @param {string} stage   e.g. `script.apt`
 */
export function bootTimingPerfName(prefix, stage) {
  return `deploy.${prefix}.boot.${stage}`;
}

/**
 * Read one node's first-boot timing and emit it as `[perf]` lines. Resolves
 * in every case (never rejects), so callers start it without awaiting.
 *
 * @param {object} args
 * @param {string} args.ip
 * @param {string} args.sshKeyPath
 * @param {string} args.prefix  perf name prefix, without `deploy.` / `.boot`
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
      // a warning must never fail the deploy either
    }
  };
  try {
    const raw = await run(ip, sshKeyPath, ['sh', '-s'], {
      input: BOOT_TIMING_SCRIPT,
      timeout: COLLECT_TIMEOUT_MS,
      transportRetry: false,
    });
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

/** Seconds (float) -> whole ms. */
function toMs(seconds) {
  return Math.round(seconds * 1000);
}
