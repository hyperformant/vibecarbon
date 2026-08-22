/**
 * Shared S3 backup helpers
 * Used by backup.js, restore.js, and compose backup cron
 */

import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { runWithRetry } from './retry.js';

/**
 * Create an S3 client from config.
 */
async function getS3Client(s3Config) {
  const { S3Client } = await import('@aws-sdk/client-s3');
  return new S3Client({
    region: s3Config.region,
    endpoint: s3Config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: s3Config.accessKey,
      secretAccessKey: s3Config.secretKey,
    },
  });
}

/**
 * List full backup archives in S3, sorted newest-first.
 */
export async function listS3Backups(s3Config) {
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const client = await getS3Client(s3Config);

  const command = new ListObjectsV2Command({
    Bucket: s3Config.bucket,
    Prefix: 'backups/',
  });

  const response = await client.send(command);
  const objects = response.Contents || [];

  return objects
    .filter((obj) => obj.Key.endsWith('_full.tar.gz'))
    .sort((a, b) => b.LastModified - a.LastModified)
    .map((obj) => ({
      name: obj.Key.replace('backups/', ''),
      key: obj.Key,
      size: formatBytes(obj.Size),
      date: obj.LastModified.toISOString().replace('T', ' ').slice(0, 19),
    }));
}

/**
 * Download a backup from S3 to a local file.
 *
 * Retries transient/non-auth errors up to 3x. Hetzner S3 fast-failure modes
 * (DNS blips, TCP RST, momentary 5xx) hit downloads too; surfaced in k8s e2e
 * fanout4b 2026-05-01 e3 restore which failed in 881ms then succeeded on a
 * manual retry against the same rig.
 */
export async function downloadS3Backup(s3Config, key, localPath) {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getS3Client(s3Config);

  const terminal = new Set([
    'InvalidAccessKeyId',
    'SignatureDoesNotMatch',
    'AccessDenied',
    'NoSuchKey',
  ]);
  await runWithRetry(
    async () => {
      const command = new GetObjectCommand({
        Bucket: s3Config.bucket,
        Key: key,
      });
      const response = await client.send(command);
      const writeStream = createWriteStream(localPath);
      await pipeline(response.Body, writeStream);
    },
    { delaysMs: [1500, 3000], isTransient: (err) => !terminal.has(err.name) },
  );
}

/**
 * Format a byte count as a human-readable string.
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}
