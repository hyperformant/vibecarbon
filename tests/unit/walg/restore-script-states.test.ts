/**
 * The restore scripts' state machine, executed (C1, I2, I3).
 *
 * Both tiers' scripts run here under bash against a temp PGDATA, with stub
 * `wal-g` (fetches a fake cluster, or fails) and `chown` on PATH. Each case
 * is a state a real server can be in when a restore starts:
 *
 *   - a stale `.vc-prev` (a proven restore whose cleanup never ran, from
 *     before `.vc-discard`) plus a fetch that FAILS: the live cluster must
 *     survive untouched. The first version moved it into staging and cleared
 *     staging before the fetch, deleting the only live copy.
 *   - the same with a fetch that succeeds: the live (unproven) copy is set
 *     aside only after the fetch, the older `.vc-prev` is kept.
 *   - a fresh, empty PGDATA: no empty `.vc-prev` is left behind.
 *   - a base backup that itself carries `.vc-*` entries: they are dropped
 *     from the staged tree, so they cannot wedge the swap.
 *   - another restore holding the lock: refused, nothing touched.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeRestoreScript } from '../../../src/lib/deploy/compose/index.js';
import { buildRecoveryConfig, renderRecoveryConf } from '../../../src/lib/walg/recovery-config.js';

const BACKUP = 'base_000000010000000000000002';
const CONF = renderRecoveryConf(buildRecoveryConfig({ target: 'latest' }));
const hasFlock = spawnSync('sh', ['-c', 'command -v flock']).status === 0;

function k8sInit(): string {
  // biome-ignore lint/suspicious/noExplicitAny: parsed YAML
  const sts = load(readFileSync('carbon/k8s/base/db/statefulset.yaml', 'utf-8')) as any;
  return sts.spec.template.spec.initContainers.find(
    (c: { name: string }) => c.name === 'walg-restore',
  ).command[2];
}

let dir: string;
let pgdata: string;
let bin: string;

/** A stub wal-g: `backup-fetch <dir> <name>` writes a fake cluster, or fails. */
function stubWalg(mode: 'ok' | 'fail' | 'ok-with-vc') {
  const body =
    mode === 'fail'
      ? 'echo "ERROR: Backup $3 does not exist" >&2; exit 1'
      : [
          'mkdir -p "$2/base" "$2/global"',
          'echo 17 > "$2/PG_VERSION"',
          'echo restored > "$2/base/marker"',
          'echo "port = 5432" > "$2/postgresql.auto.conf"',
          ...(mode === 'ok-with-vc'
            ? [
                'mkdir -p "$2/.vc-prev/base" "$2/.vc-restore" "$2/.vc-discard"',
                'echo in > "$2/.vc-restore-in-progress"',
              ]
            : []),
        ].join('\n');
  writeFileSync(join(bin, 'wal-g'), `#!/bin/sh\n[ "$1" = backup-fetch ] || exit 2\n${body}\n`);
  chmodSync(join(bin, 'wal-g'), 0o755);
}

/** The live cluster a server holds before the restore. */
function seedLive() {
  mkdirSync(join(pgdata, 'base'), { recursive: true });
  writeFileSync(join(pgdata, 'PG_VERSION'), '17\n');
  writeFileSync(join(pgdata, 'base', 'marker'), 'live\n');
}

const TIERS: Array<[string, () => string[]]> = [
  [
    'compose',
    () => {
      const script = composeRestoreScript({ backup: BACKUP, recoveryConf: CONF }).replace(
        'PGDATA=/var/lib/postgresql/data',
        `PGDATA=${pgdata}`,
      );
      writeFileSync(join(dir, 'restore.sh'), script);
      return ['bash', join(dir, 'restore.sh')];
    },
  ],
  [
    'k8s',
    () => {
      writeFileSync(join(dir, 'init.sh'), k8sInit());
      return ['bash', join(dir, 'init.sh')];
    },
  ],
];

function run(argv: string[]) {
  return spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf-8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      PGDATA: pgdata,
      RESTORE_BACKUP: BACKUP,
      RESTORE_RECOVERY_CONF: CONF,
      RESTORE_TARGET: 'latest',
    },
  });
}

