/**
 * The e2e Pulumi state bucket as a StateStoreApi, for the stale-stack sweep
 * (./sweep-run-stacks.ts).
 *
 * Where it lives is never written down here:
 * - The NAME is sharedStateBucketName() (./namespace.ts), the same function
 *   the runner pins into every scratch project. `VC_E2E_STATE_BUCKET` (local
 *   file or the CI repo variable) supplies the per-account suffix.
 * - The LOCATION is found the way the CLI's own bucket lookup does it: the
 *   provider's object-storage class (src/lib/providers/*) lists its
 *   ENDPOINTS, and a HeadBucket in each says where the bucket is (a 404 means
 *   not there; any other answer means the place cannot be told). A provider
 *   whose keys serve one cluster (Linode, Vultr) is asked in the operator's
 *   `<PROVIDER>_STORAGE_REGION`, or, for Linode, in the account's own cluster
 *   for each region the matrix deploys to.
 * - The CREDENTIALS are the compute class's OBJECT_STORAGE_ENV pair.
 *
 * Nothing here ever fails a run: a bucket that cannot be located reads as an
 * incomplete listing, which makes the sweep delete nothing.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getProviderClass } from '../../../src/lib/providers/index.js';
import { testConfig } from '../../config.js';
import { parseScratchProject, STALE_RUN_MAX_AGE_MS } from './local-artifacts.js';
import { activeNamespace, scratchNamePrefix, sharedStateBucketName } from './namespace.js';
import type { StateStoreApi } from './sweep-run-stacks.js';

/** The slice of an S3 client this module uses. */
export interface S3Like {
  // biome-ignore lint/suspicious/noExplicitAny: the SDK's command and output types vary per call
  send(command: any): Promise<any>;
}

export interface S3Config {
  provider: string;
  accessKey: string;
  secretKey: string;
  region: string;
  endpoint: string;
}

export interface E2eStateStore extends StateStoreApi {
  /** The bucket and where it was found; null when it exists nowhere or cannot be told. */
  where(): Promise<{ bucket: string; region: string; endpoint: string } | null>;
}

interface StorageClass {
  ENDPOINTS: Record<string, string>;
  keyRegions?: string;
  resolveAccountS3Region?: (region: string, o: { apiToken: string }) => Promise<string>;
  resolveS3Region(region: string): string;
  new (accessKey: string, secretKey: string, region: string): { getClient(): S3Like };
}

