/**
 * Secret generation utilities
 */

import { randomBytes } from 'node:crypto';

/**
 * Generate a secure random password
 *
 * @param {number} length - Password length (default: 32)
 * @returns {string} - Generated password
 */
export function generatePassword(length = 32) {
  return randomBytes(length).toString('base64').slice(0, length).replace(/[+/=]/g, 'x');
}

/**
 * Generate the per-project bucket-name salt: 6 lowercase hex chars, valid in
 * S3 bucket names without transformation. Generated once at `vibecarbon
 * create`, persisted as `bucketSalt` in `.vibecarbon.json`, and consumed by
 * deriveProjectBucketName (src/lib/providers/s3-base.js).
 *
 * @returns {string} - e.g. "3fa9c1"
 */
export function generateBucketSalt() {
  return randomBytes(3).toString('hex');
}

/**
 * Generate a replication password for HA Postgres deployments.
 * 24 random bytes → 32 base64url chars. URL/shell safe (no + / =).
 */
export function generateReplPassword() {
  return randomBytes(24).toString('base64url');
}
