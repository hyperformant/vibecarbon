/**
 * One archive folder per database lineage (H1, B1, B8; Decision 2, C16).
 *
 * The environment's backup prefix holds one folder per database, named by its
 * system identifier. `.vibecarbon.json` records the current one
 * (`backup.lineage`) and the ones before it (`backup.priorLineages`). Restore
 * reads one lineage's folder: -lineage when given, the recorded one when it
 * covers the target and no other is newer, and otherwise it refuses, listing
 * each lineage with its newest base, rather than silently restore the new
 * empty database or an old one.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  parseSystemIdentifier,
  recordDeployedLineage,
  SYSTEM_IDENTIFIER_SQL,
} from '../../../src/lib/deploy/backup-lineage.js';
import { envIdentityOf, resolveEnvSeed } from '../../../src/lib/env-identity.js';
import {
  AmbiguousLineageError,
  listLineages,
  NoRestorePointError,
  readEnvBaseBackups,
  recordBackupLineage,
  resolveDeployRestorePoint,
  resolveRestoreLineage,
} from '../../../src/lib/walg/restore-base.js';
import {
  RESTORE_MARKER_KEYS,
  restoreMarkerStringData,
} from '../../../src/lib/walg/restore-layout.js';

const OLD = '7612000000000000001';
const NEW = '7699032860122738725';
const BASE = 'backups/myapp/prod/walg';

const sentinel = (finish: string) =>
  JSON.stringify({ FinishTime: finish, LSN: 67108904, CompressedSize: 10, UncompressedSize: 20 });

/** S3 with ListObjectsV2 Prefix/Delimiter semantics (Contents + CommonPrefixes). */
function fakeS3(objects: Record<string, string>) {
  const calls: Array<{ command: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      calls.push({ command: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        const prefix = String(cmd.input.Prefix ?? '');
        const under = Object.keys(objects).filter((k) => k.startsWith(prefix));
        const contents = under.filter((k) => !k.slice(prefix.length).includes('/'));
        const common = [
          ...new Set(
            under
              .filter((k) => k.slice(prefix.length).includes('/'))
              .map((k) => `${prefix}${k.slice(prefix.length).split('/')[0]}/`),
          ),
        ];
        return {
          Contents: contents.map((Key) => ({ Key })),
          CommonPrefixes: common.map((Prefix) => ({ Prefix })),
          IsTruncated: false,
        };
      }
      if (cmd.constructor.name === 'GetObjectCommand') {
        const body = objects[String(cmd.input.Key)];
        if (body === undefined) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        return { Body: { transformToString: async () => body } };
      }
      throw new Error(`unexpected S3 command ${cmd.constructor.name}`);
    },
  };
}

const base = (lineage: string, name: string, finish: string) => ({
  [`${BASE}/${lineage}/basebackups_005/${name}_backup_stop_sentinel.json`]: sentinel(finish),
});

/** The old database's two bases; the new database archived WAL only. */
const destroyedAndRedeployed = {
  ...base(OLD, 'base_000000010000000000000004', '2026-10-18T02:00:00Z'),
  ...base(OLD, 'base_000000010000000000000008', '2026-10-19T02:00:00Z'),
  [`${BASE}/${NEW}/wal_005/000000010000000000000001.lz4`]: 'x',
  // Not a lineage folder (an object at the base root is no lineage).
  [`${BASE}/vibecarbon-notes.txt`]: 'x',
};

const at = (iso: string) => new Date(iso);

describe('listLineages', () => {
  it('lists each system-identifier folder with its oldest and newest base', async () => {
    const s3 = fakeS3(destroyedAndRedeployed);
    const lineages = await listLineages({ s3, bucket: 'myapp-backups', base: BASE });
    expect(lineages).toEqual([
      { lineage: NEW, oldestFinish: null, newestFinish: null },
      {
        lineage: OLD,
        oldestFinish: at('2026-10-18T02:00:00Z'),
        newestFinish: at('2026-10-19T02:00:00Z'),
      },
    ]);
    expect(s3.calls[0]).toEqual({
      command: 'ListObjectsV2Command',
      input: expect.objectContaining({ Prefix: `${BASE}/`, Delimiter: '/' }),
    });
  });

  it('a missing bucket is no lineages', async () => {
    const gone = {
      send: async () => {
        throw Object.assign(new Error('gone'), { name: 'NoSuchBucket' });
      },
    };
    expect(await listLineages({ s3: gone, bucket: 'b', base: BASE })).toEqual([]);
  });
});

const L = (lineage: string, oldest: string | null, newest: string | null) => ({
  lineage,
  oldestFinish: oldest ? at(oldest) : null,
  newestFinish: newest ? at(newest) : null,
});

