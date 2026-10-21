/**
 * The backup-prefix fence (HA-correctness final review I1).
 *
 * The retirement fence only reaches a node the CLI can reach. An old primary
 * that stays unreachable through a failover and reboots on its own still reads
 * WALG_ROLE=primary and pushes WAL, base backups and a `delete retain` into
 * the shared prefix. Failover now writes `vibecarbon-fence.json` into that
 * prefix (S3 is reachable when the old primary is not), naming the promoted
 * database and the timeline it promoted onto, and every push path refuses when
 * the fence names its database on a newer timeline than its own.
 *
 * The scripts run for real here, with bash, against stub `wal-g` and `psql`
 * binaries (and a `docker` / `kubectl` shim that runs the in-container part
 * locally). The same behaviour was verified on postgres:17.11-walg3.0.9-r2
 * against MinIO (final-fix-report.md).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BACKUP_FENCE_OBJECT,
  BACKUP_FENCE_REFUSAL,
  BACKUP_FENCE_STATE_SQL,
  BACKUP_FENCE_SWITCH_SQL,
  backupFenceWriteScript,
  parseBackupFenceState,
  parseBackupFenceSwitch,
  writeBackupFence,
  writeComposeBackupFence,
  writeK8sBackupFence,
} from '../../../src/lib/deploy/backup-fence.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ARCHIVE = join(ROOT, 'carbon/volumes/db/wal-archive.sh');
const COMPOSE_BACKUP = join(ROOT, 'carbon/backup/compose-backup.sh');
const CRONJOB = join(ROOT, 'carbon/k8s/base/backup/cronjob.yaml');
const SYSID = '7699032860122738725';

describe('the fence record', () => {
  it('parses sysid|timeline-hex, and refuses anything else', () => {
    expect(parseBackupFenceState(`${SYSID}|00000002\n`)).toEqual({
      systemIdentifier: SYSID,
      timeline: 2,
    });
    expect(parseBackupFenceState(`${SYSID}|0000001A`)).toEqual({
      systemIdentifier: SYSID,
      timeline: 26,
    });
    for (const bad of [
      '',
      `${SYSID}|`,
      `|00000002`,
      'ERROR: recovery is in progress',
      `${SYSID}|00000000`,
    ]) {
      expect(parseBackupFenceState(bad), bad).toBeNull();
    }
  });

  // Controller ruling: the switch point comes from the new timeline's history
  // file (durable; pg_last_wal_replay_lsn() is NULL after a restart), and only
  // a row naming exactly the parent timeline counts. Anything else is null,
  // and a null switch point exempts nothing.
  it('the switch point is read from the history file and must name the parent timeline', () => {
    expect(BACKUP_FENCE_SWITCH_SQL).toContain('pg_read_file($$pg_wal/$$');
    expect(BACKUP_FENCE_SWITCH_SQL).toContain('$$.history$$');
    expect(BACKUP_FENCE_SWITCH_SQL).not.toContain('pg_last_wal_replay_lsn');
    expect(parseBackupFenceSwitch('1|0000000000000004\n', 2)).toBe('0000000000000004');
    expect(parseBackupFenceSwitch('2|00000000000000ab', 3)).toBe('00000000000000AB');
    for (const [out, tl] of [
      ['1|0000000000000004', 3], // not the parent of timeline 3
      ['', 2],
      ['ERROR:  could not open file "pg_wal/00000001.history"', 1],
      ['1|', 2],
    ] as const) {
      expect(parseBackupFenceSwitch(out, tl), `${out} @${tl}`).toBeNull();
    }
  });

  it('the state query and the write script carry no single quote (they nest in sh -c quoting)', () => {
    expect(BACKUP_FENCE_STATE_SQL).not.toContain("'");
    expect(BACKUP_FENCE_SWITCH_SQL).not.toContain("'");
    const script = backupFenceWriteScript({ primaryNode: "o'brien", timeline: 2 });
    expect(script).not.toContain("'");
    const b64 = script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)?.[1] ?? '';
    expect(JSON.parse(Buffer.from(b64, 'base64').toString())).toEqual({
      primaryNode: "o'brien",
      timeline: 2,
    });
    expect(script).toContain(
      `wal-g st put --no-compress --no-encrypt -f /tmp/${BACKUP_FENCE_OBJECT} ${BACKUP_FENCE_OBJECT}`,
    );
  });

  it('writes { primaryNode, systemIdentifier, timeline, at } read from the primary', async () => {
    const scripts: string[] = [];
    const r = await writeBackupFence({
      primaryNode: 'myapp-prod-standby',
      exec: async (sql) =>
        sql === BACKUP_FENCE_STATE_SQL
          ? `${SYSID}|00000002`
          : sql === BACKUP_FENCE_SWITCH_SQL
            ? '1|0000000000000005'
            : '',
      runInDb: async (script) => {
        scripts.push(script);
        return 'FENCE_WRITTEN\n';
      },
      now: () => new Date('2026-10-21T00:00:00.000Z'),
    });
    expect(r).toEqual({
      ok: true,
      fence: {
        primaryNode: 'myapp-prod-standby',
        systemIdentifier: SYSID,
        timeline: 2,
        switchSegment: '0000000000000005',
        at: '2026-10-21T00:00:00.000Z',
      },
    });
    expect(scripts).toHaveLength(1);
  });

  it('a history file that cannot be read writes switchSegment null (fail closed)', async () => {
    const scripts: string[] = [];
    const r = await writeBackupFence({
      primaryNode: 'a',
      exec: async (sql) => {
        if (sql === BACKUP_FENCE_SWITCH_SQL) throw new Error('could not open file');
        return `${SYSID}|00000001`;
      },
      runInDb: async (script) => {
        scripts.push(script);
        return 'FENCE_WRITTEN';
      },
    });
    expect(r).toMatchObject({ ok: true, fence: { timeline: 1, switchSegment: null } });
    const b64 = scripts[0].match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)?.[1] ?? '';
    expect(JSON.parse(Buffer.from(b64, 'base64').toString()).switchSegment).toBeNull();
  });

  it('a db with no backup target skips; an unreadable primary or unconfirmed put is a failure', async () => {
    const exec = async () => `${SYSID}|00000002`;
    await expect(
      writeBackupFence({ primaryNode: 'b', exec, runInDb: async () => 'FENCE_SKIPPED' }),
    ).resolves.toEqual({ ok: true, skipped: true });
    await expect(
      writeBackupFence({ primaryNode: 'b', exec: async () => '', runInDb: async () => '' }),
    ).resolves.toMatchObject({ ok: false, reason: /system identifier and timeline/ });
    await expect(
      writeBackupFence({ primaryNode: 'b', exec, runInDb: async () => false }),
    ).resolves.toMatchObject({ ok: false, reason: /did not confirm/ });
  });

  it('compose writes through docker compose exec on the node; k8s through the db pod', async () => {
    const cmds: string[] = [];
    await writeComposeBackupFence({
      ip: '10.0.0.2',
      sshKeyPath: '/k',
      projectName: 'myapp',
      deps: {
        run: async (_ip: string, _k: string, cmd: string) => {
          cmds.push(cmd);
          return cmd.includes('psql') ? `${SYSID}|00000002` : 'FENCE_WRITTEN';
        },
      },
    });
    expect(cmds[0]).toBe(
      `cd /opt/myapp && docker compose exec -T db psql -U postgres -d postgres -tAc '${BACKUP_FENCE_STATE_SQL}'`,
    );
    expect(cmds[1]).toBe(
      `cd /opt/myapp && docker compose exec -T db psql -U postgres -d postgres -tAc '${BACKUP_FENCE_SWITCH_SQL}'`,
    );
    expect(cmds[2]).toMatch(
      /^cd \/opt\/myapp && docker compose exec -T db sh -c '.*FENCE_WRITTEN'$/,
    );

    const argvs: string[][] = [];
    const r = await writeK8sBackupFence({
      ip: '10.2.0.1',
      sshKeyPath: '/k',
      deps: {
        psql: () => async () => `${SYSID}|00000003`,
        kubectl: async (_ip: string, argv: string[]) => {
          argvs.push(argv);
          return 'FENCE_WRITTEN';
        },
      },
    });
    expect(r).toMatchObject({ ok: true, fence: { timeline: 3, primaryNode: '10.2.0.1' } });
    expect(argvs[0].slice(0, 8)).toEqual([
      '-n',
      'vibecarbon',
      'exec',
      'db-0',
      '-c',
      'db',
      '--',
      'sh',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The push paths, run for real against stubs
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'vc-bfence-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/**
 * A bin dir with stub wal-g / psql. wal-g `st cat` prints FENCE (or fails "not
 * found in storage" when it is empty); every other wal-g call records itself.
 * psql answers the recovery, sysid and timeline queries.
 */
