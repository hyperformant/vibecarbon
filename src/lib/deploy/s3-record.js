/**
 * The env's persisted `s3` block, built in one place so every save (the
 * deploy's skeleton, compose-HA's pending save, the final save) keeps the
 * same field set. A save that rebuilt `s3` by hand once dropped `appKey`,
 * which orphaned a minted key (destroy reads the record to revoke it) and
 * took a pasted Hetzner key out of the fence sync.
 */

/**
 * Rebuilt from s3Config. The fields that only exist in the PRIOR record are
 * carried from it: `bucketCreatedAt` (status' "storage settling" row, the e2e
 * upload gate's clock, null included) and `unfencedBuckets` (status' fence
 * row). The `appKey` record follows appKeyBlock.
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
