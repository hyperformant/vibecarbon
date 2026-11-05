/**
 * How long a new bucket counts as young.
 *
 * Each S3 provider class declares a window (`static bucketSettleWindowMs`);
 * only Hetzner's is non-zero, and a 0 window means none of this runs. Two things
 * read it: the state lock's scope for an HA pair (Ruling A′,
 * src/lib/iac/state-lock.js), and the deploy's record of the app bucket's
 * creation time, which the app key fence takes as proof a deploy finished.
 *
 * Nothing waits on it. The 15 minutes of NoSuchBucket a new Hetzner bucket used
 * to show came from our own probe touching it in its first second, and
 * `bucketQuietMs` prevents that, so uploads go straight to a new bucket.
 */

import { getProviderClass } from '../providers/index.js';

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
 * Whether a bucket counts as young. Always false with a 0 window. Otherwise
 * true inside the window, and true when the age is unknown: an unreadable
 * creation date is treated as a young bucket.
 *
 * @param {Date|null} createdAt
 * @param {number} now - epoch ms
 * @param {number} windowMs - the provider class's bucketSettleWindowMs
 * @returns {boolean}
 */
export function bucketIsYoung(createdAt, now, windowMs) {
  if (windowMs === 0) return false;
  const created = toEpochMs(createdAt);
  return created === null || now - created < windowMs;
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
 * Whether the Pulumi STATE bucket is still inside its provider's settle
 * window, which sets the state lock's scope for an HA pair's `up`s (Ruling
 * A′, src/lib/iac/state-lock.js). A 0-window provider answers false without
 * reading anything. An unreadable creation time, or a provider class that
 * does not declare its window, answers true: a young bucket keeps the
 * whole-operation lock, the safe side.
 *
 * @param {{ providerId: string, createProvider: () => Promise<{ bucketCreatedAt(bucket: string): Promise<Date|null> }>, bucket: string, now?: () => number }} opts
 * @returns {Promise<boolean>}
 */
export async function readStateBucketYoung({ providerId, createProvider, bucket, now = Date.now }) {
  let windowMs;
  try {
    windowMs = await settleWindowFor(providerId);
  } catch {
    return true;
  }
  if (windowMs === 0) return false;
  let createdAt = null;
  try {
    createdAt = await (await createProvider()).bucketCreatedAt(bucket);
  } catch {
    // Unknown age: young.
  }
  return bucketIsYoung(createdAt, now(), windowMs);
}
