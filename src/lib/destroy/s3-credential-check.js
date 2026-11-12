/**
 * S3-CONFIG / KEYS MISMATCH — the pre-teardown check for the paired roadmap
 * item (found 2026-07-25 during providers-configure).
 *
 * `envConfig.s3` records WHICH buckets a destroy must delete. The credentials
 * to delete them with are never persisted — they come from the environment
 * (or, on a TTY, a prompt). When the config says "there is a bucket" and the
 * environment says nothing, destroy used to walk all the way to the
 * bucket-delete effect, resolve `null` credentials, print one skipped-spinner
 * line, and finish. The bucket kept billing.
 *
 * The bucket effects themselves now record that skip as a real leak, so the
 * exit code is already covered. What this adds is TIMING: the check runs
 * before the teardown starts, while supplying the missing key is still cheap
 * and the servers are still alive. Its entries are leak-RISK — reported, not
 * exit-failing; the justification for that split is in leak-ledger.js's
 * destroyExitCode doc.
 *
 * Pure by construction (env and provider key names are injected) so the matrix
 * of bucket combinations is unit-testable without touching process.env. The
 * key reads go through `readOperatorVar` with that injected env, so a
 * quoted/padded paste counts as present exactly when the destroy's own
 * credential resolution would see it.
 */

import { backupsTargetOf } from '../backups-bucket.js';
import { readOperatorVar } from '../operator-env.js';

/**
 * @param {object} params
 * @param {object} params.envConfig - persisted environment config.
 * @param {string[]} params.envKeys - the provider's
 *   `[accessKeyEnv, secretKeyEnv]` pair (`Provider.OBJECT_STORAGE_ENV`). An
 *   empty pair means the provider declares no env-based credentials, so there
 *   is no mismatch to detect.
 * @param {Record<string, string|undefined>} [params.env] - environment to read
 *   (defaults to the process env inside the reader).
 * @param {boolean} [params.purgeBackups] - the `-purge` flag. Without it
 *   destroy keeps every bucket (the app bucket with its uploads, the backups
 *   and the state bucket), so no credentials are needed and nothing is at risk.
 * @param {boolean} [params.appBucketOwned] - the app bucket is this
 *   environment's own (ownsAppBucket): -purge deletes only that one, never a
 *   pinned bucket or an older CLI's per-project one.
 * @param {boolean} [params.canPrompt] - true when an interactive prompt can
 *   still supply the keys (a real TTY). Changes the wording only.
 * @returns {Array<{ resourceClass: string, resource: string, reason: string, hint: string }>}
 *   Leak-risk entries, one per bucket destroy intends to delete.
 */
export function checkS3CredentialMismatch({
  envConfig,
  envKeys,
  env,
  purgeBackups = false,
  appBucketOwned = true,
  canPrompt = false,
}) {
  const [accessKeyEnv, secretKeyEnv] = envKeys ?? [];
  if (!accessKeyEnv || !secretKeyEnv) return [];

  const missing = [accessKeyEnv, secretKeyEnv].filter(
    (key) => !readOperatorVar(key, { env }).value,
  );
  if (missing.length === 0) return [];

  // The backups bucket as every reader takes it: its own region (the uploads
  // region for a record an old CLI wrote without one).
  const backups = backupsTargetOf(envConfig);
  const region = envConfig?.s3?.region || backups?.region || null;
  const label = (name, bucketRegion) => (bucketRegion ? `${name} (${bucketRegion})` : name);

  /**
   * Only buckets this destroy will actually TRY to delete, which is none
   * without -purge. Under -purge: the app bucket when it is this
   * environment's own, and the backups bucket when a region names the store
   * to ask (one with none is refused before any store is asked). The
   * dedicated Pulumi state bucket is absent: a plain destroy keeps it
   * (retainStateBucket), and listing it produced a false AT-RISK entry on
   * every credential-less destroy (review finding, 2026-08-15). A -purge of
   * the last environment does delete it, under rules only retainStateBucket
   * applies (a pin, the other environments, a kept entry), and that purge
   * records its own leak, with the console steps, when it has no keys.
   */
  if (!purgeBackups) return [];
  const targets = [];
  const appBucket = envConfig?.s3?.bucket;
  if (appBucket && appBucketOwned) targets.push(label(appBucket, region));
  if (backups?.region) targets.push(label(backups.bucket, backups.region));
  if (targets.length === 0) return [];

  const missingPhrase = `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set`;
  const consequence = canPrompt
    ? 'destroy will prompt for the credentials; declining the prompt leaves the bucket in place, still billing'
    : 'the delete will be skipped and the bucket will survive, still billing';

  return targets.map((resource) => ({
    resourceClass: 'bucket',
    resource,
    reason: `this environment records an object-storage bucket but ${missingPhrase}: ${consequence}`,
    // Never a destroy rerun: by the time the leak report shows this, the
    // environment has moved to destroyedEnvironments and a rerun finds none.
    hint: `If its delete is skipped, the leak report gives the console steps for it. Next time, set ${missing.join(' and ')} (shell or the project's .env.local) before the destroy, so it can delete the bucket itself.`,
  }));
}
