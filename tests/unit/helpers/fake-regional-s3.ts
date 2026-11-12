/**
 * A regional in-memory object store with Hetzner's semantics, served through
 * a stand-in for `@aws-sdk/client-s3`, so a test can drive the REAL
 * S3CompatibleProvider (createBucket, findBucketRegion, the visibility probe)
 * across regions without a network.
 *
 * Hetzner, as confirmed on real buckets:
 *   - bucket names are global across regions;
 *   - a request's region is the client's endpoint host
 *     (`https://<region>.your-objectstorage.com`);
 *   - HeadBucket answers 200 only in the bucket's own region, 404 elsewhere;
 *   - CreateBucket on a taken name answers BucketAlreadyOwnedByYou in the
 *     owning region and BucketAlreadyExists in any other;
 *   - object and CORS calls on a bucket from another region answer
 *     NoSuchBucket 404.
 *
 * Usage (the world must exist before the mock factory runs):
 *
 *   const s3 = await vi.hoisted(async () =>
 *     (await import('../helpers/fake-regional-s3.js')).createRegionalS3World(),
 *   );
 *   vi.mock('@aws-sdk/client-s3', () => s3.module);
 *
 * `calls` logs every request as `{ command, region, bucket }`, where
 * `command` is the SDK command name without `Command` (`HeadBucket`).
 */

export type S3Call = { command: string; region: string; bucket?: string };

type StoredBucket = {
  region: string;
  createdAt: Date;
  objects: Map<string, string>;
  cors: unknown[] | null;
  policy: string | null;
};

// Every command class src/lib/providers/s3-base.js and hetzner-s3.js import.
const COMMAND_NAMES = [
  'AbortMultipartUploadCommand',
  'CopyObjectCommand',
  'CreateBucketCommand',
  'DeleteBucketCommand',
  'DeleteBucketPolicyCommand',
  'DeleteObjectCommand',
  'DeleteObjectsCommand',
  'GetBucketCorsCommand',
  'GetBucketPolicyCommand',
  'GetObjectCommand',
  'HeadBucketCommand',
  'ListBucketsCommand',
  'ListMultipartUploadsCommand',
  'ListObjectsV2Command',
  'ListObjectVersionsCommand',
  'PutBucketCorsCommand',
  'PutBucketPolicyCommand',
  'PutObjectCommand',
] as const;

type Command = { commandName: string; input: Record<string, unknown> };

function s3Error(name: string, status: number, message = name) {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
}

/** `https://fsn1.your-objectstorage.com` → `fsn1`. Anything else is a test bug. */
export function hetznerRegionOf(endpoint: string): string {
  const match = /^https:\/\/([a-z0-9-]+)\.your-objectstorage\.com\/?$/.exec(String(endpoint));
  if (!match) throw new Error(`fake-regional-s3: not a Hetzner endpoint: ${endpoint}`);
  return match[1];
}