type Located = { region: string; endpoint: string } | null;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const statusOf = (e: unknown) =>
  (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
const isNotFound = (e: unknown) =>
  statusOf(e) === 404 ||
  ['NotFound', 'NoSuchBucket', 'NoSuchKey'].includes((e as { name?: string })?.name ?? '');

/**
 * The state bucket's store for one provider, or null when that provider's
 * storage credentials are missing.
 *
 * @param opts.namespace - which namespace's bucket (default: the active one).
 *   A namespace other than the env's own ignores VC_E2E_STATE_BUCKET, which
 *   names one namespace's bucket only.
 * @param opts.dryRun - `remove` logs `would delete <key>` and deletes nothing.
 * @param opts.s3 - test seam: builds the client for a region.
 */
export function e2eStateStore(
  provider: string,
  env: Record<string, string | undefined>,
  opts: { namespace?: 'local' | 'ci'; dryRun?: boolean; s3?: (cfg: S3Config) => S3Like } = {},
): E2eStateStore | null {
  const Provider = getProviderClass(provider) as unknown as {
    OBJECT_STORAGE_ENV?: string[];
    S3_REGION_ENV?: string;
    getObjectStorageProviderClass(): Promise<StorageClass>;
  };
  const [accessEnv, secretEnv] = Provider.OBJECT_STORAGE_ENV ?? [];
  const accessKey = accessEnv ? env[accessEnv] : undefined;
  const secretKey = secretEnv ? env[secretEnv] : undefined;
  if (!accessKey || !secretKey) return null;

  const own = activeNamespace(env as NodeJS.ProcessEnv) ?? 'local';
  const wanted = opts.namespace ?? own;
  const nameEnv: Record<string, string | undefined> = { ...env };
  if (wanted !== own) delete nameEnv.VC_E2E_STATE_BUCKET;
  nameEnv.E2E_NAMESPACE = wanted === 'local' ? undefined : wanted;
  const bucket = sharedStateBucketName(nameEnv as NodeJS.ProcessEnv);
  const dryRun = opts.dryRun === true;

  let cls: StorageClass | undefined;
  const clientFor = async (region: string): Promise<S3Like> => {
    cls ??= await Provider.getObjectStorageProviderClass();
    const cfg = {
      provider,
      accessKey,
      secretKey,
      region,
      endpoint: cls.ENDPOINTS[region],
    };
    return opts.s3 ? opts.s3(cfg) : new cls(accessKey, secretKey, region).getClient();
  };

  const candidateRegions = async (): Promise<string[]> => {
    cls ??= await Provider.getObjectStorageProviderClass();
    const pinned = Provider.S3_REGION_ENV ? env[Provider.S3_REGION_ENV]?.trim() : undefined;
    if (pinned) return [pinned];
    if (cls.keyRegions === 'all') return Object.keys(cls.ENDPOINTS);
    // Keys that serve one cluster: the account's own, per matrix region.
    if (!cls.resolveAccountS3Region) return [];
    const token =
      env[
        (testConfig.e2e.providers as Record<string, { computeTokenEnv: string }>)[provider]
          ?.computeTokenEnv ?? ''
      ];
    if (!token) return [];
    const prefs = (
      testConfig.e2e.capacityPreferences as Record<string, { regions: readonly string[] }>
    )[provider];
    const found = new Set<string>();
    for (const region of prefs?.regions ?? []) {
      try {
        found.add(await cls.resolveAccountS3Region(region, { apiToken: token }));
      } catch {}
    }
    return [...found];
  };

  let located: Promise<Located> | undefined;
  /** HeadBucket per candidate region; throws when a region answers anything but not-found. */
  const locate = (): Promise<Located> => {
    located ??= (async () => {
      const regions = await candidateRegions();
      if (regions.length === 0) {
        throw new Error(`no storage region to look in for ${provider}`);
      }
      for (const region of regions) {
        const client = await clientFor(region);
        try {
          await client.send(new HeadBucketCommand({ Bucket: bucket }));
          return { region, endpoint: (cls as StorageClass).ENDPOINTS[region] };
        } catch (e) {
          if (isNotFound(e)) continue;
          throw new Error(`${region} answered "${errText(e)}" when asked for bucket ${bucket}`);
        }
      }
      return null;
    })();
    return located;
  };

  const withClient = async <T>(fn: (client: S3Like) => Promise<T>, whenAbsent: T): Promise<T> => {
    const at = await locate();
    if (!at) return whenAbsent;
    return fn(await clientFor(at.region));
  };

  return {
    async where() {
      try {
        const at = await locate();
        return at ? { bucket, ...at } : null;
      } catch {
        return null;
      }
    },

    async list(prefix) {
      let at: Located;
      try {
        at = await locate();
      } catch (e) {
        console.warn(`[state-store] ${provider}: cannot tell where ${bucket} is: ${errText(e)}`);
        return { keys: [], complete: false };
      }
      // No such bucket: no stacks, and nothing is unread.
      if (!at) return { keys: [], complete: true };
      const keys: string[] = [];
      try {
        const client = await clientFor(at.region);
        let token: string | undefined;
        do {
          const page = await client.send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
          );
          for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key);
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token);
      } catch (e) {
        console.warn(`[state-store] ${provider}: listing ${prefix} failed: ${errText(e)}`);
        return { keys, complete: false };
      }
      return { keys, complete: true };
    },

    async read(key) {
      try {
        return await withClient(async (client) => {
          const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
          return JSON.parse(await out.Body.transformToString());
        }, null);
      } catch {
        return null;
      }
    },

    async remove(keys) {
      if (dryRun) {
        for (const key of keys) console.log(`would delete ${key}`);
        return [];
      }
      const gone: string[] = [];
      let at: Located;
      try {
        at = await locate();
      } catch {
        return gone;
      }
      // No bucket: every key is already gone.
      if (!at) return [...keys];
      const client = await clientFor(at.region);
      for (const key of keys) {
        try {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
          gone.push(key);
        } catch (e) {
          if (isNotFound(e)) gone.push(key);
          else console.warn(`[state-store] ${provider}: delete ${key} failed: ${errText(e)}`);
        }
      }
      return gone;
    },
  };
}

/**
 * The CI sweep's owner predicate: a scratch project of this namespace whose
 * run started more than STALE_RUN_MAX_AGE_MS ago. The age floor keeps a run
 * in flight (a stack with no resources yet, or pending creates) from ever
 * being judged, and bounds what a token that sees another project can do.
 * A name that does not parse as a scratch project is not owned.
 */
export function ownsStaleScratchProject(
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): (project: string) => boolean {
  const prefix = scratchNamePrefix(env);
  return (project) => {
    if (!project.startsWith(prefix)) return false;
    const parsed = parseScratchProject(project);
    return (
      parsed !== null &&
      parsed.projectName === project &&
      now - parsed.createdAtMs > STALE_RUN_MAX_AGE_MS
    );
  };
}
