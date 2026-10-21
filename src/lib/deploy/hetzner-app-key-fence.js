/**
 * The Hetzner app-key deny-fence (security plan R2, Task 4).
 *
 * Hetzner keys can only be made in the console, and every key reaches every
 * bucket in the project. But each key is its own principal,
 * `arn:aws:iam:::user/<ownerId>:<accessKeyId>`, and a Deny bucket policy on
 * that principal is enforced (real-account spike, 2026-10-20). So when the
 * operator pastes an environment's app key, the deploy puts a policy on every
 * bucket vibecarbon manages for the project (the Pulumi state bucket, the
 * backups bucket and each environment's app bucket) that denies every OTHER
 * environment's pasted key. An env's own bucket never denies its own key.
 *
 * What a policy cannot close (R4): the app key can still list bucket names,
 * create buckets, use any bucket made outside vibecarbon, and delete an empty
 * fenced bucket.
 *
 * Policy changes reach Hetzner's gateways unevenly over 30 to 60 s, so each
 * fence is written once per change and then verified by a consistency gate:
 * FENCE_PROBE_STREAK denied probes in a row with a fenced key, inside a fixed
 * FENCE_PROBE_BUDGET_MS. Any allowed probe resets the streak. It is never a
 * retry of the write; an exhausted budget fails the deploy naming the bucket.
 */

/** Denied probes in a row that count as the fence holding. */
export const FENCE_PROBE_STREAK = 3;
/** The whole verification budget for one bucket. */
export const FENCE_PROBE_BUDGET_MS = 120_000;
/** Time between probes. */
export const FENCE_PROBE_INTERVAL_MS = 5_000;

/**
 * The fence principal for one key.
 * @param {string} ownerId
 * @param {string} accessKeyId
 */
function principal(ownerId, accessKeyId) {
  return `arn:aws:iam:::user/${ownerId}:${accessKeyId}`;
}

/**
 * The bucket policy that denies `deniedAccessKeyIds` everything on `bucket`.
 * One Deny statement, sorted principals, so the same inputs always render the
 * same policy.
 * @param {{ bucket: string, ownerId: string, deniedAccessKeyIds: string[] }} args
 * @returns {object}
 */
export function renderHetznerFencePolicy({ bucket, ownerId, deniedAccessKeyIds }) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Deny',
        Principal: {
          AWS: [...new Set(deniedAccessKeyIds)].sort().map((id) => principal(ownerId, id)),
        },
        Action: ['s3:*'],
        Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
      },
    ],
  };
}

/**
 * Every pasted app key recorded in the project: `{ env, id }` per
 * environment whose `s3.appKey` is a paste-fence record.
 * @param {object} projectConfig
 * @returns {{ env: string, id: string }[]}
 */
function pastedKeys(projectConfig) {
  return Object.entries(projectConfig.environments ?? {})
    .filter(([, e]) => e?.s3?.appKey?.scoping === 'paste-fence' && e.s3.appKey.id)
    .map(([env, e]) => ({ env, id: e.s3.appKey.id }));
}

/**
 * Which buckets get which fence. Every bucket vibecarbon manages for the
 * project (each env's recorded state, backups and app bucket) denies every
 * environment's pasted app key, except that an env's own app bucket never
 * denies that env's key. A bucket with nothing to deny is still listed, with
 * an empty list, so a fence left over from a destroyed env is removed.
 *
 * `leaving: true` computes the fences as they must be once `environment` is
 * gone (destroy): its key leaves every fence and its own bucket is left alone.
 *
 * @param {{ projectConfig: object, environment: string, leaving?: boolean }} args
 * @returns {{ bucket: string, deniedAccessKeyIds: string[] }[]}
 */
