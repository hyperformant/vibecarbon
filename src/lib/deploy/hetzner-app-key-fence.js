/**
 * The Hetzner app-key deny-fence (security plan R2, Task 4).
 *
 * Hetzner keys can only be made in the console, and every key reaches every
 * bucket in the project. But each key is its own principal,
 * `arn:aws:iam:::user/<ownerId>:<accessKeyId>`, and a Deny bucket policy on
 * that principal is enforced (real-account spike, 2026-10-20). So when the
 * operator pastes an environment's app key, the deploy puts a policy on every
 * bucket vibecarbon manages for the project (the Pulumi state bucket, every
 * backups bucket that holds backups, each environment's app bucket, and the
 * app bucket a destroyed environment kept) that denies every OTHER
 * environment's pasted key. An env's own bucket never denies its own key.
 * A pasted key that was replaced, or whose env was destroyed, is retired
 * (`projectConfig.retiredAppKeys`) and stays denied everywhere: the CLI
 * cannot revoke it, so only the operator can say it is gone
 * (`vibecarbon configure storage -forget <id>`).
 *
 * What a policy cannot close (R4): the app key can still list bucket names,
 * create buckets, use any bucket made outside vibecarbon, and delete an empty
 * fenced bucket.
 *
 * Each bucket is read, written and probed at its own region: a project with a
 * second storage region has buckets in two, and a Hetzner store asked about a
 * bucket of another region answers NoSuchBucket.
 *
 * Policy changes reach Hetzner's gateways unevenly over 30 to 60 s, so each
 * fence is written once per change and then verified by a consistency gate:
 * FENCE_PROBE_STREAK denied probes in a row with a fenced key, inside a fixed
 * FENCE_PROBE_BUDGET_MS. Any allowed probe resets the streak. It is never a
 * retry of the write; an exhausted budget fails the deploy naming the bucket.
 */
import { backupsHoldings } from '../backups-bucket.js';

/** Denied probes in a row that count as the fence holding. */
export const FENCE_PROBE_STREAK = 3;
/** The whole verification budget for one bucket. */
export const FENCE_PROBE_BUDGET_MS = 120_000;
/** Time between probes. */
export const FENCE_PROBE_INTERVAL_MS = 5_000;

/**
 * The infra key's store, as the fence uses it. `forRegion` gives the same
 * keys at another region (S3CompatibleProvider.forRegion); `region` is where
 * it asks, for a NoSuchBucket message about a target with no region.
 * @typedef {{ getBucketPolicy: Function, putBucketPolicy: Function,
 *   deleteBucketPolicy: Function, bucketExists?: (b: string) => Promise<boolean>,
 *   region?: string, forRegion?: (region: string) => FenceStore }} FenceStore
 */

/**
 * A fenced app key's client: is it refused on a bucket? `forRegion` as above.
 * @typedef {{ isDeniedOn(bucket: string): Promise<boolean>,
 *   forRegion?: (region: string) => FenceProbe }} FenceProbe
 */

/**
 * The fence principal for one key.
 * @param {string} ownerId
 * @param {string} accessKeyId
 */
function principal(ownerId, accessKeyId) {
  return `arn:aws:iam:::user/${ownerId}:${accessKeyId}`;
}

/**
 * The bucket policy that denies `deniedAccessKeyIds` everything on `bucket`.
 * One Deny statement, sorted principals, so the same inputs always render the
 * same policy.
 * @param {{ bucket: string, ownerId: string, deniedAccessKeyIds: string[] }} args
 * @returns {object}
 */
export function renderHetznerFencePolicy({ bucket, ownerId, deniedAccessKeyIds }) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Deny',
        Principal: {
          AWS: [...new Set(deniedAccessKeyIds)].sort().map((id) => principal(ownerId, id)),
        },
        Action: ['s3:*'],
        Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
      },
    ],
  };
}

/**
 * Every pasted app key recorded in the project: `{ env, id }` per
 * environment whose `s3.appKey` is a paste-fence record.
 * @param {object} projectConfig
 * @returns {{ env: string, id: string }[]}
 */
function pastedKeys(projectConfig) {
  return Object.entries(projectConfig.environments ?? {})
    .filter(([, e]) => e?.s3?.appKey?.scoping === 'paste-fence' && e.s3.appKey.id)
    .map(([env, e]) => ({ env, id: e.s3.appKey.id }));
}

