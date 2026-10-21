/**
 * The base backups an environment can restore from, read by the CLI straight
 * from the wal-g stop sentinels in its backup bucket (H3).
 *
 * Restore used to run `wal-g backup-fetch ... LATEST` on the server and let
 * wal-g pick. The CLI never knew which backup it was about to take, could not
 * tell the operator, could not refuse a point-in-time target older than every
 * base before stopping the database, and listed restore points through a
 * second path (wal-g's own listing over SSH, which needed a running db) that
 * could disagree with what the fetch then took. Now the CLI lists, resolves
 * the exact base, and the server fetches that name.
 *
 * Every wal-g base backup ends with `<prefix>/basebackups_005/<name>_backup_stop_sentinel.json`,
 * written last, so a backup with a sentinel is complete. This module only
 * reads (ListObjectsV2, GetObject). It never creates or probes for a bucket:
 * a missing bucket or prefix is simply no backups.
 *
 * Restore therefore needs the backup bucket's credentials locally (Decision 1):
 * the provider's object-storage env vars, or the interactive prompt.
 *
 * LINEAGES. Inside the environment's prefix each database lineage archives in
 * its own folder, named by its system identifier (carbon/volumes/db/walg-env.sh):
 * `<prefix>/<sysid>/basebackups_005/...`. A destroyed and redeployed
 * environment is a new lineage beside the old one. `.vibecarbon.json` records
 * the current one as `backup.lineage` and the ones before it as
 * `backup.priorLineages` (recordBackupLineage), and both survive a destroy
 * (env-identity.js). Every listing here reads one lineage's folder, chosen by
 * resolveRestoreLineage: never silently the new empty lineage when an older
 * one holds the backups (Decision 2).
 */
import { randomUUID } from 'node:crypto';
import * as p from '@clack/prompts';
import { formatInstant } from '../backup-format.js';
import { formatBytes } from '../backup-s3.js';
import { c } from '../colors.js';
import { loadBackupS3Config, loadS3Config } from '../config.js';
import { providerFor } from '../providers/index.js';
import { buildRecoveryConfig, RESTORE_PITR_RE, renderRecoveryConf } from './recovery-config.js';
import { BACKUP_NAME_RE, LINEAGE_RE } from './restore-layout.js';

const SENTINEL_SUFFIX = '_backup_stop_sentinel.json';

/** No base backup satisfies the requested restore point. */
export class NoRestorePointError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoRestorePointError';
  }
}

/**
 * More than one database lineage could be meant, and restore will not guess
 * (Decision 2). `lineages` is the listing it chose between.
 */
export class AmbiguousLineageError extends Error {
  /**
   * @param {string} message
   * @param {Array<{ lineage: string, oldestFinish: Date|null, newestFinish: Date|null }>} lineages
   */
  constructor(message, lineages) {
    super(message);
    this.name = 'AmbiguousLineageError';
    this.lineages = lineages;
  }
}

/**
 * The wal-g prefix inside the backup bucket: one per environment. The same
 * path compose renders into WALG_S3_PREFIX_BASE (carbon/docker-compose.yml)
 * and resolveEnvStorage hands k8s. Each lineage's archive is a folder under
 * it (listLineages).
 *
 * @param {string} projectName
 * @param {string} envName
 */
export function walgPrefixFor(projectName, envName) {
  return `backups/${projectName}/${envName}/walg`;
}

/** An S3 client for a resolved backup S3 config. */
export async function createS3Client(s3Config) {
  const { S3Client } = await import('@aws-sdk/client-s3');
  return new S3Client({
    region: s3Config.region,
    endpoint: s3Config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: s3Config.accessKey, secretAccessKey: s3Config.secretKey },
  });
}

/**
 * Resolve the backup bucket's S3 config, credentials included. Compose reads
 * the dedicated backup bucket; k8s prefers it and falls back to the storage
 * bucket (where its db pod's wal-g writes when there is no backup bucket).
 * Credentials are topped up from the provider's object-storage env vars, then
 * the prompt unless `skipPrompts`. Null when no bucket or no credentials.
 *
 * @param {{ isCompose: boolean, envName: string, projectName: string, envConfig: object, skipPrompts?: boolean }} args
 * @returns {Promise<{ bucket: string, endpoint: string, region: string, accessKey: string, secretKey: string } | null>}
 */
