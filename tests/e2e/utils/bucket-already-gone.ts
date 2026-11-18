/**
 * Is this bucket-delete error really "the bucket is already gone"?
 *
 * Object-storage LISTINGS lag DELETEs on every provider we sweep (the same
 * staleness family as the wal-g NoSuchBucket class): a post-scenario sweep
 * can enumerate a bucket that final-destroy removed seconds earlier, then
 * watch its own delete answer "no such bucket". That is the sweep's GOAL
 * STATE, not an enumeration failure, and must not brand the scenario a
 * destroy regression.
 *
 * Live veto 1 (run 33538738831, DO k8s-ha, 2026-09-01): the delete said "The
 * specified bucket does not exist" and the sweep read [regression]. The fix
 * matched those words.
 *
 * Live veto 2 (run 43757126064, DO k8s, 2026-11-15): final-destroy deleted
 * the backups bucket, and 1.8 s later the sweep's delete failed with the
 * message "UnknownError". Reproduced on real Spaces: for 1-3 s after a
 * delete, nyc3 still lists the bucket and answers ListObjectsV2 with HTTP
 * 404 and `<Code>NoSuchBucket</Code><Message></Message>`. AWS SDK v3 puts
 * the code on err.name / err.Code and words the empty message
 * "UnknownError" (it does the same for a bodiless 404, named NotFound). The
 * words matched nothing; the code and the status were there all along.
 *
 * So a missing-bucket answer is read three ways: the S3 code, the HTTP status
 * of a bodiless 404, and the words, on the error or anything in its `cause`
 * chain (emptyAndDeleteBucket wraps its version and multipart steps). And
 * it is never trusted alone: it is one endpoint's answer, and DO's nyc3 says
 * NoSuchBucket for a bucket that lives in sfo3 (probed 2026-11-15). So
 * `locate` (the store's locateBucket: a HeadBucket in every region the keys
 * can address) must find it nowhere, the same search destroy's
 * atBucketRegion makes.
 *
 * Live veto 3 (hetzner/compose, 2026-11-16), the opposite mistake: a deploy
 * died on a new bucket that would not answer, and for the next 20 minutes
 * that bucket answered NoSuchBucket to the delete and 404 to every HeadBucket
 * while ListBuckets on the same endpoint still showed it. Destroy and this
 * sweep both called it gone and left a billable bucket behind. A HEAD or
 * LIST in a Hetzner bucket's first second does this for up to 15 minutes
 * (bucketQuietMs in src/lib/providers/hetzner-s3.js), so "NoSuchBucket, and
 * no HeadBucket finds it" is not proof.
 *
 * The rule since then: a bucket the provider's own listing still shows is
 * never reported as gone. After the search, `relist` reads the listing once
 * more. Only a listing that was read and no longer shows the bucket makes it
 * gone. One that still shows it, or cannot be read, is "cannot tell", and
 * the sweep fails for that bucket.
 *
 * What that costs: listings lag real deletes too. Hetzner dropped 14 of 15
 * deleted buckets from ListBuckets by the first read after the delete was
 * acknowledged and the last by the second, under half a second (measured
 * 2026-11-17, all three locations); DigitalOcean keeps one for 1 to 3 s. The
 * second read comes after the failed delete and the whole HeadBucket search,
 * so it is later than the first by at least those round trips. A provider
 * whose listing lags longer than that still fails a sweep whose destroy was
 * clean. That is the side to be wrong on: a rerun clears it, and a leaked
 * bucket bills until someone finds it. Nothing here waits or asks twice to
 * ride the lag out.
 *
 * Deliberately narrow: a 403, a network error, an object-level 404
 * (NoSuchKey, NoSuchUpload) or a search that cannot tell keeps failing the
 * sweep loudly.
 */

/** The store's locateBucket: the region holding the bucket, or null when none does. */
export type LocateBucket = () => Promise<string | null>;

/**
 * A fresh read of the listing the sweep enumerated from, taken when called:
 * the bucket names it shows now, or null when it cannot be read.
 */
export type RelistBuckets = () => Promise<string[] | null>;

