/**
 * Persistent deploy logger.
 *
 * Tees every byte written to process.stdout / process.stderr during a
 * deploy invocation into ~/.vibecarbon/logs/<env>-<ts>.log. Survives
 * cluster teardown and process exit so a failed deploy can be reviewed
 * after the fact — including the long-running Pulumi/k3s/Flux output
 * that's otherwise lost when a session ends.
 *
 * ANSI escape sequences (color, cursor moves, spinner frames) are
 * stripped from the file so it's grep-able and reads cleanly in
 * `less`/editors. The terminal still gets the original colored output.
 *
 * Writes are SYNCHRONOUS (openSync/writeSync). The deploy path ends many
 * failures with `process.exit()`, which drops anything an async
 * `fs.WriteStream` has not flushed, including the file's own open. That made
 * a step that failed and exited (excitingai, 2026-10-16: "S3 setup failed"
 * one second into "Creating S3 bucket") read as a hang in the log, because
 * the failure line never reached the file.
 */

import { closeSync, existsSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { armDeadAirGuard, disarmDeadAirGuard } from './cli/progress.js';
import { perfEnabled } from './perf.js';

// Strip ANSI CSI sequences (ESC + `[` + params + final byte) and bare CRs.
// Built from String.fromCharCode to avoid biome's no-control-characters lint
// rejecting a literal escape in the regex; equivalent to
// `/\x1b\[[0-9;?]*[a-zA-Z]|\r/g`.
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[a-zA-Z]|\\r`, 'g');

/** The running deploy log's writer, or null outside withDeployLog. */
let activeLogWriter = null;

/**
 * Write detail to the deploy log file only, never the terminal. For the full
 * text of an error whose terminal rendering is one summarized line: the
 * operator reads the line, the log keeps the whole thing for diagnosis. A
 * no-op when no deploy log is open.
 * @param {string} text
 */
export function writeLogDetail(text) {
  if (!activeLogWriter) return;
  const s = String(text ?? '').replace(ANSI_RE, '');
  activeLogWriter(s.endsWith('\n') ? s : `${s}\n`);
}

/**
 * Wrap an async function so all stdout/stderr during its run is also
 * tee'd to ~/.vibecarbon/logs/<envName>-<timestamp>.log. Returns
 * whatever the wrapped function returns; rethrows after restoring.
 *
 * Every write lands in the file before the call that made it returns,
 * so the caller can read the log back as soon as the call settles.
 *
 * @param {string} envName  Environment name for the log filename
 *                          (defaults to "deploy" if missing).
 * @param {() => Promise<any>} fn  Async work to run.
 * @returns {Promise<{result: any, logPath: string}>}
 */
export async function withDeployLog(envName, fn) {
  const logDir = join(homedir(), '.vibecarbon', 'logs');
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeEnv = (envName || 'deploy').replace(/[^a-zA-Z0-9_-]/g, '_');
  const logPath = join(logDir, `${safeEnv}-${ts}.log`);
  const fd = openSync(logPath, 'a');
  let open = true;
  const writeLog = (text) => {
    if (!open) return;
    try {
      writeSync(fd, text);
    } catch {
      // best-effort — never break terminal output for the sake of logging
    }
  };
  activeLogWriter = writeLog;

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const tee = (orig) => (chunk, encoding, cb) => {
    try {
      const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      writeLog(s.replace(ANSI_RE, ''));
    } catch {
      // best-effort — never break terminal output for the sake of logging
    }
    return orig(chunk, encoding, cb);
  };

  process.stdout.write = tee(originalStdoutWrite);
  process.stderr.write = tee(originalStderrWrite);

  // Dead-air guard: >2s with no output, no spinner, and no prompt waiting →
  // a fallback "Still working…" line on the terminal plus a [deadair] marker
  // in this log for e2e/perf mining. drawWrite is the pre-tee terminal write
  // so fallback frames never pollute the log file — the marker is the record.
  armDeadAirGuard({
    drawWrite: originalStdoutWrite,
    onDeadAir: (secs) => {
      const line = `[deadair] ${secs}s without spinner or output\n`;
      writeLog(line);
      if (perfEnabled()) originalStderrWrite(line);
    },
  });

  // Header so the file is self-describing.
  writeLog(
    `# vibecarbon deploy log\n# env: ${envName ?? '(unset)'}\n# started: ${new Date().toISOString()}\n# argv: ${process.argv.join(' ')}\n\n`,
  );

  const closeLog = () => {
    if (!open) return;
    open = false;
    if (activeLogWriter === writeLog) activeLogWriter = null;
    try {
      closeSync(fd);
    } catch {}
  };

  const restore = async () => {
    // Disarm before un-installing the tee so the write chain unwinds in
    // reverse order (guard wraps the tee'd writes).
    disarmDeadAirGuard();
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    closeLog();
  };

  try {
    const result = await fn();
    await restore();
    return { result, logPath };
  } catch (err) {
    writeLog(`\n# deploy threw: ${err instanceof Error ? err.stack || err.message : err}\n`);
    await restore();
    throw err;
  }
}
