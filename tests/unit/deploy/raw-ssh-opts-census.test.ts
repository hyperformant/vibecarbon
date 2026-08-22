/**
 * Census: every RAW-STRING ssh invocation in src must carry the shared
 * transport protections.
 *
 * The chokepoints (lib/ssh.js#sshRun, compose sshRun/sshRunAsync,
 * host-keys.js builders) all bake in SSH_CONNECTION_OPTS — BatchMode,
 * ConnectTimeout, ServerAlive keepalives, ControlMaster. But a handful of
 * sites hand-roll `… | ssh …` pipelines inside bash -c strings, and those
 * silently miss whatever the chokepoint gains next. Run 31961619204
 * (compose-ha scale) failed exactly there: the bundle upload's hand-rolled
 * argv had no keepalives/ConnectTimeout and hung 140s into a
 * kex_exchange_identification reset with no retry — a transport class the
 * chokepoints had already root-fixed (mitigation-audit cluster 3).
 *
 * Rule: any line in src that pipes into ssh or execs ssh as a raw string
 * must, within its surrounding window, either interpolate a shared-opts
 * source (composeSshOptsString / SSH_CONNECTION_OPTS) or carry the
 * keepalive literal itself (ServerAliveInterval — the load-bearing
 * protection a hand-rolled subset most often drops).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(fileURLToPath(new URL('../../..', import.meta.url)), 'src');

const RAW_SSH = /(\|\s*ssh\s)|(exec \/usr\/bin\/ssh)/;
const SHARED_MARKERS = /composeSshOptsString|SSH_CONNECTION_OPTS|ServerAliveInterval/;
const WINDOW = 15;

function walk(dir: string, out: string[] = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

describe('raw-string ssh invocations carry the shared transport opts', () => {
  it('every | ssh / exec ssh site references the shared opts (or the keepalive literal)', () => {
    let sites = 0;
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (!RAW_SSH.test(line)) return;
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        sites++;
        // CODE lines only: a comment that merely NAMES the shared opts must
        // not satisfy the census (mutation check: deleting image.js's
        // SSH_CONNECTION_OPTS push initially went unflagged because the
        // explanatory comment above it still matched).
        const windowText = lines
          .slice(Math.max(0, i - WINDOW), i + WINDOW + 1)
          .filter((l) => {
            const t = l.trim();
            return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
          })
          .join('\n');
        expect(
          SHARED_MARKERS.test(windowText),
          `${file}:${i + 1} raw ssh invocation without the shared transport opts ` +
            '(no composeSshOptsString/SSH_CONNECTION_OPTS interpolation and no ServerAlive keepalives) — ' +
            'this is how the bundle-upload kex-reset class (run 31961619204) survives chokepoint fixes',
        ).toBe(true);
      });
    }
    // bundle upload, image sideload, remote-build wrapper at minimum.
    expect(sites).toBeGreaterThanOrEqual(3);
  });
});
