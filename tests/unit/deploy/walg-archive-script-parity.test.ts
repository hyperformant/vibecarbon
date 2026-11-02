/**
 * The WAL-archive wrapper is ONE script deployed two ways, and this pins that.
 *
 * `carbon/volumes/db/wal-archive.sh` is bind-mounted by compose; k8s ships a
 * copy inside the `vibecarbon-wal-archive` ConfigMap. The ConfigMap has always
 * CLAIMED, in a header comment, to be "byte-for-byte in sync" with the compose
 * file. It was not. The k8s copy had lost BOTH guards the compose copy carries:
 *
 *   - the wal-g role write-guard, so a k8s standby — or, worse, a standby whose
 *     first-boot seed exited UNSEEDED and is therefore briefly an INDEPENDENT
 *     primary — pushed WAL straight into the primary's single canonical
 *     WALG_S3_PREFIX. Two writers, one backup stream.
 *   - the pg_is_in_recovery() gate behind it.
 *
 * A comment cannot enforce anything, so this test does: it dedents the block
 * scalar out of the ConfigMap and compares it to the file. The failure message
 * prints the exact block to paste back, so re-syncing is mechanical.
 *
 * It also pins the ONE property both copies must never lose: every guard and
 * every exhausted-retry path exits 0. A non-zero archive_command makes postgres
 * refuse to recycle the segment, pg_wal grows without bound and the disk fills
 * (RCA prod-1 2026-05-26) — which is worse than the PITR gap it would be
 * signalling.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { WALG_ROLE_PARSE_SH, walgRoleReadFragment } from '../../../src/lib/deploy/walg-role.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const COMPOSE_SCRIPT = 'carbon/volumes/db/wal-archive.sh';
const WALG_ENV_SCRIPT = 'carbon/volumes/db/walg-env.sh';
const K8S_CONFIGMAP = 'carbon/k8s/base/backup/configmap-walg.yaml';

const composeBody = readFileSync(`${repoRoot}${COMPOSE_SCRIPT}`, 'utf-8');
const walgEnvBody = readFileSync(`${repoRoot}${WALG_ENV_SCRIPT}`, 'utf-8');
const configMapRaw = readFileSync(`${repoRoot}${K8S_CONFIGMAP}`, 'utf-8');
const configMap = loadYaml(configMapRaw) as { data: Record<string, string> };
const k8sBody = configMap.data['wal-archive.sh'];
const k8sWalgEnvBody = configMap.data['walg-env.sh'];

const SYSID = '7699032860122738725';
const work = mkdtempSync(join(tmpdir(), 'vc-walg-env-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
/** A bin dir whose pg_controldata prints SYSID, or fails like an unreadable PGDATA. */
function controldataBin(name: string, readable = true) {
  const bin = join(work, name);
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'pg_controldata'),
    readable
      ? `#!/bin/sh\nprintf 'pg_control version number:            1700\\nDatabase system identifier:           ${SYSID}\\n'\n`
      : '#!/bin/sh\necho "pg_controldata: error: could not open file" >&2\nexit 1\n',
  );
  chmodSync(join(bin, 'pg_controldata'), 0o755);
  return bin;
}

/** A role directory holding `walg-role` with `content` (null: no file); returns the file. */
function roleFile(name: string, content: string | null) {
  const dir = join(work, `role-${name}`);
  mkdirSync(dir, { recursive: true });
  if (content !== null) writeFileSync(join(dir, 'walg-role'), content);
  return join(dir, 'walg-role');
}
/** The role every run that is meant to reach the push carries. */
const PRIMARY_ROLE_FILE = roleFile('primary', 'primary\n');

