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

/** Wait-free check that the bucket exists, then always (re)apply CORS. */
export async function ensureDevBucket({ client, bucket, origins }) {
  // Throws (NotFound) until the S3 service has created the bucket; main()
  // retries.
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
  // The S3 container accepts connections, and creates the bucket, a moment
  // after compose reports it up.
  let lastError;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await ensureDevBucket({ client, bucket: S3_BUCKET, origins: devOrigins(env) });
      console.log(`Dev bucket ready: ${S3_BUCKET}`);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastError;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Non-fatal for dev: the app boots without storage; uploads just 503/fail.
    console.warn(`Warning: could not prepare the dev bucket (${error.message}).`);
  });
}
