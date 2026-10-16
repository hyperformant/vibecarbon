#!/usr/bin/env node
/**
 * Apply browser-upload CORS to the local dev bucket.
 *
 * The dev S3 service (Garage, docker-compose.override.yml) creates the bucket
 * and its key itself at start. Uploads go straight from the browser to a
 * presigned URL, so the bucket also needs CORS for the Vite origin, which
 * depends on this checkout's port settings and so is set here, through the
 * same S3 PutBucketCors call deploy makes on real buckets.
 * Idempotent: safe to run on every `npm run dev:start`.
 *
 * This never creates the bucket. One made through the S3 API gets a key-local
 * alias in Garage, and Garage ignores CORS rules on those for preflights
 * (it answers them with a wildcard origin), so a missing bucket is retried
 * until Garage's own setup has made it.
 *
 * Skips quietly when the S3_* env vars are not set (storage is optional).
 *
 * Usage:
 *   node scripts/ensure-dev-bucket.js
 */

import { fileURLToPath } from 'node:url';
import { HeadBucketCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import { readEnvFiles } from './lib/dotenv.js';

/**
 * Origins the browser may upload from: the Vite dev origin, with the same port
 * rule as scripts/dev.js and the server CORS (DEV_VITE_PORT, else
 * 5173 + DEV_PORT_OFFSET).
 */
export function devOrigins(env) {
  const offset = Number.parseInt(env.DEV_PORT_OFFSET || '0', 10) || 0;
  const port = env.DEV_VITE_PORT || String(5173 + offset);
  return [`http://localhost:${port}`];
}

/**
 * Check the bucket exists, then (re)apply its CORS. Throws NotFound until
 * Garage has created the bucket; prepareDevBucket waits that out.
 */
export async function ensureDevBucket({ client, bucket, origins }) {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        // The rule deploy puts on real buckets (setBucketCors in the CLI's
        // src/lib/providers/s3-base.js), so a header the upload starts
        // sending fails here first instead of in production.
        CORSRules: [
          {
            AllowedOrigins: origins,
            AllowedMethods: ['GET', 'PUT', 'HEAD'],
            AllowedHeaders: ['content-type', 'content-length'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );
}

const CONNECTION_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

/**
 * True while the local S3 is still starting: the port refuses or drops the
 * connection, or Garage has not created the bucket yet. Waiting for a
 * container to come up, not a retry of a failed request.
 */
export function isStillStarting(error) {
  if (error?.name === 'NotFound' || error?.name === 'NoSuchBucket') return true;
  if (error?.$metadata?.httpStatusCode === 404) return true;
  const code = error?.code ?? error?.cause?.code;
  return CONNECTION_ERRORS.has(code);
}

/** True when the S3 service rejected the key: no amount of waiting fixes it. */
export function isAuthFailure(error) {
  if (['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied'].includes(error?.name)) {
    return true;
  }
  return error?.$metadata?.httpStatusCode === 403;
}

export const AUTH_FAILURE_HELP =
  "the S3 key in .env.local doesn't match the local Garage. Run `node scripts/dev-init.js --force` " +
  '(this repo), or copy S3_ACCESS_KEY and S3_SECRET_KEY from a fresh `vibecarbon create`';

/**
 * Apply CORS once the local S3 is up. Waits (attempts x delayMs) only while
 * isStillStarting; any other error, an auth failure included, throws at once.
 */
export async function prepareDevBucket({
  client,
  bucket,
  origins,
  attempts = 10,
  delayMs = 1000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureDevBucket({ client, bucket, origins });
      return;
    } catch (error) {
      if (isAuthFailure(error)) {
        throw Object.assign(new Error(AUTH_FAILURE_HELP), { cause: error, authFailure: true });
      }
      if (!isStillStarting(error) || attempt >= attempts) throw error;
      await sleep(delayMs);
    }
  }
}

async function main() {
  // Shell wins, but a blank export falls through to the .env files.
  const env = { ...readEnvFiles(process.cwd()) };
  for (const [key, value] of Object.entries(process.env)) {
    if (value) env[key] = value;
  }
  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY } = env;
  if (!S3_ENDPOINT || !S3_REGION || !S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    console.log('Dev bucket: S3_* not set, skipping.');
    return;
  }
  const client = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  });
  await prepareDevBucket({ client, bucket: S3_BUCKET, origins: devOrigins(env) });
  console.log(`Dev bucket ready: ${S3_BUCKET}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Non-fatal for dev: the app boots without storage; uploads just 503/fail.
    // A refused connection arrives as an AggregateError with an empty message.
    const reason = error.message || error.code || error.name;
    console.warn(`Warning: could not prepare the dev bucket (${reason}).`);
  });
}
