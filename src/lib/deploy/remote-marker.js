/**
 * Wait for a marker file on a server over ONE held SSH session.
 *
 * The old boot waits opened a fresh SSH connection every poll. This holds the
 * session instead: the remote script returns the moment the marker exists and
 * streams the boot log while it waits, so the spinner can say what the server
 * is doing. The script ends itself after `holdS`, so a half-open connection
 * cannot use up the deadline, and the caller reconnects.
 */

import { hasSentinelLine } from '../remote-sentinel.js';
import { shEscape } from '../shell.js';

/**
 * The remote script. Prints CONNECTED, then READY the moment `markerPath`
 * exists. With `logPath` it streams that log from its first line while it
 * waits. Ends by itself after `holdS` seconds (non-zero, no READY).
 *
 * @param {string} markerPath
 * @param {{holdS: number, logPath?: string}} options
 * @returns {string}
 */
export function markerWaitScript(markerPath, { holdS, logPath }) {
  return [
    'echo CONNECTED',
    `timeout ${Math.max(1, Math.ceil(holdS))} sh -c '`,
    '  [ -f "$1" ] && exit 0',
    '  ( until [ -f "$1" ]; do sleep 0.2; done ) & w=$!',
    '  [ -z "$2" ] || tail -n +1 -s 0.2 -F --pid="$w" "$2" 2>/dev/null',
    '  wait "$w"',
    `' _ ${shEscape(markerPath)} ${shEscape(logPath ?? '')} && echo READY`,
  ].join('\n');
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} args
 * @param {(script: string, opts: {timeoutMs: number, onLine: (line: string) => void}) => Promise<string|null>} args.run
 *   Runs the script remotely; calls onLine per stdout line as it arrives;
 *   resolves to stdout or null. Never throws.
 * @param {string} args.markerPath
 * @param {string} [args.logPath]
 * @param {number} args.deadlineMs - absolute time (same clock as `now`)
 * @param {number} [args.holdS=30]
 * @param {number} [args.reconnectDelayMs=750]
 * @param {(line: string) => void} [args.onLine] - log lines (never the sentinels)
 * @param {() => void} [args.onConnected] - fires once
 * @param {() => number} [args.now]
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @returns {Promise<{ready: boolean, connected: boolean}>}
 */
export async function waitForRemoteMarker({
  run,
  markerPath,
  logPath,
  deadlineMs,
  holdS = 30,
  reconnectDelayMs = 750,
  onLine,
  onConnected,
  now = Date.now,
  sleep = defaultSleep,
}) {
  let connected = false;
  let ready = false;
  const markConnected = () => {
    if (connected) return;
    connected = true;
    onConnected?.();
  };
  const handleLine = (raw) => {
    const line = String(raw).trim();
    if (line === 'CONNECTED') return markConnected();
    if (line === 'READY') {
      markConnected();
      ready = true;
      return;
    }
    markConnected();
    if (line) onLine?.(line);
  };

  while (now() < deadlineMs) {
    const remainingS = (deadlineMs - now()) / 1000;
    const timeoutMs = Math.min(holdS, remainingS) * 1000 + 5000;
    const script = markerWaitScript(markerPath, {
      holdS: Math.min(holdS, Math.ceil(remainingS)),
      logPath,
    });
    let streamed = false;
    const out = await run(script, {
      timeoutMs,
      onLine: (line) => {
        streamed = true;
        handleLine(line);
      },
    });
    // A run that cannot stream still reports through its resolved stdout.
    if (out != null) {
      markConnected();
      if (!streamed) for (const line of String(out).split('\n')) handleLine(line);
      if (hasSentinelLine(out, 'READY')) ready = true;
    }
    if (ready) return { ready: true, connected };
    await sleep(reconnectDelayMs);
  }
  return { ready: false, connected };
}
