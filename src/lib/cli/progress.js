/**
 * Spinner-safe progress logging.
 *
 * clack draws a spinner as a single cursor-controlled line. ANY raw write to
 * stdout/stderr while a spinner is active (a retry logger's `console.error`, a
 * background task's log) shreds that line — the spinner appears frozen and the
 * cursor strays. This was the root cause of the "spinners aren't working"
 * reports on flaky connections, where SSH/registry/pulumi retry loggers spammed
 * raw `[retry] …` lines over an active spinner.
 *
 * The fix is a tiny registry: `spinner()` is a drop-in for `p.spinner()` that
 * records itself as the active spinner while running, and `progressLog()` routes
 * transient messages through that active spinner (`.message()`, which updates the
 * line cleanly) or falls back to `console.error` when none is running. Retry
 * loggers call `progressLog` instead of `console.error`, so they update the
 * spinner instead of corrupting it — with zero behavior change when no spinner
 * is up.
 */

import * as p from '@clack/prompts';

/** The spinner currently animating, or null. Only one clack spinner is ever
 *  meant to be active at a time. */
let _active = null;

/**
 * True only when we can cleanly cursor-animate a spinner in place. Otherwise
 * the frame loop degrades to one line per tick — hundreds of identical lines
 * over a long step. We fall back to a quiet start/stop when ANY of:
 *  - stdout is not a TTY (piped/redirected/captured): cursor-erase is a no-op.
 *  - a CI signal is present (`CI`, `CONTINUOUS_INTEGRATION`, `GITHUB_ACTIONS`):
 *    clack itself prints per-frame under CI, and CI logs want plain lines.
 *  - `TERM=dumb` or `NO_COLOR`: the terminal has opted out of control codes.
 *  - `VIBECARBON_PLAIN` is set: explicit operator escape hatch for any terminal
 *    (or output capture) that doesn't honor `\e[1G\e[J` cursor-erase.
 * @param {NodeJS.WriteStream} [out]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function shouldAnimateSpinner(out = process.stdout, env = process.env) {
  if (out?.isTTY !== true) return false;
  if (env.VIBECARBON_PLAIN) return false;
  if (env.NO_COLOR) return false;
  if (env.TERM === 'dumb') return false;
  if (env.CI || env.CONTINUOUS_INTEGRATION || env.GITHUB_ACTIONS) return false;
  return true;
}

/**
 * Non-animating stand-in for a clack spinner. Emits ONE clean line on start and
 * on stop (plus on a genuinely changed message), never a per-frame stream.
 * Same surface as a clack spinner (start/message/stop/error/cancel) and still
 * registers as `_active` so the dead-air guard treats the work as covered and
 * `progressLog` has somewhere to route.
 */
function quietSpinner() {
  let last = null;
  const api = {
    start(msg) {
      _active = api;
      last = null;
      if (msg != null && msg !== last) {
        last = msg;
        p.log.info(msg);
      }
      return api;
    },
    message(msg) {
      // Only emit on a real change so a caller (or progressLog retry chatter)
      // that repeats the same text can't reintroduce line-spam.
      if (msg != null && msg !== last) {
        last = msg;
        p.log.info(msg);
      }
    },
    stop(msg, code) {
      if (_active === api) _active = null;
      if (msg != null) (code === 1 ? p.log.error : p.log.success)(msg);
    },
    error(msg) {
      if (_active === api) _active = null;
      if (msg != null) p.log.error(msg);
    },
    cancel(msg) {
      if (_active === api) _active = null;
      if (msg != null) p.log.warn(msg);
    },
  };
  return api;
}

