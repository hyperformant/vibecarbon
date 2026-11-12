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
 * bucket of another region answers NoSuchBucket. So a NoSuchBucket is never
 * taken at its word: the bucket is looked for in every region first, and one
 * found elsewhere (a record an older CLI got wrong, or one that names no
 * region) is fenced where it is.
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
 * `locateBucket` asks every region for a bucket and answers null only when
 * every one said not found (S3CompatibleProvider.locateBucket).
 * @typedef {{ getBucketPolicy: Function, putBucketPolicy: Function,
 *   deleteBucketPolicy: Function, locateBucket?: (b: string) => Promise<string|null>,
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
 *   - `deploying`: the environment being deployed uses it, so this deploy's
 *     storage step just made or found it where its record says. It is never
 *     looked for elsewhere: HEADs on a bucket made moments ago can start
 *     Hetzner's NoSuchBucket window.
 *   - `notFoundMarks`: how many of the destroyed records that name it carry
 *     the not-found mark for the role they name it in (`appBucketNotFound`
 *     for their app bucket, `backupsNotFound` for the backups bucket they
 *     kept): an earlier run found it in no region. `all`, `some` or `none`.
 *     The mark never takes a bucket out of the targets; it only quiets the
 *     report while the bucket stays gone.
 * @typedef {{ bucket: string, region: string|null, deniedAccessKeyIds: string[],
 *   mayBeAbsent: boolean, live: boolean, deploying: boolean,
 *   notFoundMarks: 'all' | 'some' | 'none',
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
 *   - every app bucket a destroyed environment's record names, unless that
 *     destroy's -purge confirmed it deleted it (`appBucketPurged`, written
 *     nowhere else). A plain destroy keeps it with its uploads, and -purge
 *     keeps a pinned or shared one, or an emptied shell it could not delete
 *     yet. A record from before the mark reads as kept. One found in no
 *     region is passed over and reported (applyHetznerFences' `gone`), and
 *     the caller's save marks the record `appBucketNotFound`
 *     (recordFenceFindings). A marked record stays a target: every fenced
 *     run reads its bucket where the record says, looks in every region
 *     after a NoSuchBucket, says nothing while no region has it, and fences
 *     it wherever it turns up (`found`, which clears the mark). A missed
 *     region or a wrong NoSuchBucket never ends its fence. A bucket found
 *     in another region (`located`) is fenced there, and the save writes
 *     that region into the destroyed record's `s3.region`, so it is read
 *     there directly from then on.
 *   A kept backups bucket that no region has is marked the same way, with
 *   `backupsNotFound` on the destroyed record that kept it.
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
   *   deploying: boolean, user: string|null, region: string|null, recorded: boolean,
   *   env: string, envLive: boolean, destroyedNames: number, notFound: number }>}
   */
  const buckets = new Map();
  /**
   * `notFound` is set only for a destroyed record's app bucket or kept
   * backups bucket: whether that record carries the not-found mark for it.
   * @param {string} bucket
   * @param {{ owner: string|null, done: boolean, live: boolean,
   *   region: string|null|undefined, recorded: boolean, env: string,
   *   notFound?: boolean }} seen
   */
  const note = (bucket, seen) => {
    const prev = buckets.get(bucket);
    const takes = Boolean(seen.region) && (!prev?.region || (seen.recorded && !prev.recorded));
    const from = takes || !prev;
    buckets.set(bucket, {
      owner: prev ? prev.owner : seen.owner,
      completed: (prev?.completed ?? false) || seen.done,
      live: (prev?.live ?? false) || seen.live,
      deploying: (prev?.deploying ?? false) || (!leaving && seen.live && seen.env === environment),
      user: prev?.user ?? (seen.live ? seen.env : null),
      region: takes ? seen.region : (prev?.region ?? null),
      recorded: takes ? seen.recorded : (prev?.recorded ?? false),
      env: from ? seen.env : prev.env,
      envLive: from ? seen.live : prev.envLive,
      destroyedNames: (prev?.destroyedNames ?? 0) + (seen.notFound === undefined ? 0 : 1),
      notFound: (prev?.notFound ?? 0) + (seen.notFound ? 1 : 0),
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
      ...(h.live ? {} : { notFound: Boolean(h.notFound) }),
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
    if (!own || gone(name) || entry.appBucketPurged) continue;
    note(own, {
      owner: null,
      done: false,
      live: false,
      region: entry.s3.region,
      recorded: true,
      env: name,
      notFound: Boolean(entry.appBucketNotFound),
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
      deploying: b.deploying,
      notFoundMarks: /** @type {'all'|'some'|'none'} */ (
        b.notFound === 0 ? 'none' : b.notFound === b.destroyedNames ? 'all' : 'some'
      ),
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
 * Where a target's region came from, for a message: `, the region staging's
 * record names for it,` or `, old's uploads region (no record names a region
 * for this bucket),`. Empty for a target built by hand.
 * @param {Partial<FenceTarget>} target
 */
function regionSource({ region, regionFrom: from }) {
  if (!from) return '';
  if (!region)
    return ' (no record names a region for this bucket, so the store was asked in its own)';
  const whose = from.live ? `${from.env}'s` : `destroyed ${from.env}'s`;
  return from.recorded
    ? `, the region ${whose} record names for it,`
    : `, ${whose} uploads region (no record names a region for this bucket),`;
}

/**
 * The error for a NoSuchBucket the fence cannot pass over. It says which
 * region was asked and where that region came from, and what was found:
 *   - `deploying`: the deploy's own bucket, which its storage step just made
 *     or found there, so Hetzner most likely has not caught up yet;
 *   - `two-ways`: HeadBucket finds it in the region that answered NoSuchBucket;
 *   - `nowhere`: no region has it, and a deployed environment uses it;
 *   - `unlocatable`: the store cannot look in other regions;
 *   - `unsearchable`: a region answered the search with something other than
 *     not found (`searchErr`, which names that region and its answer), so
 *     where the bucket is cannot be told.
 * @param {{ bucket: string, err: Error, asked: string|undefined,
 *   target: Partial<FenceTarget>,
 *   how: 'deploying'|'two-ways'|'nowhere'|'unlocatable'|'unsearchable',
 *   searchErr?: Error & { region?: string } }} args
 * @returns {Error}
 */
function noSuchBucketError({ bucket, err, asked, target, how, searchErr }) {
  const where = asked ? ` in ${asked}` : '';
  const head = `bucket ${bucket} answered NoSuchBucket${where}${regionSource(target)} while its app key fence was read (${err.message})`;
  if (how === 'two-ways') {
    return new Error(
      `${head}, but HeadBucket${where} finds it, so it was not skipped: the store is answering two ways. Deploy again in a few minutes.`,
    );
  }
  if (how === 'deploying') {
    return new Error(
      `${head}. This deploy's storage step made or found it there just now, so it was not skipped: Hetzner most likely has not caught up with it yet. Deploy again in a few minutes.`,
    );
  }
  if (how === 'unsearchable') {
    const at = searchErr?.region ? ` in ${searchErr.region}` : '';
    return new Error(
      `${head}, and looking for it in every region failed: ${searchErr?.message}. The app key fence cannot tell where the bucket is, so it stops rather than pass it over. Deploy again; if this repeats, check bucket ${bucket}${at} in the Hetzner console.`,
      { cause: searchErr },
    );
  }
  if (how === 'nowhere') {
    const env = target.regionFrom?.redeploy;
    return new Error(
      `${head}, and no region has it. A deployed environment uses it, so it was not skipped. ${env ? `Deploy ${env} again` : 'Deploy the environment that uses it again'}: its deploy records the bucket it uses from now on, making it if needed.`,
    );
  }
  return new Error(
    `${head}. This store cannot look for it in other regions, so it was not skipped.`,
  );
}

/**
 * The lines a deploy or destroy prints about what the fence found: a bucket
 * fenced in another region than its record gives (`located`), a bucket only
 * destroyed environments named that no region has any more (`gone`), and a
 * bucket an earlier run found in no region that is back where its record
 * says (`found`; one back elsewhere already has its `located` line). Never
 * silent: a wrong record, a vanished bucket and a returned one are all worth
 * knowing. A bucket still gone after an earlier run said so is not repeated.
 * @param {{ located?: { bucket: string, region: string, onRecord: string|null,
 *   regionFrom?: FenceTarget['regionFrom'] }[], gone?: string[],
 *   found?: { bucket: string, region: string|null }[] } | null | undefined} out
 * @returns {string[]}
 */
export function fenceInfoLines(out) {
  const lines = [];
  for (const { bucket, region, onRecord, regionFrom: from } of out?.located ?? []) {
    const whose = from && (from.live ? `${from.env}'s` : `destroyed ${from.env}'s`);
    const not =
      !from || !onRecord
        ? 'and no record names its region'
        : from.recorded
          ? `not ${onRecord} as ${whose} record says`
          : `not ${whose} uploads region ${onRecord}`;
    // A live record is corrected by that environment's own deploy; a
    // destroyed one by the save after this run (recordFenceFindings).
    const next = from?.live ? `; deploy ${from.env} again to record where it is` : '';
    lines.push(`app key fence: ${bucket} is in ${region}, ${not}; fenced it there${next}`);
  }
  for (const bucket of out?.gone ?? []) {
    lines.push(
      `app key fence: nothing to fence on ${bucket}: only a destroyed environment's record names it, and no region has it now`,
    );
  }
  for (const { bucket, region } of out?.found ?? []) {
    if ((out?.located ?? []).some((l) => l.bucket === bucket)) continue;
    const where = region ? ` in ${region}` : '';
    lines.push(
      `app key fence: ${bucket} is back${where}, though an earlier run found it in no region; fenced it there`,
    );
  }
  return lines;
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
 * A bucket the provider says does not exist is looked for in every region
 * (`locateBucket`) before anything else, except one the deploying
 * environment uses (`deploying`), whose NoSuchBucket fails the run at once.
 * Found in another region: it is fenced there and reported in `located`.
 * Found where it answered NoSuchBucket: the store is answering two ways, and
 * the run fails. In no region: passed over only when `mayBeAbsent` (no live
 * env that uses it finished a deploy into it), as `skipped` when a live env
 * names it (the deploy warns, status marks it) or `gone` when only destroyed
 * envs do (nothing is left to fence; fenceInfoLines prints it). A bucket
 * every naming record already marks `appBucketNotFound` is passed over
 * quietly instead, in no list: an earlier run reported it, and its save
 * marked it. Otherwise the run fails, naming the region asked and whose
 * record gave it. A bucket some record marks not found that this run reads,
 * where its record says or where it was located, is fenced as usual and
 * reported in `found`, so the caller's save clears the marks.
 *
 * Every call for a target, its policy read and write and each probe, goes
 * to the target's `region` (`forRegion` on the client and on each probe),
 * whatever region the caller built them at, or to the region locateBucket
 * found it in. A target without a region uses them as given.
 *
 * @param {object} args
 * @param {FenceStore} args.s3 - the infra key's client
 * @param {string} args.ownerId
 * @param {(Pick<FenceTarget, 'bucket' | 'deniedAccessKeyIds'> & Partial<FenceTarget>)[]} args.targets
 *   as fenceTargets gives them; `live` defaults to true, `mayBeAbsent` and
 *   `deploying` to false.
 * @param {Record<string, FenceProbe>} [args.probes]
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @param {() => number} [args.now]
 * @returns {Promise<{ written: string[], removed: string[], unverified: string[],
 *   skipped: string[], gone: string[], located: { bucket: string, region: string,
 *   endpoint: string|null, onRecord: string|null, regionFrom: FenceTarget['regionFrom'] }[],
 *   found: { bucket: string, region: string|null }[] }>}
 *   `located[].onRecord` is the target's region (null when no record names one),
 *   and `located[].endpoint` the found region's host.
 *   `found[].region` is where it was read.
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
  const located = [];
  const found = [];
  // Every write lands first; the verifications then run side by side, since
  // each waits on its own bucket's consistency.
  const verifications = [];
  for (const target of targets) {
    const {
      bucket,
      deniedAccessKeyIds,
      mayBeAbsent = false,
      live = true,
      notFoundMarks = 'none',
    } = target;
    let region = target.region;
    let store = atRegion(s3, region);
    let current;
    try {
      current = await store.getBucketPolicy(bucket);
    } catch (err) {
      if (!isNoSuchBucket(err)) throw err;
      const asked = region ?? store.region;
      const fail = (how) => noSuchBucketError({ bucket, err, asked, target, how });
      if (target.deploying) throw fail('deploying');
      if (typeof store.locateBucket !== 'function') throw fail('unlocatable');
      let at;
      try {
        at = await store.locateBucket(bucket);
      } catch (searchErr) {
        throw noSuchBucketError({ bucket, err, asked, target, how: 'unsearchable', searchErr });
      }
      if (at === null) {
        if (!mayBeAbsent) throw fail('nowhere');
        if (live) skipped.push(bucket);
        // Still gone, and already reported and marked by an earlier run.
        else if (notFoundMarks !== 'all') gone.push(bucket);
        continue;
      }
      if (at === asked) throw fail('two-ways');
      region = at;
      store = atRegion(s3, at);
      located.push({
        bucket,
        region: at,
        // That region's host, for a record whose stale endpoint would win.
        endpoint: store.endpoint ?? null,
        onRecord: target.region ?? null,
        regionFrom: target.regionFrom ?? null,
      });
      try {
        current = await store.getBucketPolicy(bucket);
      } catch (again) {
        if (!isNoSuchBucket(again)) throw again;
        throw noSuchBucketError({ bucket, err: again, asked: at, target: {}, how: 'two-ways' });
      }
    }
    // Read where it is: an earlier run's "no region has it" was wrong or is
    // over, and the save clears the mark.
    if (notFoundMarks !== 'none') found.push({ bucket, region: region ?? store.region ?? null });
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
  return { written, removed, unverified, skipped, gone, located, found };
}