describe('wal-archive.sh is byte-identical across compose and k8s', () => {
  it('the ConfigMap block scalar dedents to exactly the compose script', () => {
    if (k8sBody !== composeBody) {
      const paste = composeBody
        .split('\n')
        .map((l) => (l.length ? `    ${l}` : l))
        .join('\n');
      throw new Error(
        `${K8S_CONFIGMAP} has drifted from ${COMPOSE_SCRIPT}. They must stay identical — ` +
          `the k8s copy silently losing the wal-g role write-guard is exactly how a standby ` +
          `ended up archiving into the primary's WAL stream. Replace everything under ` +
          `\`wal-archive.sh: |\` with:\n\n${paste}`,
      );
    }
    expect(k8sBody).toBe(composeBody);
  });

  it('the ConfigMap carries walg-env.sh byte-identical too', () => {
    if (k8sWalgEnvBody !== walgEnvBody) {
      const paste = walgEnvBody
        .split('\n')
        .map((l) => (l.length ? `    ${l}` : l))
        .join('\n');
      throw new Error(
        `${K8S_CONFIGMAP} has drifted from ${WALG_ENV_SCRIPT}. Replace everything under ` +
          `\`walg-env.sh: |\` with:\n\n${paste}`,
      );
    }
    expect(k8sWalgEnvBody).toBe(walgEnvBody);
  });

  it('the ConfigMap carries db-guard.sh byte-identical, and it parses under sh', () => {
    expect(configMap.data['db-guard.sh']).toBe(
      readFileSync(`${repoRoot}carbon/volumes/db/db-guard.sh`, 'utf-8'),
    );
    expect(spawnSync('sh', ['-n', `${repoRoot}carbon/volumes/db/db-guard.sh`]).status).toBe(0);
  });

  it('both tiers source walg-env.sh before anything reads the prefix', () => {
    for (const body of [composeBody, k8sBody]) {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in the script text, not a JS placeholder
      const source = body.indexOf('. "${WALG_ENV_SH:-/etc/postgresql/walg-env.sh}"');
      expect(source).toBeGreaterThan(-1);
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in the script text, not a JS placeholder
      expect(source).toBeLessThan(body.indexOf('case "${WALG_S3_PREFIX:-}" in'));
      expect(source).toBeLessThan(body.indexOf('st cat vibecarbon-fence.json'));
    }
  });

  it('both tiers therefore carry the wal-g role write-guard', () => {
    // The bring-up guard: a standby db can briefly be an independent primary
    // (not yet in recovery) before it is reseeded, which the recovery gate
    // below cannot catch. Only the role file saying primary arms archiving.
    for (const [name, body] of [
      [COMPOSE_SCRIPT, composeBody],
      [K8S_CONFIGMAP, k8sBody],
    ] as const) {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in the script text, not a JS placeholder
      expect(body, name).toContain('case "${VC_WALG_ROLE:-}" in');
      expect(body, name).toMatch(/standby\)\n[^\n]*wal-g role standby[^\n]*\n\s*exit 0\n/);
      expect(body, name).toMatch(/\*\)\n[^\n]*WAL_ARCHIVE_ROLE_UNKNOWN[^\n]*\n\s*exit 1\n/);
    }
  });

  it('both tiers therefore carry the pg_is_in_recovery() gate', () => {
    for (const [name, body] of [
      [COMPOSE_SCRIPT, composeBody],
      [K8S_CONFIGMAP, k8sBody],
    ] as const) {
      expect(body, name).toContain('SELECT pg_is_in_recovery()');
      // Fallback for when psql cannot answer from the archive_command context.
      expect(body, name).toContain('standby.signal');
      // Only SKIP on POSITIVE confirmation of recovery — an unknown answer must
      // never drop a real primary's WAL.
      expect(body, name).toMatch(/if \[ "\$in_recovery" = "t" \]; then/);
    }
  });

  // Final review ruling (e): a segment given up on a failing bucket is a
  // silent PITR gap, the worst outcome for a backup. Exhausted retries now
  // hold the segment (exit 1: postgres keeps it and retries, and
  // pg_stat_archiver turns status red); only disk pressure drops one, with a
  // durable record. The old pin (every exhausted path exits 0) was that bug.
  it('exit codes: refusals and a held segment exit 1; only the disk-pressure drop and the overwrite refusal give a segment up', () => {
    const exits = (composeBody.match(/^\s*exit \d+/gm) ?? []).map((e) => e.trim());
    // retired, role unknown, fence, final hold (the walg-env source's
    // `|| exit 1` is not a line of its own)
    expect(exits.filter((e) => e === 'exit 1')).toHaveLength(4);
    expect(composeBody).toMatch(/backup prefix fenced to another primary[^\n]*\n\s*exit 1\n/);
    expect(composeBody.indexOf('vibecarbon-fence.json')).toBeLessThan(
      composeBody.indexOf('wal-push "$WAL_PATH"'),
    );
    expect(composeBody).toMatch(
      /if \[ -f "\$\{PGDATA_DIR\}\/vibecarbon-retired" \]; then\n[^\n]*retired node: backups refused[^\n]*\n\s*exit 1\n/,
    );
    expect(composeBody.indexOf('vibecarbon-retired')).toBeLessThan(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in the script text, not a JS placeholder
      composeBody.indexOf('case "${VC_WALG_ROLE:-}" in'),
    );
    // The script ends holding the segment.
    expect(composeBody).toMatch(/WAL_ARCHIVE_FAILED[^\n]*keeping the segment[^\n]*\nexit 1\n?$/);
    expect(composeBody).toMatch(/WAL_ARCHIVE_DROPPED[^\n]*\n\s*fi\n\s*exit 0\n/);
  });

  it('the ConfigMap header no longer merely ASKS for sync — it names the pin', () => {
    // The old header said "IMPORTANT: keep this script body byte-for-byte in
    // sync" and nothing enforced it. If someone deletes the pin, this fails.
    const header = configMapRaw.slice(0, configMapRaw.indexOf('apiVersion:'));
    expect(header).toContain('walg-archive-script-parity');
  });

  it('the ConfigMap header names both ways a segment is given up: disk pressure and an overwrite refusal', () => {
    const header = configMapRaw
      .slice(0, configMapRaw.indexOf('apiVersion:'))
      .replace(/\n# ?/g, ' ');
    expect(header).not.toMatch(/Only disk pressure drops a segment/);
    expect(header).toMatch(/disk pressure[^.]*durable gap record/);
    expect(header).toMatch(/overwrite refusal/);
    // The script gives the overwrite refusal up with exit 0, as the header says.
    expect(composeBody).toMatch(/already archived, contents differ[\s\S]*?exit 0/);
  });
});

