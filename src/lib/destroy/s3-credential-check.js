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
 * of bucket combinations is unit-testable without touching process.env.
 */

/**
 * @param {object} params
 * @param {object} params.envConfig - persisted environment config.
 * @param {string[]} params.envKeys - the provider's
 *   `[accessKeyEnv, secretKeyEnv]` pair (`Provider.OBJECT_STORAGE_ENV`). An
 *   empty pair means the provider declares no env-based credentials, so there
 *   is no mismatch to detect.
 * @param {Record<string, string|undefined>} [params.env] - environment to read.
 * @param {boolean} [params.purgeBackups] - the `-purge` flag. Without it the
 *   backup bucket is deliberately preserved and its credentials are irrelevant.
 * @param {boolean} [params.canPrompt] - true when an interactive prompt can
 *   still supply the keys (a real TTY). Changes the wording only.
 * @returns {Array<{ resourceClass: string, resource: string, reason: string, hint: string }>}
 *   Leak-risk entries, one per bucket destroy intends to delete.
 */
export function checkS3CredentialMismatch({
  envConfig,
  envKeys,
  env = process.env,
  purgeBackups = false,
  canPrompt = false,
}) {
  const [accessKeyEnv, secretKeyEnv] = envKeys ?? [];
  if (!accessKeyEnv || !secretKeyEnv) return [];

  const missing = [accessKeyEnv, secretKeyEnv].filter((key) => !env?.[key]);
  if (missing.length === 0) return [];

  const region = envConfig?.s3?.region || envConfig?.backupS3?.region || null;
  const label = (name, bucketRegion) => (bucketRegion ? `${name} (${bucketRegion})` : name);

  /**
   * Only buckets this destroy will actually TRY to delete. The dedicated
   * Pulumi state bucket is deliberately absent: destroy KEEPS it now
   * (retainStateBucket), so listing it here produced a false AT-RISK ledger
   * entry — and wrong advice — on every credential-less destroy (review
   * finding, 2026-08-15).
   */
  const targets = [];
  const appBucket = envConfig?.s3?.bucket;
  if (appBucket) targets.push(label(appBucket, region));
  const backupBucket = envConfig?.backupS3?.bucket;
  if (purgeBackups && backupBucket) {
    targets.push(label(backupBucket, envConfig?.backupS3?.region || region));
  }
  if (targets.length === 0) return [];

  const missingPhrase = `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set`;
  const consequence = canPrompt
    ? 'destroy will prompt for the credentials; declining the prompt leaves the bucket in place, still billing'
    : 'the delete will be skipped and the bucket will survive, still billing';

  return targets.map((resource) => ({
    resourceClass: 'bucket',
    resource,
    reason: `this environment records an object-storage bucket but ${missingPhrase}: ${consequence}`,
    hint: `Export ${missing.join(' and ')} (shell or the project's .env.local) and re-run the destroy.`,
  }));
}
