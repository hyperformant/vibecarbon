import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * carbon/volumes/db/db-guard.sh is the compose db container's entrypoint. A
 * restore leaves `.vc-restore-in-progress` in PGDATA while it swaps the
 * fetched cluster in; a boot that finds it with no restore running would
 * start postgres on a half-moved data directory (or initdb an empty one), so
 * it refuses and says what to do. Otherwise it hands over to the image's own
 * db-entrypoint.sh unchanged.
 */
const GUARD = fileURLToPath(new URL('../../../carbon/volumes/db/db-guard.sh', import.meta.url));

let dir: string;
let pgdata: string;
let bin: string;
let roleDir: string;

function runGuard(env: Record<string, string> = {}) {
  return spawnSync('sh', [GUARD, 'postgres', '-c', 'config_file=/x'], {
    encoding: 'utf-8',
    env: { PATH: `${bin}:${process.env.PATH}`, PGDATA: pgdata, ...env },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-db-guard-'));
  pgdata = join(dir, 'data');
  bin = join(dir, 'bin');
  mkdirSync(pgdata);
  mkdirSync(bin);
  roleDir = join(dir, 'role');
  mkdirSync(roleDir);
  const stub = join(bin, 'db-entrypoint.sh');
  writeFileSync(stub, '#!/bin/sh\necho "STUB-ENTRYPOINT $*"\n');
  chmodSync(stub, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('db-guard.sh', () => {
  it('refuses to boot over an interrupted restore', () => {
    writeFileSync(join(pgdata, '.vc-restore-in-progress'), 'in\n');
    const r = runGuard();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('restore interrupted; rerun vibecarbon restore');
    expect(r.stdout).not.toContain('STUB-ENTRYPOINT');
  });

  it('lets the restore itself through (RESTORE_BACKUP set)', () => {
    writeFileSync(join(pgdata, '.vc-restore-in-progress'), 'in\n');
    const r = runGuard({ RESTORE_BACKUP: 'base_000000010000000000000002' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('STUB-ENTRYPOINT postgres -c config_file=/x');
  });

  it('execs the image entrypoint with the same arguments on a normal boot', () => {
    const r = runGuard();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('STUB-ENTRYPOINT postgres -c config_file=/x');
  });
});

describe('db-guard.sh applies the k8s role intent', () => {
  it('writes the intent atomically into the role dir, then execs the entrypoint', () => {
    const r = runGuard({ VC_WALG_ROLE_INTENT: 'standby', VC_WALG_ROLE_DIR: roleDir });
    expect(r.status).toBe(0);
    expect(readFileSync(join(roleDir, 'walg-role'), 'utf-8')).toBe('standby\n');
    expect(existsSync(join(roleDir, 'walg-role.tmp'))).toBe(false);
    expect(r.stdout).toContain('STUB-ENTRYPOINT postgres');
  });

  it('no intent (compose, or a cluster before its first deploy): leaves the file alone', () => {
    writeFileSync(join(roleDir, 'walg-role'), 'primary\n');
    runGuard({ VC_WALG_ROLE_DIR: roleDir });
    expect(readFileSync(join(roleDir, 'walg-role'), 'utf-8')).toBe('primary\n');
  });

  it('a garbage intent REMOVES the file (no role means hold WAL)', () => {
    writeFileSync(join(roleDir, 'walg-role'), 'primary\n');
    runGuard({ VC_WALG_ROLE_INTENT: 'leader', VC_WALG_ROLE_DIR: roleDir });
    expect(existsSync(join(roleDir, 'walg-role'))).toBe(false);
  });

  it('the intent write ends in sync (the atomic-write constraint)', () => {
    expect(readFileSync(GUARD, 'utf-8')).toMatch(
      /mv -f "\$VC_ROLE_DIR\/walg-role\.tmp" "\$VC_ROLE_DIR\/walg-role"\n\s*sync/,
    );
  });

  it('syncs the tmp before the rename, so the rename never exposes unsynced bytes', () => {
    expect(readFileSync(GUARD, 'utf-8')).toMatch(
      /chmod 0644 "\$VC_ROLE_DIR\/walg-role\.tmp"\n\s*sync\n\s*mv -f "\$VC_ROLE_DIR\/walg-role\.tmp"/,
    );
  });

  it('an interrupted restore still refuses first, before any role write', () => {
    writeFileSync(join(pgdata, '.vc-restore-in-progress'), 'in\n');
    expect(runGuard({ VC_WALG_ROLE_INTENT: 'standby', VC_WALG_ROLE_DIR: roleDir }).status).toBe(1);
    expect(existsSync(join(roleDir, 'walg-role'))).toBe(false);
  });
});

const ID = 'att-7f3c';
const SB = () => ({ VC_WALG_ROLE_INTENT: 'standby', VC_WALG_ROLE_DIR: roleDir });
function stage(id = ID, { conninfo = true, signal = true } = {}) {
  const s = join(pgdata, '.vc-reseed');
  mkdirSync(join(s, 'base'), { recursive: true });
  writeFileSync(join(s, 'PG_VERSION'), '17\n');
  if (signal) writeFileSync(join(s, 'standby.signal'), '');
  writeFileSync(join(s, 'postgresql.auto.conf'), conninfo ? "primary_conninfo = 'host=x'\n" : '');
  writeFileSync(join(s, '.vc-reseed-id'), id);
  writeFileSync(join(pgdata, '.vc-reseed-ready'), id);
}
function live() {
  writeFileSync(join(pgdata, 'PG_VERSION'), '17\n');
  mkdirSync(join(pgdata, 'base'));
  writeFileSync(join(pgdata, 'base', 'OLD'), 'old');
}
/**
 * A `mv` on PATH that fails (like a crash at that step) for one source
 * basename moving to a destination matching `dest`; every other move is real.
 */
function failMv(name: string, dest: string) {
  const real = spawnSync('sh', ['-c', 'command -v mv'], { encoding: 'utf-8' }).stdout.trim();
  const stub = join(bin, 'mv');
  writeFileSync(
    stub,
    `#!/bin/sh\nlast=""; for a; do last="$a"; done\nfor a; do case "$a" in */${name}) case "$last" in ${dest}) echo "stub mv: refusing $a" >&2; exit 1;; esac;; esac; done\nexec ${real} "$@"\n`,
  );
  chmodSync(stub, 0o755);
}
const unfailMv = () => rmSync(join(bin, 'mv'), { force: true });
/** Every reseed bookkeeping entry is gone from PGDATA. */
function expectNoReseedState() {
  for (const f of ['.vc-reseed', '.vc-reseed-ready', '.vc-reseed-in-progress', '.vc-reseed-id']) {
    expect(existsSync(join(pgdata, f)), f).toBe(false);
  }
}
/** The old cluster is the one PGDATA boots, untouched. */
function expectOldTreeBoots(r: ReturnType<typeof runGuard>) {
  expect(r.status, r.stderr).toBe(0);
  expect(readFileSync(join(pgdata, 'base', 'OLD'), 'utf-8')).toBe('old');
  expect(existsSync(join(pgdata, 'standby.signal'))).toBe(false);
  expect(existsSync(join(pgdata, '.vc-reseeded-from'))).toBe(false);
  expect(r.stdout).toContain('STUB-ENTRYPOINT postgres');
}
/** The staged tree is what PGDATA boots, complete. */
function expectNewTreeBoots(r: ReturnType<typeof runGuard>) {
  expect(r.status, r.stderr).toBe(0);
  expect(r.stderr).toContain(`RESEED_SWAPPED ${ID}`);
  expect(readFileSync(join(pgdata, 'PG_VERSION'), 'utf-8')).toBe('17\n');
  expect(existsSync(join(pgdata, 'standby.signal'))).toBe(true);
  expect(readFileSync(join(pgdata, 'postgresql.auto.conf'), 'utf-8')).toContain('primary_conninfo');
  expect(existsSync(join(pgdata, 'base'))).toBe(true);
  expect(existsSync(join(pgdata, 'base', 'OLD'))).toBe(false);
  expect(readFileSync(join(pgdata, '.vc-reseeded-from'), 'utf-8')).toBe(ID);
  expectNoReseedState();
  expect(r.stdout).toContain('STUB-ENTRYPOINT postgres');
}

describe('db-guard.sh reseed swap', () => {
  it('the protocol marker is line 2 (the live-pod guard greps it)', () => {
    expect(readFileSync(GUARD, 'utf-8').split('\n')[1]).toBe('# vc-reseed-protocol: 1');
  });

  it('a standby swaps a verified staging in, keeps the old tree in .vc-discard, records the attempt, then execs postgres', () => {
    live();
    stage();
    const r = runGuard(SB());
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`RESEED_SWAPPED ${ID}`);
    expect(existsSync(join(pgdata, 'standby.signal'))).toBe(true);
    expect(existsSync(join(pgdata, 'base', 'OLD'))).toBe(false);
    expect(existsSync(join(pgdata, '.vc-discard', 'base', 'OLD'))).toBe(true);
    expect(readFileSync(join(pgdata, '.vc-reseeded-from'), 'utf-8')).toBe(ID);
    for (const f of ['.vc-reseed', '.vc-reseed-ready', '.vc-reseed-in-progress', '.vc-reseed-id'])
      expect(existsSync(join(pgdata, f))).toBe(false);
    expect(r.stdout).toContain('STUB-ENTRYPOINT postgres');
    expectNewTreeBoots(r);
  });

  it('C16: a stale ready marker on a PRIMARY (survived a promotion) is refused and cleared; the live tree boots', () => {
    live();
    stage();
    const r = runGuard({ VC_WALG_ROLE_INTENT: 'primary', VC_WALG_ROLE_DIR: roleDir });
    expect(r.stderr).toContain('RESEED_REFUSED');
    expect(existsSync(join(pgdata, 'base', 'OLD'))).toBe(true);
    expect(existsSync(join(pgdata, '.vc-reseed'))).toBe(false);
    expect(existsSync(join(pgdata, '.vc-reseed-ready'))).toBe(false);
    expect(r.stdout).toContain('STUB-ENTRYPOINT');
    expectOldTreeBoots(r);
  });

  it('C16: no intent at all (compose, or no ConfigMap) never swaps', () => {
    live();
    stage();
    const r = runGuard();
    expect(r.stderr).toContain('RESEED_REFUSED');
    expect(existsSync(join(pgdata, 'base', 'OLD'))).toBe(true);
    expectOldTreeBoots(r);
    expectNoReseedState();
  });

  it.each([
    ['an unknown intent', 'leader'],
    ['an empty intent', ''],
    ['a cased intent', 'Standby'],
    ['a padded intent', 'standby '],
  ])('%s never swaps', (_n, intent) => {
    live();
    stage();
    const r = runGuard({ VC_WALG_ROLE_INTENT: intent, VC_WALG_ROLE_DIR: roleDir });
    expect(r.stderr).toContain('RESEED_REFUSED');
    expectOldTreeBoots(r);
    expectNoReseedState();
  });

  it('a staging whose id does not match the ready marker is refused and cleared', () => {
    live();
    stage();
    writeFileSync(join(pgdata, '.vc-reseed', '.vc-reseed-id'), 'other');
    const r = runGuard(SB());
    expect(r.stderr).toContain('RESEED_REFUSED');
    expect(existsSync(join(pgdata, 'base', 'OLD'))).toBe(true);
    expectOldTreeBoots(r);
    expectNoReseedState();
  });

  it('an empty ready marker is refused, even when the staging id is empty too', () => {
    live();
    stage('');
    const r = runGuard(SB());
    expect(r.stderr).toContain('RESEED_REFUSED');
    expectOldTreeBoots(r);
  });

  it.each([
    ['no standby.signal', { signal: false }],
    ['no primary_conninfo', { conninfo: false }],
  ])('refuses a staging with %s', (_n, opts) => {
    live();
    stage(ID, opts);
    const r = runGuard(SB());
    expect(r.stderr).toContain('RESEED_REFUSED');
    expect(existsSync(join(pgdata, 'base', 'OLD'))).toBe(true);
    expectOldTreeBoots(r);
  });

  it('refuses a staging with no PG_VERSION', () => {
    live();
    stage();
    rmSync(join(pgdata, '.vc-reseed', 'PG_VERSION'));
    const r = runGuard(SB());
    expect(r.stderr).toContain('RESEED_REFUSED');
    expectOldTreeBoots(r);
  });

  it('a ready marker with no staging at all is refused and cleared', () => {
    live();
    writeFileSync(join(pgdata, '.vc-reseed-ready'), ID);
    const r = runGuard(SB());
    expect(r.stderr).toContain('RESEED_REFUSED');
    expectOldTreeBoots(r);
    expectNoReseedState();
  });

  it('clears a leftover .vc-discard before it starts a swap (D9: garbage)', () => {
    live();
    stage();
    mkdirSync(join(pgdata, '.vc-discard', 'base'), { recursive: true });
    writeFileSync(join(pgdata, '.vc-discard', 'base', 'ANCIENT'), 'x');
    const r = runGuard(SB());
    expectNewTreeBoots(r);
    expect(existsSync(join(pgdata, '.vc-discard', 'base', 'ANCIENT'))).toBe(false);
    expect(existsSync(join(pgdata, '.vc-discard', 'base', 'OLD'))).toBe(true);
  });

  it('resumes a crash right after the "out" mark, before any move (whatever the intent)', () => {
    live();
    stage();
    mkdirSync(join(pgdata, '.vc-discard'));
    writeFileSync(join(pgdata, '.vc-reseed-in-progress'), `out ${ID}`);
    const r = runGuard({ VC_WALG_ROLE_INTENT: 'primary', VC_WALG_ROLE_DIR: roleDir });
    expectNewTreeBoots(r);
    expect(existsSync(join(pgdata, '.vc-discard', 'base', 'OLD'))).toBe(true);
  });

  it('resumes a crash mid "out" (whatever the intent): finishes moving the cluster aside, then swaps', () => {
    live();
    stage();
    mkdirSync(join(pgdata, '.vc-discard'));
    renameSync(join(pgdata, 'base'), join(pgdata, '.vc-discard', 'base'));
    writeFileSync(join(pgdata, '.vc-reseed-in-progress'), `out ${ID}`);
    const r = runGuard({ VC_WALG_ROLE_DIR: roleDir });
    expect(r.stderr).toContain(`RESEED_SWAPPED ${ID}`);
    expect(existsSync(join(pgdata, '.vc-discard', 'PG_VERSION'))).toBe(true);
    expect(existsSync(join(pgdata, 'standby.signal'))).toBe(true);
    expectNewTreeBoots(r);
  });

  it('a failed move while moving the cluster out never marks "in": it stops, then the next start finishes', () => {
    live();
    stage();
    failMv('base', '*/.vc-discard/');
    const r1 = runGuard(SB());
    expect(r1.status).not.toBe(0);
    expect(r1.stdout).not.toContain('STUB-ENTRYPOINT');
    expect(readFileSync(join(pgdata, '.vc-reseed-in-progress'), 'utf-8')).toBe(`out ${ID}`);
    // Nothing from staging moved: the old cluster is whole across PGDATA and .vc-discard.
    expect(readFileSync(join(pgdata, 'base', 'OLD'), 'utf-8')).toBe('old');
    expect(existsSync(join(pgdata, '.vc-reseed', 'PG_VERSION'))).toBe(true);
    unfailMv();
    expectNewTreeBoots(runGuard(SB()));
  });

  it('resumes a crash mid "in": moves the rest of staging in', () => {
    stage();
    mkdirSync(join(pgdata, '.vc-discard'));
    renameSync(join(pgdata, '.vc-reseed', 'PG_VERSION'), join(pgdata, 'PG_VERSION'));
    writeFileSync(join(pgdata, '.vc-reseed-in-progress'), `in ${ID}`);
    const r = runGuard(SB());
    expect(r.stderr).toContain(`RESEED_SWAPPED ${ID}`);
    expect(existsSync(join(pgdata, 'standby.signal'))).toBe(true);
    expect(existsSync(join(pgdata, 'base'))).toBe(true);
    expectNewTreeBoots(r);
  });

  it('a failed move while moving staging in stops before cleanup; the next start (any intent) finishes', () => {
    live();
    stage();
    failMv('base', `${pgdata}/`);
    const r1 = runGuard(SB());
    expect(r1.status).not.toBe(0);
    expect(r1.stdout).not.toContain('STUB-ENTRYPOINT');
    expect(readFileSync(join(pgdata, '.vc-reseed-in-progress'), 'utf-8')).toBe(`in ${ID}`);
    expect(existsSync(join(pgdata, '.vc-reseed', 'base'))).toBe(true);
    expect(existsSync(join(pgdata, '.vc-reseeded-from'))).toBe(false);
    unfailMv();
    expectNewTreeBoots(runGuard({ VC_WALG_ROLE_DIR: roleDir }));
  });

  it('resumes "in" when staging is already gone (crash after the moves, before cleanup)', () => {
    writeFileSync(join(pgdata, 'PG_VERSION'), '17\n');
    writeFileSync(join(pgdata, 'standby.signal'), '');
    writeFileSync(join(pgdata, '.vc-reseed-ready'), ID);
    writeFileSync(join(pgdata, '.vc-reseed-in-progress'), `in ${ID}`);
    const r = runGuard(SB());
    expect(r.stderr).toContain(`RESEED_SWAPPED ${ID}`);
    expect(existsSync(join(pgdata, '.vc-reseed-in-progress'))).toBe(false);
    expect(readFileSync(join(pgdata, '.vc-reseeded-from'), 'utf-8')).toBe(ID);
    expectNoReseedState();
  });

  it('resumes after the record was written but before the markers went', () => {
    writeFileSync(join(pgdata, 'PG_VERSION'), '17\n');
    writeFileSync(join(pgdata, 'standby.signal'), '');
    writeFileSync(join(pgdata, '.vc-reseeded-from'), ID);
    writeFileSync(join(pgdata, '.vc-reseed-ready'), ID);
    writeFileSync(join(pgdata, '.vc-reseed-in-progress'), `in ${ID}`);
    const r = runGuard(SB());
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(pgdata, '.vc-reseeded-from'), 'utf-8')).toBe(ID);
    expectNoReseedState();
  });

  it('"in" that ends with no PG_VERSION in PGDATA refuses to boot (never initdb over a lost tree)', () => {
    mkdirSync(join(pgdata, '.vc-discard', 'base'), { recursive: true });
    writeFileSync(join(pgdata, '.vc-reseed-in-progress'), `in ${ID}`);
    const r = runGuard(SB());
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('STUB-ENTRYPOINT');
    expect(existsSync(join(pgdata, '.vc-reseed-in-progress'))).toBe(true);
    expect(existsSync(join(pgdata, '.vc-discard', 'base'))).toBe(true);
  });

  it('"out" with a staging that lost PG_VERSION rolls the cluster BACK and boots it', () => {
    live();
    stage();
    rmSync(join(pgdata, '.vc-reseed', 'PG_VERSION'));
    mkdirSync(join(pgdata, '.vc-discard'));
    renameSync(join(pgdata, 'base'), join(pgdata, '.vc-discard', 'base'));
    writeFileSync(join(pgdata, '.vc-reseed-in-progress'), `out ${ID}`);
    const r = runGuard(SB());
    expect(r.stderr).toContain('RESEED_ROLLED_BACK');
    expect(existsSync(join(pgdata, 'base', 'OLD'))).toBe(true);
    expect(existsSync(join(pgdata, '.vc-reseed-in-progress'))).toBe(false);
    expectOldTreeBoots(r);
    expectNoReseedState();
    expect(existsSync(join(pgdata, '.vc-discard'))).toBe(false);
  });

  it('an unknown in-progress state refuses to boot and moves nothing', () => {
    live();
    stage();
    writeFileSync(join(pgdata, '.vc-reseed-in-progress'), 'sideways');
    const r = runGuard(SB());
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('STUB-ENTRYPOINT');
    expect(readFileSync(join(pgdata, 'base', 'OLD'), 'utf-8')).toBe('old');
    expect(existsSync(join(pgdata, '.vc-reseed', 'PG_VERSION'))).toBe(true);
  });

  it('an interrupted RESTORE still wins: refuse before touching any reseed state', () => {
    live();
    stage();
    writeFileSync(join(pgdata, '.vc-restore-in-progress'), 'in');
    expect(runGuard(SB()).status).toBe(1);
    expect(existsSync(join(pgdata, '.vc-reseed-ready'))).toBe(true);
  });

  it('refuses symlinked reseed markers (it runs as root)', () => {
    live();
    stage();
    rmSync(join(pgdata, '.vc-reseed-ready'));
    symlinkSync('/etc/passwd', join(pgdata, '.vc-reseed-ready'));
    expect(runGuard(SB()).status).toBe(1);
  });

  it.each([
    ['.vc-reseed-in-progress', 'file'],
    ['.vc-reseed', 'dir'],
    ['.vc-discard', 'dir'],
    ['.vc-restore.lock', 'file'],
  ])('refuses a symlinked %s, moving nothing', (name) => {
    live();
    stage();
    const target = join(dir, 'elsewhere');
    mkdirSync(target);
    if (name === '.vc-reseed') {
      renameSync(join(pgdata, '.vc-reseed'), join(target, 'staged'));
      symlinkSync(join(target, 'staged'), join(pgdata, name));
    } else {
      symlinkSync(target, join(pgdata, name));
    }
    const r = runGuard(SB());
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('STUB-ENTRYPOINT');
    expect(readFileSync(join(pgdata, 'base', 'OLD'), 'utf-8')).toBe('old');
    expect(readdirSync(target).filter((f) => f !== 'staged')).toEqual([]);
  });

  it('refuses while a restore holds the lock, moving nothing', async () => {
    live();
    stage();
    const lock = join(pgdata, '.vc-restore.lock');
    writeFileSync(lock, '');
    const holder = spawn('flock', [lock, 'sleep', '5']);
    try {
      await new Promise((r) => setTimeout(r, 300));
      const r = runGuard(SB());
      expect(r.status).toBe(75);
      expect(r.stdout).not.toContain('STUB-ENTRYPOINT');
      expect(readFileSync(join(pgdata, 'base', 'OLD'), 'utf-8')).toBe('old');
      expect(existsSync(join(pgdata, '.vc-reseed-ready'))).toBe(true);
    } finally {
      holder.kill();
    }
  });

  it('a normal boot with no reseed state is unchanged', () => {
    live();
    const r = runGuard(SB());
    expect(r.stdout).toContain('STUB-ENTRYPOINT postgres -c config_file=/x');
    expect(existsSync(join(pgdata, '.vc-restore.lock'))).toBe(false);
  });
});

describe('db-guard.sh reseed markers are durable', () => {
  it('every reseed marker is written tmp, sync, rename, sync', () => {
    expect(readFileSync(GUARD, 'utf-8')).toContain(
      `vc_put() { rm -f "$1.tmp"; printf '%s' "$2" > "$1.tmp"; sync; mv -f "$1.tmp" "$1"; sync; }`,
    );
  });
});

describe('db-guard.sh reseed swap: fix round 1', () => {
  it.each([
    ['.vc-discard', 'dir'],
    ['.vc-reseed-in-progress', 'file'],
    ['.vc-reseeded-from', 'file'],
    ['.vc-prev', 'dir'],
    ['.vc-restore-in-progress', 'file'],
    ['.vc-reseed-ready', 'file'],
  ])(
    'I1: a staging that carries %s (a failed-back primary) is refused before anything moves',
    (name, kind) => {
      live();
      stage();
      const p = join(pgdata, '.vc-reseed', name);
      if (kind === 'dir') {
        mkdirSync(p);
        writeFileSync(join(p, 'x'), 'x');
      } else {
        writeFileSync(p, name === '.vc-reseed-in-progress' ? `in ${ID}` : ID);
      }
      const r = runGuard(SB());
      expect(r.stderr).toContain('RESEED_REFUSED');
      expectOldTreeBoots(r);
      expectNoReseedState();
      expect(existsSync(join(pgdata, '.vc-discard'))).toBe(false);
      // A second start is a plain boot: nothing is wedged.
      const r2 = runGuard(SB());
      expect(r2.stderr).not.toContain('RESEED');
      expectOldTreeBoots(r2);
    },
  );

  it('M1: the roll back syncs the moves back before the markers go', () => {
    expect(readFileSync(GUARD, 'utf-8')).toMatch(
      /rmdir "\$R_DISC"\n\s*fi\n\s*sync\n\s*rm -rf "\$R_STAGE"; rm -f "\$R_READY" "\$R_MARK"/,
    );
  });

  it('M2: an unknown in-progress state names the way out', () => {
    live();
    writeFileSync(join(pgdata, '.vc-reseed-in-progress'), 'sideways');
    const r = runGuard(SB());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('run vibecarbon restore');
    expect(r.stderr).toContain('remove');
  });

  it('M2: "in" with no PG_VERSION names the way out', () => {
    mkdirSync(join(pgdata, '.vc-discard', 'base'), { recursive: true });
    writeFileSync(join(pgdata, '.vc-reseed-in-progress'), `in ${ID}`);
    const r = runGuard(SB());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('run vibecarbon restore');
    expect(r.stderr).toContain('.vc-discard');
  });
});
