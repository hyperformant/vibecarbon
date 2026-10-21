import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { composeRestoreScript } from '../../../src/lib/deploy/compose/index.js';
import { buildRecoveryConfig, renderRecoveryConf } from '../../../src/lib/walg/recovery-config.js';

/**
 * Census: neither restore script destroys the live cluster before the fetched
 * backup is proven (H2a). Before this, both cleared PGDATA first and then ran
 * `wal-g backup-fetch ... LATEST`: a fetch that failed (a missing or broken
 * backup, a full disk, a storage error past the retry budget) left an empty
 * PGDATA and no database at all.
 *
 * Now both fetch a NAMED backup into a staging directory on the same volume,
 * and only once it is complete move the live cluster aside and the staged one
 * in. The live cluster's mount point cannot be renamed (both tiers mount the
 * volume at PGDATA), so staging and the previous cluster live inside it:
 * `$PGDATA/.vc-restore` and `$PGDATA/.vc-prev`. The CLI removes `.vc-prev`
 * only after the restored database promoted and proved writable.
 *
 * The rules, for every line of both scripts:
 *   - an `rm -rf` that names PGDATA targets the staging dir, the previous
 *     cluster or the in-progress marker, never PGDATA or its contents;
 *   - an `rm -rf` of the previous cluster, and every move of the live
 *     cluster's entries, comes after the line that runs `backup-fetch`;
 *   - no `find ... -delete` on PGDATA;
 *   - `backup-fetch` never names LATEST.
 */

const ROOT = process.cwd();
const BACKUP = 'base_000000010000000000000002';

function composeScript(): string {
  return composeRestoreScript({
    backup: BACKUP,
    recoveryConf: renderRecoveryConf(buildRecoveryConfig({ target: 'latest' })),
  });
}

function k8sInitScript(): string {
  const docs = readFileSync(join(ROOT, 'carbon/k8s/base/db/statefulset.yaml'), 'utf-8');
  // biome-ignore lint/suspicious/noExplicitAny: parsed YAML
  const sts = load(docs) as any;
  const init = sts.spec.template.spec.initContainers.find(
    (c: { name: string }) => c.name === 'walg-restore',
  );
  return init.command[2] as string;
}

const SCRIPTS: Array<[string, () => string]> = [
  ['compose composeRestoreScript()', composeScript],
  ['k8s walg-restore init container', k8sInitScript],
];

const PGDATA_REF = /\$\{?PGDATA(?::\?)?\}?/;
// Staging, the previous cluster, the set-aside unproven copy, the marker, and
// the .vc-* names a staged tree may carry (dropped before the swap).
const ALLOWED_RM_TARGET =
  /^"\$\{?PGDATA(?::\?)?\}?\/(\.vc-restore|\.vc-prev|\.vc-discard|\.vc-restore-in-progress|\.vc-restore\/\.vc-[a-z.-]+)"$/;