// Restoring parity in the ConfigMap achieves NOTHING on an existing cluster by
// itself: the db StatefulSet mounts the script with `subPath: wal-archive.sh`,
// and a subPath ConfigMap mount is materialised once at container start and
// never updated in place. `kubectl apply` changes the object; the database keeps
// executing the old script until its pod is recreated. So the pod template
// carries the ConfigMap's sha: a changed script changes the template, and the
// same apply rolls the pod (inside the db rollout wait).
describe('a changed wal-archive.sh actually reaches the running db pod', () => {
  const k3s = readFileSync(`${repoRoot}src/lib/deploy/k8s/k3s.js`, 'utf-8');
  const sts = readFileSync(`${repoRoot}carbon/k8s/base/db/statefulset.yaml`, 'utf-8');

  it('is still mounted by subPath — the premise of the sha annotation', () => {
    // If this ever becomes a whole-directory mount, the kubelet updates it in
    // place and the annotation becomes unnecessary rather than wrong.
    expect(sts).toMatch(
      /mountPath: \/etc\/postgresql\/wal-archive\.sh\n\s+subPath: wal-archive\.sh/,
    );
  });

  it('stamps the ConfigMap sha into the POD TEMPLATE, so a change rolls the pod', () => {
    const template = sts.slice(sts.indexOf('  template:'), sts.indexOf('    spec:'));
    expect(template).toContain('vibecarbon.dev/wal-archive-sha: "{{WAL_ARCHIVE_SHA}}"');
  });

  it('hashes the shipped ConfigMap file and renders it into the StatefulSet', () => {
    expect(k3s).toContain("join(projectDir, 'k8s/base/backup/configmap-walg.yaml')");
    expect(k3s).toContain("createHash('sha256')");
    expect(k3s).toContain('walArchiveSha: walArchiveConfigSha(projectDir)');
    expect(k3s).toContain("WAL_ARCHIVE_SHA: walArchiveSha || 'none'");
  });
});

