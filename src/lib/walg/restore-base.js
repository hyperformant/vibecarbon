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
 */
import * as p from '@clack/prompts';
import { formatInstant } from '../backup-format.js';
import { formatBytes } from '../backup-s3.js';
import { c } from '../colors.js';
import { loadBackupS3Config, loadS3Config } from '../config.js';
import { providerFor } from '../providers/index.js';

const SENTINEL_SUFFIX = '_backup_stop_sentinel.json';

/** No base backup satisfies the requested restore point. */
export class NoRestorePointError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoRestorePointError';
  }
}

/**
 * The wal-g prefix inside the backup bucket: one per environment. The same
 * path compose renders into WALG_S3_PREFIX (carbon/docker-compose.yml) and
 * resolveEnvStorage hands k8s.
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
 * An environment's base backups, read from its backup bucket: the one listing
 * path behind `restore` (and `restore -l`), `backup -l`, scale and the
 * single-server failover guide. Never SSH: the db need not be running.
 *
 * `s3Config` is null when there is no backup bucket on record or no
 * credentials for it; callers name the variables (backupCredentialVars).
 *
 * @param {{ envName: string, envConfig: object, projectName: string, skipPrompts?: boolean, s3Config?: object, resolveS3?: typeof resolveS3Config, makeClient?: (cfg: object) => any }} args
 * @returns {Promise<{ s3Config: object | null, location: string | null, backups: Awaited<ReturnType<typeof listBaseBackups>> }>}
 */
export async function readEnvBaseBackups({
  envName,
  envConfig,
  projectName,
  skipPrompts = false,
  s3Config: given,
  resolveS3 = resolveS3Config,
  makeClient = createS3Client,
}) {
  const isCompose = envConfig?.deployMode === 'compose' || envConfig?.deployMode === 'compose-ha';
  const s3Config =
    given ?? (await resolveS3({ isCompose, envName, projectName, envConfig, skipPrompts }));
  if (!s3Config?.bucket) return { s3Config: null, location: null, backups: [] };
  const prefix = walgPrefixFor(projectName, envName);
  const location = `s3://${s3Config.bucket}/${prefix}`;
  const s3 = await makeClient(s3Config);
  const backups = await listBaseBackups({ s3, bucket: s3Config.bucket, prefix });
  return { s3Config, location, backups };
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