function stubs(
  name: string,
  {
    fence,
    sysid = SYSID,
    tl = '00000001',
    psqlFails = false,
  }: {
    fence: string | null;
    sysid?: string;
    tl?: string;
    psqlFails?: boolean;
  },
) {
  const bin = join(work, name);
  mkdirSync(bin, { recursive: true });
  const log = join(bin, 'walg.log');
  writeFileSync(log, '');
  writeFileSync(
    join(bin, 'wal-g'),
    `#!/bin/bash
if [ "$1" = st ] && [ "$2" = cat ]; then
  ${fence === null ? `echo "ERROR: download the file: object 'p/vibecarbon-fence.json' not found in storage" >&2; exit 1` : `printf '%s\\n' '${fence}'`}
  exit 0
fi
echo "$*" >> ${log}
exit 0
`,
  );
  writeFileSync(
    join(bin, 'psql'),
    `#!/bin/bash
${psqlFails ? 'exit 2' : ''}
case "$*" in
  *pg_is_in_recovery*) echo f ;;
  *system_identifier*pg_walfile_name*) echo "${sysid}|${tl}" ;;
  *system_identifier*) echo ${sysid} ;;
  *pg_walfile_name*) echo ${tl} ;;
esac
`,
  );
  // docker compose exec -T db <cmd...> / kubectl exec ... -- <cmd...>: run <cmd...> here.
  writeFileSync(join(bin, 'docker'), '#!/bin/bash\nshift 4\nexec "$@"\n');
  writeFileSync(
    join(bin, 'kubectl'),
    '#!/bin/bash\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
  );
  for (const f of ['wal-g', 'psql', 'docker', 'kubectl']) chmodSync(join(bin, f), 0o755);
  return { bin, pushes: () => readFileSync(log, 'utf-8') };
}

