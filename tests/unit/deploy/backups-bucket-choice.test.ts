/**
 * Which backups bucket an environment gets (src/lib/backups-bucket.js).
 *
 * One bucket per project and storage region: the first region keeps
 * `<project>-<salt>-backups`, each further region gets
 * `<project>-<salt>-<region>-backups`. The chooser's rules, first match wins:
 * recorded (the env's own record, never moved), shared (another environment's
 * backups in this region), first (the base name, held by nobody), region (the
 * region's own name). The settle step creates the chosen bucket and takes its
 * region and endpoint from that create, never from the plan.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  backupsBucketHolders,
  backupsHoldings,
  backupsTargetOf,
  chooseBackupsBucket,
  settleBackupsBucket,
} from '../../../src/lib/backups-bucket.js';
import { resolveEnvSeed } from '../../../src/lib/env-identity.js';

const BASE = 'myapp-abc123-backups';
const FSN1 = 'myapp-abc123-fsn1-backups';
const HEL1 = 'myapp-abc123-hel1-backups';
const EP = (region: string) => `https://${region}.your-objectstorage.com`;

/** A deployed environment whose backups are recorded in `bucket` at `region`. */
function live(storage: string, bucket: string, region = storage) {
  return {
    deployedAt: '2026-11-01T00:00:00.000Z',
    s3: { bucket: 'x-storage', region: storage, endpoint: EP(storage) },
    backupS3: { bucket, region, endpoint: EP(region) },
  };
}

function project(environments: object = {}, destroyedEnvironments?: object) {
  return {
    projectName: 'myapp',
    bucketSalt: 'abc123',
    environments,
    ...(destroyedEnvironments && { destroyedEnvironments }),
  };
}

const choose = (projectConfig: object, region: string, envConfig: object = {}) =>
  chooseBackupsBucket({ environment: 'staging', envConfig, projectConfig, region } as never);

describe('backupsTargetOf (the one reader of environments.<env>.backupS3)', () => {
  it('returns the record as is', () => {
    expect(backupsTargetOf(live('fsn1', BASE, 'nbg1'))).toEqual({
      bucket: BASE,
      region: 'nbg1',
      endpoint: EP('nbg1'),
    });
  });

  it('is null without a record or without a bucket', () => {
    expect(backupsTargetOf({})).toBeNull();
    expect(backupsTargetOf(undefined as never)).toBeNull();
    expect(backupsTargetOf({ backupS3: { region: 'nbg1' } })).toBeNull();
  });

  it('falls back to the uploads region, and to its endpoint, for a record without a region (very old CLIs)', () => {
    expect(
      backupsTargetOf({ s3: { region: 'fsn1', endpoint: EP('fsn1') }, backupS3: { bucket: BASE } }),
    ).toEqual({ bucket: BASE, region: 'fsn1', endpoint: EP('fsn1') });
  });

  it('takes the uploads endpoint only when the regions match, else null', () => {
    expect(
      backupsTargetOf({
        s3: { region: 'fsn1', endpoint: EP('fsn1') },
        backupS3: { bucket: BASE, region: 'fsn1' },
      }),
    ).toEqual({ bucket: BASE, region: 'fsn1', endpoint: EP('fsn1') });
    expect(
      backupsTargetOf({
        s3: { region: 'fsn1', endpoint: EP('fsn1') },
        backupS3: { bucket: BASE, region: 'nbg1' },
      }),
    ).toEqual({ bucket: BASE, region: 'nbg1', endpoint: null });
  });
});

describe('backupsHoldings and backupsBucketHolders', () => {
  it('counts every live record, and leaves out the excepted environment', () => {
    const config = project({ prod: live('nbg1', BASE), staging: live('fsn1', FSN1) });
    expect(backupsHoldings(config as never, { except: 'staging' })).toEqual([
      { env: 'prod', bucket: BASE, region: 'nbg1' },
    ]);
  });

  it('counts a preserved destroyed sibling, not a backupsPurged one', () => {
    const config = project(
      {},
      {
        old: { backupS3: { bucket: BASE, region: 'nbg1', endpoint: EP('nbg1') } },
        gone: {
          backupS3: { bucket: FSN1, region: 'fsn1', endpoint: EP('fsn1') },
          backupsPurged: true,
        },
      },
    );
    expect(backupsHoldings(config as never, {})).toEqual([
      { env: 'old', bucket: BASE, region: 'nbg1' },
    ]);
  });

  it('a live sibling deployed by an older CLI, with no record, holds the base name in its uploads region', () => {
    const legacy = { deployedAt: '2026-01-01T00:00:00.000Z', s3: { region: 'hel1' } };
    // A skeleton that never finished holds nothing.
    const skeleton = { status: 'deploying', s3: { region: 'nbg1' } };
    const config = project({ legacy, skeleton });
    expect(backupsHoldings(config as never, {})).toEqual([
      { env: 'legacy', bucket: BASE, region: 'hel1' },
    ]);
  });

  it('names each environment holding exactly that bucket, once', () => {
    const config = project(
      { prod: live('nbg1', BASE), staging: live('fsn1', FSN1), preview: live('nbg1', BASE) },
      // A rebuild in flight: the destroyed record and the new live entry share a name.
      { prod: { backupS3: { bucket: BASE, region: 'nbg1' } } },
    );
    expect(backupsBucketHolders(config as never, { bucket: BASE, except: 'preview' })).toEqual([
      'prod',
    ]);
    expect(backupsBucketHolders(config as never, { bucket: FSN1, except: 'prod' })).toEqual([
      'staging',
    ]);
    expect(backupsBucketHolders(config as never, { bucket: FSN1, except: 'staging' })).toEqual([]);
  });
});