describe('resolveRestoreLineage (no -lineage)', () => {
  const env = (lineage?: string) => ({ backup: lineage ? { lineage } : {} });

  it('uses the recorded lineage when it covers the target and nothing else is newer', () => {
    const lineages = [
      L(OLD, '2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z'),
      L(NEW, '2026-10-15T00:00:00Z', '2026-10-20T00:00:00Z'),
    ];
    expect(resolveRestoreLineage({ envConfig: env(NEW), lineages })).toBe(NEW);
    expect(
      resolveRestoreLineage({
        envConfig: env(NEW),
        lineages,
        target: at('2026-10-16T00:00:00Z'),
      }),
    ).toBe(NEW);
  });

  it('the recorded lineage has no base and a prior one does: refuses, listing both with their newest base', () => {
    const lineages = [L(OLD, '2026-10-18T02:00:00Z', '2026-10-19T02:00:00Z'), L(NEW, null, null)];
    let err: unknown;
    try {
      resolveRestoreLineage({ envConfig: env(NEW), lineages });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AmbiguousLineageError);
    const message = (err as Error).message;
    expect(message).toContain(`${OLD}  newest base 2026-10-19T02:00:00Z`);
    expect(message).toContain(`${NEW}  no base backups yet (recorded for this environment)`);
    expect(message).toContain('-lineage');
    expect((err as AmbiguousLineageError).lineages.map((l) => l.lineage)).toEqual([OLD, NEW]);
  });

  it('a recorded lineage absent from the bucket, beside one that holds bases, is listed too', () => {
    const lineages = [L(OLD, '2026-10-18T02:00:00Z', '2026-10-19T02:00:00Z')];
    expect(() => resolveRestoreLineage({ envConfig: env(NEW), lineages })).toThrow(
      new RegExp(`${NEW}  no base backups yet`),
    );
  });

  it('a prior lineage with a newer base than the recorded one refuses', () => {
    const lineages = [
      L(NEW, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'),
      L(OLD, '2026-10-01T00:00:00Z', '2026-10-09T00:00:00Z'),
    ];
    expect(() => resolveRestoreLineage({ envConfig: env(NEW), lineages })).toThrow(
      AmbiguousLineageError,
    );
  });

  it('a point in time before the recorded lineage, with another lineage beside it, refuses', () => {
    const lineages = [
      L(OLD, '2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z'),
      L(NEW, '2026-10-15T00:00:00Z', '2026-10-20T00:00:00Z'),
    ];
    expect(() =>
      resolveRestoreLineage({
        envConfig: env(NEW),
        lineages,
        target: at('2026-10-03T00:00:00Z'),
      }),
    ).toThrow(AmbiguousLineageError);
  });

  it('only one lineage: it, recorded or not; a point before it still resolves (the base pick names the window)', () => {
    const one = [L(NEW, '2026-10-15T00:00:00Z', '2026-10-20T00:00:00Z')];
    expect(resolveRestoreLineage({ envConfig: env(NEW), lineages: one })).toBe(NEW);
    expect(resolveRestoreLineage({ envConfig: {}, lineages: one })).toBe(NEW);
    expect(
      resolveRestoreLineage({
        envConfig: env(NEW),
        lineages: one,
        target: at('2026-10-01T00:00:00Z'),
      }),
    ).toBe(NEW);
  });

  it('nothing recorded and two lineages with bases refuses', () => {
    const lineages = [
      L(OLD, '2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z'),
      L(NEW, '2026-10-15T00:00:00Z', '2026-10-20T00:00:00Z'),
    ];
    expect(() => resolveRestoreLineage({ envConfig: {}, lineages })).toThrow(AmbiguousLineageError);
  });

  it('no base anywhere: the recorded lineage, or null', () => {
    expect(resolveRestoreLineage({ envConfig: env(NEW), lineages: [L(NEW, null, null)] })).toBe(
      NEW,
    );
    expect(resolveRestoreLineage({ envConfig: {}, lineages: [] })).toBeNull();
  });
});

describe('resolveRestoreLineage (-lineage)', () => {
  const lineages = [L(OLD, '2026-10-18T02:00:00Z', '2026-10-19T02:00:00Z'), L(NEW, null, null)];

  it('-lineage overrides the record and the ambiguity', () => {
    expect(
      resolveRestoreLineage({ envConfig: { backup: { lineage: NEW } }, lineages, flag: OLD }),
    ).toBe(OLD);
  });

  it('a -lineage with no base backups, or that is no system identifier, refuses', () => {
    expect(() => resolveRestoreLineage({ envConfig: {}, lineages, flag: NEW })).toThrow(
      NoRestorePointError,
    );
    expect(() => resolveRestoreLineage({ envConfig: {}, lineages, flag: NEW })).toThrow(
      new RegExp(`lineages with base backups: ${OLD}`),
    );
    expect(() => resolveRestoreLineage({ envConfig: {}, lineages, flag: '../x' })).toThrow(
      /not a database system identifier/,
    );
  });
});

describe('readEnvBaseBackups reads one lineage folder', () => {
  const S3 = {
    bucket: 'myapp-backups',
    endpoint: 'e',
    region: 'r',
    accessKey: 'a',
    secretKey: 's',
  };

  it('the recorded new lineage with no base, beside the old one, refuses (never the empty one)', async () => {
    await expect(
      readEnvBaseBackups({
        envName: 'prod',
        envConfig: { deployMode: 'compose', backup: { lineage: NEW, priorLineages: [OLD] } },
        projectName: 'myapp',
        s3Config: S3,
        makeClient: () => fakeS3(destroyedAndRedeployed),
      }),
    ).rejects.toThrow(AmbiguousLineageError);
  });

  it('-lineage reads that folder and names it in the location', async () => {
    const s3 = fakeS3(destroyedAndRedeployed);
    const listing = await readEnvBaseBackups({
      envName: 'prod',
      envConfig: { deployMode: 'compose', backup: { lineage: NEW, priorLineages: [OLD] } },
      projectName: 'myapp',
      s3Config: S3,
      lineage: OLD,
      makeClient: () => s3,
    });
    expect(listing.lineage).toBe(OLD);
    expect(listing.location).toBe(`s3://myapp-backups/${BASE}/${OLD}`);
    expect(listing.backups.map((b) => b.name)).toEqual([
      'base_000000010000000000000004',
      'base_000000010000000000000008',
    ]);
    const lists = s3.calls.filter((c) => c.command === 'ListObjectsV2Command');
    expect(lists.at(-1)?.input.Prefix).toBe(`${BASE}/${OLD}/basebackups_005/`);
  });

  it('no lineage on record and none with bases: an empty listing at the base', async () => {
    const listing = await readEnvBaseBackups({
      envName: 'prod',
      envConfig: { deployMode: 'compose' },
      projectName: 'myapp',
      s3Config: S3,
      makeClient: () => fakeS3({}),
    });
    expect(listing).toMatchObject({
      lineage: null,
      backups: [],
      location: `s3://myapp-backups/${BASE}`,
    });
  });
});

describe('deploy -restore resolves the lineage too', () => {
  const s3Config = {
    bucket: 'myapp-backups',
    walgPrefix: BASE,
    endpoint: 'e',
    region: 'r',
    accessKey: 'a',
    secretKey: 's',
  };
  const args = (over: Record<string, unknown> = {}) => ({
    restore: 'latest',
    k8s: true,
    s3Config,
    credentialVars: 'HETZNER_ACCESS_KEY and HETZNER_SECRET_KEY',
    makeClient: () => fakeS3(destroyedAndRedeployed),
    ...over,
  });

  it("the destroyed environment's recorded lineage: its newest base, and the marker names the lineage", async () => {
    const point = await resolveDeployRestorePoint(
      args({ envConfig: { backup: { lineage: OLD } } }),
    );
    expect(point).toMatchObject({ backup: 'base_000000010000000000000008', lineage: OLD });
    const marker = restoreMarkerStringData({ ...point, origin: 'deploy' } as never);
    expect(marker.RESTORE_LINEAGE).toBe(OLD);
  });

  it('ambiguous refuses; -lineage chooses; -lineage without -restore refuses', async () => {
    await expect(
      resolveDeployRestorePoint(args({ envConfig: { backup: { lineage: NEW } } })),
    ).rejects.toThrow(AmbiguousLineageError);
    await expect(
      resolveDeployRestorePoint(args({ envConfig: { backup: { lineage: NEW } }, lineage: OLD })),
    ).resolves.toMatchObject({ lineage: OLD });
    await expect(resolveDeployRestorePoint(args({ restore: null, lineage: OLD }))).rejects.toThrow(
      /pass it with -restore/,
    );
  });
});

describe('the restore marker carries RESTORE_LINEAGE', () => {
  const marker = {
    backup: 'base_000000010000000000000004',
    target: 'latest',
    recoveryConf: '-restore_command',
    attempt: '0f0e5c1a-0000-4000-8000-000000000001',
    origin: 'restore' as const,
  };

  it('set with the rest, cleared with the rest', () => {
    expect(RESTORE_MARKER_KEYS).toContain('RESTORE_LINEAGE');
    expect(restoreMarkerStringData({ ...marker, lineage: OLD }).RESTORE_LINEAGE).toBe(OLD);
    expect(restoreMarkerStringData(null).RESTORE_LINEAGE).toBe('');
  });

  it('a marker with no lineage is refused', () => {
    expect(() => restoreMarkerStringData(marker as never)).toThrow(
      /not a database system identifier/,
    );
  });
});

describe('a destroyed and redeployed environment keeps its old lineage on record (B8)', () => {
  const project = {
    projectName: 'myapp',
    environments: {},
    destroyedEnvironments: {
      prod: {
        destroyedAt: '2026-10-19T12:00:00Z',
        deployMode: 'compose',
        backup: { schedule: '0 */6 * * *', retentionDays: 30, lineage: OLD },
      },
    },
  };

  it('destroy keeps backup.lineage in the identity record', () => {
    expect(
      envIdentityOf({ deployMode: 'compose', backup: { lineage: OLD, priorLineages: ['1'] } }),
    ).toMatchObject({ backup: { lineage: OLD, priorLineages: ['1'] } });
    expect(resolveEnvSeed(project, 'prod').envConfig.backup).toMatchObject({ lineage: OLD });
  });

  it('the redeploy records the new lineage and pushes the old one to priorLineages', () => {
    const seed = resolveEnvSeed(project, 'prod').envConfig.backup as { lineage: string };
    expect(recordBackupLineage(seed, NEW)).toEqual({ lineage: NEW, priorLineages: [OLD] });
    // The same database again changes nothing; priorLineages never repeats.
    expect(recordBackupLineage({ lineage: NEW, priorLineages: [OLD] }, NEW)).toEqual({
      lineage: NEW,
      priorLineages: [OLD],
    });
    expect(recordBackupLineage({ lineage: OLD, priorLineages: [NEW] }, NEW)).toEqual({
      lineage: NEW,
      priorLineages: [OLD],
    });
    expect(recordBackupLineage(undefined, NEW)).toEqual({ lineage: NEW });
  });

  it('the deploy reads the system identifier and names the restore of each earlier lineage', async () => {
    const info: string[] = [];
    const record = await recordDeployedLineage({
      environment: 'prod',
      backup: { lineage: OLD },
      exec: async (sql) => (sql === SYSTEM_IDENTIFIER_SQL ? `${NEW}\n` : ''),
      where: '10.0.0.1',
      listLineages: async () => [
        L(OLD, '2026-10-18T02:00:00Z', '2026-10-19T02:00:00Z'),
        L(NEW, null, null),
      ],
      log: { info: (m) => info.push(m), warn: () => {} },
    });
    expect(record).toEqual({ lineage: NEW, priorLineages: [OLD] });
    expect(info.join('\n')).toContain(`vibecarbon restore prod -lineage ${OLD}`);
    expect(info.join('\n')).not.toContain(`-lineage ${NEW}`);
  });

  it('the same lineage lists nothing; an unreadable system identifier fails the deploy', async () => {
    const list = vi.fn();
    await expect(
      recordDeployedLineage({
        environment: 'prod',
        backup: { lineage: NEW },
        exec: async () => NEW,
        where: '10.0.0.1',
        listLineages: list,
        log: { info: () => {}, warn: () => {} },
      }),
    ).resolves.toEqual({ lineage: NEW });
    expect(list).not.toHaveBeenCalled();
    await expect(
      recordDeployedLineage({
        environment: 'prod',
        backup: { lineage: NEW },
        exec: async () => 'ERROR: connection refused',
        where: '10.0.0.1',
        log: { info: () => {}, warn: () => {} },
      }),
    ).rejects.toThrow(/could not read the database system identifier on 10\.0\.0\.1/);
    expect(parseSystemIdentifier(`${NEW}\n`)).toBe(NEW);
    expect(parseSystemIdentifier('')).toBeNull();
  });

  it("every deploy's final save records it, from the pre-deploy backup block", () => {
    const orch = readFileSync('src/lib/deploy/orchestrator.js', 'utf-8');
    expect(orch).toMatch(/recordDeployedLineage\(\{\s*environment,\s*backup: envConfig\.backup,/);
    expect(orch).toContain('backup: { ...backupConfig, ...backupLineage },');
    // Before the final save.
    expect(orch.indexOf('recordDeployedLineage({')).toBeLessThan(
      orch.indexOf('saveProjectConfig(clearDestroyedRecord(finalConfig, environment))'),
    );
  });
});