/**
 * One bucket's fence, as fenceTargets computes it.
 *   - `region`: where the bucket lives (null when no record names one).
 *   - `regionFrom`: whose record gave that region (`env`, `live` false for
 *     a destroyed environment's), whether the record states it or it stands
 *     in from that environment's uploads region (`recorded`), and which
 *     environment's deploy would record it (`redeploy`: that one if live,
 *     else the first live one using the bucket, else null). Null for a
 *     target built by hand. The NoSuchBucket message names them.
 *   - `mayBeAbsent`: no live environment that names the bucket has finished a
 *     deploy into it, so a confirmed absence may be skipped.
 *   - `live`: a live environment names it. A bucket only destroyed
 *     environments name and that is gone has nothing left to fence.
 * @typedef {{ bucket: string, region: string|null, deniedAccessKeyIds: string[],
 *   mayBeAbsent: boolean, live: boolean,
 *   regionFrom: { env: string, live: boolean, recorded: boolean,
 *     redeploy: string|null } | null }} FenceTarget
 */

/**
 * Which buckets get which fence. Every bucket vibecarbon manages for the
 * project denies every environment's pasted app key, except that an env's
 * own app bucket never denies that env's key:
 *   - each live environment's state bucket and app bucket;
 *   - every backups bucket that holds backups (backupsHoldings): a live
 *     environment's, one a destroyed environment kept for recovery, and the
 *     base bucket an older CLI's environment archives into with no record;
 *   - every app bucket a destroyed environment's record names. A plain
 *     destroy keeps it with its uploads, and -purge keeps a pinned or shared
 *     one; the record does not say which, so each is fenced, and one found
 *     gone is passed over (applyHetznerFences' `gone`).
 * Every RETIRED pasted key (`projectConfig.retiredAppKeys`: replaced, or its
 * env destroyed) is denied everywhere: the CLI cannot revoke a pasted key,
 * so it stays fenced until the operator deletes it in the console and
 * forgets it (`configure storage -forget`). A bucket with nothing to deny is
 * still listed, with an empty list, so a fence nothing needs any more is
 * removed.
 *
 * `leaving: true` computes the fences as they must be once `environment` is
 * gone (destroy): its own buckets are left alone. Its key leaves the fences
 * only if the caller did not retire it (destroy does retire it).
 *
 * `region` comes from the records that name the bucket: an app bucket's
 * `s3.region`, the state bucket's `s3.stateBucketRegion`, a backups bucket's
 * record region. A record that states none stands its uploads region in. A
 * stated region beats a stand-in, whichever record is listed first; between
 * two of a kind the first stays. Null when no record names one (an older
 * CLI's): applyHetznerFences then asks the client it was given.
 *
 * @param {{ projectConfig: object, environment: string, leaving?: boolean }} args
 * @returns {FenceTarget[]}
 */