describe('chooseBackupsBucket', () => {
  it('first: an empty project gets the base name in its region', () => {
    expect(choose(project(), 'fsn1')).toEqual({ bucket: BASE, region: 'fsn1', source: 'first' });
  });

  it('first: an unsalted project keeps its unsalted base name', () => {
    const config = { projectName: 'myapp', environments: {} };
    expect(choose(config, 'fsn1')).toEqual({
      bucket: 'myapp-backups',
      region: 'fsn1',
      source: 'first',
    });
  });

  it('region: the base name lives in another region, so this region gets its own name', () => {
    expect(choose(project({ prod: live('nbg1', BASE) }), 'fsn1')).toEqual({
      bucket: FSN1,
      region: 'fsn1',
      source: 'region',
    });
  });

  it('shared: a third environment joins the bucket of its region', () => {
    const config = project({ prod: live('nbg1', BASE), staging: live('fsn1', FSN1) });
    const preview = (region: string) =>
      chooseBackupsBucket({ environment: 'preview', envConfig: {}, projectConfig: config, region });
    expect(preview('nbg1')).toEqual({ bucket: BASE, region: 'nbg1', source: 'shared' });
    expect(preview('fsn1')).toEqual({ bucket: FSN1, region: 'fsn1', source: 'shared' });
  });

  it('shared beats first: a region bucket shared by a sibling wins over the unused base name', () => {
    // The base name is held by nobody, so `first` would pick it.
    expect(choose(project({ prod: live('fsn1', FSN1) }), 'fsn1')).toEqual({
      bucket: FSN1,
      region: 'fsn1',
      source: 'shared',
    });
  });

  it('shared: a preserved destroyed sibling counts, a backupsPurged one does not', () => {
    const preserved = project({}, { old: { backupS3: { bucket: BASE, region: 'nbg1' } } });
    expect(choose(preserved, 'nbg1')).toEqual({ bucket: BASE, region: 'nbg1', source: 'shared' });
    expect(choose(preserved, 'fsn1').source).toBe('region');
    const purged = project(
      {},
      { old: { backupS3: { bucket: BASE, region: 'nbg1' }, backupsPurged: true } },
    );
    expect(choose(purged, 'fsn1')).toEqual({ bucket: BASE, region: 'fsn1', source: 'first' });
  });

  it('shared: a live sibling with no record holds the base name in its uploads region', () => {
    const config = project({
      legacy: { deployedAt: '2026-01-01T00:00:00.000Z', s3: { region: 'hel1' } },
    });
    expect(choose(config, 'hel1')).toEqual({ bucket: BASE, region: 'hel1', source: 'shared' });
    expect(choose(config, 'fsn1')).toEqual({ bucket: FSN1, region: 'fsn1', source: 'region' });
  });

  it('shared: several names in one region pick the base name, else the smallest', () => {
    const withBase = project({ a: live('hel1', HEL1), b: live('hel1', BASE) });
    expect(choose(withBase, 'hel1')).toEqual({ bucket: BASE, region: 'hel1', source: 'shared' });
    const withoutBase = project({
      a: live('hel1', 'myapp-zz-backups'),
      b: live('hel1', HEL1),
      c: live('nbg1', BASE),
    });
    expect(choose(withoutBase, 'hel1')).toEqual({ bucket: HEL1, region: 'hel1', source: 'shared' });
  });

  it('recorded beats shared: an environment keeps its own record, region included', () => {
    const config = project({ prod: live('fsn1', FSN1) });
    const staging = live('fsn1', BASE, 'nbg1');
    expect(choose(config, 'fsn1', staging)).toEqual({
      bucket: BASE,
      region: 'nbg1',
      source: 'recorded',
    });
  });

  it('recorded: a destroyed environment seeded for a rebuild keeps its recorded bucket', () => {
    const config = project(
      { prod: live('fsn1', FSN1) },
      { staging: { backupS3: { bucket: BASE, region: 'nbg1', endpoint: EP('nbg1') } } },
    );
    const { envConfig } = resolveEnvSeed(config, 'staging');
    expect(choose(config, 'fsn1', envConfig)).toEqual({
      bucket: BASE,
      region: 'nbg1',
      source: 'recorded',
    });
  });

  it("never counts the environment's own entries as a sibling", () => {
    // staging's own skeleton (no record yet) and its own purged record hold nothing.
    const config = project({ staging: { status: 'deploying' } }, {});
    expect(choose(config, 'fsn1')).toEqual({ bucket: BASE, region: 'fsn1', source: 'first' });
  });
});