// Final review M2: with no backup target (local dev's empty WALG_S3_PREFIX,
// or a bucketless `s3:///...` render) every segment waited out the wal-g
// attempts and logged WAL_ARCHIVE_FAILED. The script now exits 0 before any
// wal-g call, like backup/compose-backup.sh. Runs the real script with bash.
describe('wal-archive.sh with no backup target', () => {
  const bin = controldataBin('no-target');
  const run = (base: string) =>
    spawnSync('bash', [`${repoRoot}${COMPOSE_SCRIPT}`, 'pg_wal/000000010000000000000001'], {
      encoding: 'utf-8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        WALG_S3_PREFIX_BASE: base,
        WALG_ENV_SH: `${repoRoot}${WALG_ENV_SCRIPT}`,
        VC_WALG_ROLE_FILE: PRIMARY_ROLE_FILE,
        WAL_ARCHIVE_RETRIES: '1',
        WAL_ARCHIVE_SLEEP: '0',
        PGDATA: '/nonexistent',
      },
      timeout: 10_000,
    });

  for (const prefix of ['', 's3:///backups/acme']) {
    it(`"${prefix}" exits 0 at once with one line, never reaching wal-g`, () => {
      const r = run(prefix);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('wal-archive: no backup target');
      expect(r.stderr).not.toContain('WAL_ARCHIVE_FAILED');
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
    });
  }

  it('a missing walg-env.sh refuses (exit 1, postgres retries), never a silent no-target skip', () => {
    const r = spawnSync(
      'bash',
      [`${repoRoot}${COMPOSE_SCRIPT}`, 'pg_wal/000000010000000000000001'],
      {
        encoding: 'utf-8',
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          WALG_S3_PREFIX_BASE: 's3://bucket/backups/acme',
          WALG_ENV_SH: '/nonexistent/walg-env.sh',
          VC_WALG_ROLE_FILE: PRIMARY_ROLE_FILE,
          PGDATA: '/nonexistent',
        },
        timeout: 10_000,
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain('no backup target');
  });

  it('a real target still goes through the wal-g attempts (control)', () => {
    const r = run('s3://bucket/backups/acme');
    // No wal-g here, so every attempt fails and the segment is held.
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain('no backup target');
    expect(r.stderr).toContain('WAL_ARCHIVE_FAILED');
  });

  it('the guard sits before the wal-g retry loop in both copies', () => {
    for (const body of [composeBody, k8sBody]) {
      expect(body.indexOf('""|s3:///*)')).toBeGreaterThan(-1);
      expect(body.indexOf('""|s3:///*)')).toBeLessThan(body.indexOf('wal-push "$WAL_PATH"'));
    }
  });
});

