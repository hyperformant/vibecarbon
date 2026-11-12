/**
 * S3-CONFIG / KEYS MISMATCH — the pre-teardown check for the paired roadmap
 * item (found 2026-07-25 during providers-configure).
 *
 * `envConfig.s3` records the object storage a destroy reaches: the Pulumi
 * stack state every destroy opens, and the buckets a -purge deletes. The
 * credentials for it are never persisted — they come from the environment
 * (or, on a TTY, a prompt). When the config says "there is a bucket" and the
 * environment says nothing, destroy used to walk all the way to the
 * bucket-delete effect, resolve `null` credentials, print one skipped-spinner
 * line, and finish. The bucket kept billing.
 *
 * The effects themselves now record what they could not do: a skipped
 * bucket delete as a leak, a stack state they could not open as unverified
 * (which keeps the entry), so the exit code is already covered. What this
 * adds is TIMING: the check runs
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
 * @param {string} [params.environment] - the environment's name, for the
 *   rerun the stack state line names.
 * @param {string[]} [params.stackEnvs] - the Pulumi stacks whose state this
 *   destroy opens (planDestroyTargets). With `envConfig.s3` recorded, that
 *   state is in object storage, so every destroy needs the keys, -purge or
 *   not: the compose tiers remove it (removePulumiStackStateEffect), and the
 *   k8s tiers run `pulumi destroy` against it (destroyK8sInfraEffect).
 *   Without them that state stays and the environment's entry is kept.
 * @param {boolean} [params.purgeBackups] - the `-purge` flag. Without it
 *   destroy deletes no bucket (it keeps the app bucket with its uploads, the
 *   backups and the state bucket), so only the stack state needs the keys.
 * @param {boolean} [params.appBucketOwned] - the app bucket is this
 *   environment's own (ownsAppBucket): -purge deletes only that one, never a
 *   pinned bucket or an older CLI's per-project one.
 * @param {string[]} [params.backupsHolders] - the other environments that
 *   keep backups in this environment's backups bucket (backupsBucketHolders).
 *   With any, -purge deletes only this environment's folder there.
 * @param {string} [params.backupsPrefix] - that folder,
 *   `backups/<project>/<env>/`.
 * @param {boolean} [params.canPrompt] - true when an interactive prompt can
 *   still supply the keys (a real TTY). Changes the wording only, and keeps
 *   the bucket lines beside the stack state line (see below).
 * @returns {Array<{ resourceClass: string, resource: string, reason: string, hint: string }>}
 *   Leak-risk entries: the stack state when this destroy opens one, then one
 *   per bucket -purge intends to delete (this environment's folder, for a
 *   backups bucket other environments keep backups in).
 */
export function checkS3CredentialMismatch({
  envConfig,
  envKeys,
  env,
  environment = '<env>',
  stackEnvs = [],
  purgeBackups = false,
  appBucketOwned = true,
  backupsHolders = [],
  backupsPrefix = "this environment's folder",
  canPrompt = false,
}) {
  const [accessKeyEnv, secretKeyEnv] = envKeys ?? [];
  if (!accessKeyEnv || !secretKeyEnv) return [];

  const missing = [accessKeyEnv, secretKeyEnv].filter(
    (key) => !readOperatorVar(key, { env }).value,
  );
  if (missing.length === 0) return [];
  const keys = missing.join(' and ');
  const missingPhrase = `${keys} ${missing.length === 1 ? 'is' : 'are'} not set`;

  const buckets = purgeBackups
    ? bucketRisks({
        envConfig,
        appBucketOwned,
        backupsHolders,
        backupsPrefix,
        keys,
        missingPhrase,
        canPrompt,
      })
    : [];
  if (!envConfig?.s3 || stackEnvs.length === 0) return buckets;

  // The stack state, on every destroy that opens one. Without the keys the
  // destroy cannot open it: the compose tiers keep it (unverified
  // pulumi-stack lines), and the k8s tiers' `pulumi destroy` finds an empty
  // stack and is marked unverified. Either way the entry is kept, and that
  // rerun can run, so the hint names it, with -purge when this one has it.
  const rerun = `vibecarbon destroy ${environment}${purgeBackups ? ' -purge' : ''}`;
  // Off a TTY nothing else can supply the keys, so the destroy cannot open
  // the stack state, which keeps the entry (on k8s, whenever the environment
  // records infrastructure: recordPulumiDestroyOutcome), and a kept entry
  // keeps every bucket under -purge (deleteAppBucketEffect,
  // handleBackupBucket). No bucket delete is tried, so none can be skipped,
  // and this one line says what happens to them. On a TTY the prompt may get
  // the keys for the stack state and then be declined for a bucket, so the
  // bucket lines stay.
  const keepsBuckets = !canPrompt && buckets.length > 0;
  const consequence = canPrompt
    ? "destroy will prompt for the credentials; declining the prompt keeps the stack state and the environment's entry in .vibecarbon.json for a rerun"
    : "destroy cannot open it, so the stack state and the environment's entry in .vibecarbon.json are kept for a rerun";
  const state = {
    resourceClass: 'pulumi-stack',
    resource: stackEnvs.join(', '),
    reason:
      `this environment keeps its Pulumi stack state in object storage but ${missingPhrase}: ` +
      consequence +
      (keepsBuckets ? '; -purge keeps its buckets for that rerun too' : ''),
    hint:
      `Set ${keys} (shell or the project's .env.local) before the destroy, so it can open ` +
      `the stack state. If this one runs without them, set them and run \`${rerun}\` again: ` +
      'the kept entry lets that rerun finish.',
  };
  return keepsBuckets ? [state] : [state, ...buckets];
}