export function fenceTargets({ projectConfig, environment, leaving = false }) {
  const envs = Object.entries(projectConfig.environments ?? {}).filter(
    ([name]) => !(leaving && name === environment),
  );
  const keys = pastedKeys(projectConfig).filter((k) => !(leaving && k.env === environment));
  /** @type {Map<string, string|null>} bucket → owning env (null: shared) */
  const owners = new Map();
  for (const [, e] of envs) {
    for (const shared of [e?.s3?.stateBucket, e?.backupS3?.bucket]) {
      if (shared) owners.set(shared, null);
    }
  }
  for (const [name, e] of envs) {
    const own = e?.s3?.bucket;
    // A pinned bucket may be one several envs share; it is not this env's
    // own, so it denies every pasted key like the state and backups buckets.
    if (own && !owners.has(own)) owners.set(own, e.s3.bucketPin ? null : name);
  }
  return [...owners.entries()]
    .map(([bucket, owner]) => ({
      bucket,
      deniedAccessKeyIds: keys
        .filter((k) => k.env !== owner)
        .map((k) => k.id)
        .sort(),
    }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/**
 * The key ids a policy vibecarbon wrote denies, or null when the policy is
 * not one vibecarbon wrote (anything but our single Deny statement).
 * @param {object|null} policy
 * @param {string} bucket
 * @param {string} ownerId
 * @returns {string[]|null}
 */
function fencedIdsOf(policy, bucket, ownerId) {
  const statements = policy?.Statement;
  if (!Array.isArray(statements) || statements.length !== 1) return null;
  const st = statements[0];
  const resources = [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`];
  if (
    st.Effect !== 'Deny' ||
    JSON.stringify(st.Action) !== JSON.stringify(['s3:*']) ||
    JSON.stringify(st.Resource) !== JSON.stringify(resources)
  ) {
    return null;
  }
  const aws = st.Principal?.AWS;
  const list = Array.isArray(aws) ? aws : aws ? [aws] : [];
  const prefix = `arn:aws:iam:::user/${ownerId}:`;
  if (!list.every((p) => typeof p === 'string' && p.startsWith(prefix))) return null;
  return list.map((p) => p.slice(prefix.length)).sort();
}

/**
 * Wait until `probe` refuses FENCE_PROBE_STREAK times in a row, inside the
 * budget. A consistency gate, not a retry: it never writes anything.
 * @param {{ bucket: string, probe: { isDeniedOn(bucket: string): Promise<boolean> }, sleep: (ms: number) => Promise<void>, now: () => number }} args
 */
async function waitForFence({ bucket, probe, sleep, now }) {
  const deadline = now() + FENCE_PROBE_BUDGET_MS;
  let streak = 0;
  while (true) {
    streak = (await probe.isDeniedOn(bucket)) ? streak + 1 : 0;
    if (streak >= FENCE_PROBE_STREAK) return;
    if (now() + FENCE_PROBE_INTERVAL_MS > deadline) {
      throw new Error(
        `the app key fence on bucket ${bucket} did not hold within ${FENCE_PROBE_BUDGET_MS / 1000} s (${FENCE_PROBE_STREAK} denied probes in a row), so the app key may still reach it. Run the deploy again; the fence is already written.`,
      );
    }
    await sleep(FENCE_PROBE_INTERVAL_MS);
  }
}

/**
 * Write the fences that changed and verify each one.
 *
 * For each target the current policy is read first. When it already denies
 * exactly the wanted keys nothing is written. A policy vibecarbon did not
 * write is never overwritten: the deploy stops naming the bucket. An empty
 * deny list removes our policy.
 *
 * Each written fence is verified with every fenced key the caller holds a
 * probe client for (`probes`, by access key id). A bucket none of them is
 * fenced from is written but not verified, and is reported back.
 *
 * @param {object} args
 * @param {{ getBucketPolicy: Function, putBucketPolicy: Function, deleteBucketPolicy: Function }} args.s3 - the infra key's client
 * @param {string} args.ownerId
 * @param {{ bucket: string, deniedAccessKeyIds: string[] }[]} args.targets
 * @param {Record<string, { isDeniedOn(bucket: string): Promise<boolean> }>} [args.probes]
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @param {() => number} [args.now]
 * @returns {Promise<{ written: string[], removed: string[], unverified: string[] }>}
 */
export async function applyHetznerFences({
  s3,
  ownerId,
  targets,
  probes = {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}) {
  const written = [];
  const removed = [];
  const unverified = [];
  for (const { bucket, deniedAccessKeyIds } of targets) {
    const current = await s3.getBucketPolicy(bucket);
    const currentIds = current ? fencedIdsOf(current, bucket, ownerId) : [];
    if (currentIds === null) {
      throw new Error(
        `bucket ${bucket} has a bucket policy vibecarbon did not write, so the app key fence cannot be set on it. Remove that policy in the Hetzner console and deploy again.`,
      );
    }
    const wanted = [...new Set(deniedAccessKeyIds)].sort();
    if (JSON.stringify(currentIds) === JSON.stringify(wanted)) continue;
    if (wanted.length === 0) {
      await s3.deleteBucketPolicy(bucket);
      removed.push(bucket);
      continue;
    }
    await s3.putBucketPolicy(
      bucket,
      renderHetznerFencePolicy({ bucket, ownerId, deniedAccessKeyIds: wanted }),
    );
    written.push(bucket);
    const checkers = wanted.map((id) => probes[id]).filter(Boolean);
    if (checkers.length === 0) {
      unverified.push(bucket);
      continue;
    }
    for (const probe of checkers) await waitForFence({ bucket, probe, sleep, now });
  }
  return { written, removed, unverified };
}
