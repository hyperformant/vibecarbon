import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `kubectl wait --for=condition=Ready pods --all` in src/ must exclude
 * terminal-phase pods. A Completed CronJob pod (the in-cluster backup job)
 * never reports Ready, so an unfiltered `--all` wait blocks for its whole
 * budget whenever a run crosses the backup schedule — a time-of-day flake
 * (e4 2026-08-29: every pod 1/1 Running, one backup-* 0/1 Completed, 10-min
 * timeout failed the scale step against a healthy cluster). Terminal-phase
 * pods are done, not not-ready: `status.phase!=Succeeded,status.phase!=Failed`
 * (NOT phase=Running, which would skip Pending pods still coming up).
 *
 * Census walk: any future `wait ... pods --all` site is drafted in
 * automatically. Waits that target a named pod or a label selecting only
 * long-running pods are not members — a job pod can't match them.
 */
describe('pod-Ready wait census', () => {
  it('every `wait --for=condition=Ready pods --all` excludes terminal phases', () => {
    const srcRoot = join(new URL('../../..', import.meta.url).pathname, 'src');
    const files = readdirSync(srcRoot, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.js'))
      .map((d) => join(d.parentPath, d.name));
    let members = 0;
    const misses: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!line.includes("'--all'")) return;
        // Member = an --all in a kubectl wait argv for pod readiness:
        // look back a few lines for the condition and the pods target.
        const back = lines.slice(Math.max(0, i - 6), i).join('\n');
        if (!back.includes('condition=Ready') || !/['"]pods?['"]/.test(back)) return;
        members += 1;
        const ahead = lines.slice(i, i + 12).join('\n');
        if (!/status\.phase!=Succeeded,status\.phase!=Failed/.test(ahead)) {
          misses.push(`${file.replace(srcRoot, 'src')}:${i + 1}`);
        }
      });
    }
    expect(members).toBeGreaterThanOrEqual(1); // census not vacuous
    expect(misses, `unfiltered pod-Ready --all waits: ${misses.join(', ')}`).toEqual([]);
  });
});