function codeLines(script: string): string[] {
  return script
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

for (const [label, build] of SCRIPTS) {
  describe(`${label}: nothing destroys the live cluster before the fetch is proven`, () => {
    const lines = codeLines(build());
    const fetchIdx = lines.findIndex((l) => /\bwal-g backup-fetch\b/.test(l));

    it('runs backup-fetch, against a named backup and never LATEST', () => {
      expect(fetchIdx, 'no backup-fetch line').toBeGreaterThan(-1);
      for (const l of lines.filter((x) => x.includes('backup-fetch'))) {
        expect(l).not.toMatch(/\bLATEST\b/);
      }
    });

    it('fetches into the staging dir, not PGDATA', () => {
      expect(lines[fetchIdx]).toMatch(/backup-fetch "\$\{?PGDATA\}?\/\.vc-restore"/);
    });

    it('every rm -rf on PGDATA targets staging, the previous cluster or the marker', () => {
      for (const l of lines) {
        if (!/\brm\s+-[a-z]*r/.test(l) || !PGDATA_REF.test(l)) continue;
        const targets = l
          .replace(/.*?\brm\s+-[a-z]+\s+/, '')
          .replace(/\s*(;|&&|\|\||2>).*$/, '')
          .split(/\s+/);
        for (const t of targets) {
          expect(t, `rm target in: ${l}`).toMatch(ALLOWED_RM_TARGET);
        }
      }
    });

    it('before the fetch, removes nothing but the staging dir', () => {
      lines.slice(0, fetchIdx).forEach((l) => {
        if (!/\brm\s+-[a-z]*r/.test(l)) return;
        expect(l, `rm before backup-fetch: ${l}`).toMatch(/^rm -rf "\$PGDATA\/\.vc-restore"$/);
      });
    });

    it('moves no cluster entries anywhere before the fetch', () => {
      lines.slice(0, fetchIdx).forEach((l) => {
        expect(l, `cluster move before backup-fetch: ${l}`).not.toMatch(
          /vc_cluster_entries\s*\|.*\bmv\b/,
        );
        if (/\bmv\b/.test(l)) {
          expect(l, `mv before backup-fetch: ${l}`).not.toMatch(/\.vc-(prev|discard)/);
        }
      });
    });

    it('removes the previous cluster nowhere: the CLI does, after the proof', () => {
      for (const l of lines) {
        if (/\brm\b/.test(l)) expect(l, l).not.toMatch(/"\$PGDATA\/\.vc-prev"/);
      }
    });

    it('writes the marker only by rename (tmp then mv), never in place', () => {
      for (const l of lines) {
        expect(l, `in-place marker write: ${l}`).not.toMatch(/>\s*"\$VC_MARKER"/);
      }
      expect(lines.some((l) => /mv -f "\$VC_MARKER\.tmp" "\$VC_MARKER"/.test(l))).toBe(true);
    });

    it('drops the discard before the marker goes, so no slow step follows the marker removal', () => {
      const markerOff = lines.lastIndexOf('rm -f "$VC_MARKER"');
      const lastDiscardRm = lines.reduce(
        (last, l, i) => (l === 'rm -rf "$PGDATA/.vc-discard"' ? i : last),
        -1,
      );
      expect(markerOff).toBeGreaterThan(lastDiscardRm);
      const after = lines.slice(markerOff + 1).filter((l) => /\b(rm|mv|find)\b/.test(l));
      expect(after, after.join('\n')).toEqual([]);
    });

    it('never find -deletes inside PGDATA', () => {
      for (const l of lines) {
        if (/\bfind\b/.test(l) && PGDATA_REF.test(l)) expect(l).not.toMatch(/-delete\b/);
      }
    });
  });
}

describe('the CLI retires a proven .vc-prev with one rename and no removal in front', () => {
  it('RETIRE_PREVIOUS_SH', async () => {
    const { RETIRE_PREVIOUS_SH, REMOVE_DISCARD_SH } = await import(
      '../../../src/lib/walg/restore-layout.js'
    );
    expect(RETIRE_PREVIOUS_SH).not.toMatch(/\brm\b/);
    expect(RETIRE_PREVIOUS_SH).toBe(
      'mkdir -p /var/lib/postgresql/data/.vc-discard && if [ -e /var/lib/postgresql/data/.vc-prev ]; then mv /var/lib/postgresql/data/.vc-prev /var/lib/postgresql/data/.vc-discard/prev.$$; fi',
    );
    // The attempt record goes first and fast, after the marker clear (the k8s
    // init's repeat guard must outlive the marker, never the attempt), then
    // the slow discard.
    expect(REMOVE_DISCARD_SH).toBe(
      'rm -f /var/lib/postgresql/data/.vc-restored-from && rm -rf /var/lib/postgresql/data/.vc-discard',
    );
  });
});

describe('both tiers run the same staged-tree, settle and swap steps', () => {
  function block(script: string, start: string, end: string): string {
    const i = script.indexOf(start);
    const j = script.indexOf(end, i);
    if (i < 0 || j < 0) throw new Error(`no ${start} block`);
    return script
      .slice(i, j + end.length)
      .split('\n')
      .map((l) => l.trim())
      .join('\n');
  }
  for (const [start, end] of [['# --- staged ---', '# --- end swap ---']]) {
    it(start, () => {
      expect(block(k8sInitScript(), start, end)).toBe(block(composeScript(), start, end));
    });
  }
});

describe('k8s walg-restore: the staleness retry clears staging, never PGDATA', () => {
  it('keeps the quarantined WALG_FETCH_ATTEMPTS ladder and its clear targets .vc-restore', () => {
    const script = k8sInitScript();
    expect(script).toContain('WALG_FETCH_ATTEMPTS=5');
    const loop = script.slice(
      script.indexOf('while :; do'),
      script.indexOf('done', script.indexOf('while :; do')),
    );
    const clears = loop.split('\n').filter((l) => /\brm\s+-rf\b/.test(l));
    expect(clears.length).toBeGreaterThan(0);
    for (const l of clears) expect(l.trim()).toBe('rm -rf "$PGDATA/.vc-restore"');
  });
});

/**
 * Census (C11): listing base backups is the CLI's job, from the stop
 * sentinels in the bucket (src/lib/walg/restore-base.js listBaseBackups).
 * `wal-g backup-list` over SSH depended on a running db, and the restore
 * point it offered could disagree with what the fetch then took.
 */
describe('no wal-g backup-list under src/', () => {
  // walg-audit.js runs it INSIDE the db container on purpose: the probe proves
  // the container's own credentials and prefix reach storage at deploy time.
  const ALLOW = new Set(['src/lib/deploy/walg-audit.js']);

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  }

  it('only walg-audit.js names it', () => {
    const offenders = walk(join(ROOT, 'src'))
      .filter((f) => /\.(js|ts|mjs|sh)$/.test(f))
      .map((f) => relative(ROOT, f))
      .filter((f) => !ALLOW.has(f))
      .filter((f) =>
        /wal-g['"\s,]+backup-list|wal-g backup-list/.test(readFileSync(join(ROOT, f), 'utf-8')),
      );
    expect(offenders).toEqual([]);
  });
});