export function fenceTargets({ projectConfig, environment, leaving = false }) {
  const gone = (name) => leaving && name === environment;
  const envs = Object.entries(projectConfig.environments ?? {}).filter(([name]) => !gone(name));
  const keys = pastedKeys(projectConfig).filter((k) => !gone(k.env));
  const retired = (projectConfig.retiredAppKeys ?? []).filter(
    (id) => typeof id === 'string' && id && !keys.some((k) => k.id === id),
  );
  // The env being deployed counts as complete: s3-setup created or verified
  // every bucket it references this very run, so a NoSuchBucket from one of
  // them is never a reason to skip its fence.
  const completed = (name, e) =>
    (!leaving && name === environment) ||
    e?.status === 'deployed' ||
    Object.hasOwn(e?.s3 ?? {}, 'bucketCreatedAt');
  /**
   * @type {Map<string, { owner: string|null, completed: boolean, live: boolean,
   *   user: string|null, region: string|null, recorded: boolean, env: string,
   *   envLive: boolean }>}
   */
  const buckets = new Map();
  /**
   * @param {string} bucket
   * @param {{ owner: string|null, done: boolean, live: boolean,
   *   region: string|null|undefined, recorded: boolean, env: string }} seen
   */
  const note = (bucket, seen) => {
    const prev = buckets.get(bucket);
    const takes = Boolean(seen.region) && (!prev?.region || (seen.recorded && !prev.recorded));
    const from = takes || !prev;
    buckets.set(bucket, {
      owner: prev ? prev.owner : seen.owner,
      completed: (prev?.completed ?? false) || seen.done,
      live: (prev?.live ?? false) || seen.live,
      user: prev?.user ?? (seen.live ? seen.env : null),
      region: takes ? seen.region : (prev?.region ?? null),
      recorded: takes ? seen.recorded : (prev?.recorded ?? false),
      env: from ? seen.env : prev.env,
      envLive: from ? seen.live : prev.envLive,
    });
  };
  for (const [name, e] of envs) {
    const state = e?.s3?.stateBucket;
    if (!state) continue;
    const stated = e.s3.stateBucketRegion;
    note(state, {
      owner: null,
      done: completed(name, e),
      live: true,
      region: stated ?? e.s3.region,
      recorded: Boolean(stated),
      env: name,
    });
  }
  for (const h of backupsHoldings(projectConfig, { except: leaving ? environment : undefined })) {
    note(h.bucket, {
      owner: null,
      done: h.live && completed(h.env, projectConfig.environments?.[h.env]),
      live: h.live,
      region: h.region,
      recorded: h.regionRecorded,
      env: h.env,
    });
  }
  for (const [name, e] of envs) {
    const own = e?.s3?.bucket;
    // A pinned bucket may be one several envs share; it is not this env's
    // own, so it denies every pasted key like the state and backups buckets.
    if (!own) continue;
    const seen = {
      done: completed(name, e),
      live: true,
      region: e.s3.region,
      recorded: true,
      env: name,
    };
    note(own, { ...seen, owner: buckets.has(own) || e.s3.bucketPin ? null : name });
  }
  // Noted after the live ones: a rebuild's live record of the same bucket
  // keeps it its own.
  for (const [name, entry] of Object.entries(projectConfig.destroyedEnvironments ?? {})) {
    const own = entry?.s3?.bucket;
    if (!own || gone(name)) continue;
    note(own, {
      owner: null,
      done: false,
      live: false,
      region: entry.s3.region,
      recorded: true,
      env: name,
    });
  }
  return [...buckets.entries()]
    .map(([bucket, b]) => ({
      bucket,
      region: b.region,
      deniedAccessKeyIds: [
        ...new Set([...keys.filter((k) => k.env !== b.owner).map((k) => k.id), ...retired]),
      ].sort(),
      mayBeAbsent: !b.completed,
      live: b.live,
      regionFrom: {
        env: b.env,
        live: b.envLive,
        recorded: b.recorded,
        redeploy: b.envLive ? b.env : b.user,
      },
    }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/**
 * The key ids a policy vibecarbon wrote denies, or null when the policy is
 * not one vibecarbon wrote (anything but our single Deny statement).
 * @param {object|null} policy
 * @param {string} bucket
 * @param {string} ownerId
 * @returns {string[]|null}
 */
function fencedIdsOf(policy, bucket, ownerId) {
  const statements = policy?.Statement;
  if (!Array.isArray(statements) || statements.length !== 1) return null;
  const st = statements[0];
  const resources = [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`];
  if (
    st.Effect !== 'Deny' ||
    JSON.stringify(st.Action) !== JSON.stringify(['s3:*']) ||
    JSON.stringify(st.Resource) !== JSON.stringify(resources)
  ) {
    return null;
  }
  const aws = st.Principal?.AWS;
  const list = Array.isArray(aws) ? aws : aws ? [aws] : [];
  const prefix = `arn:aws:iam:::user/${ownerId}:`;
  if (!list.every((p) => typeof p === 'string' && p.startsWith(prefix))) return null;
  return list.map((p) => p.slice(prefix.length)).sort();
}

/**
 * `client` at `region`, through its forRegion; the client itself for a
 * target with no region on record, or one that cannot move.
 * @template T
 * @param {T & { forRegion?: (region: string) => T }} client
 * @param {string|null|undefined} region
 * @returns {T}
 */
function atRegion(client, region) {
  return region && typeof client.forRegion === 'function' ? client.forRegion(region) : client;
}

/**
 * Wait until `probe` refuses FENCE_PROBE_STREAK times in a row, inside the
 * budget. A consistency gate, not a retry: it never writes anything. The probe
 * asks at the bucket's own region: anywhere else the bucket answers 404,
 * which is never a denial, so the fence could never be seen to hold.
 * @param {{ bucket: string, region?: string|null, probe: FenceProbe, sleep: (ms: number) => Promise<void>, now: () => number, streakNeeded?: number }} args
 */
async function waitForFence({
  bucket,
  region,
  probe,
  sleep,
  now,
  streakNeeded = FENCE_PROBE_STREAK,
}) {
  const asker = atRegion(probe, region);
  const deadline = now() + FENCE_PROBE_BUDGET_MS;
  let streak = 0;
  while (true) {
    streak = (await asker.isDeniedOn(bucket)) ? streak + 1 : 0;
    if (streak >= streakNeeded) return;
    if (now() + FENCE_PROBE_INTERVAL_MS > deadline) {
      throw new Error(
        `the app key fence on bucket ${bucket} did not hold within ${FENCE_PROBE_BUDGET_MS / 1000} s (${streakNeeded} denied probe${streakNeeded === 1 ? '' : 's'} in a row), so the app key may still reach it. Run the deploy again; the fence is already written.`,
      );
    }
    await sleep(FENCE_PROBE_INTERVAL_MS);
  }
}

/** True when an S3 error says the bucket does not exist. */
function isNoSuchBucket(err) {
  return err?.name === 'NoSuchBucket' || err?.Code === 'NoSuchBucket';
}

/**
 * The error for a NoSuchBucket the fence cannot pass over. It says which
 * region was asked and where that region came from: a region on record that
 * is wrong answers exactly like a bucket Hetzner has not caught up on yet.
 * @param {{ bucket: string, err: Error, asked: string|undefined,
 *   region: string|null|undefined, regionFrom: FenceTarget['regionFrom'] | undefined,
 *   mayBeAbsent: boolean, found: boolean|null }} args
 *   `asked`: the region the store was asked in; `found`: what HeadBucket
 *   there said (null when it was not asked).
 * @returns {Error}
 */
function noSuchBucketError({ bucket, err, asked, region, regionFrom, mayBeAbsent, found }) {
  const from = regionFrom ?? null;
  const whose = from && (from.live ? `${from.env}'s` : `destroyed ${from.env}'s`);
  const where = asked ? ` in ${asked}` : '';
  const why = !from
    ? ''
    : !region
      ? ' (no record names a region for this bucket, so the store was asked in its own)'
      : from.recorded
        ? `, the region ${whose} record names for it,`
        : `, ${whose} uploads region (no record names a region for this bucket),`;
  const head = `bucket ${bucket} answered NoSuchBucket${where}${why} while its app key fence was read (${err.message})`;
  if (found) {
    return new Error(
      `${head}, but HeadBucket${where} finds it, so it was not skipped: the store is answering two ways. Deploy again in a few minutes.`,
    );
  }
  const notSkipped = mayBeAbsent
    ? 'This store cannot confirm the bucket is gone, so it was not skipped.'
    : 'A deployed environment uses it, so it was not skipped.';
  const caughtUp =
    'If this deploy made it moments ago, Hetzner has not caught up yet: deploy again in a few minutes.';
  let hint;
  if (!from) hint = caughtUp;
  else if (!from.redeploy) hint = 'Deploy again in a few minutes.';
  else if (region && from.recorded) {
    hint = `${caughtUp} Otherwise ${whose} record names the wrong region: deploy ${from.redeploy} again, which records where the bucket is.`;
  } else hint = `Deploy ${from.redeploy} again: its deploy records where the bucket is.`;
  return new Error(`${head}. ${notSkipped} ${hint}`);
}

/**
 * Write the fences that changed and verify every fence that denies anything.
 *
 * For each target the current policy is read first. When it already denies
 * exactly the wanted keys nothing is written. A policy vibecarbon did not
 * write is never overwritten: the deploy stops naming the bucket. An empty
 * deny list removes our policy.
 *
 * Every target with a non-empty deny list is verified on every run, with
 * every fenced key the caller holds a probe client for (`probes`, by access
 * key id): a just-written fence needs FENCE_PROBE_STREAK denied probes in a
 * row, an unchanged one a single denied probe, both inside the budget. The
 * verifications start once every write is done and run in parallel; a
 * failure names every bucket that did not hold. So a
 * run after an exhausted budget checks again instead of trusting the
 * unchanged policy. A bucket none of the probes is fenced from is reported
 * as `unverified`.
 *
 * A bucket the provider says does not exist is passed over only when
 * `mayBeAbsent` (no live env that uses it finished a deploy into it) and a
 * HeadBucket in the same region confirms it is gone. One a live env names is
 * reported as `skipped`, which the deploy warns about and status marks; one
 * only destroyed envs named (`live: false`, say an app bucket -purge
 * deleted) as `gone`, since nothing is left there to fence. Otherwise the
 * NoSuchBucket fails the run, naming the region asked and whose record gave
 * it: a bucket Hetzner has not caught up on and a region on record that is
 * wrong answer the same way, and a skip there would leave it unfenced.
 *
 * Every call for a target, its policy read and write, its HeadBucket and
 * each probe, goes to the target's `region` (`forRegion` on the client and on
 * each probe), whatever region the caller built them at. A target without a
 * region uses them as given.
 *
 * @param {object} args
 * @param {FenceStore} args.s3 - the infra key's client
 * @param {string} args.ownerId
 * @param {(Pick<FenceTarget, 'bucket' | 'deniedAccessKeyIds'> & Partial<FenceTarget>)[]} args.targets
 *   as fenceTargets gives them; `live` defaults to true and `mayBeAbsent` to false.
 * @param {Record<string, FenceProbe>} [args.probes]
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @param {() => number} [args.now]
 * @returns {Promise<{ written: string[], removed: string[], unverified: string[], skipped: string[], gone: string[] }>}
 */
export async function applyHetznerFences({
  s3,
  ownerId,
  targets,
  probes = {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}) {
  const written = [];
  const removed = [];
  const unverified = [];
  const skipped = [];
  const gone = [];
  // Every write lands first; the verifications then run side by side, since
  // each waits on its own bucket's consistency.
  const verifications = [];
  for (const target of targets) {
    const { bucket, region, deniedAccessKeyIds, mayBeAbsent = false, live = true } = target;
    const store = atRegion(s3, region);
    let current;
    try {
      current = await store.getBucketPolicy(bucket);
    } catch (err) {
      if (!isNoSuchBucket(err)) throw err;
      const found = mayBeAbsent && store.bucketExists ? await store.bucketExists(bucket) : null;
      if (found === false) {
        (live ? skipped : gone).push(bucket);
        continue;
      }
      throw noSuchBucketError({
        bucket,
        err,
        asked: region ?? store.region,
        region,
        regionFrom: target.regionFrom,
        mayBeAbsent,
        found,
      });
    }
    const currentIds = current ? fencedIdsOf(current, bucket, ownerId) : [];
    if (currentIds === null) {
      throw new Error(
        `bucket ${bucket} has a bucket policy vibecarbon did not write, so the app key fence cannot be set on it. Remove that policy in the Hetzner console and deploy again.`,
      );
    }
    const wanted = [...new Set(deniedAccessKeyIds)].sort();
    const unchanged = JSON.stringify(currentIds) === JSON.stringify(wanted);
    if (wanted.length === 0) {
      if (!unchanged) {
        await store.deleteBucketPolicy(bucket);
        removed.push(bucket);
      }
      continue;
    }
    if (!unchanged) {
      await store.putBucketPolicy(
        bucket,
        renderHetznerFencePolicy({ bucket, ownerId, deniedAccessKeyIds: wanted }),
      );
      written.push(bucket);
    }
    const checkers = wanted.map((id) => probes[id]).filter(Boolean);
    if (checkers.length === 0) {
      unverified.push(bucket);
      continue;
    }
    for (const probe of checkers) {
      verifications.push(() =>
        waitForFence({
          bucket,
          region,
          probe,
          sleep,
          now,
          streakNeeded: unchanged ? 1 : FENCE_PROBE_STREAK,
        }),
      );
    }
  }
  const failed = (await Promise.allSettled(verifications.map((verify) => verify()))).filter(
    (r) => r.status === 'rejected',
  );
  if (failed.length === 1) throw failed[0].reason;
  if (failed.length > 1) throw new Error(failed.map((r) => r.reason.message).join('\n'));
  return { written, removed, unverified, skipped, gone };
}