/**
 * The buckets a -purge will actually TRY to delete: the app bucket when it
 * is this environment's own, and the backups bucket when a region names the
 * store to ask (one with none is refused before any store is asked). For a
 * backups bucket other environments keep backups in, only this
 * environment's folder is deleted, so that is the line. The dedicated
 * Pulumi state bucket is absent: a plain destroy keeps it
 * (retainStateBucket), and listing it produced a false AT-RISK entry on
 * every credential-less destroy (review finding, 2026-08-15). A -purge of
 * the last environment does delete it, under rules only retainStateBucket
 * applies (a pin, the other environments, a kept entry), and that purge
 * records its own leak, with the console steps, when it has no keys.
 */
function bucketRisks({
  envConfig,
  appBucketOwned,
  backupsHolders,
  backupsPrefix,
  keys,
  missingPhrase,
  canPrompt,
}) {
  // The backups bucket as every reader takes it: its own region (the uploads
  // region for a record an old CLI wrote without one).
  const backups = backupsTargetOf(envConfig);
  const region = envConfig?.s3?.region || backups?.region || null;
  const label = (name, bucketRegion) => (bucketRegion ? `${name} (${bucketRegion})` : name);

  // Never a destroy rerun in these hints: a delete is skipped for want of
  // keys only when the entry moves (a kept entry keeps its buckets for the
  // rerun, deleteAppBucketEffect and handleBackupBucket), so a rerun would
  // find no environment. The leak line that skip writes has the console steps.
  const bucket = (resource) => ({
    resourceClass: 'bucket',
    resource,
    reason:
      `this environment records an object-storage bucket but ${missingPhrase}: ` +
      (canPrompt
        ? 'destroy will prompt for the credentials; declining the prompt leaves the bucket in place, still billing'
        : 'the delete will be skipped and the bucket will survive, still billing'),
    hint: `If its delete is skipped, the leak report gives the console steps for it. Next time, set ${keys} (shell or the project's .env.local) before the destroy, so it can delete the bucket itself.`,
  });

  const targets = [];
  const appBucket = envConfig?.s3?.bucket;
  if (appBucket && appBucketOwned) targets.push(bucket(label(appBucket, region)));
  if (backups?.region && backupsHolders.length === 0) {
    targets.push(bucket(label(backups.bucket, backups.region)));
  }
  if (backups?.region && backupsHolders.length > 0) {
    const verb = backupsHolders.length === 1 ? 'keeps' : 'keep';
    targets.push({
      resourceClass: 'bucket',
      resource: `${backupsPrefix} in ${label(backups.bucket, backups.region)}`,
      reason:
        `this environment keeps its backups in a bucket where ${backupsHolders.join(', ')} ` +
        `${verb} backups too, but ${missingPhrase}: ` +
        (canPrompt
          ? "destroy will prompt for the credentials; declining the prompt leaves this environment's backups there, still billing"
          : "the delete will be skipped and this environment's backups stay there, still billing"),
      hint: `If the delete is skipped, the leak report gives the console steps for it. Next time, set ${keys} (shell or the project's .env.local) before the destroy, so it can delete this environment's backups itself.`,
    });
  }
  return targets;
}