export type BucketDeleteVerdict = { gone: true; why: string } | { gone: false; why: string };

interface S3ErrorShape {
  name?: string;
  Code?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
  cause?: unknown;
}

const MISSING_BUCKET_WORDS =
  /NoSuchBucket|specified bucket does not exist|bucket .{0,60}(does not exist|not found)/i;

/** The error and every error in its `cause` chain (bounded, cycle-safe). */
function chain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let at: unknown = err;
  while (at != null && out.length < 5 && !out.includes(at)) {
    out.push(at);
    at = typeof at === 'object' ? (at as S3ErrorShape).cause : undefined;
  }
  return out;
}

function saysMissing(e: unknown): boolean {
  if (typeof e === 'string') return MISSING_BUCKET_WORDS.test(e);
  if (typeof e !== 'object' || e === null) return false;
  const { name, Code, message, $metadata } = e as S3ErrorShape;
  if (name === 'NoSuchBucket' || Code === 'NoSuchBucket') return true;
  // A 404 with no body: the SDK has no code to read and names it NotFound.
  if ($metadata?.httpStatusCode === 404 && name === 'NotFound') return true;
  return MISSING_BUCKET_WORDS.test(String(message ?? ''));
}

/**
 * Does this error say "no such bucket" (by code, status or words)? A claim
 * from one endpoint, not proof: classifyBucketDeleteError confirms it.
 */
export function saysBucketMissing(err: unknown): boolean {
  return chain(err).some(saysMissing);
}

/**
 * One line for a failed delete: the S3 code and HTTP status first, so
 * "UnknownError" alone never reaches the log again.
 */
export function describeBucketError(err: unknown): string {
  if (typeof err !== 'object' || err === null) return String(err);
  const { name, Code, message, $metadata } = err as S3ErrorShape;
  const code = name && name !== 'Error' ? name : Code;
  const status = $metadata?.httpStatusCode;
  const head = [code, status ? `(HTTP ${status})` : ''].filter(Boolean).join(' ');
  const first = String(message ?? '').split('\n')[0];
  const cause = (err as S3ErrorShape).cause;
  const tail = cause ? `; cause: ${describeBucketError(cause)}` : '';
  if (!head) return `${first}${tail}`;
  return first && first !== code ? `${head}: ${first}${tail}` : `${head}${tail}`;
}

/**
 * The sweep's verdict on a failed bucket delete: gone only when the store
 * says the bucket does not exist, no region these keys reach holds it, AND a
 * listing read after that search no longer shows it. The order is the point:
 * `relist` runs last, so it is the latest word on the bucket.
 */
export async function classifyBucketDeleteError(
  err: unknown,
  bucket: string,
  locate: LocateBucket,
  relist: RelistBuckets,
): Promise<BucketDeleteVerdict> {
  const said = describeBucketError(err);
  if (!saysBucketMissing(err)) return { gone: false, why: said };
  let found: string | null;
  try {
    found = await locate();
  } catch (searchErr) {
    return {
      gone: false,
      why: `${said}, and the search of every region could not tell: ${describeBucketError(searchErr)}`,
    };
  }
  if (found !== null) {
    return { gone: false, why: `${said}, but a HeadBucket finds it in ${found}` };
  }
  let listed: string[] | null;
  let listProblem = '';
  try {
    listed = await relist();
  } catch (listErr) {
    listed = null;
    listProblem = `: ${describeBucketError(listErr)}`;
  }
  if (listed === null) {
    return {
      gone: false,
      why: `${said}, and no HeadBucket finds it, but the bucket listing could not be read again${listProblem}, so whether it is gone cannot be told`,
    };
  }
  if (listed.includes(bucket)) {
    return {
      gone: false,
      why: `${said}, and no HeadBucket finds it, but the bucket listing still shows it: it may be a live bucket that is not answering yet (on Hetzner, up to about 15 minutes), so it is not counted as gone. Sweep again in about 15 minutes, or delete it in the provider console`,
    };
  }
  return { gone: true, why: `${said}, no region holds it, and the listing no longer shows it` };
}
