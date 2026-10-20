/**
 * The bucket settle gate.
 *
 * A brand-new Hetzner bucket answers inconsistently for about 16 minutes:
 * on 2026-10-20 a minutes-old bucket refused about 40% of CORS preflights
 * with a 403 and answered some requests with NoSuchBucket, then probes went
 * 58/60 and 60/60 three times and it stayed clean. Each S3 provider class
 * declares how long that window is (`static bucketSettleWindowMs`); only
 * Hetzner's is non-zero, and a 0 window means none of this runs.
 *
 * The deploy never waits on the gate (R5): it records the bucket's creation
 * time and prints a note. Only verification runs `waitForBucketSettled`,
 * which waits for consistency evidence (BUCKET_SETTLE_STREAK clean rounds in
 * a row, any failure resets the streak) within a fixed budget. It is not a
 * retry of the consumer.
 */

import { getProviderClass } from '../providers/index.js';

/** Requests per probe round, half preflights and half signed HeadBucket. */
export const BUCKET_SETTLE_ROUND_SIZE = 20;
/** Consecutive clean rounds that count as settled. */
export const BUCKET_SETTLE_STREAK = 3;
export const BUCKET_SETTLE_ROUND_INTERVAL_MS = 30_000;
export const BUCKET_SETTLE_BUDGET_MS = 25 * 60_000;

const MINUTE_MS = 60_000;

/**
 * @param {Date|string|null|undefined} createdAt
 * @returns {number|null} epoch ms, or null when unknown or unparseable
 */
