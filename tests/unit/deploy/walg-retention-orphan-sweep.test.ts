import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * CLASS (run 33287840597, hetzner compose backup, 2026-08-30 02:36Z): a
 * wal-g backup-push interrupted mid-upload (Hetzner Object Storage stale
 * frontend answered NoSuchBucket for an existing bucket) leaves a
 * sentinel-less orphan — base_…/ data files with no
 * `_backup_stop_sentinel.json`, because the sentinel is written LAST.
 * `wal-g delete retain` then hard-crashes on EVERY subsequent run while
 * "retrieving permanent objects":
 *
 *   ERROR: object 'base_000000020000000000000014_backup_stop_sentinel.json'
 *   not found in storage
 *
 * The withWalgStaleStorageRetry ladder re-ran the whole script 5 times and
 * every attempt failed on the same permanent orphan — a retry cannot heal a
 * missing object. The remedy is wal-g's own: `delete garbage BACKUPS`
 * ("deletes only leftover — partially deleted or unsuccessful — backups
 * files") swept BEFORE `delete retain`, so an orphan from any earlier
 * interrupted push is removed instead of wedging retention forever.
 *
 * Census: every `wal-g delete retain` call site in the template must be
 * preceded (same file) by the garbage sweep. The walk greps carbon/ so a
 * future backup surface (new mode, new script) is drafted automatically.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CARBON = join(ROOT, 'carbon');
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build']);

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkFiles(full));
    else if (/\.(sh|ya?ml)$/.test(entry)) out.push(full);
  }
  return out;
}

// CODE lines only — a doc comment naming `wal-g delete retain` is not a call
// site (the raw-ssh-opts census was fooled by exactly this once).
function codeOf(file: string): string {
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
}

describe('wal-g retention call sites sweep sentinel-less orphans first', () => {
  const retainSites = walkFiles(CARBON).filter((f) => codeOf(f).includes('wal-g delete retain'));

  it('census still sees the two known retention surfaces', () => {
    // Sanity: if a refactor moves these, the census below is guarding nothing.
    const rels = retainSites.map((f) => f.slice(CARBON.length + 1)).sort();
    expect(rels).toContain('backup/compose-backup.sh');
    expect(rels).toContain('k8s/base/backup/cronjob.yaml');
  });

  it.each(retainSites.map((f) => [f.slice(CARBON.length + 1), f] as const))(
    '%s runs `delete garbage BACKUPS --confirm` before `delete retain`',
    (_rel, file) => {
      const body = codeOf(file);
      const sweep = body.indexOf('wal-g delete garbage BACKUPS --confirm');
      const retain = body.indexOf('wal-g delete retain');
      expect(
        sweep,
        'no orphan sweep — an interrupted backup-push wedges retention forever ' +
          '(see 2026-08-30 hetzner compose backup RCA)',
      ).toBeGreaterThan(-1);
      expect(sweep, 'the sweep must run BEFORE delete retain').toBeLessThan(retain);
    },
  );
});
