/**
 * A `Promise.race` timeout arm must not hold the event loop open after
 * the race is decided.
 *
 * 2026-08-23, handle-probe evidence from the perf matrix (hetzner batch +
 * DO re-leg): every `destroy` CLI lingered ~175s past its own completion
 * banner — `cli.destroy.total 41739ms` but `loop drained at +220845ms`.
 * The cause: destroy's backup-bucket purge races the S3 purge against a
 * bare `setTimeout(..., 180_000)`. When the purge wins (the normal case),
 * the losing timer keeps the process alive until it fires. Three destroys
 * per scenario × 3 minutes = ~9 wasted CI minutes per leg, and any
 * step-wall measurement of destroy silently absorbs the tail.
 *
 * status.js already carries the correct idiom (`t.unref()` + comment).
 * This census walks EVERY Promise.race in src/ whose arm starts a timer
 * and requires the timer be unref'd or cleared — so the next timeout arm
 * cannot reintroduce the class.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function allJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...allJsFiles(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

interface RaceSite {
  file: string;
  line: number;
  window: string;
}

/** Every Promise.race site, with the ~30 lines that follow it. */
function raceSites(): RaceSite[] {
  const sites: RaceSite[] = [];
  for (const file of allJsFiles(SRC)) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((text, i) => {
      if (!text.includes('Promise.race')) return;
      if (text.trimStart().startsWith('*') || text.trimStart().startsWith('//')) return;
      sites.push({
        file: file.slice(SRC.length + 1),
        line: i + 1,
        // Comments don't keep the event loop alive — match code only, so a
        // comment MENTIONING unref can't satisfy the census.
        window: lines
          .slice(i, i + 30)
          .filter((l) => {
            const t = l.trimStart();
            return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
          })
          .join('\n'),
      });
    });
  }
  return sites;
}

describe('Promise.race timer arms must not hold the event loop', () => {
  const sites = raceSites();

  it('walks a non-trivial surface (never vacuously green)', () => {
    // destroy.js purge, status.js replication probe, two admin-probe races.
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });

  it.each(sites.map((s) => [`${s.file}:${s.line}`, s]))(
    '%s: a setTimeout arm is unref’d or cleared',
    (_label, site) => {
      const { window } = site as RaceSite;
      if (!window.includes('setTimeout(')) return; // races promises, not timers
      expect(
        /\.unref\(\)|unref === 'function'|clearTimeout\(/.test(window),
        `Promise.race at ${(site as RaceSite).file}:${(site as RaceSite).line} starts a timer ` +
          'that outlives the race — unref() it (see status.js) or clearTimeout in a finally',
      ).toBe(true);
    },
  );
});
