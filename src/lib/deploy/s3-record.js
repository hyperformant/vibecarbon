/**
 * The env's persisted `s3` block, built in one place so every save (the
 * deploy's skeleton, compose-HA's pending save, the final save) keeps the
 * same field set. A save that rebuilt `s3` by hand once dropped `appKey`,
 * which orphaned a minted key (destroy reads the record to revoke it) and
 * took a pasted Hetzner key out of the fence sync.
 */

/**
 * Rebuilt from s3Config. The fields that only exist in the PRIOR record are
 * carried from it: `bucketCreatedAt` (the app key fence reads it as proof a
 * deploy finished, null included) and `unfencedBuckets` (status' fence row).
 * The `appKey` record follows appKeyBlock.
 *
 * @param {{ bucket: string, bucketPin?: string, region: string, endpoint: string, stateBucket?: string, stateBucketRegion?: string, stateEndpoint?: string, appKey?: object|null }} s3Config
 * @param {{ bucketCreatedAt?: string|null, appKey?: object, unfencedBuckets?: string[] } | undefined} priorS3
 */
export function envS3Record(s3Config, priorS3) {
  return {
    bucket: s3Config.bucket,
    ...(s3Config.bucketPin && { bucketPin: s3Config.bucketPin }),
    ...(priorS3 &&
      Object.hasOwn(priorS3, 'bucketCreatedAt') && {
        bucketCreatedAt: priorS3.bucketCreatedAt,
      }),
    region: s3Config.region,
    endpoint: s3Config.endpoint,
    stateBucket: s3Config.stateBucket,
    ...(s3Config.stateBucketRegion && { stateBucketRegion: s3Config.stateBucketRegion }),
    ...(s3Config.stateEndpoint && { stateEndpoint: s3Config.stateEndpoint }),
    ...appKeyBlock(s3Config, priorS3),
    ...(Array.isArray(priorS3?.unfencedBuckets) &&
      priorS3.unfencedBuckets.length > 0 && { unfencedBuckets: priorS3.unfencedBuckets }),
  };
}

/**
 * The six fields of the env's persisted `s3` block a Pulumi state-backend read
 * needs (the app bucket, and the dedicated state bucket where one exists), so
 * a command that reaches the deploy's stack builds the backend the deploy
 * used. The caller checks the block exists, adds the credentials, and keeps
 * its own answer to a missing block or missing keys.
 *
 * @param {{ s3: { bucket: string, region: string, endpoint: string, stateBucket?: string, stateBucketRegion?: string, stateEndpoint?: string } }} envConfig
 */
export function stateS3Fields(envConfig) {
  return {
    bucket: envConfig.s3.bucket,
    region: envConfig.s3.region,
    endpoint: envConfig.s3.endpoint,
    stateBucket: envConfig.s3.stateBucket,
    stateBucketRegion: envConfig.s3.stateBucketRegion,
    stateEndpoint: envConfig.s3.stateEndpoint,
  };
}

/**
 * The `appKey` record (R9: `{ id, scoping, tier, bucket }`, never a secret)
 * for an env save. Once this deploy resolved the app credential,
 * `s3Config.appKey` is the truth (null: the shared tier, no record). Before
 * that, the prior record is carried, so a save ahead of the resolve never
 * forgets a minted key that destroy must revoke.
 * @param {{ appKey?: object|null }} s3Config
 * @param {{ appKey?: object } | undefined} priorS3
 */
function appKeyBlock(s3Config, priorS3) {
  if (Object.hasOwn(s3Config, 'appKey')) return s3Config.appKey ? { appKey: s3Config.appKey } : {};
  return priorS3?.appKey ? { appKey: priorS3.appKey } : {};
}
