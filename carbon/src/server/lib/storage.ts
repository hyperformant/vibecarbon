import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './env';

export const UPLOAD_KINDS = {
  avatar: {
    prefix: 'avatars',
    maxBytes: 2_097_152,
    types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as readonly string[],
  },
  private: {
    prefix: 'private',
    maxBytes: 10_485_760,
    types: [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
      'text/plain',
      'text/csv',
    ] as readonly string[],
  },
} as const;
export type UploadKind = keyof typeof UPLOAD_KINDS;

const TYPE_RE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;

/** Strip parameters, trim, lowercase; reject anything not a plain type/subtype. */
function normalizeContentType(raw: string): string {
  const t = raw.split(';')[0].trim().toLowerCase();
  if (!TYPE_RE.test(t)) throw new StorageInputError('type_not_allowed');
  return t;
}
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
};
const EXPIRES_IN = 300;
const KEY_RE = /^(avatars|private)\/([A-Za-z0-9-]{1,64})\/([0-9a-f-]{36})\.([a-z0-9]{1,8})$/;

export class StorageInputError extends Error {}
export class StorageNotConfiguredError extends Error {}

export function isStorageConfigured(): boolean {
  return Boolean(
    env.S3_ENDPOINT && env.S3_REGION && env.S3_BUCKET && env.S3_ACCESS_KEY && env.S3_SECRET_KEY
  );
}

let client: S3Client | null = null;
function s3(): S3Client {
  if (!isStorageConfigured()) throw new StorageNotConfiguredError('storage_not_configured');
  client ??= new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    // Presigned URLs must not embed a body checksum (the SDK would sign the CRC32 of an
    // empty body, and real uploads would then fail validation).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY as string,
      secretAccessKey: env.S3_SECRET_KEY as string,
    },
  });
  return client;
}

export function buildObjectKey(kind: UploadKind, userId: string, contentType: string): string {
  const spec = UPLOAD_KINDS[kind];
  const type = normalizeContentType(contentType);
  if (!spec.types.includes(type)) throw new StorageInputError('type_not_allowed');
  return `${spec.prefix}/${userId}/${randomUUID()}.${EXT[type]}`;
}

export async function presignUpload(args: {
  kind: UploadKind;
  userId: string;
  contentType: string;
  size: number;
}): Promise<{ key: string; url: string; headers: Record<string, string>; expiresIn: number }> {
  // Not-configured wins over input errors: an unconfigured server always says so.
  const sdk = s3();
  const spec = UPLOAD_KINDS[args.kind];
  if (!Number.isInteger(args.size) || args.size <= 0 || args.size > spec.maxBytes) {
    throw new StorageInputError('size_not_allowed');
  }
  const contentType = normalizeContentType(args.contentType);
  const key = buildObjectKey(args.kind, args.userId, contentType);
  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: args.size,
  });
  // Signing Content-Length makes S3 reject a body whose size differs from the
  // size we approved.
  const url = await getSignedUrl(sdk, command, {
    expiresIn: EXPIRES_IN,
    signableHeaders: new Set(['content-type', 'content-length']),
  });
  return {
    key,
    url,
    expiresIn: EXPIRES_IN,
    headers: { 'Content-Type': contentType, 'Content-Length': String(args.size) },
  };
}

export async function presignRead(key: string): Promise<string> {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      // Private files never render inline from the storage origin.
      ...(key.startsWith('private/') ? { ResponseContentDisposition: 'attachment' } : {}),
    }),
    {
      expiresIn: EXPIRES_IN,
    }
  );
}

export function parseObjectKey(
  raw: string
): { kind: UploadKind; userId: string; key: string } | null {
  const m = KEY_RE.exec(raw);
  if (!m) return null;
  return { kind: m[1] === 'avatars' ? 'avatar' : 'private', userId: m[2], key: raw };
}