export async function resolveS3Config({
  isCompose,
  envName,
  projectName,
  envConfig,
  skipPrompts = false,
}) {
  const Provider = providerFor(envConfig);
  const backupS3 = loadBackupS3Config(envName);
  const s3Config = isCompose ? backupS3 : backupS3 || loadS3Config(envName);
  if (!s3Config?.bucket) return null;
  if (s3Config.accessKey && s3Config.secretKey) return s3Config;
  const creds = await Provider.promptObjectStorageCredentials(projectName, {
    save: false,
    skipPrompts,
  });
  if (!creds) return null;
  return { ...s3Config, accessKey: creds.accessKey, secretKey: creds.secretKey };
}

/** The env vars a provider's object-storage credentials come from, for messages. */
export function backupCredentialVars(envConfig) {
  const vars = providerFor(envConfig).OBJECT_STORAGE_ENV ?? [];
  return vars.length ? vars.join(' and ') : 'the object-storage credentials';
}

/** "0/1A2B3C" from a numeric LSN, or the string as given. */
function formatLsn(raw) {
  if (typeof raw === 'string') return raw;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return '';
  const hi = Math.floor(raw / 2 ** 32);
  const lo = raw % 2 ** 32;
  return `${hi.toString(16).toUpperCase()}/${lo.toString(16).toUpperCase()}`;
}

async function bodyText(body) {
  if (body && typeof body.transformToString === 'function') return body.transformToString();
  return String(body ?? '');
}

/**
 * Every complete base backup under `<prefix>/basebackups_005/`, oldest first.
 *
 * @param {{ s3: { send: (cmd: unknown) => Promise<any> }, bucket: string, prefix: string }} args
 * @returns {Promise<Array<{ name: string, timeline: number, startLsn: string, finishTime: Date, sizeBytes: number, uncompressedBytes: number }>>}
 */