export function createRegionalS3World() {
  const buckets = new Map<string, StoredBucket>();
  const calls: S3Call[] = [];

  /** The bucket if it lives in `region`, else the NoSuchBucket answer. */
  function inRegion(name: unknown, region: string): StoredBucket {
    const bucket = buckets.get(String(name));
    if (!bucket || bucket.region !== region) {
      throw s3Error('NoSuchBucket', 404, 'The specified bucket does not exist');
    }
    return bucket;
  }

  function handle(region: string, { commandName, input }: Command): unknown {
    const name = commandName.replace(/Command$/, '');
    const bucketName = typeof input.Bucket === 'string' ? input.Bucket : undefined;
    calls.push({ command: name, region, ...(bucketName ? { bucket: bucketName } : {}) });
    switch (name) {
      case 'HeadBucket': {
        const bucket = buckets.get(String(bucketName));
        if (!bucket || bucket.region !== region) throw s3Error('NotFound', 404);
        return {};
      }
      case 'CreateBucket': {
        const existing = buckets.get(String(bucketName));
        if (existing) {
          throw existing.region === region
            ? s3Error('BucketAlreadyOwnedByYou', 409)
            : s3Error('BucketAlreadyExists', 409);
        }
        seed(String(bucketName), region);
        return {};
      }
      case 'DeleteBucket': {
        const bucket = inRegion(bucketName, region);
        if (bucket.objects.size > 0) throw s3Error('BucketNotEmpty', 409);
        buckets.delete(String(bucketName));
        return {};
      }
      case 'ListBuckets':
        return {
          Buckets: [...buckets.entries()].map(([Name, b]) => ({
            Name,
            CreationDate: b.createdAt,
          })),
        };
      case 'ListObjectsV2': {
        const bucket = inRegion(bucketName, region);
        const prefix = String(input.Prefix ?? '');
        const keys = [...bucket.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const max = Number(input.MaxKeys ?? 1000);
        const page = keys.slice(0, max);
        return {
          Contents: page.map((Key) => ({ Key, Size: bucket.objects.get(Key)?.length ?? 0 })),
          KeyCount: page.length,
          IsTruncated: false,
        };
      }
      case 'ListObjectVersions':
        inRegion(bucketName, region);
        return { Versions: [], DeleteMarkers: [], IsTruncated: false };
      case 'ListMultipartUploads':
        inRegion(bucketName, region);
        return { Uploads: [], IsTruncated: false };
      case 'AbortMultipartUpload':
        inRegion(bucketName, region);
        return {};
      case 'PutObject': {
        const bucket = inRegion(bucketName, region);
        bucket.objects.set(String(input.Key), String(input.Body ?? ''));
        return {};
      }
      case 'GetObject': {
        const bucket = inRegion(bucketName, region);
        const body = bucket.objects.get(String(input.Key));
        if (body === undefined) throw s3Error('NoSuchKey', 404);
        return { Body: { transformToString: async () => body } };
      }
      case 'DeleteObject':
        inRegion(bucketName, region).objects.delete(String(input.Key));
        return {};
      case 'DeleteObjects': {
        const bucket = inRegion(bucketName, region);
        const objects = (input.Delete as { Objects?: Array<{ Key: string }> })?.Objects ?? [];
        for (const { Key } of objects) bucket.objects.delete(Key);
        return { Deleted: objects };
      }
      case 'CopyObject': {
        const dest = inRegion(bucketName, region);
        const source = decodeURI(String(input.CopySource));
        const slash = source.indexOf('/');
        const from = inRegion(source.slice(0, slash), region);
        const body = from.objects.get(source.slice(slash + 1));
        if (body === undefined) throw s3Error('NoSuchKey', 404);
        dest.objects.set(String(input.Key), body);
        return {};
      }
      case 'PutBucketCors':
        inRegion(bucketName, region).cors =
          (input.CORSConfiguration as { CORSRules?: unknown[] })?.CORSRules ?? [];
        return {};
      case 'GetBucketCors': {
        const bucket = inRegion(bucketName, region);
        if (!bucket.cors) throw s3Error('NoSuchCORSConfiguration', 404);
        return { CORSRules: bucket.cors };
      }
      case 'PutBucketPolicy':
        inRegion(bucketName, region).policy = String(input.Policy);
        return {};
      case 'GetBucketPolicy': {
        const bucket = inRegion(bucketName, region);
        if (!bucket.policy) throw s3Error('NoSuchBucketPolicy', 404);
        return { Policy: bucket.policy };
      }
      case 'DeleteBucketPolicy':
        inRegion(bucketName, region).policy = null;
        return {};
      default:
        throw new Error(`fake-regional-s3: no handler for ${commandName}`);
    }
  }

  /** Put a bucket in `region`, as if it had been created there earlier. */
  function seed(name: string, region: string, objects: Record<string, string> = {}) {
    buckets.set(name, {
      region,
      createdAt: new Date(),
      objects: new Map(Object.entries(objects)),
      cors: null,
      policy: null,
    });
  }

  class S3Client {
    readonly config: Record<string, unknown>;
    readonly region: string;
    // s3-base.js adds its ListBuckets build-step middleware here.
    readonly middlewareStack = { add: () => {} };
    constructor(config: Record<string, unknown>) {
      this.config = config;
      this.region = hetznerRegionOf(String(config.endpoint));
    }
    async send(command: Command) {
      return handle(this.region, command);
    }
    destroy() {}
  }

  const commands = Object.fromEntries(
    COMMAND_NAMES.map((commandName) => [
      commandName,
      // A named class per command, holding its input like the SDK's.
      {
        [commandName]: class {
          readonly commandName = commandName;
          constructor(readonly input: Record<string, unknown>) {}
        },
      }[commandName],
    ]),
  );

  return {
    buckets,
    calls,
    seed,
    /** Where `name` lives, or undefined. */
    regionOf: (name: string) => buckets.get(name)?.region,
    /** Empty the world and the call log. */
    reset() {
      buckets.clear();
      calls.length = 0;
    },
    /** The `@aws-sdk/client-s3` stand-in for `vi.mock`. */
    module: { S3Client, ...commands },
  };
}

export type RegionalS3World = ReturnType<typeof createRegionalS3World>;