/**
 * Clip an animated-spinner message so the RENDERED frame can never wrap the
 * terminal. clack renders `<frame>  <message><suffix>` — a 3-column prefix,
 * then up to 3 animation dots (or a ` [59m 59s]`-style elapsed suffix for
 * `{ indicator: 'timer' }` spinners) — but its per-frame erase counts rows
 * from the BARE message, not the rendered frame. So a frame that outgrows the
 * terminal by even one column wraps to a second row the erase doesn't cover,
 * and EVERY tick leaks a line (the 'Transferring app image…' spam: clean
 * through dots 0–2, one leaked line per frame the moment the dot cycle hit 3).
 * The reserve must therefore cover the whole rendered overhead, not just the
 * prefix.
 * @param {string} msg
 * @param {number} [cols]
 * @param {number} [reserve]
 */
export const DOTS_RESERVE = 7; // 3 frame prefix + 3 dots + 1 safety
export const TIMER_RESERVE = 16; // 3 frame prefix + 12 for " [599m 59s]" + 1 safety

export function clipToWidth(msg, cols = process.stdout.columns, reserve = DOTS_RESERVE) {
  if (typeof msg !== 'string' || !cols) return msg;
  const max = cols - reserve;
  if (max <= 10 || msg.length <= max) return msg;
  return `${msg.slice(0, max - 1)}…`;
}

/**
 * Drop-in replacement for `p.spinner()` that registers itself as the active
 * spinner between start() and stop() so `progressLog` can route through it.
 * On a real interactive TTY this is a transparent clack spinner (with messages
 * clipped to the terminal width so long labels can't wrap and defeat clack's
 * erase); under CI or a non-TTY it degrades to a quiet start/stop (see
 * shouldAnimateSpinner) so clack can't spam one line per frame. Options
 * (e.g. `{ indicator: 'timer' }`) are forwarded to `p.spinner()`.
 *
 * @param {Parameters<typeof p.spinner>[0]} [opts]
 */
export function spinner(opts) {
  if (!shouldAnimateSpinner()) return quietSpinner();
  const s = p.spinner(opts);
  const reserve = opts?.indicator === 'timer' ? TIMER_RESERVE : DOTS_RESERVE;
  const _start = s.start.bind(s);
  s.start = (msg) => {
    _active = s;
    return _start(clipToWidth(msg, process.stdout.columns, reserve));
  };
  if (typeof s.message === 'function') {
    const _message = s.message.bind(s);
    s.message = (msg) => _message(clipToWidth(msg, process.stdout.columns, reserve));
  }
  // Every terminal method (stop / error / cancel) de-registers us — otherwise a
  // spinner ended via .error() (e.g. destroy's orphan loop) would leave a stale
  // active ref and the next progressLog() would land on a dead line. Only clear
  // if we're still the active one — a sibling that already took over must not be
  // un-registered by our terminal call.
  for (const method of ['stop', 'error', 'cancel']) {
    if (typeof s[method] === 'function') {
      const orig = s[method].bind(s);
      s[method] = (...args) => {
        if (_active === s) _active = null;
        return orig(...args);
      };
    }
  }
  return s;
}

/**
 * Emit a transient progress / retry message without corrupting an active
 * spinner. Routes to the active spinner's message line if one is running,
 * otherwise to stderr (same visible behavior as the raw console.error it
 * replaces).
 *
 * @param {string} message
 */
export function progressLog(message) {
  if (_active && typeof _active.message === 'function') {
    _active.message(message);
  } else {
    console.error(message);
  }
}

// --- Dead-air guard --------------------------------------------------------
//
// Complement to the registry above: the registry keeps OTHER output from
// corrupting a running spinner; the guard keeps the ABSENCE of a spinner from
// looking like a hang. Any awaited work that renders nothing (the class of
// bug behind the pre-plan silent window fixed in a3bb44e) trips it: after
// thresholdMs with no stdout/stderr writes, no registered spinner, and no
// prompt waiting on raw-mode stdin, a self-drawn fallback line appears and a
// [deadair] marker is emitted for log mining.
//
// The fallback is deliberately NOT a clack spinner — it is drawn through
// `drawWrite` (which bypasses the guard's own write-wrap, so frames don't
// count as activity) and erased the moment any foreign write arrives, so it
// can never fight clack output. Spec:
// the deadair-guard-design spec

