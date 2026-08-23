/**
 * Names the handles that keep a CLI process alive after its work is done.
 *
 * The 2026-08-23 perf audit found k8s warm-deploys and -purge final-destroys
 * lingering 27-180s after printing their completion banner — step wall vs
 * cli.deploy.total proved it, but nothing named the culprit handle. Preloaded
 * into every harness-spawned CLI (cli-runner sets NODE_OPTIONS), this prints
 * the active handle inventory when the event loop finally drains, and — the
 * useful part — a snapshot N seconds after the process SHOULD have exited is
 * visible by diffing the banner timestamp against the beforeExit timestamp.
 *
 * CJS + zero deps so --require works regardless of the CLI's module graph.
 * Output goes to stderr; the harness captures it per-step.
 */
const startedAt = Date.now();
process.on('beforeExit', () => {
  try {
    const handles = process._getActiveHandles ? process._getActiveHandles() : [];
    const lines = handles.map((h) => {
      const name = (h && h.constructor && h.constructor.name) || typeof h;
      if (name === 'Socket') {
        return `Socket remote=${h.remoteAddress || '?'}:${h.remotePort || '?'} local=${h.localPort || '?'}`;
      }
      if (name === 'Timeout') return `Timeout msecs=${h._idleTimeout}`;
      if (name === 'ChildProcess') {
        return `ChildProcess pid=${h.pid} argv=${(h.spawnargs || []).slice(0, 5).join(' ')}`;
      }
      return name;
    });
    process.stderr.write(
      `[handle-probe] loop drained at +${Date.now() - startedAt}ms; ${handles.length} handle(s)\n` +
        lines.map((l) => `[handle-probe]   ${l}\n`).join(''),
    );
  } catch {
    /* the probe must never break the CLI */
  }
});
