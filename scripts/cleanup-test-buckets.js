#!/usr/bin/env node
/**
 * Clean up orphaned Hetzner S3 buckets from e2e tests.
 *
 * AD-HOC OPS TOOL — intentionally unreferenced by package.json scripts, docs,
 * or code (same category as sweep-hetzner.js). Run by hand when e2e runs leak
 * buckets: `node scripts/cleanup-test-buckets.js`. Kept per 2026-07-08 audit
 * review.
 *
 * Conservative: only touches buckets whose name starts with `testapp-`
 * (our e2e project-name convention). Never touches buckets with
 * any other prefix, so the real web app's buckets are safe.
 *
 * Iterates all three Hetzner S3 regions (nbg1, fsn1, hel1), empties each
 * matching bucket paginated (including object versions and multipart
 * uploads), then deletes it.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';

const TEST_PREFIX = 'testapp-';
const REGIONS = ['nbg1', 'fsn1', 'hel1'];

// Env-only: populate HETZNER_ACCESS_KEY and HETZNER_SECRET_KEY via tests/.env.e2e or export directly.
const s3 = {
  accessKey: process.env.HETZNER_ACCESS_KEY,
  secretKey: process.env.HETZNER_SECRET_KEY,
};
if (!s3?.accessKey || !s3?.secretKey) {
  throw new Error('HETZNER_ACCESS_KEY and HETZNER_SECRET_KEY required; set via tests/.env.e2e or export directly');
}

const dryRun = process.argv.includes('--dry-run');

async function emptyBucket(client, bucketName) {
  let totalDeleted = 0;

  // 1. Current objects
  let continuationToken;
  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );
    const objects = (list.Contents ?? [])
      .filter((o) => o.Key)
      .map((o) => ({ Key: o.Key }));
    if (objects.length > 0) {
      if (!dryRun) {
        await client.send(
          new DeleteObjectsCommand({ Bucket: bucketName, Delete: { Objects: objects, Quiet: true } }),
        );
      }
      totalDeleted += objects.length;
    }
    continuationToken = list.NextContinuationToken;
  } while (continuationToken);

  // 2. Object versions + delete markers (required on versioned buckets —
  // without this, DeleteBucket fails with BucketNotEmpty even after step 1)
  try {
    let keyMarker;
    let versionIdMarker;
    do {
      const versions = await client.send(
        new ListObjectVersionsCommand({
          Bucket: bucketName,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      );
      const toDelete = [
        ...(versions.Versions ?? []).map((v) => ({ Key: v.Key, VersionId: v.VersionId })),
        ...(versions.DeleteMarkers ?? []).map((d) => ({ Key: d.Key, VersionId: d.VersionId })),
      ];
      if (toDelete.length > 0) {
        if (!dryRun) {
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucketName,
              Delete: { Objects: toDelete, Quiet: true },
            }),
          );
        }
        totalDeleted += toDelete.length;
      }
      keyMarker = versions.IsTruncated ? versions.NextKeyMarker : undefined;
      versionIdMarker = versions.IsTruncated ? versions.NextVersionIdMarker : undefined;
    } while (keyMarker);
  } catch {
    // Non-fatal — not every S3-compatible provider supports ListObjectVersions
  }

  // 3. Incomplete multipart uploads (also blocks DeleteBucket if present)
  try {
    const uploads = await client.send(new ListMultipartUploadsCommand({ Bucket: bucketName }));
    for (const upload of uploads.Uploads ?? []) {
      if (!dryRun) {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucketName,
            Key: upload.Key,
            UploadId: upload.UploadId,
          }),
        );
      }
    }
  } catch {
    // Non-fatal — not every provider supports multipart listing
  }

  return totalDeleted;
}

async function main() {
  let totalBuckets = 0;
  let totalObjectsDeleted = 0;
  const errors = [];

  for (const region of REGIONS) {
    const client = new S3Client({
      endpoint: `https://${region}.your-objectstorage.com`,
      region,
      credentials: { accessKeyId: s3.accessKey, secretAccessKey: s3.secretKey },
      forcePathStyle: true,
    });

    console.log(`\n=== ${region} ===`);
    let resp;
    try {
      resp = await client.send(new ListBucketsCommand({}));
    } catch (err) {
      console.warn(`  list-buckets failed: ${err.message}`);
      continue;
    }

    const all = (resp.Buckets ?? []).filter((b) => !!b.Name);
    const matches = all.filter((b) => b.Name.startsWith(TEST_PREFIX));
    const kept = all.filter((b) => !b.Name.startsWith(TEST_PREFIX));

    console.log(
      `  ${all.length} bucket(s) total; ${matches.length} match "${TEST_PREFIX}*"; ${kept.length} kept:`,
    );
    for (const b of kept) console.log(`    keep  ${b.Name}`);
    for (const b of matches) console.log(`    ${dryRun ? 'would-del' : 'DELETE'} ${b.Name}`);

    for (const bucket of matches) {
      const name = bucket.Name;
      process.stdout.write(`  emptying ${name} ... `);
      try {
        const n = await emptyBucket(client, name);
        process.stdout.write(`${n} obj`);
        if (!dryRun) {
          await client.send(new DeleteBucketCommand({ Bucket: name }));
          process.stdout.write(' + deleted\n');
        } else {
          process.stdout.write(' (dry run)\n');
        }
        totalBuckets++;
        totalObjectsDeleted += n;
      } catch (err) {
        process.stdout.write(`\n    ERROR on ${name}: ${err.message}\n`);
        errors.push({ bucket: name, region, error: err.message });
      }
    }
  }

  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}Total: ${totalBuckets} bucket(s) processed, ${totalObjectsDeleted} object(s) deleted.`,
  );
  if (errors.length > 0) {
    console.log(`${errors.length} error(s):`);
    for (const e of errors) console.log(`  ${e.region}/${e.bucket}: ${e.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
