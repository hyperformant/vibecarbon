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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectPathFor } from '../../../src/lib/template-paths.js';
import { getFilePolicy } from '../../../src/lib/upgrade-policy.js';
import { gitScrubbedEnv } from '../../_shared/git-env.js';

const CARBON = join(__dirname, '../../../carbon');

/**
 * The template's files, as git sees them. A walk of the disk also finds a
 * developer's gitignored output (a local docker-compose.dev-init.yml mounting
 * volumes/db/super-admin.generated.sql), which is no part of the template and
 * failed this census on any checkout that had one.
 */
function templateFiles(): string[] {
  // Inside a git hook, GIT_DIR points at the repository without a work tree,
  // which makes git treat CARBON as the tree root and list its node_modules
  // (no root .gitignore applies there). Run it as a plain invocation.
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: CARBON,
    encoding: 'utf-8',
    env: gitScrubbedEnv(),
  })
    .split('\n')
    .filter((f) => f && existsSync(join(CARBON, f)))
    .map((f) => projectPathFor(f));
}

const shipped = (f: string) => getFilePolicy(f) !== 'never';
const all = templateFiles();
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

  it('every core bind-mount source exists in the template, or is a runtime dir the CLI writes', () => {
    // Runtime directories: no template file backs them; the CLI creates them
    // on the server before the stack starts. Each entry says who.
    const RUNTIME_DIRS: Record<string, string> = {
      // The wal-g role (D7): composeWalgRoleWriteShell (walg-role.js) makes
      // /opt/<project>/.vibecarbon-role and writes walg-role in it before
      // every compose `up` (deploy's write-node-roles, scale's replacement).
      '.vibecarbon-role': 'composeWalgRoleWriteShell',
    };
    expect(mounts.some((m) => m.source in RUNTIME_DIRS)).toBe(true);
    // The core files only: an add-on's compose file mounts directories its
    // service module scaffolds, outside this template.
    const core = mounts.filter((m) => /^docker-compose(\.prod)?\.yml$/.test(m.from));
    const missing = core
      .filter((m) => !(m.source in RUNTIME_DIRS) && !existsSync(join(CARBON, m.source)))
      .map((m) => `${m.from} mounts ./${m.source}, which the template does not ship`);
    expect(missing).toEqual([]);
    // A runtime dir never collides with a template path upgrade would ship.
    for (const dir of Object.keys(RUNTIME_DIRS)) {
      expect(existsSync(join(CARBON, dir)), dir).toBe(false);
    }
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