const ESC = '\u001b';
const ERASE_LINE = `\r${ESC}[2K`;
const FALLBACK_FRAMES = ['◒', '◐', '◓', '◑'];

/** Active guard state, or null. One guard at a time — re-arming replaces. */
let _guard = null;

/**
 * @param {object} [opts]
 * @param {number} [opts.thresholdMs]  Silence needed before dead air is declared.
 * @param {number} [opts.pollMs]  Poll cadence (also the fallback frame rate).
 * @param {number} [opts.markerEveryMs]  Re-emit cadence while dead air persists.
 * @param {(seconds: number) => void} [opts.onDeadAir]  Marker sink.
 * @param {(s: string) => boolean} [opts.drawWrite]  Terminal write used for
 *   fallback frames/erases. Pass a pre-tee write to keep frames out of logs.
 * @param {boolean} [opts.isTTY]  Draw the fallback line (markers emit regardless).
 * @param {() => boolean} [opts.stdinIsRaw]  True while a prompt owns stdin.
 */
export function armDeadAirGuard({
  thresholdMs = 2_000,
  pollMs = 500,
  markerEveryMs = 5_000,
  onDeadAir = null,
  drawWrite = null,
  isTTY = process.stdout.isTTY === true,
  stdinIsRaw = () => process.stdin.isTTY === true && process.stdin.isRaw === true,
} = {}) {
  disarmDeadAirGuard();

  // Keep the unbound originals for identity-preserving restore; call through
  // bound copies.
  const rawStdout = process.stdout.write;
  const rawStderr = process.stderr.write;
  const callStdout = rawStdout.bind(process.stdout);
  const callStderr = rawStderr.bind(process.stderr);
  const draw = drawWrite || callStdout;

  const g = {
    rawStdout,
    rawStderr,
    lastActivity: Date.now(),
    lastMarkerElapsed: null,
    fallbackVisible: false,
    frame: 0,
    timer: null,
  };

  const clearFallback = () => {
    if (!g.fallbackVisible) return;
    g.fallbackVisible = false;
    draw(ERASE_LINE);
  };
  g.clearFallback = clearFallback;

  // Any foreign write is proof of life: erase the fallback first so clack (or
  // anything else) draws onto a clean line, then reset the silence window.
  const noteActivity = () => {
    clearFallback();
    g.lastActivity = Date.now();
    g.lastMarkerElapsed = null;
  };

  process.stdout.write = (chunk, encoding, cb) => {
    noteActivity();
    return callStdout(chunk, encoding, cb);
  };
  process.stderr.write = (chunk, encoding, cb) => {
    noteActivity();
    return callStderr(chunk, encoding, cb);
  };

  g.timer = setInterval(() => {
    // A running spinner or a prompt waiting on raw-mode stdin is byte-silent
    // but not dead air — keep bumping the clock so a fresh window is required
    // after it ends.
    if (_active || stdinIsRaw()) {
      clearFallback();
      g.lastActivity = Date.now();
      g.lastMarkerElapsed = null;
      return;
    }
    const elapsed = Date.now() - g.lastActivity;
    if (elapsed < thresholdMs) return;
    if (
      onDeadAir &&
      (g.lastMarkerElapsed === null || elapsed - g.lastMarkerElapsed >= markerEveryMs)
    ) {
      g.lastMarkerElapsed = elapsed;
      try {
        onDeadAir(Math.round(elapsed / 1000));
      } catch {
        // marker sinks are best-effort — never break the deploy for logging
      }
    }
    if (isTTY) {
      g.fallbackVisible = true;
      draw(`${ERASE_LINE}${FALLBACK_FRAMES[g.frame++ % FALLBACK_FRAMES.length]} Still working…`);
    }
  }, pollMs);
  g.timer.unref?.();

  _guard = g;
}

export function disarmDeadAirGuard() {
  if (!_guard) return;
  clearInterval(_guard.timer);
  _guard.clearFallback();
  process.stdout.write = _guard.rawStdout;
  process.stderr.write = _guard.rawStderr;
  _guard = null;
}
