/**
 * Secret generation utilities
 */

import { createHmac, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

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
 * Generate a JWT token with HS256 signing
 *
 * @param {string} secret - JWT signing secret
 * @param {object} payload - Token payload
 * @param {number} exp - Expiration time in seconds (default: 10 years)
 * @returns {string} - Signed JWT token
 */
export function generateJWT(secret, payload, exp = 315360000) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);

  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + exp,
  };

  const base64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
  const base64Payload = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');

  const signature = createHmac('sha256', secret)
    .update(`${base64Header}.${base64Payload}`)
    .digest('base64url');

  return `${base64Header}.${base64Payload}.${signature}`;
}

/**
 * Generate a replication password for HA Postgres deployments.
 * 24 random bytes → 32 base64url chars. URL/shell safe (no + / =).
 */
export function generateReplPassword() {
  return randomBytes(24).toString('base64url');
}

/**
 * Generate a bcrypt hash of a password
 * Uses the same algorithm as Supabase GoTrue (bcrypt with cost factor 10)
 *
 * @param {string} password - Plain text password
 * @returns {string} - Bcrypt hash
 */
export function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}
