#!/usr/bin/env node
/**
 * Ensure the local dev bucket exists and allows browser uploads.
 *
 * The dev S3 service (SeaweedFS) starts empty. Uploads go straight from the
 * browser to a presigned URL, so the bucket needs CORS for the Vite origin.
 * Idempotent: safe to run on every `npm run dev:start`.
 *
 * Skips quietly when the S3_* env vars are not set (storage is optional).
 *
 * Usage:
 *   node scripts/ensure-dev-bucket.js
 */

import { fileURLToPath } from 'node:url';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { readEnvFiles } from './lib/dotenv.js';

/** Origins the browser may upload from: the default Vite port plus any override. */
export function devOrigins(env) {
  const origins = ['http://localhost:5173'];
  const port = env.DEV_VITE_PORT;
  if (port) origins.push(`http://localhost:${port}`);
  return [...new Set(origins)];
}

/** Create the bucket if missing and always (re)apply CORS. */
export async function ensureDevBucket({ client, bucket, origins }) {
  let exists = true;
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    exists = false;
  }
  if (!exists) {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (error?.name !== 'BucketAlreadyOwnedByYou') throw error;
    }
  }
  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: origins,
            AllowedMethods: ['GET', 'PUT', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3000,
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
  // The S3 container can accept connections a moment after compose reports it up.
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