export async function listBaseBackups({ s3, bucket, prefix }) {
  const { GetObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const folder = `${prefix.replace(/\/+$/, '')}/basebackups_005/`;
  const keys = [];
  let token;
  do {
    let page;
    try {
      page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: folder,
          Delimiter: '/',
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
    } catch (err) {
      if (err?.name === 'NoSuchBucket' || err?.Code === 'NoSuchBucket') return [];
      throw err;
    }
    for (const obj of page?.Contents ?? []) {
      if (obj?.Key?.endsWith(SENTINEL_SUFFIX)) keys.push(obj.Key);
    }
    token = page?.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  const backups = [];
  for (const key of keys) {
    const name = key.slice(folder.length, -SENTINEL_SUFFIX.length);
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const sentinel = JSON.parse(await bodyText(res?.Body));
    const finishTime = new Date(sentinel.FinishTime);
    if (Number.isNaN(finishTime.getTime())) {
      throw new Error(`base backup ${name}: its stop sentinel has no readable FinishTime`);
    }
    const compressed = Number(sentinel.CompressedSize);
    const uncompressed = Number(sentinel.UncompressedSize);
    backups.push({
      name,
      timeline: Number.parseInt(name.slice('base_'.length, 'base_'.length + 8), 16),
      startLsn: formatLsn(sentinel.LSN ?? sentinel.StartLsn),
      finishTime,
      sizeBytes: compressed > 0 ? compressed : uncompressed || 0,
      uncompressedBytes: uncompressed > 0 ? uncompressed : compressed || 0,
    });
  }
  return backups.sort((a, b) => a.finishTime.getTime() - b.finishTime.getTime());
}

/**
 * The database lineages archived under an environment's prefix: one folder
 * per system identifier (ListObjectsV2 with Delimiter '/'), each with the
 * finish times of its oldest and newest complete base backup (null when it
 * holds none). Folders that are not a system identifier are not lineages.
 * Oldest lineage first, by its newest base (lineages with none first).
 *
 * @param {{ s3: { send: (cmd: unknown) => Promise<any> }, bucket: string, base: string }} args
 * @returns {Promise<Array<{ lineage: string, oldestFinish: Date|null, newestFinish: Date|null }>>}
 */
export async function listLineages({ s3, bucket, base }) {
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const root = `${base.replace(/\/+$/, '')}/`;
  const ids = [];
  let token;
  do {
    let page;
    try {
      page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: root,
          Delimiter: '/',
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
    } catch (err) {
      if (err?.name === 'NoSuchBucket' || err?.Code === 'NoSuchBucket') return [];
      throw err;
    }
    for (const cp of page?.CommonPrefixes ?? []) {
      const id = String(cp?.Prefix ?? '')
        .slice(root.length)
        .replace(/\/$/, '');
      if (LINEAGE_RE.test(id)) ids.push(id);
    }
    token = page?.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  const lineages = [];
  for (const lineage of ids) {
    const backups = await listBaseBackups({ s3, bucket, prefix: `${root}${lineage}` });
    lineages.push({
      lineage,
      oldestFinish: backups[0]?.finishTime ?? null,
      newestFinish: backups.at(-1)?.finishTime ?? null,
    });
  }
  const at = (l) => l.newestFinish?.getTime() ?? -1;
  return lineages.sort((a, b) => at(a) - at(b));
}

function instant(d) {
  return d ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

/**
 * The lineage a restore reads (Decision 2, C16). `-lineage` (`flag`) decides
 * when given and must name a lineage that holds base backups. Otherwise the
 * recorded `envConfig.backup.lineage`, when it covers the target (any base for
 * 'latest'; its oldest base finished at or before an instant) and no other
 * lineage has a newer base. With nothing recorded, the only lineage that holds
 * bases. With no bases anywhere, the recorded lineage (or null), so the caller
 * reports an empty listing. Anything else is ambiguous: a redeployed env whose
 * new database has no base yet beside the old one's backups must never restore
 * the empty one, or the old one, without the operator saying which.
 *
 * @param {{ envConfig?: object, lineages: Array<{ lineage: string, oldestFinish: Date|null, newestFinish: Date|null }>, flag?: string|null, target?: 'latest' | Date }} args
 * @returns {string|null}
 * @throws {AmbiguousLineageError}
 * @throws {NoRestorePointError} when `flag` names no lineage with base backups
 */
export function resolveRestoreLineage({ envConfig, lineages, flag = null, target = 'latest' }) {
  const withBases = lineages.filter((l) => l.newestFinish);
  if (flag !== null && flag !== undefined && flag !== '') {
    const named = String(flag);
    if (!LINEAGE_RE.test(named)) {
      throw new NoRestorePointError(
        `-lineage ${named} is not a database system identifier (digits only)`,
      );
    }
    if (!withBases.some((l) => l.lineage === named)) {
      const known = withBases.map((l) => l.lineage).join(', ') || 'none';
      throw new NoRestorePointError(
        `lineage ${named} holds no base backups (lineages with base backups: ${known})`,
      );
    }
    return named;
  }
  const current = envConfig?.backup?.lineage ? String(envConfig.backup.lineage) : null;
  // A deploy replaced an archived database (unrestoredPrior): the new one's
  // own bases, however new, never make the pick while the old one holds bases.
  const unrestored = envConfig?.backup?.unrestoredPrior
    ? String(envConfig.backup.unrestoredPrior)
    : null;
  if (unrestored && unrestored !== current && withBases.some((l) => l.lineage === unrestored)) {
    throw ambiguousLineage(
      `this environment's database was replaced by a new one (lineage ${current ?? 'unknown'}) while lineage ${unrestored} still holds backups, and restore will not guess which one you mean:`,
      withBases,
      current,
    );
  }
  const others = withBases.filter((l) => l.lineage !== current);
  if (others.length === 0) return current;
  const cur = withBases.find((l) => l.lineage === current);
  if (!current && others.length === 1) return others[0].lineage;
  if (cur) {
    const covers =
      target === 'latest' || !target || (cur.oldestFinish && cur.oldestFinish <= target);
    const newer = others.some((l) => l.newestFinish > cur.newestFinish);
    if (covers && !newer) return current;
  }
  throw ambiguousLineage(
    'more than one database lineage holds backups for this environment, and restore will not guess which one you mean:',
    withBases,
    current,
  );
}

/** The refusal: each lineage with its newest and oldest base, and the flag. */
function ambiguousLineage(head, withBases, current) {
  const cur = withBases.find((l) => l.lineage === current);
  const listed = [
    ...(current && !cur ? [{ lineage: current, oldestFinish: null, newestFinish: null }] : []),
    ...withBases,
  ].sort((a, b) => (b.newestFinish?.getTime() ?? -1) - (a.newestFinish?.getTime() ?? -1));
  const rows = listed.map(
    (l) =>
      `  ${l.lineage}  ${l.newestFinish ? `newest base ${instant(l.newestFinish)}, oldest ${instant(l.oldestFinish)}` : 'no base backups yet'}` +
      `${l.lineage === current ? ' (recorded for this environment)' : ''}`,
  );
  return new AmbiguousLineageError(
    [head, ...rows, 'Pass -lineage <system identifier> to choose one.'].join('\n'),
    listed,
  );
}

/**
 * The `backup` record after a deploy read the database's system identifier:
 * `lineage` is it, and a changed one moves the old lineage to the front of
 * `priorLineages` (B8), so a restore can still name the archive a destroyed
 * database left. Pure.
 *
 * A recorded `unrestoredPrior` (see recordDeployedLineage) survives a deploy
 * of the same database and is dropped when the lineage changes (the deploy
 * computes a new one).
 *
 * @param {{ lineage?: string, priorLineages?: string[], unrestoredPrior?: string } | undefined} backup
 * @param {string} sysid
 * @returns {{ lineage: string, priorLineages?: string[], unrestoredPrior?: string }}
 */
export function recordBackupLineage(backup, sysid) {
  if (!LINEAGE_RE.test(String(sysid ?? ''))) {
    throw new Error(`recordBackupLineage: ${JSON.stringify(sysid)} is not a system identifier`);
  }
  const prior = Array.isArray(backup?.priorLineages) ? backup.priorLineages.map(String) : [];
  const was = backup?.lineage ? String(backup.lineage) : null;
  const next = was && was !== sysid ? [was, ...prior] : prior;
  const priorLineages = [...new Set(next)].filter((l) => l !== sysid);
  const keep = was === sysid && backup?.unrestoredPrior ? String(backup.unrestoredPrior) : null;
  return {
    lineage: sysid,
    ...(priorLineages.length > 0 && { priorLineages }),
    ...(keep && { unrestoredPrior: keep }),
  };
}

/**
 * The `backup` record after a restore of `lineage` completed: the restored
 * lineage is the one now serving, and the operator chose it, so
 * `unrestoredPrior` is cleared. Pure.
 *
 * @param {{ lineage?: string, priorLineages?: string[], unrestoredPrior?: string } | undefined} backup
 * @param {string} lineage
 */
export function restoredLineageRecord(backup, lineage) {
  const { unrestoredPrior: _cleared, ...record } = recordBackupLineage(backup, lineage);
  return record;
}

/**
 * An environment's base backups, read from its backup bucket: the one listing
 * path behind `restore` (and `restore -l`), `backup -l`, scale and the
 * single-server failover guide. Never SSH: the db need not be running.
 *
 * Reads one lineage's folder: `lineage` (the -lineage flag) or the one
 * resolveRestoreLineage picks for `target`. `lineage` comes back null when
 * no lineage is recorded and none holds a base (an empty listing).
 *
 * `s3Config` is null when there is no backup bucket on record or no
 * credentials for it; callers name the variables (backupCredentialVars).
 *
 * @param {{ envName: string, envConfig: object, projectName: string, skipPrompts?: boolean, s3Config?: object, lineage?: string|null, target?: 'latest' | Date, resolveS3?: typeof resolveS3Config, makeClient?: (cfg: object) => any }} args
 * @returns {Promise<{ s3Config: object | null, location: string | null, lineage: string | null, backups: Awaited<ReturnType<typeof listBaseBackups>> }>}
 * @throws {AmbiguousLineageError}
 */
export async function readEnvBaseBackups({
  envName,
  envConfig,
  projectName,
  skipPrompts = false,
  s3Config: given,
  lineage: flag = null,
  target = 'latest',
  resolveS3 = resolveS3Config,
  makeClient = createS3Client,
}) {
  const isCompose = envConfig?.deployMode === 'compose' || envConfig?.deployMode === 'compose-ha';
  const s3Config =
    given ?? (await resolveS3({ isCompose, envName, projectName, envConfig, skipPrompts }));
  if (!s3Config?.bucket) return { s3Config: null, location: null, lineage: null, backups: [] };
  const base = walgPrefixFor(projectName, envName);
  const s3 = await makeClient(s3Config);
  const lineages = await listLineages({ s3, bucket: s3Config.bucket, base });
  const lineage = resolveRestoreLineage({ envConfig, lineages, flag, target });
  const prefix = lineage ? `${base}/${lineage}` : base;
  const location = `s3://${s3Config.bucket}/${prefix}`;
  const backups = lineage ? await listBaseBackups({ s3, bucket: s3Config.bucket, prefix }) : [];
  return { s3Config, location, lineage, backups };
}

/**
 * The base backup a restore to `target` starts from: for 'latest' the newest
 * by finish time, for an instant the newest that finished at or before it
 * (recovery must reach the base's stop point before it can stop at the
 * target).
 *
 * @template {{ name: string, finishTime: Date }} T
 * @param {T[]} backups
 * @param {'latest' | Date} target
 * @returns {T}
 */
export function resolveRestoreBase(backups, target) {
  const sorted = [...backups].sort((a, b) => a.finishTime.getTime() - b.finishTime.getTime());
  if (sorted.length === 0) throw new NoRestorePointError('no base backups found');
  if (target === 'latest') return sorted[sorted.length - 1];
  const eligible = sorted.filter((b) => b.finishTime.getTime() <= target.getTime());
  if (eligible.length === 0) {
    throw new NoRestorePointError(
      `no base backup finished at or before ${target.toISOString()}; ` +
        `oldest ${sorted[0].finishTime.toISOString()}, newest ${sorted[sorted.length - 1].finishTime.toISOString()}`,
    );
  }
  return eligible[eligible.length - 1];
}

/**
 * A restore point as the operator names it: `latest` (the newest base plus
 * all WAL), an ISO-8601 instant (point-in-time recovery), or a wal-g base
 * backup name (that base plus all WAL). Null for anything else; the caller
 * says what was wrong in its own words.
 *
 * @param {string} source
 * @returns {{ kind: 's3', name: string, base?: string } | null}
 */
export function parseRestoreSource(source) {
  if (source === 'latest') return { kind: 's3', name: 'latest' };
  if (RESTORE_PITR_RE.test(source)) return { kind: 's3', name: source };
  if (BACKUP_NAME_RE.test(source)) return { kind: 's3', name: 'latest', base: source };
  return null;
}

/**
 * The base backup a chosen restore point fetches: the named one for a base
 * name, else resolveRestoreBase (newest, or newest at or before a PITR
 * instant).
 *
 * @param {Array<{ name: string, finishTime: Date }>} backups
 * @param {{ name: string, base?: string }} chosenSource
 * @throws {NoRestorePointError}
 */
export function pickRestoreBase(backups, chosenSource) {
  if (chosenSource.base) {
    const named = backups.find((b) => b.name === chosenSource.base);
    if (!named) throw new NoRestorePointError(`no base backup named ${chosenSource.base}`);
    return named;
  }
  return resolveRestoreBase(
    backups,
    chosenSource.name === 'latest' ? 'latest' : new Date(chosenSource.name),
  );
}

/**
 * The restore point's target and the recovery config both tiers apply,
 * restore_command pinned to `lineage` (the folder the base came from).
 *
 * @param {{ name?: string }} chosenSource
 * @param {string} lineage
 */
export function restorePointOf(chosenSource, lineage) {
  const target =
    chosenSource.name === 'latest' || !chosenSource.name ? 'latest' : chosenSource.name;
  return { target, recoveryConf: renderRecoveryConf(buildRecoveryConfig({ target, lineage })) };
}

/**
 * The restore point `deploy -restore` seeds the new database from, resolved
 * before anything is provisioned (C5): the exact base backup, read from the
 * stop sentinels in the bucket and prefix the db pod's wal-g uses (the
 * backup bucket, else the storage bucket; s3Config.walgPrefix), with its
 * target, recovery config and size. Null for a deploy without -restore.
 * deployK3s only checks the object is complete.
 *
 * Reads only (ListObjectsV2, GetObject), with the deploy's own object-storage
 * credentials (Decision 1). Errors name the variables, never a value.
 *
 * The base comes from one lineage's folder: `lineage` (the -lineage flag), or
 * resolveRestoreLineage's pick from `envConfig.backup` (the destroyed
 * environment's record, which survives a destroy).
 *
 * @param {{ restore: string | null, k8s: boolean, envConfig?: object, lineage?: string | null, s3Config: { bucket?: string, walgPrefix?: string, endpoint?: string, region?: string, accessKey?: string, secretKey?: string }, backupBucketName?: string | null, credentialVars: string, makeClient?: (cfg: object) => any }} args
 * @returns {Promise<{ backup: string, target: string, recoveryConf: string, sizeBytes: number, attempt: string, lineage: string } | null>}
 * @throws {NoRestorePointError} when no base backup satisfies the restore point
 * @throws {AmbiguousLineageError}
 */
export async function resolveDeployRestorePoint({
  restore,
  k8s,
  envConfig,
  lineage: flag = null,
  s3Config,
  backupBucketName,
  credentialVars,
  makeClient = createS3Client,
}) {
  if (!restore) {
    if (flag)
      throw new Error('-lineage chooses the backups -restore seeds from; pass it with -restore');
    return null;
  }
  assertDeployRestoreAllowed({ restore, k8s });
  const chosen = parseRestoreSource(String(restore));
  if (!chosen) {
    throw new Error(
      `${JSON.stringify(restore)} is not a restore point. Pass latest, a base backup name ` +
        '(e.g. base_000000010000000000000004) or an ISO-8601 time (e.g. 2026-06-22T14:30:00Z)',
    );
  }
  const bucket = backupBucketName || s3Config?.bucket;
  const prefix = s3Config?.walgPrefix;
  if (!bucket || !prefix) {
    throw new Error('there is no backup bucket on record for this environment to restore from');
  }
  if (!s3Config.accessKey || !s3Config.secretKey) {
    throw new Error(`reading the backups in s3://${bucket}/${prefix} needs ${credentialVars}`);
  }
  const s3 = await makeClient({ ...s3Config, bucket });
  const lineages = await listLineages({ s3, bucket, base: prefix });
  const lineage = resolveRestoreLineage({
    envConfig,
    lineages,
    flag,
    target: chosen.name === 'latest' ? 'latest' : new Date(chosen.name),
  });
  if (!lineage) {
    throw new NoRestorePointError(`no base backups found in s3://${bucket}/${prefix}`);
  }
  const folder = `${prefix}/${lineage}`;
  const backups = await listBaseBackups({ s3, bucket, prefix: folder });
  let base;
  try {
    base = pickRestoreBase(backups, chosen);
  } catch (err) {
    if (!(err instanceof NoRestorePointError)) throw err;
    throw new NoRestorePointError(`${err.message} in s3://${bucket}/${folder}`);
  }
  const { target, recoveryConf } = restorePointOf(chosen, lineage);
  // A new attempt id per deploy: the walg-restore init records it after the
  // swap, so a db pod start during this attempt boots instead of restoring
  // again, and a later attempt of the same base always restores.
  return {
    backup: base.name,
    target,
    recoveryConf,
    sizeBytes: base.sizeBytes,
    attempt: randomUUID(),
    lineage,
  };
}

/**
 * The refusals `deploy -restore` needs nothing remote for, run before the
 * orchestrator saves or mints anything (M1): k8s tiers only, and an
 * environment with a completed deploy on record already runs a database
 * (destroy deletes the record; a failed deploy -restore never stamps
 * deployedAt, so its rerun passes). deployK3s refuses again on the cluster.
 *
 * @param {{ restore: string | null, k8s: boolean, environment?: string, deployedAt?: string | null }} args
 */
export function assertDeployRestoreAllowed({ restore, k8s, environment, deployedAt = null }) {
  if (!restore) return;
  if (!k8s) {
    throw new Error(
      'deploy -restore is k8s and k8s-ha only. On compose, deploy first, then run vibecarbon restore',
    );
  }
  if (deployedAt) {
    throw new Error(
      [
        `${environment} already runs a database (deployed ${deployedAt}); deploy -restore seeds a new one.`,
        'Restore into the running environment:',
        `  vibecarbon restore ${environment} -source ${restore}`,
        'or destroy it first and run deploy -restore again.',
      ].join('\n'),
    );
  }
}

/**
 * Print an environment's base backups, newest first: the shared body of
 * `restore -l`, `backup -l` and the single-server failover guide.
 *
 * @param {{ backups: Array<{ name: string, finishTime: Date, sizeBytes: number }>, envName: string, location: string, limit?: number }} args
 */
export function printBaseBackupList({ backups, envName, location, limit }) {
  if (backups.length === 0) {
    p.log.info(`No base backups in ${location}.`);
    p.log.info(`Create one with: ${c.info(`vibecarbon backup ${envName}`)}`);
    return;
  }
  const newestFirst = [...backups].reverse();
  const shown = limit ? newestFirst.slice(0, limit) : newestFirst;
  p.log.info(
    `${c.bold(`Backups for ${envName}`)} (${backups.length} base backup(s), newest first):`,
  );
  for (const b of shown) {
    p.log.message(
      `  ${formatInstant(b.finishTime).padEnd(22)} ${c.dim(b.name)}  ${c.dim(formatBytes(b.sizeBytes))}`,
    );
  }
}
