/**
 * Census: one archive folder per database lineage (H1, B1, B8).
 *
 * The environment's WAL-G prefix used to be the archive itself, so a destroyed
 * and redeployed environment (a new database, a new system identifier)
 * archived into the folder the old database left: its first base backup
 * became LATEST over the old data, and its WAL segments landed in the same
 * wal_005/ the old timeline lives in. Now the environment's prefix is
 * WALG_S3_PREFIX_BASE and each lineage has its own folder under it, named by
 * its system identifier. carbon/volumes/db/walg-env.sh is the ONE place that
 * turns the base into WALG_S3_PREFIX, so the census holds:
 *
 *   (a) every WAL-G-using script, container or CLI-built exec script sources
 *       walg-env.sh before its first wal-g call (or is walg-env.sh). The k8s
 *       walg-restore init sources it only on a restore (C15), after the
 *       normal-boot exit and with RESTORE_LINEAGE required;
 *   (b) WALG_PREVENT_WAL_OVERWRITE is "true" in the compose db env, the k8s db
 *       container, the walg-restore init and the backup CronJob, so a segment
 *       name already archived with other bytes is refused, never overwritten;
 *   (c) nothing under carbon/ or src/ sets WALG_S3_PREFIX except walg-env.sh
 *       and its byte-identical copy in configmap-walg.yaml (C16);
 *   (d) every WALG_S3_PREFIX_BASE construction carries an env segment (moved
 *       here from app-bucket-single-resolver-census arm (d), under the new
 *       name), except local dev's documented empty override.
 *
 * The walks list files, not sites, so a new wal-g caller is caught.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_FENCE_OBJECT,
  backupFenceWriteScript,
} from '../../../src/lib/deploy/backup-fence.js';
import { composeRestoreScript } from '../../../src/lib/deploy/compose/index.js';
import { buildDbManifestValues } from '../../../src/lib/deploy/k8s/k3s.js';
import { buildWalgAuditProbe, VERIFY_HINTS } from '../../../src/lib/deploy/walg-audit.js';
import { buildRecoveryConfig, renderRecoveryConf } from '../../../src/lib/walg/recovery-config.js';
import { WALG_ENV_PATH, WALG_ENV_SOURCE } from '../../../src/lib/walg/restore-layout.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');
const tracked = (dir: string) =>
  spawnSync('git', ['ls-files', dir], { cwd: ROOT, encoding: 'utf-8' })
    .stdout.split('\n')
    .filter(Boolean);

const WALG_ENV_FILE = 'carbon/volumes/db/walg-env.sh';
const CONFIGMAP = 'carbon/k8s/base/backup/configmap-walg.yaml';
const SYSID = '7699032860122738725';

/** A wal-g subcommand invocation (not prose naming one). */
const WALG_CALL =
  /(?:^|[\s;&|(`'"])(?:wal-g|"\$WALG")\s+(?:wal-push|wal-fetch|backup-push|backup-fetch|backup-list|st\s|delete\s)/;
const isComment = (line: string) => /^\s*(?:#|\/\/|\*|\/\*)/.test(line);
/** The source line, in either spelling (scripts the tests run take WALG_ENV_SH). */
const SOURCES_WALG_ENV =
  /(?:^|[\s;&|])\.\s+(?:"\$\{WALG_ENV_SH:-\/etc\/postgresql\/walg-env\.sh\}"|\/etc\/postgresql\/walg-env\.sh)(?:\s|$|;|&)/;

function firstIndex(lines: string[], re: RegExp) {
  return lines.findIndex((l) => !isComment(l) && re.test(l));
}

describe('(a) every wal-g caller sources walg-env.sh first', () => {
  const carbonCallers = tracked('carbon')
    .filter((f) => /\.(sh|ya?ml)$/.test(f))
    .filter((f) =>
      read(f)
        .split('\n')
        .some((l) => !isComment(l) && WALG_CALL.test(l)),
    );

  it('the template wal-g callers are exactly the known five', () => {
    expect(carbonCallers.sort()).toEqual(
      [
        'carbon/backup/compose-backup.sh',
        'carbon/k8s/base/backup/configmap-walg.yaml',
        'carbon/k8s/base/backup/cronjob.yaml',
        'carbon/k8s/base/db/statefulset.yaml',
        'carbon/volumes/db/wal-archive.sh',
      ].sort(),
    );
  });

  it.each(carbonCallers)('%s sources walg-env.sh before its first wal-g call', (file) => {
    const lines = read(file).split('\n');
    const source = firstIndex(lines, SOURCES_WALG_ENV);
    const call = firstIndex(lines, WALG_CALL);
    expect(source, `${file} never sources walg-env.sh`).toBeGreaterThan(-1);
    expect(source, `${file} calls wal-g before sourcing walg-env.sh`).toBeLessThan(call);
  });

  it('the walg-restore init sources it only on a restore, with RESTORE_LINEAGE required (C15)', () => {
    const sts = read('carbon/k8s/base/db/statefulset.yaml');
    const normalBoot = sts.indexOf('walg-restore: no restore requested, normal boot.');
    const lineageRequired = sts.indexOf('RESTORE_BACKUP is set without RESTORE_LINEAGE');
    const source = sts.indexOf(`. ${WALG_ENV_PATH}`);
    const fetch = sts.indexOf('wal-g backup-fetch');
    expect(normalBoot).toBeGreaterThan(-1);
    expect(lineageRequired).toBeGreaterThan(normalBoot);
    expect(source).toBeGreaterThan(lineageRequired);
    expect(source).toBeLessThan(fetch);
    // One source only: the normal boot never reads a system identifier.
    expect(sts.split(`. ${WALG_ENV_PATH}`)).toHaveLength(2);
  });

  it('walg-env.sh is mounted wherever a wal-g caller runs (compose db, k8s db and init)', () => {
    const compose = loadYaml(read('carbon/docker-compose.yml')) as {
      services: { db: { volumes: string[] } };
    };
    expect(compose.services.db.volumes).toContain(
      './volumes/db/walg-env.sh:/etc/postgresql/walg-env.sh:ro,Z',
    );
    const sts = loadYaml(read('carbon/k8s/base/db/statefulset.yaml')) as {
      spec: {
        template: {
          spec: {
            initContainers: Array<{ name: string; volumeMounts: Array<Record<string, string>> }>;
            containers: Array<{ name: string; volumeMounts: Array<Record<string, string>> }>;
          };
        };
      };
    };
    const pod = sts.spec.template.spec;
    for (const c of [
      pod.initContainers.find((x) => x.name === 'walg-restore'),
      pod.containers.find((x) => x.name === 'db'),
    ]) {
      expect(c?.volumeMounts, c?.name).toContainEqual(
        expect.objectContaining({
          name: 'wal-archive-script',
          mountPath: WALG_ENV_PATH,
          subPath: 'walg-env.sh',
        }),
      );
    }
  });

  const srcCallers = tracked('src')
    .filter((f) => f.endsWith('.js'))
    .filter((f) =>
      read(f)
        .split('\n')
        .some((l) => !isComment(l) && WALG_CALL.test(l)),
    );

  it('the CLI files that build an in-container wal-g script are exactly the known four', () => {
    // Each one's built scripts are checked below. A new file here needs its
    // own case, which is the moment to make it source walg-env.sh.
    expect(srcCallers.sort()).toEqual(
      [
        'src/lib/deploy/backup-fence.js',
        'src/lib/deploy/compose/index.js',
        'src/lib/deploy/walg-audit.js',
        'src/lib/walg/recovery-config.js',
      ].sort(),
    );
  });

  const sourcedBefore = (script: string, call: string) => {
    const source = script.indexOf(WALG_ENV_SOURCE);
    expect(source, `no walg-env.sh source in:\n${script}`).toBeGreaterThan(-1);
    expect(source, `wal-g before walg-env.sh in:\n${script}`).toBeLessThan(script.indexOf(call));
  };

  it('backup-fence.js: the fence write lands in the lineage folder', () => {
    const script = backupFenceWriteScript({ primaryNode: 'a', timeline: 2 });
    expect(script.startsWith(WALG_ENV_SOURCE)).toBe(true);
    sourcedBefore(script, `wal-g st put --no-compress --no-encrypt -f /tmp/${BACKUP_FENCE_OBJECT}`);
    sourcedBefore(script, 'WALG_S3_PREFIX');
  });

  it('walg-audit.js: the probe (both modes) and the operator hints', () => {
    for (const requirePrimary of [false, true]) {
      const probe = buildWalgAuditProbe({ requirePrimary });
      sourcedBefore(probe, 'wal-g backup-list');
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in the script text, not a JS placeholder
      sourcedBefore(probe, 'PFX="${WALG_S3_PREFIX:-}"');
    }
    for (const hint of Object.values(VERIFY_HINTS))
      sourcedBefore(hint as string, 'wal-g backup-list');
  });

  it('compose/index.js: the restore script names the lineage, then sources, then fetches', () => {
    const script = composeRestoreScript({
      backup: 'base_000000010000000000000004',
      recoveryConf: renderRecoveryConf(buildRecoveryConfig({ target: 'latest' })),
      lineage: SYSID,
    });
    expect(script.indexOf(`export RESTORE_LINEAGE='${SYSID}'`)).toBeGreaterThan(-1);
    expect(script.indexOf(`export RESTORE_LINEAGE='${SYSID}'`)).toBeLessThan(
      script.indexOf(WALG_ENV_SOURCE),
    );
    sourcedBefore(script, 'wal-g backup-fetch');
  });

  it("recovery-config.js: restore_command fetches WAL from the restored lineage's folder", () => {
    const { lines } = buildRecoveryConfig({ target: 'latest' });
    const restoreCommand = lines.find((l) => l.startsWith('restore_command'));
    expect(restoreCommand).toBe(
      `restore_command = '${WALG_ENV_SOURCE} && wal-g wal-fetch "%f" "%p"'`,
    );
  });
});

describe('(b) WALG_PREVENT_WAL_OVERWRITE is on wherever WAL is pushed', () => {
  it('compose db env', () => {
    const compose = loadYaml(read('carbon/docker-compose.yml')) as {
      services: { db: { environment: Record<string, string> } };
    };
    expect(compose.services.db.environment.WALG_PREVENT_WAL_OVERWRITE).toBe('true');
  });

  it('k8s db container and walg-restore init', () => {
    const sts = loadYaml(read('carbon/k8s/base/db/statefulset.yaml')) as {
      spec: {
        template: {
          spec: {
            initContainers: Array<{ name: string; env: Array<{ name: string; value?: string }> }>;
            containers: Array<{ name: string; env: Array<{ name: string; value?: string }> }>;
          };
        };
      };
    };
    const pod = sts.spec.template.spec;
    for (const c of [
      pod.initContainers.find((x) => x.name === 'walg-restore'),
      pod.containers.find((x) => x.name === 'db'),
    ]) {
      expect(c?.env.find((e) => e.name === 'WALG_PREVENT_WAL_OVERWRITE')?.value, c?.name).toBe(
        'true',
      );
    }
  });

  it('the backup CronJob exec script', () => {
    const cron = read('carbon/k8s/base/backup/cronjob.yaml');
    const lines = cron.split('\n');
    const set = lines.findIndex((l) => l.trim() === 'export WALG_PREVENT_WAL_OVERWRITE=true');
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(firstIndex(lines, WALG_CALL));
  });
});

describe('(c) nothing sets WALG_S3_PREFIX but walg-env.sh', () => {
  const SETS = [
    /(?:^|[;&|]\s*|\bexport\s+)WALG_S3_PREFIX=/,
    /\s-e\s+["']?WALG_S3_PREFIX=/,
    /^["']?WALG_S3_PREFIX["']?\s*:(?!-)/,
    /name:\s*["']?WALG_S3_PREFIX["']?\s*$/,
    /\.WALG_S3_PREFIX\s*=(?!=)/,
    /\[['"]WALG_S3_PREFIX['"]\]\s*=(?!=)/,
  ];
  const sets = (line: string) => !isComment(line) && SETS.some((re) => re.test(line.trim()));
  const files = [...tracked('carbon'), ...tracked('src')].filter((f) =>
    /\.(sh|ya?ml|js|mjs|ts|tsx|json|toml|conf)$|\.env\.example$/.test(f),
  );

  it('walg-env.sh sets it (the patterns are live)', () => {
    expect(read(WALG_ENV_FILE).split('\n').filter(sets).length).toBeGreaterThanOrEqual(3);
  });

  it('no other file under carbon/ or src/ does, except the ConfigMap parity copy', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f === WALG_ENV_FILE) continue;
      for (const [i, line] of read(f).split('\n').entries()) {
        if (sets(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    }
    // The ConfigMap's sets are exactly the walg-env.sh key's (C16).
    const copy = (loadYaml(read(CONFIGMAP)) as { data: Record<string, string> }).data[
      'walg-env.sh'
    ];
    const inCopy = copy.split('\n').filter(sets).length;
    const cmOffenders = offenders.filter((o) => o.startsWith(`${CONFIGMAP}:`));
    expect(cmOffenders).toHaveLength(inCopy);
    expect(copy).toBe(read(WALG_ENV_FILE));
    expect(
      offenders.filter((o) => !o.startsWith(`${CONFIGMAP}:`)),
      'set WALG_S3_PREFIX_BASE and source walg-env.sh instead',
    ).toEqual([]);
  });

  it('the k8s render gives the db pod the base, never WALG_S3_PREFIX', () => {
    const values = buildDbManifestValues({
      dbImageTag: 'ghcr.io/hyperformant/postgres:17.11-walg3.0.9-r2',
      s3Config: { bucket: 'b', walgPrefix: 'backups/proj/prod/walg', endpoint: 'e', region: 'r' },
      backupBucketName: 'proj-backups',
      dbPrivateIp: '10.0.1.2',
      storageClass: 'hcloud-volumes',
      walArchiveSha: 'x',
    });
    expect(values.WALG_S3_PREFIX_BASE).toBe('s3://proj-backups/backups/proj/prod/walg');
    expect(values).not.toHaveProperty('WALG_S3_PREFIX');
    expect(read('carbon/k8s/base/db/statefulset.yaml')).not.toContain('{{WALG_S3_PREFIX}}');
  });
});

describe('(d) every WALG_S3_PREFIX_BASE construction has an env segment', () => {
  it('except the empty dev override', () => {
    const files = [
      ...tracked('src').filter((f) => f.endsWith('.js')),
      ...tracked('carbon').filter((f) => /docker-compose[^/]*\.yml$/.test(f)),
      ...tracked('carbon/k8s').filter((f) => /\.ya?ml$/.test(f)),
    ];
    const assignment = /^\s*(?:export\s+)?["']?WALG_S3_PREFIX_BASE["']?\s*[:=]\s*(\S.*)$/;
    const seen: string[] = [];
    const offenders: string[] = [];
    for (const f of files) {
      for (const [i, line] of read(f).split('\n').entries()) {
        const m = assignment.exec(line);
        if (!m || line.trimStart().startsWith('#')) continue;
        const value = m[1].trim();
        seen.push(`${f}:${i + 1}`);
        if (value === '""' || value === "''") continue;
        if (!/walgPrefix|VC_ENV/.test(value)) offenders.push(`${f}:${i + 1}: ${value}`);
      }
    }
    // compose, the dev override and k3s.js's render.
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(
      offenders,
      `WALG_S3_PREFIX_BASE without an env segment: ${offenders.join('; ')}`,
    ).toEqual([]);
  });
});