function toEpochMs(createdAt) {
  if (createdAt == null) return null;
  const ms = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whether verification must run the gate before it uploads. Always false
 * with a 0 window. Otherwise true inside the window, and true when the age
 * is unknown: an unreadable creation date is treated as a young bucket.
 *
 * @param {Date|null} createdAt
 * @param {number} now - epoch ms
 * @param {number} windowMs - the provider class's bucketSettleWindowMs
 * @returns {boolean}
 */
export function bucketNeedsSettle(createdAt, now, windowMs) {
  if (windowMs === 0) return false;
  const created = toEpochMs(createdAt);
  return created === null || now - created < windowMs;
}

/**
 * Age-based settle state, for the deploy note and the status row. No
 * network: it reads the persisted creation time and the provider's window.
 *
 * @param {Date|string|null} createdAt
 * @param {number} now - epoch ms
 * @param {number} windowMs
 * @returns {{ settling: boolean, remainingMs: number|null }} `remainingMs`
 *   is null when the age is unknown, 0 once settled.
 */
export function storageSettleStatus(createdAt, now, windowMs) {
  if (windowMs === 0) return { settling: false, remainingMs: 0 };
  const created = toEpochMs(createdAt);
  if (created === null) return { settling: true, remainingMs: null };
  const remainingMs = Math.max(0, windowMs - (now - created));
  return { settling: remainingMs > 0, remainingMs };
}

/**
 * The one line a deploy prints when its bucket is still settling. An
 * unknown age quotes the whole window.
 *
 * @param {{ remainingMs: number|null }} status - from storageSettleStatus
 * @param {number} windowMs
 * @returns {string}
 */
export function bucketSettleNote(status, windowMs) {
  const minutes = Math.ceil((status.remainingMs ?? windowMs) / MINUTE_MS);
  return `new storage bucket, browser uploads can fail for about ${minutes} more minutes while it settles; vibecarbon status shows when it is done`;
}

/**
 * The settle window a provider's S3 class declares. Throws when the class
 * does not declare it as its own static: there is no default to fall back
 * to (the census test pins every class).
 *
 * @param {string} providerId - e.g. 'hetzner'
 * @returns {Promise<number>}
 */
export async function settleWindowFor(providerId) {
  const S3Class = await getProviderClass(providerId).getObjectStorageProviderClass();
  if (!Object.hasOwn(S3Class, 'bucketSettleWindowMs')) {
    throw new Error(`${S3Class.name} does not declare static bucketSettleWindowMs`);
  }
  return S3Class.bucketSettleWindowMs;
}

/**
 * Probe until BUCKET_SETTLE_STREAK consecutive rounds come back clean, or
 * the budget runs out. A round with any failure resets the streak.
 *
 * `lastFailures` is the failure list of the most recent round that had any,
 * so an exhausted gate names what was still going wrong even when its last
 * round happened to be clean.
 *
 * @param {object} opts
 * @param {() => Promise<{ ok: number, total: number, failures: string[] }>} opts.probeRound
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {number} [opts.budgetMs]
 * @returns {Promise<{ settled: boolean, rounds: number, lastFailures: string[] }>}
 */
export async function waitForBucketSettled({
  probeRound,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  budgetMs = BUCKET_SETTLE_BUDGET_MS,
}) {
  const deadline = now() + budgetMs;
  let rounds = 0;
  let streak = 0;
  let lastFailures = [];
  while (now() < deadline) {
    const round = await probeRound();
    rounds += 1;
    if (round.ok === round.total && round.failures.length === 0) {
      streak += 1;
      if (streak >= BUCKET_SETTLE_STREAK) return { settled: true, rounds, lastFailures };
    } else {
      streak = 0;
      lastFailures = round.failures;
    }
    await sleep(BUCKET_SETTLE_ROUND_INTERVAL_MS);
  }
  return { settled: false, rounds, lastFailures };
}

/**
 * One probe round against the app bucket, shaped like what a browser upload
 * and the app server do first:
 *   - unauthenticated CORS preflights for a PUT under the env's key prefix,
 *     clean when the answer is 200 and echoes the origin;
 *   - signed HeadBucket calls, each through `signedHead` (which must use a
 *     fresh client, so each lands on a new connection), clean when no error.
 *
 * A failure string is `options:<status>` (or `options:200-no-acao`,
 * `options:200-wrong-acao`, `options:<error name>`) or `head:<error name>`.
 *
 * @param {object} opts
 * @param {string} opts.endpoint - e.g. https://fsn1.your-objectstorage.com
 * @param {string} opts.bucket
 * @param {string} opts.keyPrefix - `<env>/`
 * @param {string} opts.origin - the app origin the CORS rule must allow
 * @param {() => Promise<unknown>} opts.signedHead - one signed HeadBucket
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {() => Promise<{ ok: number, total: number, failures: string[] }>}
 */
export function makeAppBucketProbeRound({
  endpoint,
  bucket,
  keyPrefix,
  origin,
  signedHead,
  fetchImpl = globalThis.fetch,
}) {
  const url = `${endpoint}/${bucket}/${keyPrefix}.settle-probe`;
  const preflight = async () => {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT' },
      });
    } catch (err) {
      return `options:${err?.name || 'Error'}`;
    }
    if (res.status !== 200) return `options:${res.status}`;
    const acao = res.headers.get('access-control-allow-origin');
    if (!acao) return 'options:200-no-acao';
    if (acao !== origin) return 'options:200-wrong-acao';
    return null;
  };
  const head = async () => {
    try {
      await signedHead();
      return null;
    } catch (err) {
      return `head:${err?.name || 'Error'}`;
    }
  };
  return async () => {
    const half = BUCKET_SETTLE_ROUND_SIZE / 2;
    const outcomes = await Promise.all([
      ...Array.from({ length: half }, preflight),
      ...Array.from({ length: half }, head),
    ]);
    const failures = outcomes.filter((o) => o !== null);
    return { ok: outcomes.length - failures.length, total: outcomes.length, failures };
  };
}

/**
 * A `signedHead` for makeAppBucketProbeRound: one HeadBucket through a new
 * S3 client per call (so a new connection), with the SDK's own retry off,
 * so a transient answer counts against the round instead of being hidden.
 *
 * @param {object} opts
 * @param {string} opts.providerId
 * @param {string} opts.accessKey
 * @param {string} opts.secretKey
 * @param {string} opts.region - object-storage region
 * @param {string} opts.bucket
 * @returns {() => Promise<void>}
 */
export function makeSignedHead({ providerId, accessKey, secretKey, region, bucket }) {
  return async () => {
    const { S3Client, HeadBucketCommand } = await import('@aws-sdk/client-s3');
    const S3Class = await getProviderClass(providerId).getObjectStorageProviderClass();
    const client = new S3Client({
      region: S3Class.S3_SIGNING_REGION ?? region,
      endpoint: S3Class.ENDPOINTS[region],
      forcePathStyle: true,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
    });
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } finally {
      client.destroy();
    }
  };
}