const ls = (p = pgdata) => readdirSync(p).sort();
const read = (rel: string) => readFileSync(join(pgdata, rel), 'utf-8').trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-restore-states-'));
  pgdata = join(dir, 'data');
  bin = join(dir, 'bin');
  mkdirSync(pgdata);
  mkdirSync(bin);
  writeFileSync(join(bin, 'chown'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'chown'), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

for (const [tier, build] of TIERS) {
  describe.skipIf(!hasFlock)(`${tier} restore script states`, () => {
    it('a stale .vc-prev and a failed fetch: the live cluster survives untouched', () => {
      seedLive();
      mkdirSync(join(pgdata, '.vc-prev', 'base'), { recursive: true });
      writeFileSync(join(pgdata, '.vc-prev', 'PG_VERSION'), '17\n');
      stubWalg('fail');
      const r = run(build());
      expect(r.status, r.stderr).not.toBe(0);
      expect(r.stderr).toContain('nothing was moved');
      expect(read('base/marker')).toBe('live');
      expect(read('PG_VERSION')).toBe('17');
      expect(existsSync(join(pgdata, '.vc-prev', 'PG_VERSION'))).toBe(true);
      expect(existsSync(join(pgdata, '.vc-restore-in-progress'))).toBe(false);
    });

    it('a stale .vc-prev and a good fetch: sets the unproven copy aside after the fetch, keeps .vc-prev', () => {
      seedLive();
      mkdirSync(join(pgdata, '.vc-prev', 'base'), { recursive: true });
      writeFileSync(join(pgdata, '.vc-prev', 'base', 'marker'), 'original\n');
      stubWalg('ok');
      const r = run(build());
      expect(r.status, r.stderr).toBe(0);
      expect(read('base/marker')).toBe('restored');
      expect(read('.vc-prev/base/marker')).toBe('original');
      expect(ls()).not.toContain('.vc-discard');
      expect(ls()).not.toContain('.vc-restore');
      expect(ls()).not.toContain('.vc-restore-in-progress');
      expect(existsSync(join(pgdata, 'recovery.signal'))).toBe(true);
    });

    it('a live cluster and a good fetch: the live one moves to .vc-prev', () => {
      seedLive();
      stubWalg('ok');
      const r = run(build());
      expect(r.status, r.stderr).toBe(0);
      expect(read('base/marker')).toBe('restored');
      expect(read('.vc-prev/base/marker')).toBe('live');
      expect(read('postgresql.auto.conf')).toContain("recovery_target_timeline = 'current'");
    });

    it('a fresh, empty PGDATA leaves no empty .vc-prev behind', () => {
      stubWalg('ok');
      const r = run(build());
      expect(r.status, r.stderr).toBe(0);
      expect(read('base/marker')).toBe('restored');
      expect(ls()).not.toContain('.vc-prev');
    });

    it('a staged tree carrying .vc-* entries cannot wedge the swap', () => {
      seedLive();
      stubWalg('ok-with-vc');
      const r = run(build());
      expect(r.status, r.stderr).toBe(0);
      expect(read('base/marker')).toBe('restored');
      expect(read('.vc-prev/base/marker')).toBe('live');
      expect(ls()).not.toContain('.vc-restore-in-progress');
      expect(ls()).not.toContain('.vc-discard');
      expect(existsSync(join(pgdata, '.vc-prev', '.vc-prev'))).toBe(false);
    });

    it('a swap interrupted half way in (marker "in") is settled by the rerun', () => {
      // .vc-prev holds the whole original; PGDATA a part of the staged copy.
      mkdirSync(join(pgdata, '.vc-prev', 'base'), { recursive: true });
      writeFileSync(join(pgdata, '.vc-prev', 'base', 'marker'), 'original\n');
      mkdirSync(join(pgdata, 'global'));
      writeFileSync(join(pgdata, '.vc-restore-in-progress'), 'in\n');
      stubWalg('ok');
      const r = run(build());
      expect(r.status, r.stderr).toBe(0);
      expect(read('base/marker')).toBe('restored');
      expect(read('.vc-prev/base/marker')).toBe('original');
      expect(ls()).not.toContain('.vc-restore-in-progress');
    });

    it('a swap interrupted half way out (marker "out") finishes moving the live one aside', () => {
      mkdirSync(join(pgdata, '.vc-prev', 'base'), { recursive: true });
      writeFileSync(join(pgdata, '.vc-prev', 'base', 'marker'), 'live\n');
      writeFileSync(join(pgdata, 'PG_VERSION'), '17\n');
      writeFileSync(join(pgdata, '.vc-restore-in-progress'), '');
      stubWalg('ok');
      const r = run(build());
      expect(r.status, r.stderr).toBe(0);
      expect(read('base/marker')).toBe('restored');
      expect(read('.vc-prev/PG_VERSION')).toBe('17');
      expect(read('.vc-prev/base/marker')).toBe('live');
    });

    it('refuses while another restore holds the lock, touching nothing', async () => {
      seedLive();
      stubWalg('ok');
      const lock = join(pgdata, '.vc-restore.lock');
      writeFileSync(lock, '');
      const holder = spawn('flock', [lock, 'sleep', '5']);
      try {
        await new Promise((r) => setTimeout(r, 300));
        const r = run(build());
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain('another restore');
        expect(read('base/marker')).toBe('live');
        expect(ls()).not.toContain('.vc-prev');
      } finally {
        holder.kill();
      }
    });
  });
}
