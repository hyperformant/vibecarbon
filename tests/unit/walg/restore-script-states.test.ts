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
import { WALG_ENV_SOURCE } from '../../../src/lib/walg/restore-layout.js';

/** The database lineage (system identifier) whose folder holds the backup. */
const LINEAGE = '7699032860122738725';
const BASE_PREFIX = 's3://b/backups/p/prod/walg';
/** The real walg-env.sh, in place of the in-container path. */
const WALG_ENV = `. ${join(process.cwd(), 'carbon/volumes/db/walg-env.sh')}`;

const BACKUP = 'base_000000010000000000000002';
const CONF = renderRecoveryConf(buildRecoveryConfig({ target: 'latest', lineage: LINEAGE }));
// This attempt's id (the marker's RESTORE_ATTEMPT), and the record a
// completed swap of it leaves.
const ATTEMPT = '11111111-2222-4333-8444-555555555555';
const RECORD = `${BACKUP} ${ATTEMPT}`;
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
function stubWalg(mode: 'ok' | 'fail' | 'ok-with-vc' | 'ok-with-gap') {
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
          // A base pushed while the source database had dropped WAL under
          // disk pressure carries its gap record (wal-archive.sh).
          ...(mode === 'ok-with-gap'
            ? [
                'echo "000000010000000000000003 2026-10-21T00:00:00Z" > "$2/vibecarbon-wal-gap"',
                'echo "000000010000000000000004 2026-10-21T00:00:01Z" > "$2/vibecarbon-wal-gap.clearing"',
              ]
            : []),
        ].join('\n');
  // Every fetch must read the restored lineage's folder (walg-env.sh with
  // RESTORE_LINEAGE), never the base or the volume's own cluster.
  const prefixCheck = `[ "$WALG_S3_PREFIX" = "${BASE_PREFIX}/${LINEAGE}" ] || { echo "wal-g: wrong prefix $WALG_S3_PREFIX" >&2; exit 3; }`;
  writeFileSync(
    join(bin, 'wal-g'),
    `#!/bin/sh\n[ "$1" = backup-fetch ] || exit 2\n${prefixCheck}\n${body}\n`,
  );
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
      const script = composeRestoreScript({
        lineage: LINEAGE,
        backup: BACKUP,
        recoveryConf: CONF,
        attempt: ATTEMPT,
      })
        .replace('PGDATA=/var/lib/postgresql/data', `PGDATA=${pgdata}`)
        .replace(WALG_ENV_SOURCE, WALG_ENV);
      writeFileSync(join(dir, 'restore.sh'), script);
      return ['bash', join(dir, 'restore.sh')];
    },
  ],
  [
    'k8s',
    () => {
      writeFileSync(join(dir, 'init.sh'), k8sInit().replace(WALG_ENV_SOURCE, WALG_ENV));
      return ['bash', join(dir, 'init.sh')];
    },
  ],
];

function run(argv: string[], env: Record<string, string> = {}) {
  return spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf-8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      PGDATA: pgdata,
      RESTORE_BACKUP: BACKUP,
      RESTORE_RECOVERY_CONF: CONF,
      RESTORE_TARGET: 'latest',
      RESTORE_ATTEMPT: ATTEMPT,
      RESTORE_LINEAGE: LINEAGE,
      WALG_S3_PREFIX_BASE: BASE_PREFIX,
      ...env,
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

    it('a good swap records the base the volume now holds', () => {
      seedLive();
      stubWalg('ok');
      const r = run(build());
      expect(r.status, r.stderr).toBe(0);
      expect(read('.vc-restored-from')).toBe(RECORD);
      expect(ls()).not.toContain('.vc-restored-from.tmp');
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

    it('a restored base never carries the source database WAL gap record', () => {
      seedLive();
      stubWalg('ok-with-gap');
      const r = run(build());
      expect(r.status, r.stderr).toBe(0);
      expect(read('base/marker')).toBe('restored');
      expect(ls()).not.toContain('vibecarbon-wal-gap');
      expect(ls()).not.toContain('vibecarbon-wal-gap.clearing');
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

/**
 * The k8s init runs on EVERY db pod start while the marker is set (Fix round
 * 1, I1). Once a restore of that base has swapped in, a later start (a drain,
 * an OOM, a template change) before the CLI cleared the marker must not move
 * the live cluster aside and restore it again: a silent rewind. Compose has
 * no such repeat: its script runs once, invoked by the CLI.
 */
describe.skipIf(!hasFlock)('k8s walg-restore is idempotent per restore attempt', () => {
  const k8s = () => {
    writeFileSync(join(dir, 'init.sh'), k8sInit().replace(WALG_ENV_SOURCE, WALG_ENV));
    return ['bash', join(dir, 'init.sh')];
  };

  it('marker set, this attempt already swapped in: no move, normal boot', () => {
    seedLive();
    writeFileSync(join(pgdata, '.vc-restored-from'), RECORD);
    stubWalg('ok');
    const r = run(k8s());
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('already restored');
    expect(read('base/marker')).toBe('live');
    expect(ls()).not.toContain('.vc-prev');
  });

  it('marker set to a different base: restores it', () => {
    seedLive();
    writeFileSync(join(pgdata, '.vc-restored-from'), `base_000000010000000000000001 ${ATTEMPT}`);
    stubWalg('ok');
    const r = run(k8s());
    expect(r.status, r.stderr).toBe(0);
    expect(read('base/marker')).toBe('restored');
    expect(read('.vc-prev/base/marker')).toBe('live');
    expect(read('.vc-restored-from')).toBe(RECORD);
  });

  it('the same base to another target is another attempt: restores it (N1a)', () => {
    seedLive();
    writeFileSync(join(pgdata, '.vc-restored-from'), RECORD);
    stubWalg('ok');
    const other = '99999999-2222-4333-8444-555555555555';
    const r = run(k8s(), { RESTORE_TARGET: '2026-10-19T12:00:00Z', RESTORE_ATTEMPT: other });
    expect(r.status, r.stderr).toBe(0);
    expect(read('base/marker')).toBe('restored');
    expect(read('.vc-restored-from')).toBe(`${BACKUP} ${other}`);
  });

  it('a record an earlier attempt left behind does not stop a new attempt (N1b)', () => {
    seedLive();
    writeFileSync(
      join(pgdata, '.vc-restored-from'),
      `${BACKUP} 00000000-dead-4000-8000-000000000000`,
    );
    stubWalg('ok');
    const r = run(k8s());
    expect(r.status, r.stderr).toBe(0);
    expect(read('base/marker')).toBe('restored');
  });

  it('a marker from an older CLI (no attempt) always restores', () => {
    seedLive();
    writeFileSync(join(pgdata, '.vc-restored-from'), `${BACKUP} `);
    stubWalg('ok');
    const r = run(k8s(), { RESTORE_ATTEMPT: '' });
    expect(r.status, r.stderr).toBe(0);
    expect(read('base/marker')).toBe('restored');
  });

  it('a swap left in progress is settled even when the record names this attempt', () => {
    mkdirSync(join(pgdata, '.vc-prev', 'base'), { recursive: true });
    writeFileSync(join(pgdata, '.vc-prev', 'base', 'marker'), 'original\n');
    writeFileSync(join(pgdata, '.vc-restore-in-progress'), 'in\n');
    writeFileSync(join(pgdata, '.vc-restored-from'), RECORD);
    stubWalg('ok');
    const r = run(k8s());
    expect(r.status, r.stderr).toBe(0);
    expect(read('base/marker')).toBe('restored');
    expect(ls()).not.toContain('.vc-restore-in-progress');
  });
});