describe('settleBackupsBucket', () => {
  const projectConfig = project();
  const created = (region: string, isNew = true) => ({
    name: 'n',
    created: isNew,
    ready: true,
    region,
    endpoint: EP(region),
  });

  it("re-chooses in the uploads bucket's region when the plan named another", async () => {
    const rechoose = vi.fn(() => ({ bucket: FSN1, region: 'fsn1', source: 'region' }));
    const create = vi.fn(async (_b: string, region: string) => created(region));
    const settled = await settleBackupsBucket({
      plan: { bucket: BASE, region: 'nbg1', source: 'first' },
      appRegion: 'fsn1',
      environment: 'staging',
      projectConfig,
      rechoose,
      create,
      log: vi.fn(),
    } as never);
    expect(rechoose).toHaveBeenCalledWith('fsn1');
    expect(create.mock.calls).toEqual([[FSN1, 'fsn1']]);
    expect(settled).toEqual({
      target: { bucket: FSN1, region: 'fsn1', endpoint: EP('fsn1') },
      created: true,
      source: 'region',
    });
  });

  it('never re-chooses a recorded bucket', async () => {
    const rechoose = vi.fn();
    const create = vi.fn(async (_b: string, region: string) => created(region, false));
    const settled = await settleBackupsBucket({
      plan: { bucket: BASE, region: 'nbg1', source: 'recorded' },
      appRegion: 'fsn1',
      environment: 'staging',
      projectConfig,
      rechoose,
      create,
      log: vi.fn(),
    } as never);
    expect(rechoose).not.toHaveBeenCalled();
    expect(create.mock.calls).toEqual([[BASE, 'nbg1']]);
    expect(settled.target).toEqual({ bucket: BASE, region: 'nbg1', endpoint: EP('nbg1') });
  });

  it('switches from the base name to the region name when the base lives elsewhere, and says so', async () => {
    const log = vi.fn();
    const create = vi.fn(async (bucket: string, region: string) =>
      bucket === BASE ? created('nbg1', false) : created(region),
    );
    const settled = await settleBackupsBucket({
      plan: { bucket: BASE, region: 'fsn1', source: 'first' },
      appRegion: 'fsn1',
      environment: 'staging',
      projectConfig,
      rechoose: vi.fn(),
      create,
      log,
    } as never);
    expect(create.mock.calls).toEqual([
      [BASE, 'fsn1'],
      [FSN1, 'fsn1'],
    ]);
    expect(log.mock.calls).toEqual([
      [`${BASE} already lives in nbg1, so staging's backups in fsn1 go to ${FSN1}`],
    ]);
    // Not `region`: the switch said its one line, so the caller's
    // first-in-region line stays quiet.
    expect(settled).toEqual({
      target: { bucket: FSN1, region: 'fsn1', endpoint: EP('fsn1') },
      created: true,
      source: 'switched',
    });
  });

  it('takes region and endpoint from the create, never from the plan', async () => {
    const log = vi.fn();
    const settled = await settleBackupsBucket({
      plan: { bucket: HEL1, region: 'fsn1', source: 'shared' },
      appRegion: 'fsn1',
      environment: 'staging',
      projectConfig,
      rechoose: vi.fn(),
      create: vi.fn(async () => created('hel1', false)),
      log,
    } as never);
    expect(settled.target).toEqual({ bucket: HEL1, region: 'hel1', endpoint: EP('hel1') });
    // Only a `first` plan switches.
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps the base name when its create answers in the planned region', async () => {
    const log = vi.fn();
    const settled = await settleBackupsBucket({
      plan: { bucket: BASE, region: 'fsn1', source: 'first' },
      appRegion: 'fsn1',
      environment: 'staging',
      projectConfig,
      rechoose: vi.fn(),
      create: vi.fn(async (_b: string, region: string) => created(region)),
      log,
    } as never);
    expect(settled).toEqual({
      target: { bucket: BASE, region: 'fsn1', endpoint: EP('fsn1') },
      created: true,
      source: 'first',
    });
    expect(log).not.toHaveBeenCalled();
  });
});