const fenceJson = (timeline: number, sysid = SYSID, switchSegment: string | null = null) =>
  JSON.stringify({ primaryNode: 'b', systemIdentifier: sysid, timeline, switchSegment, at: 'x' });

const env = (bin: string) => ({
  PATH: `${bin}:${process.env.PATH}`,
  WALG_S3_PREFIX: 's3://bkt/backups/p/e/walg',
  AWS_ACCESS_KEY_ID: 'k',
  AWS_SECRET_ACCESS_KEY: 's',
  WAL_ARCHIVE_WALG: join(bin, 'wal-g'),
  WAL_ARCHIVE_RETRIES: '1',
  WAL_ARCHIVE_SLEEP: '0',
  PGDATA: join(work, 'pgdata-none'),
  RETAIN: '2',
  BACKUP_RETENTION_DAYS: '2',
});

const archive = (name: string, segment: string, opts: Parameters<typeof stubs>[1]) => {
  const st = stubs(name, opts);
  const r = spawnSync('bash', [ARCHIVE, `pg_wal/${segment}`], {
    encoding: 'utf-8',
    env: env(st.bin),
    timeout: 10_000,
  });
  return { ...r, pushes: st.pushes() };
};

describe('wal-archive.sh against the fence', () => {
  it('no fence object (never failed over): pushes', () => {
    const r = archive('a1', '000000010000000000000004', { fence: null });
    expect(r.status).toBe(0);
    expect(r.pushes).toContain('wal-push pg_wal/000000010000000000000004');
  });

  it('the fence names this database on a newer timeline: refuses with exit 1, no push', () => {
    const r = archive('a2', '000000010000000000000004', { fence: fenceJson(2) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(BACKUP_FENCE_REFUSAL);
    expect(r.pushes).toBe('');
  });

  it('the promoted node on the fenced timeline (or newer) pushes', () => {
    expect(archive('a3', '000000020000000000000005', { fence: fenceJson(2) }).pushes).toContain(
      'wal-push',
    );
    expect(archive('a4', '000000030000000000000005', { fence: fenceJson(2) }).status).toBe(0);
  });

  it('another database (a recreated env) pushes whatever its timeline', () => {
    const r = archive('a5', '000000010000000000000004', { fence: fenceJson(5, '1234') });
    expect(r.status).toBe(0);
    expect(r.pushes).toContain('wal-push');
  });

  it('psql unreadable: the older timeline alone refuses (fail safe)', () => {
    const r = archive('a6', '000000010000000000000004', { fence: fenceJson(2), psqlFails: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(BACKUP_FENCE_REFUSAL);
  });

  // A planned failover with an archive backlog on the old primary: the
  // segments before the branch are history both timelines need. Refusing them
  // would leave a gap every pre-failover base backup replays through.
  it('the parent timeline before the switch segment pushes; from the switch on it refuses', () => {
    const fence = fenceJson(2, SYSID, '0000000000000005');
    const before = archive('s1', '000000010000000000000004', { fence });
    expect(before.status).toBe(0);
    expect(before.pushes).toContain('wal-push pg_wal/000000010000000000000004');
    for (const seg of ['000000010000000000000005', '000000010000000000000009']) {
      const r = archive(`s2-${seg}`, seg, { fence });
      expect(r.status, seg).toBe(1);
      expect(r.stderr, seg).toContain(BACKUP_FENCE_REFUSAL);
    }
    // Compared numerically across the log id half too.
    const hi = fenceJson(2, SYSID, '0000000100000002');
    expect(archive('s3', '0000000100000000000000FF', { fence: hi }).status).toBe(0);
    expect(archive('s4', '000000010000000100000002', { fence: hi }).status).toBe(1);
  });

  it('a timeline older than the parent refuses even before the switch segment', () => {
    // Fence on timeline 3, switch from timeline 2 at segment 9: timeline 1 is
    // not the parent, so its segment 4 is refused.
    const fence = fenceJson(3, SYSID, '0000000000000009');
    const r = archive('s5', '000000010000000000000004', { fence });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(BACKUP_FENCE_REFUSAL);
    expect(archive('s6', '000000020000000000000004', { fence }).status).toBe(0);
  });

  it('a fence with no switch point exempts nothing on the old timeline', () => {
    const r = archive('s7', '000000010000000000000001', { fence: fenceJson(2, SYSID, null) });
    expect(r.status).toBe(1);
    expect(r.pushes).toBe('');
  });

  it('the .history and .partial files a promotion archives are exempt', () => {
    for (const seg of ['00000002.history', '000000010000000000000004.partial']) {
      const r = archive(`a7-${seg}`, seg, { fence: fenceJson(3) });
      expect(r.status, seg).toBe(0);
      expect(r.pushes, seg).toContain('wal-push');
    }
  });
});

const backupRuns = {
  compose: (bin: string) => {
    const dir = join(work, `proj-${bin.split('/').pop()}`);
    mkdirSync(join(dir, 'backup'), { recursive: true });
    writeFileSync(join(dir, 'backup/compose-backup.sh'), readFileSync(COMPOSE_BACKUP));
    return spawnSync('bash', ['backup/compose-backup.sh'], {
      cwd: dir,
      encoding: 'utf-8',
      env: env(bin),
      timeout: 10_000,
    });
  },
  k8s: (bin: string) => {
    const cron = loadYaml(readFileSync(CRONJOB, 'utf-8')) as {
      spec: {
        jobTemplate: { spec: { template: { spec: { containers: Array<{ command: string[] }> } } } };
      };
    };
    const script = cron.spec.jobTemplate.spec.template.spec.containers[0].command[2];
    return spawnSync('bash', ['-c', script], { encoding: 'utf-8', env: env(bin), timeout: 10_000 });
  },
};

describe.each(Object.entries(backupRuns))('%s base backup against the fence', (tier, runBackup) => {
  const run = (name: string, opts: Parameters<typeof stubs>[1]) => {
    const st = stubs(`${tier}-${name}`, opts);
    const r = runBackup(st.bin);
    return { ...r, pushes: st.pushes() };
  };

  it('no fence object: backs up and prunes', () => {
    const r = run('b1', { fence: null });
    expect(r.status).toBe(0);
    expect(r.pushes).toMatch(/backup-push[\s\S]*delete retain FULL 2/);
  });

  it('the fence names this database on a newer timeline: refuses, no push and no delete', () => {
    const r = run('b2', { fence: fenceJson(2) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(BACKUP_FENCE_REFUSAL);
    expect(r.pushes).toBe('');
  });

  it('the fenced primary itself backs up', () => {
    expect(run('b3', { fence: fenceJson(2), tl: '00000002' }).status).toBe(0);
  });

  it('another database backs up', () => {
    expect(run('b4', { fence: fenceJson(9, '1234') }).status).toBe(0);
  });

  it('a fence it cannot compare with refuses (fail closed)', () => {
    const r = run('b5', { fence: '{"garbage":true}' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not compare this node with the backup-prefix fence');
    expect(r.pushes).toBe('');
  });
});

describe('census: every backup push path checks the fence first', () => {
  const PUSH = /wal-g (?:wal-push|backup-push|delete retain)|"\$WALG" wal-push/;
  const walk = (dir: string): string[] =>
    spawnSync('git', ['ls-files', dir], { cwd: ROOT, encoding: 'utf-8' })
      .stdout.split('\n')
      .filter((f) => /\.(sh|ya?ml)$/.test(f));

  const pushFiles = walk('carbon').filter((f) =>
    readFileSync(join(ROOT, f), 'utf-8')
      .split('\n')
      .some((l) => !/^\s*#/.test(l) && PUSH.test(l)),
  );

  it('the push paths are exactly the archive wrapper (both copies) and the two backup jobs', () => {
    expect(pushFiles.sort()).toEqual(
      [
        'carbon/backup/compose-backup.sh',
        'carbon/k8s/base/backup/configmap-walg.yaml',
        'carbon/k8s/base/backup/cronjob.yaml',
        'carbon/volumes/db/wal-archive.sh',
      ].sort(),
    );
  });

  it.each(pushFiles)('%s reads the fence object before its first push', (file) => {
    const text = readFileSync(join(ROOT, file), 'utf-8');
    const lines = text.split('\n');
    const firstPush = lines.findIndex((l) => !/^\s*#/.test(l) && PUSH.test(l));
    const fenceRead = lines.findIndex((l) => l.includes(`st cat ${BACKUP_FENCE_OBJECT}`));
    expect(fenceRead).toBeGreaterThan(-1);
    expect(fenceRead).toBeLessThan(firstPush);
    expect(text).toContain(BACKUP_FENCE_REFUSAL);
  });

  it('both failover flows write the fence after the promote and before the DNS flip and swap save', () => {
    const flows: Array<[string, string, string, string]> = [
      [
        'src/failover.js',
        'await catchUpReseedAndPromote();',
        'flipAndVerifyDns({',
        'swapRoles(envName',
      ],
      [
        'src/lib/deploy/compose/ha.js',
        "s.stop('Standby database promoted to primary');",
        'dnsFlip = await flipDns(',
        'swapRoles(envName',
      ],
    ];
    for (const [file, promote, flip, swap] of flows) {
      const text = readFileSync(join(ROOT, file), 'utf-8');
      const body = text.slice(
        text.indexOf(
          file.endsWith('ha.js')
            ? 'export async function failoverComposeHA('
            : 'export async function failoverHA(',
        ),
      );
      const write = body.indexOf('await writeFence(');
      expect(write, file).toBeGreaterThan(body.indexOf(promote));
      expect(write, file).toBeLessThan(body.indexOf(flip));
      expect(write, file).toBeLessThan(body.indexOf(swap));
    }
  });
});
