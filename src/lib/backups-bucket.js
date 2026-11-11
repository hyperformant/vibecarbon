/**
 * The backups bucket: one per project and STORAGE region.
 *
 * A project's first storage region keeps `<project>-<salt>-backups`
 * (`deriveProjectBucketName(projectConfig, 'backups')`), so a single-region
 * project, which is almost every project, keeps exactly the one bucket it has
 * always had. Each further storage region gets `<project>-<salt>-<region>-backups`
 * (deriveRegionBackupsBucketName). Each environment's uploads and backups stay
 * in its own storage region, and restore reads its own region's bucket.
 *
 * This module owns every answer about that bucket: the deploy chooses it here
 * (chooseBackupsBucket, then settleBackupsBucket), every reader takes the
 * record through backupsTargetOf, and every S3 call to it is configured by
 * backupStorageConfig, at the bucket's own region and endpoint. Nothing else
 * derives a backups name. Pure: no I/O, no prompts; settleBackupsBucket is
 * handed its create and its log.
 */
import { deriveProjectBucketName, deriveRegionBackupsBucketName } from './providers/s3-base.js';

/**
 * Where an environment's backups are: the bucket, its region and the endpoint
 * that region's store serves it at.
 * @typedef {{ bucket: string, region: string | null, endpoint: string | null }} BackupsTarget
 */

/**
 * One environment keeping backups in one bucket.
 * @typedef {{ env: string, bucket: string, region: string | null }} BackupsHolding
 */

/**
 * How the deploy picked the bucket (chooseBackupsBucket's rules, in order).
 * @typedef {'recorded' | 'shared' | 'first' | 'region'} BackupsSource
 */

/**
 * The backups record of one environment (`environments.<env>.backupS3`, or a
 * `destroyedEnvironments` entry), the ONLY reader of that field.
 *
 * A record without a region was written by a very old CLI, when backups always
 * sat beside the uploads: its region is the uploads region. The uploads
 * endpoint stands in for a missing endpoint only when the regions match; a
 * bucket in another region is never reached through the uploads host.
 *
 * @param {{ backupS3?: { bucket?: string, region?: string, endpoint?: string },
 *   s3?: { region?: string, endpoint?: string } } | null | undefined} envConfig
 * @returns {BackupsTarget | null}
 */
export function backupsTargetOf(envConfig) {
  const record = envConfig?.backupS3;
  if (!record?.bucket) return null;
  const uploads = envConfig.s3 ?? {};
  const region = record.region ?? uploads.region ?? null;
  const endpoint =
    record.endpoint ?? (region && region === uploads.region ? (uploads.endpoint ?? null) : null);
  return { bucket: record.bucket, region, endpoint };
}

/**
 * Every environment that keeps backups in a bucket of this project:
 *   - each live environment's record;
 *   - each `destroyedEnvironments` entry not marked `backupsPurged`: a plain
 *     destroy keeps the environment's backups for recovery, so it holds its
 *     bucket just as a live one does, and a `-purge` that removed its folder
 *     records `backupsPurged`, after which it holds nothing;
 *   - a live environment an older CLI deployed (`deployedAt`, no record): it
 *     archives into the base name in its uploads region, so it is never
 *     orphaned by a purge or chosen around by a sibling.
 * A name can appear twice (a destroyed record and the live rebuild of it);
 * backupsBucketHolders folds that.
 *
 * @param {{ projectName: string, bucketSalt?: string,
 *   environments?: Record<string, any>, destroyedEnvironments?: Record<string, any> }} projectConfig
 * @param {{ except?: string }} [opts] - the environment asking, never its own sibling
 * @returns {BackupsHolding[]}
 */
export function backupsHoldings(projectConfig, { except } = {}) {
  /** @type {BackupsHolding[]} */
  const out = [];
  for (const [env, envConfig] of Object.entries(projectConfig?.environments ?? {})) {
    if (env === except) continue;
    const target = backupsTargetOf(envConfig);
    if (target) {
      out.push({ env, bucket: target.bucket, region: target.region });
    } else if (envConfig?.deployedAt) {
      out.push({
        env,
        bucket: deriveProjectBucketName(projectConfig, 'backups'),
        region: envConfig.s3?.region ?? null,
      });
    }
  }
  for (const [env, entry] of Object.entries(projectConfig?.destroyedEnvironments ?? {})) {
    if (env === except || entry?.backupsPurged) continue;
    const target = backupsTargetOf(entry);
    if (target) out.push({ env, bucket: target.bucket, region: target.region });
  }
  return out;
}

/**
 * The environments, other than `except`, that keep backups in exactly
 * `bucket`: destroy `-purge` deletes a backups bucket only when this is empty.
 *
 * @param {Parameters<typeof backupsHoldings>[0]} projectConfig
 * @param {{ bucket: string, except?: string }} opts
 * @returns {string[]} environment names, each once
 */
export function backupsBucketHolders(projectConfig, { bucket, except }) {
  const names = backupsHoldings(projectConfig, { except })
    .filter((h) => h.bucket === bucket)
    .map((h) => h.env);
  return [...new Set(names)];
}