// walg-env.sh, run for real (sourced by sh, as every caller does), with a stub
// pg_controldata standing in for the cluster in PGDATA.
describe('walg-env.sh exports the lineage folder', () => {
  const source = (env: Record<string, string>, readable = true) =>
    spawnSync(
      'sh',
      ['-c', `set -eu; . "${repoRoot}${WALG_ENV_SCRIPT}"; printf '%s' "$WALG_S3_PREFIX"`],
      {
        encoding: 'utf-8',
        env: {
          PATH: `${controldataBin(readable ? 'ok' : 'unreadable', readable)}:${process.env.PATH}`,
          PGDATA: '/var/lib/postgresql/data',
          ...env,
        },
        timeout: 10_000,
      },
    );
  const BASE = 's3://b/backups/p/prod/walg';

  it("the cluster's system identifier, read from pg_controldata", () => {
    const r = source({ WALG_S3_PREFIX_BASE: BASE });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${BASE}/${SYSID}`);
  });

  it('RESTORE_LINEAGE wins (a restore fetches before PGDATA holds that database)', () => {
    const r = source({ WALG_S3_PREFIX_BASE: BASE, RESTORE_LINEAGE: '7612000000000000001' }, false);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${BASE}/7612000000000000001`);
  });

  it('no base, or a bucketless one, is no target: nothing is read', () => {
    expect(source({ WALG_S3_PREFIX_BASE: '' }, false)).toMatchObject({ status: 0, stdout: '' });
    expect(source({}, false)).toMatchObject({ status: 0, stdout: '' });
    expect(source({ WALG_S3_PREFIX_BASE: 's3:///backups/p/prod/walg' }, false)).toMatchObject({
      status: 0,
      stdout: 's3:///backups/p/prod/walg',
    });
  });

  it('a PGDATA it cannot read exits 1 with the one-line cause', () => {
    const r = source({ WALG_S3_PREFIX_BASE: BASE }, false);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim()).toBe(
      'walg-env: no database system identifier in /var/lib/postgresql/data',
    );
  });

  it('a RESTORE_LINEAGE that is no system identifier exits 1', () => {
    const r = source({ WALG_S3_PREFIX_BASE: BASE, RESTORE_LINEAGE: '../other' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not a database system identifier');
  });

  it('runs under busybox-style sh with set -u (no bashisms)', () => {
    const r = spawnSync('sh', ['-n', `${repoRoot}${WALG_ENV_SCRIPT}`], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    expect(walgEnvBody).not.toMatch(/\[\[|\$\{[A-Za-z_]+:[0-9]/);
  });
});

describe('the wal-g role parser (one text, carried by walg-env.sh)', () => {
  const bin = controldataBin('role');
  const roleDir = join(work, 'role');
  mkdirSync(roleDir, { recursive: true });
  const put = (content: string | null, { symlink = false } = {}) => {
    const f = join(roleDir, 'walg-role');
    rmSync(f, { force: true });
    if (content === null) return f;
    if (symlink) {
      writeFileSync(join(roleDir, 'target'), content);
      symlinkSync(join(roleDir, 'target'), f);
    } else writeFileSync(f, content);
    return f;
  };
  const viaEnv = (f: string) => {
    const r = spawnSync(
      'sh',
      ['-c', `. "${repoRoot}${WALG_ENV_SCRIPT}" && printf 'R=[%s]' "$VC_WALG_ROLE"`],
      {
        encoding: 'utf-8',
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          WALG_S3_PREFIX_BASE: 's3://b/backups/p/prod/walg',
          PGDATA: '/x',
          VC_WALG_ROLE_FILE: f,
        },
      },
    );
    expect(r.status).toBe(0);
    return r.stdout.trim();
  };
  const viaFragment = (f: string) =>
    spawnSync('sh', ['-c', `${walgRoleReadFragment(f)}\nprintf 'R=[%s]' "$VC_WALG_ROLE"`], {
      encoding: 'utf-8',
    }).stdout.trim();

  it.each([
    ['primary\n', 'R=[primary]'],
    ['standby', 'R=[standby]'],
    ['', 'R=[]'],
    ['Primary\n', 'R=[]'],
    ['primary\nstandby\n', 'R=[]'],
    ['primary\r\n', 'R=[]'],
    [' primary', 'R=[]'],
  ])('%j reads as %s, through walg-env.sh and through the fragment alike', (content, want) => {
    const f = put(content);
    expect(viaEnv(f)).toBe(want);
    expect(viaFragment(f)).toBe(want);
  });
  it('a missing file or a symlink is no role, never an exit', () => {
    expect(viaEnv(put(null))).toBe('R=[]');
    expect(viaEnv(put('primary\n', { symlink: true }))).toBe('R=[]');
    expect(viaFragment(put('primary\n', { symlink: true }))).toBe('R=[]');
  });
  it('walg-env.sh carries the parser verbatim, in both copies', () => {
    expect(walgEnvBody).toContain(WALG_ROLE_PARSE_SH);
    expect(k8sWalgEnvBody).toContain(WALG_ROLE_PARSE_SH);
  });
  it('the fragment leaves no helper variable behind', () => {
    const r = spawnSync(
      'sh',
      [
        '-c',
        `${walgRoleReadFragment('/nonexistent')}\nprintf '[%s]' "\${vc_walg_role_file-unset}"`,
      ],
      { encoding: 'utf-8' },
    );
    expect(r.stdout).toBe('[unset]');
  });
});

// Fix round 1 M1: with WALG_PREVENT_WAL_OVERWRITE on, wal-g refuses a segment
// name the archive already holds with other bytes. Retrying cannot change
// that, so the wrapper logs a distinct line at once (plus the usual
// WAL_ARCHIVE_FAILED, exit 0, as for any segment it gives up on).
describe('wal-archive.sh on an overwrite refusal', () => {
  it('one attempt, no backoff, a distinct line, then WAL_ARCHIVE_FAILED and exit 0', () => {
    const bin = controldataBin('overwrite');
    const calls = join(bin, 'walg-calls');
    writeFileSync(calls, '');
    writeFileSync(
      join(bin, 'wal-g'),
      [
        '#!/bin/sh',
        `echo "$*" >> ${calls}`,
        'if [ "$1" = st ]; then echo "object not found in storage" >&2; exit 1; fi',
        `echo "ERROR: 2026/10/21 10:00:00.000000 WAL file '000000010000000000000001' already archived, contents differ, unable to overwrite" >&2`,
        'exit 1',
      ].join('\n'),
    );
    chmodSync(join(bin, 'wal-g'), 0o755);
    const started = Date.now();
    const r = spawnSync(
      'bash',
      [`${repoRoot}${COMPOSE_SCRIPT}`, 'pg_wal/000000010000000000000001'],
      {
        encoding: 'utf-8',
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          WALG_S3_PREFIX_BASE: 's3://bucket/backups/acme',
          WALG_ENV_SH: `${repoRoot}${WALG_ENV_SCRIPT}`,
          WAL_ARCHIVE_WALG: join(bin, 'wal-g'),
          VC_WALG_ROLE_FILE: PRIMARY_ROLE_FILE,
          WAL_ARCHIVE_RETRIES: '3',
          // A real backoff: an overwrite refusal must never sleep through it.
          WAL_ARCHIVE_SLEEP: '5',
          PGDATA: '/nonexistent',
        },
        timeout: 20_000,
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(
      readFileSync(calls, 'utf-8')
        .split('\n')
        .filter((l) => l.startsWith('wal-push')),
    ).toHaveLength(1);
    expect(r.stderr).toMatch(/WAL_ARCHIVE_OVERWRITE_REFUSED: [^\n]*000000010000000000000001/);
    expect(r.stderr).toContain('WAL_ARCHIVE_FAILED');
  });
});

// The exhausted-retry policy, run for real with bash against a wal-g stub that
// always fails. The disk numbers come from the test-only overrides (the
// Docker test runs the same paths on the db image's busybox df).
describe('wal-archive.sh when every push fails', () => {
  const GiB = 1024 ** 3;
  const SEG = '000000010000000000000007';
  function setup(name: string) {
    const bin = controldataBin(`exhausted-${name}`);
    writeFileSync(
      join(bin, 'wal-g'),
      [
        '#!/bin/sh',
        'if [ "$1" = st ]; then echo "object not found in storage" >&2; exit 1; fi',
        'echo "ERROR: dial tcp: connection refused" >&2',
        'exit 1',
      ].join('\n'),
    );
    chmodSync(join(bin, 'wal-g'), 0o755);
    const pgdata = join(work, `pgdata-${name}`);
    mkdirSync(join(pgdata, 'pg_wal'), { recursive: true });
    writeFileSync(join(pgdata, 'pg_wal', SEG), 'x');
    const run = (env: Record<string, string> = {}) =>
      spawnSync('bash', [`${repoRoot}${COMPOSE_SCRIPT}`, join(pgdata, 'pg_wal', SEG)], {
        encoding: 'utf-8',
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          WALG_S3_PREFIX_BASE: 's3://bucket/backups/acme',
          WALG_ENV_SH: `${repoRoot}${WALG_ENV_SCRIPT}`,
          WAL_ARCHIVE_WALG: join(bin, 'wal-g'),
          VC_WALG_ROLE_FILE: PRIMARY_ROLE_FILE,
          WAL_ARCHIVE_RETRIES: '2',
          WAL_ARCHIVE_SLEEP: '0',
          PGDATA: pgdata,
          ...env,
        },
        timeout: 10_000,
      });
    const gap = () => {
      try {
        return readFileSync(join(pgdata, 'vibecarbon-wal-gap'), 'utf-8');
      } catch {
        return null;
      }
    };
    return { run, gap, pgdata };
  }

  it('room on the disk: exit 1 (postgres keeps the segment and retries), no gap record', () => {
    const { run, gap } = setup('room');
    const r = run({
      VC_WAL_GUARD_TOTAL_BYTES: String(100 * GiB),
      VC_WAL_GUARD_FREE_BYTES: String(50 * GiB),
    });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(
      /WAL_ARCHIVE_FAILED: [^\n]*failed after 2 attempts; keeping the segment/,
    );
    expect(r.stderr).not.toContain('WAL_ARCHIVE_DROPPED');
    expect(gap()).toBeNull();
  });

  it.each([
    ['under 2 GiB free', 100 * GiB, 1.5 * GiB],
    ['under 10% free', 100 * GiB, 9 * GiB],
  ])(
    '%s: exit 0, WAL_ARCHIVE_DROPPED, and the segment appended to the gap record',
    (_l, total, free) => {
      const { run, gap } = setup(`pressure-${free}`);
      const env = {
        VC_WAL_GUARD_TOTAL_BYTES: String(total),
        VC_WAL_GUARD_FREE_BYTES: String(Math.floor(free)),
      };
      const r = run(env);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/WAL_ARCHIVE_DROPPED: [^\n]*under 10% or 2 GiB/);
      expect(r.stderr).not.toContain('WAL_ARCHIVE_FAILED');
      expect(gap()).toMatch(new RegExp(`^${SEG} \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z\\n$`));
      // A second drop appends.
      expect(run(env).status).toBe(0);
      expect(gap()?.trim().split('\n')).toHaveLength(2);
    },
  );

  it('a gap record that cannot be written is said so, still exit 0', () => {
    const { run, pgdata } = setup('gap-unwritable');
    // A directory at the record's path makes the append fail.
    mkdirSync(join(pgdata, 'vibecarbon-wal-gap'));
    const r = run({
      VC_WAL_GUARD_TOTAL_BYTES: String(100 * GiB),
      VC_WAL_GUARD_FREE_BYTES: String(1 * GiB),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/WAL_ARCHIVE_DROPPED: [^\n]*gap record could not be written/);
    expect(r.stderr).not.toContain('recorded in');
  });

  it('free space it cannot read holds the segment', () => {
    const { run, gap } = setup('unreadable');
    const r = run({ PGDATA: '/nonexistent' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('WAL_ARCHIVE_FAILED');
    expect(gap()).toBeNull();
  });
});

// The role guard, run for real with bash (postgres runs the script that way),
// against every role state. A wal-g stub records each call, so "never reached
// wal-g" and "no segment dropped" are observed, not inferred.
describe('wal-archive.sh role guard', () => {
  const GiB = 1024 ** 3;
  const SEG = '000000010000000000000009';
  let n = 0;
  /**
   * One run. `role` is the role file's content (null: no file, `{symlink}`: a
   * symlink to a file saying primary). Disk pressure is on by default, so a
   * path that reaches the drop would drop: the guard must stop it first.
   */
  const archive = (
    role: string | null | { symlink: true },
    {
      base = 's3://bucket/backups/acme',
      retired = false,
      pressure = true,
      env = {},
    }: {
      base?: string;
      retired?: boolean;
      pressure?: boolean;
      /** Extra env the script inherits (its parent's). */
      env?: Record<string, string>;
    } = {},
  ) => {
    n += 1;
    const bin = controldataBin(`guard-${n}`);
    const calls = join(bin, 'walg-calls');
    writeFileSync(calls, '');
    writeFileSync(
      join(bin, 'wal-g'),
      [
        '#!/bin/sh',
        `echo "$*" >> ${calls}`,
        'if [ "$1" = st ]; then echo "object not found in storage" >&2; exit 1; fi',
        'echo "ERROR: dial tcp: connection refused" >&2',
        'exit 1',
      ].join('\n'),
    );
    chmodSync(join(bin, 'wal-g'), 0o755);
    const pgdata = join(work, `pgdata-guard-${n}`);
    mkdirSync(join(pgdata, 'pg_wal'), { recursive: true });
    writeFileSync(join(pgdata, 'pg_wal', SEG), 'x');
    if (retired) writeFileSync(join(pgdata, 'vibecarbon-retired'), '');
    const roleDir = join(work, `guard-role-${n}`);
    mkdirSync(roleDir, { recursive: true });
    const file = join(roleDir, 'walg-role');
    if (role !== null && typeof role === 'object') {
      writeFileSync(join(roleDir, 'target'), 'primary\n');
      symlinkSync(join(roleDir, 'target'), file);
    } else if (role !== null) writeFileSync(file, role);
    const r = spawnSync('bash', [`${repoRoot}${COMPOSE_SCRIPT}`, join(pgdata, 'pg_wal', SEG)], {
      encoding: 'utf-8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        WALG_S3_PREFIX_BASE: base,
        WALG_ENV_SH: `${repoRoot}${WALG_ENV_SCRIPT}`,
        WAL_ARCHIVE_WALG: join(bin, 'wal-g'),
        VC_WALG_ROLE_FILE: file,
        WAL_ARCHIVE_RETRIES: '1',
        WAL_ARCHIVE_SLEEP: '0',
        PGDATA: pgdata,
        ...(pressure
          ? { VC_WAL_GUARD_TOTAL_BYTES: String(100 * GiB), VC_WAL_GUARD_FREE_BYTES: String(GiB) }
          : {}),
        ...env,
      },
      timeout: 10_000,
    });
    let gap: string | null = null;
    try {
      gap = readFileSync(join(pgdata, 'vibecarbon-wal-gap'), 'utf-8');
    } catch {}
    return { ...r, walg: readFileSync(calls, 'utf-8'), gap };
  };

  it.each([
    ['no role file', null],
    ['an empty role file', ''],
    ['a garbage role', 'leader\n'],
    ['a role that is not the exact word', 'Primary\n'],
    ['a symlinked role file', { symlink: true } as const],
  ])('%s: holds the segment (exit 1) with a named line, never reaching wal-g', (_l, role) => {
    const r = archive(role);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('WAL_ARCHIVE_ROLE_UNKNOWN');
    expect(r.stderr).not.toContain('WAL_ARCHIVE_FAILED');
    expect(r.walg).toBe('');
  });

  it('a VC_WALG_ROLE=primary inherited from the env, with no role file, still holds (exit 1), never reaching wal-g', () => {
    // Only the role file arms archiving: the parser resets VC_WALG_ROLE before
    // it reads, so a value leaking in from the parent never stands in for it.
    const r = archive(null, { pressure: false, env: { VC_WALG_ROLE: 'primary' } });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('WAL_ARCHIVE_ROLE_UNKNOWN');
    expect(r.walg).toBe('');
    expect(r.gap).toBeNull();
  });

  it('an unknown role under disk pressure still never drops a segment (D8)', () => {
    const r = archive(null, { pressure: true });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain('WAL_ARCHIVE_DROPPED');
    expect(r.gap).toBeNull();
    expect(r.walg).toBe('');
  });

  it('standby: explicit skip, exit 0 (D2), never reaching wal-g', () => {
    const r = archive('standby\n');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('wal-g role standby');
    expect(r.walg).toBe('');
    expect(r.gap).toBeNull();
  });

  it('primary: goes on to the push (it fails here, so it holds after the attempts)', () => {
    const r = archive('primary\n', { pressure: false });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('WAL_ARCHIVE_FAILED');
    expect(r.stderr).not.toContain('WAL_ARCHIVE_ROLE_UNKNOWN');
    expect(r.walg).toContain('wal-push');
  });

  it('the retired node refuses (exit 1) whatever the role says, before the role is read', () => {
    for (const role of ['primary\n', 'standby\n', null]) {
      const r = archive(role, { retired: true });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('retired node: backups refused');
      expect(r.stderr).not.toContain('WAL_ARCHIVE_ROLE_UNKNOWN');
      expect(r.walg).toBe('');
      expect(r.gap).toBeNull();
    }
  });

  it('no backup target skips BEFORE the role is consulted (local dev never holds WAL)', () => {
    for (const base of ['', 's3:///backups/acme']) {
      const r = archive(null, { base });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('no backup target');
      expect(r.stderr).not.toContain('WAL_ARCHIVE_ROLE_UNKNOWN');
    }
  });

  it('never reads the WALG_ROLE env, in either copy', () => {
    for (const body of [composeBody, k8sBody]) expect(body).not.toMatch(/\$\{?WALG_ROLE\b/);
  });

  it('guard order: retired, walg-env, no-target, role, recovery, fence, push', () => {
    for (const body of [composeBody, k8sBody]) {
      const at = (s: string) => {
        const i = body.indexOf(s);
        expect(i, s).toBeGreaterThan(-1);
        return i;
      };
      expect(at('vibecarbon-retired" ]')).toBeLessThan(at('walg-env.sh}"'));
      expect(at('walg-env.sh}"')).toBeLessThan(at('""|s3:///*)'));
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in the script text, not a JS placeholder
      expect(at('""|s3:///*)')).toBeLessThan(at('case "${VC_WALG_ROLE:-}" in'));
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in the script text, not a JS placeholder
      expect(at('case "${VC_WALG_ROLE:-}" in')).toBeLessThan(at('SELECT pg_is_in_recovery()'));
      expect(at('SELECT pg_is_in_recovery()')).toBeLessThan(at('st cat vibecarbon-fence.json'));
      expect(at('st cat vibecarbon-fence.json')).toBeLessThan(at('wal-push "$WAL_PATH"'));
    }
  });
});
