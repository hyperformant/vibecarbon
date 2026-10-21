/**
 * Census: a file `vibecarbon upgrade` ships (safe or merge) must never depend
 * on a template file upgrade refuses to ship (never). Otherwise an upgraded
 * project runs the new script against the old dependency, or mounts a path
 * that does not exist on disk (Docker then mounts an empty directory there).
 *
 * Two dependency shapes are checked:
 *   1. a compose file's `./<path>:<container path>` bind mount, and
 *   2. a shell script sourcing a container path (`. "${X:-/etc/...}"`),
 *      resolved to its template file through the compose mounts.
 *
 * The 0.5x backup branch shipped compose-backup.sh (safe) sourcing a new
 * volumes/db/walg-env.sh (never): every upgraded compose backup exited 1.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectPathFor } from '../../../src/lib/template-paths.js';
import { getFilePolicy } from '../../../src/lib/upgrade-policy.js';

const CARBON = join(__dirname, '../../../carbon');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(projectPathFor(relative(CARBON, p)));
  }
  return out;
}

const shipped = (f: string) => getFilePolicy(f) !== 'never';
const all = walk(CARBON);
const composeFiles = all.filter((f) => /^docker-compose[^/]*\.yml$/.test(f) && shipped(f));

/** Every template file a mount source covers (a file, or each file under a directory). */
function filesUnder(src: string): string[] {
  const abs = join(CARBON, src);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [src];
  return all.filter((f) => f.startsWith(`${src}/`));
}

const mounts: { from: string; source: string; target: string }[] = [];
for (const f of composeFiles) {
  for (const m of readFileSync(join(CARBON, f), 'utf-8').matchAll(
    /^\s*-\s+\.\/([^:\s]+):([^:\s]+)/gm,
  )) {
    mounts.push({ from: f, source: m[1].replace(/\/$/, ''), target: m[2] });
  }
}

describe('upgrade ships every file a shipped file depends on', () => {
  it('finds the compose mounts it checks', () => {
    expect(mounts.some((m) => m.source === 'volumes/db/walg-env.sh')).toBe(true);
  });

  it('every bind-mount source of a shipped compose file is shipped too', () => {
    const stranded = mounts.flatMap((m) =>
      filesUnder(m.source)
        .filter((f) => !shipped(f))
        .map((f) => `${m.from} mounts ${f}`),
    );
    expect(stranded).toEqual([]);
  });

  it('every container path a shipped shell script sources resolves to a shipped file', () => {
    const scripts = all.filter((f) => f.endsWith('.sh') && shipped(f));
    expect(scripts).toContain('backup/compose-backup.sh');
    const stranded: string[] = [];
    for (const s of scripts) {
      const text = readFileSync(join(CARBON, s), 'utf-8');
      for (const m of text.matchAll(/^\s*\.\s+"?\$\{[A-Z_]+:-([^}]+)\}"?/gm)) {
        const mount = mounts.find((x) => x.target === m[1]);
        expect(mount, `${s} sources ${m[1]}, which no compose file mounts`).toBeTruthy();
        if (mount && !shipped(mount.source)) stranded.push(`${s} sources ${mount.source}`);
      }
    }
    expect(stranded).toEqual([]);
  });
});