/**
 * The backups bucket a deploy of `environment` uses, for storage in `region`.
 * First match wins:
 *   1. `recorded`: the environment's own record (live, or seeded from its
 *      destroyed record for a rebuild). Never moved, region included: earlier
 *      lineages stay where restore looks for them, even for an environment an
 *      older CLI put in another region's bucket.
 *   2. `shared`: another environment's backups in `region`. Several names
 *      there should not happen; the base name wins if among them, else the
 *      smallest, so every caller agrees.
 *   3. `first`: the base name, when no other environment holds it. Any holding
 *      of it is in another region by now (one in `region` was rule 2's).
 *   4. `region`: this region's own name.
 * The region of rules 2-4 is a plan: settleBackupsBucket creates the bucket
 * and takes its real region from that create.
 *
 * @param {{ environment: string, envConfig: object, projectConfig: Parameters<typeof backupsHoldings>[0],
 *   region: string }} args - `region` is the STORAGE region (s3Config.region)
 * @returns {{ bucket: string, region: string, source: BackupsSource }}
 */
export function chooseBackupsBucket({ environment, envConfig, projectConfig, region }) {
  const own = backupsTargetOf(envConfig);
  // A record with no region anywhere (nor an uploads region) has nothing to
  // keep: the requested region is the only one there is.
  if (own) return { bucket: own.bucket, region: own.region ?? region, source: 'recorded' };
  const holdings = backupsHoldings(projectConfig, { except: environment });
  const base = deriveProjectBucketName(projectConfig, 'backups');
  const here = [...new Set(holdings.filter((h) => h.region === region).map((h) => h.bucket))];
  if (here.length > 0) {
    const bucket = here.includes(base) ? base : here.sort()[0];
    return { bucket, region, source: 'shared' };
  }
  if (!holdings.some((h) => h.bucket === base)) return { bucket: base, region, source: 'first' };
  return { bucket: deriveRegionBackupsBucketName(projectConfig, region), region, source: 'region' };
}

/**
 * Create (or find) the planned backups bucket and settle where it really is.
 *
 *   - A plan that is not `recorded` follows the uploads bucket: when the
 *     uploads bucket's own create found it in another region than the plan
 *     (a pinned bucket, or one an older CLI recorded under the wrong region),
 *     the bucket is chosen again for that region.
 *   - A `first` plan whose create answers from another region means the base
 *     name already exists there with nothing on record (a concurrent first
 *     deploy, or a crash before the record): that is a definite answer, not a
 *     failure, so this environment switches to its region's own name. The
 *     switch says its one line and returns `source: 'switched'`, so the
 *     caller's "first environment in this region" line stays quiet.
 *   - The region and endpoint ALWAYS come from the settled bucket's own
 *     create, never from the plan.
 *
 * @param {{
 *   plan: { bucket: string, region: string, source: BackupsSource },
 *   appRegion: string,
 *   environment: string,
 *   projectConfig: { projectName: string, bucketSalt?: string },
 *   rechoose: (region: string) => { bucket: string, region: string, source: BackupsSource },
 *   create: (bucket: string, region: string) =>
 *     Promise<{ created: boolean, region: string, endpoint: string }>,
 *   log: (line: string) => void,
 * }} args
 * @returns {Promise<{ target: BackupsTarget, created: boolean,
 *   source: BackupsSource | 'switched' }>}
 */
export async function settleBackupsBucket({
  plan,
  appRegion,
  environment,
  projectConfig,
  rechoose,
  create,
  log,
}) {
  const chosen =
    plan.source !== 'recorded' && plan.region !== appRegion ? rechoose(appRegion) : plan;
  let bucket = chosen.bucket;
  /** @type {BackupsSource | 'switched'} */
  let source = chosen.source;
  let res = await create(bucket, chosen.region);
  if (chosen.source === 'first' && res.region !== chosen.region) {
    const regionName = deriveRegionBackupsBucketName(projectConfig, chosen.region);
    log(
      `${bucket} already lives in ${res.region}, so ${environment}'s backups in ${chosen.region} go to ${regionName}`,
    );
    bucket = regionName;
    source = 'switched';
    res = await create(bucket, chosen.region);
  }
  return {
    target: { bucket, region: res.region, endpoint: res.endpoint },
    created: res.created,
    source,
  };
}

/**
 * The S3 config that talks to the backups bucket: the deploy's object-storage
 * credentials and WAL-G prefix, with the bucket, region and endpoint of the
 * target. The ONE way to build it: a `{ ...s3Config, bucket }` spread keeps
 * the uploads bucket's region and endpoint, and a backups bucket in another
 * region (an environment an older CLI put there, which keeps it) then answers
 * from the wrong host. Nothing else of the uploads config rides along (no
 * state bucket, no app key). Null without a target, so no caller reaches the
 * uploads host by accident; a caller with a legacy no-backups-bucket path
 * falls back to its uploads config explicitly.
 *
 * @param {{ accessKey?: string, secretKey?: string, walgPrefix?: string } | null | undefined} s3Config
 * @param {BackupsTarget | null | undefined} target
 * @returns {{ accessKey: string | undefined, secretKey: string | undefined,
 *   walgPrefix: string | undefined, bucket: string, region: string | null,
 *   endpoint: string | null } | null}
 */
export function backupStorageConfig(s3Config, target) {
  if (!target?.bucket) return null;
  return {
    accessKey: s3Config?.accessKey,
    secretKey: s3Config?.secretKey,
    walgPrefix: s3Config?.walgPrefix,
    bucket: target.bucket,
    region: target.region,
    endpoint: target.endpoint,
  };
}
