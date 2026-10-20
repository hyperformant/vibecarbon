# One App Bucket Per Project Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop creating object-storage buckets on every redeploy. Each project gets one long-lived app bucket, and each environment writes under its own `<env>/` key prefix. Destroy deletes only that prefix, and `-purge` of the last live environment deletes the bucket. A new bucket's first deploy waits on real consistency evidence before it reports success.

**Architecture:**
- **One bucket per project.** `deriveProjectBucketName(projectConfig)` loses the `storageBucketGeneration` segment and becomes the one stable project name, `<project>-<salt>-storage`.
- **One resolver.** A new `resolveEnvStorage(envName, envConfig, projectConfig)` returns `{ bucket, keyPrefix, backupBucket, walgPrefix }`. Every consumer reads it through `gatheredConfig.s3Config`, as it reads `resolveEnvBucketNames` today:
  - the server `.env` and the k8s Secret;
  - CORS;
  - destroy;
  - the template app, which applies `S3_KEY_PREFIX` at its S3 boundary, so the keys stored in the database stay env-independent.
- **CORS is per bucket**, so a deploy merges its origin into the rule's origin list, and destroy removes it.
- **The settle window is a provider-declared property** (`static bucketSettleWindowMs` on each S3 provider class): Hetzner 20 minutes, every other provider 0. A 0 window means no settle code runs at all: no creation-time read, no note, no status row, no e2e probes.
- **The deploy never waits for a new bucket to settle.** On a provider with a non-zero window it records the bucket's creation time on the env (`s3.bucketCreatedAt`). When the bucket is younger than that window, the deploy ends with a one-line note, and `vibecarbon status` shows "storage settling" until the window has passed. Only verification waits: the e2e upload check runs the settle gate (3 consecutive clean rounds of fresh-connection probes, matching the 2026-10-20 settle probe: 58/60, then 60/60 three times, then settled) before it uploads.

**Tech Stack:** Node ESM CLI (`src/`), `@aws-sdk/client-s3`, vitest (root: pnpm), Hono template app (`carbon/`, npm), docker compose and k3s manifests.

**Spec:** No spec file. The decision is the item 1 recommendation agreed in conversation on 2026-10-20 ("stop creating buckets in the deploy path"; Brandon: "Go ahead"). The evidence lives in two places:
- the session scratchpad: `restore-bucket-report.md`, `cors-probe.txt` (about 40% preflight 403 on a minutes-old bucket) and `cors-settle.txt` (clean about 16 minutes after create);
- memory `drop-supabase-lean-graphite.md` (the Hetzner new-bucket window).

Rulings made without a spec file are provisional and are recorded below.

## Rulings (made while planning)

- **R1, the backup bucket follows the same model, with one fix.**
  - It is already long-lived and per project: a stable `<project>-<salt>-backups` name, never rotated, preserved by plain destroy.
  - What it lacks is env isolation. `WALG_S3_PREFIX` is `s3://<bucket>/backups/<project>/walg` at `carbon/docker-compose.yml:225` and `src/lib/deploy/k8s/k3s.js:2496`, so two environments of one project push WAL into the same prefix.
  - Task 6 makes it `backups/<project>/<env>/walg`.
  - `-purge` deletes that env's prefix, and deletes the backup bucket only when no other live environment remains.
  - Cost if wrong: existing deployments' backups sit at the old prefix after a redeploy (see Compatibility).
- **R2, creation stays in the `s3-setup` step** (`src/lib/deploy/orchestrator.js:573-620`), not in the credential prompt.
  - `s3-setup` is already the first provider-side write of a deploy, seconds after `verifyObjectStorageKeys` (`src/lib/deploy/prompts.js:446`).
  - Moving it into the prompt phase would put a side effect in code that previews and cancels run through.
  - The window is closed by not recreating buckets and by the gate, not by a few seconds of extra age.
  - Cost if wrong: none observable.
- **R3, the e2e harness does NOT pin the app bucket** (unlike `pinSharedStateBucket`, `tests/e2e/scenarios/_run-lifecycle.ts:2586`).
  - Every scenario creates a new project, so every cold deploy exercises the young-bucket path on real infra (the note, the status row, and the e2e check's settle gate): the customer first-deploy path.
  - The destroy, redeploy and restore leg now reuses the warm bucket, which is the leg that failed on 2026-10-20.
  - Cost if wrong: the e2e verify step after each cold deploy can wait out the tail of the window, a few minutes. The deploy itself does not (R5).
- **R4, a live env whose persisted `s3.bucket` is not the project bucket fails closed.** Deploy stops and prints the one-off steps; it does not silently re-point the env at an empty bucket (see Compatibility). This is a guard, not migration code.
- **R6, the settle window is declared per provider, and only evidence makes it non-zero** (Brandon, 2026-10-20: the new-bucket window is Hetzner-specific, and other providers must not pay for it).
  - Each `S3CompatibleProvider` subclass declares `static bucketSettleWindowMs` as its own property. `S3CompatibleProvider` itself declares none, so a missing declaration is a census failure, not a silent default.
  - `HetznerS3Provider.bucketSettleWindowMs = 20 * 60_000`, with a comment citing the 2026-10-20 probes (about 40% CORS preflight 403 and some NoSuchBucket on a minutes-old bucket; 58/60 then 60/60 three times, settled about 16 minutes after create).
  - `DigitalOceanSpacesProvider`, `LinodeObjectStorageProvider`, `ScalewayObjectStorageProvider`, `VultrObjectStorageProvider`: `0`, with a one-line comment that no settle window has been observed.
  - With `0`, the deploy makes no `listBuckets` call for the creation time, persists no `s3.bucketCreatedAt`, prints no note, status shows no row, and the e2e upload check never calls the gate (zero probes, zero delay).
  - Cost if wrong: a provider with an unobserved window keeps today's behaviour (intermittent uploads right after a cold deploy) until probes justify a value.
- **R7, no new per-deploy cost on the critical path for any provider.** Audit of everything this plan adds to deploy, status and destroy:
  - Creation-time read (`listBuckets`): Hetzner only (R6), and it runs inside the concurrent CORS task below, not in line.
  - CORS read-before-write (`GetBucketCors` then `PutBucketCors`, Task 3): needed on every provider, because the rule is now shared across environments and a blind PUT would drop the other environments' origins. It moves off the critical path: `applyAppBucketCors` is started as a concurrent task right after `s3-setup` and awaited just before the success outro, so its two round trips overlap provisioning. When the merged origin list equals the existing one (every warm redeploy), the PUT is skipped, so a redeploy costs one GET where today it costs one PUT.
  - Destroy: `deletePrefix` replaces `emptyAndDeleteBucket` (list plus batch delete either way). The "is this the last live env" decision reads `.vibecarbon.json` only, no API call.
  - Status: the settling row is computed from the persisted timestamp and the provider's static window, with no network call.
  - WAL-G per-env prefix and the app's `S3_KEY_PREFIX`: no API calls.
  - Cost if wrong: if the concurrent CORS task fails late, the deploy reports it at the outro instead of early; the warn-and-skip-PUT rule from Task 3 is unchanged.
- **R5, the deploy never awaits the settle gate** (replaces the earlier "await before success, warn when exhausted" design; Brandon, 2026-10-20: compose cold deploys must finish in under 3 minutes).
  - A first deploy on a fast link finishes in about 2-4 minutes, well inside the ~16-minute window, so awaiting the gate would set the cold-deploy time to the window.
  - Nothing on a freshly deployed app uploads in its first minutes, so the cost of not waiting is a short stretch where a browser upload may fail.
  - The recorded state is the creation time alone, `envConfig.s3.bucketCreatedAt` (ISO string). There is no `settled` flag: no process stays alive after the deploy to set one honestly, and a flag set by age alone would duplicate the timestamp.
  - `vibecarbon status` is age-based and makes no network calls for this row: younger than the provider's `bucketSettleWindowMs` shows `storage settling (about N min left)`, older shows nothing extra. An unknown creation time (`null`) shows `storage settling` until a redeploy records one.
  - The deploy ends with one line when the bucket is young: `new storage bucket, browser uploads can fail for about N more minutes while it settles; vibecarbon status shows when it is done`.
  - Verification keeps a bounded wait: the e2e upload check calls `waitForBucketSettled` with `BUCKET_SETTLE_BUDGET_MS` before uploading, and fails with the last round's failures if the budget runs out.
  - Cost if wrong: an operator who uploads within the first ~16 minutes of a brand-new project can see an intermittent upload failure, with the note and the status row explaining it.

## Global Constraints

- No customers: no migration code for old buckets, prefixes or the `storageBucketGeneration` key. Projects holding that key simply ignore it. Ship with a Compatibility note in the PR body and no `!:` footer.
- No retry ladders. The gate waits for consistency evidence: 3 consecutive clean rounds, where any failure resets the streak, within a fixed budget. It does not retry consumers.
- Gate constants, exported from one module:
  - No module-level window constant: the window is each provider class's `static bucketSettleWindowMs` (R6).
  - `BUCKET_SETTLE_ROUND_SIZE = 20`
  - `BUCKET_SETTLE_STREAK = 3`
  - `BUCKET_SETTLE_ROUND_INTERVAL_MS = 30_000`
  - `BUCKET_SETTLE_BUDGET_MS = 25 * 60_000`
- CORS never contains `*` (`setBucketCors` already refuses it). A domainless env contributes `http://localhost:3000` and `http://localhost:5173`, as today.
- The key prefix is exactly `<env>/`, with the env name already validated by `ENV_NAME_FORMAT`. The env var is `S3_KEY_PREFIX`.
- dotenv writes only through `formatDotenvLine`. The bundle's `envOverrides` rewriter is the existing allow-listed site.
- Conventional commits, pathspec commits (`git commit -- <files>`), never `--no-verify`. Root uses pnpm, `carbon/` uses npm.
- Never print secret values in logs, tests or the PR.

## Review Focus

1. **Two live envs in one project** (prod plus staging): destroying staging leaves prod's objects and prod's CORS origin intact. Today both envs derive the same bucket name and destroy deletes the whole bucket. This is a latent data-loss bug the change fixes. Test in Task 4.
2. **Redeploy of a live env deployed before this change** (persisted `s3.bucket` is `…-storage-<gen>`): deploy fails closed with the steps from R4. It never silently uses a new empty bucket. Test in Task 2.
3. **A provider with a 0 settle window (DigitalOcean, Linode, Scaleway, Vultr), a Hetzner bucket older than 20 minutes, or unreadable creation-date metadata.** With a 0 window: zero `listBuckets` calls, no `s3.bucketCreatedAt`, no note, no status row, zero e2e probes. An old Hetzner bucket gets no note, no row and no probes. An unknown Hetzner age (`null`) is treated as young: the note and row appear, and the e2e gate runs. Tests in Task 5.
4. **First deploy domainless, second with a domain.** The CORS origins become the union of localhost and `https://<domain>`. Destroying the env removes only what it contributed, and the PUT never receives an empty list: the rule is deleted instead. Test in Task 3.
5. **A deploy against a brand-new bucket** finishes without any settle wait: zero probe calls from the orchestrator, one note line, and `s3.bucketCreatedAt` persisted. An exhausted gate in the e2e check returns `{ settled: false, rounds, lastFailures }` within the budget and does not hang. Tests in Task 5.

## File Map

- `src/lib/providers/s3-base.js`:
  - `deriveProjectBucketName`: drop the generation branch.
  - New `getBucketCorsOrigins`, `deletePrefix`, `bucketCreatedAt`. No `bucketSettleWindowMs` on the base class.
- `src/lib/providers/{hetzner-s3,digitalocean-spaces,linode-objectstorage,scaleway-objectstorage,vultr-objectstorage}.js`: `static bucketSettleWindowMs` (R6).
- `src/lib/deploy/prompts.js`: `resolveEnvBucketNames` is replaced by `resolveEnvStorage`.
- `src/lib/deploy/orchestrator.js`:
  - `applyAppBucketCors` becomes a merge, started concurrently after s3-setup and awaited before the outro (R7);
  - persist `s3.bucketCreatedAt` and print the young-bucket note before the success outro (no gate, no wait);
  - persist `s3.keyPrefix`.
- New `src/lib/deploy/bucket-settle.js`: the gate.
- `src/lib/deploy/bundle.js`: the `S3_KEY_PREFIX` override.
- `src/lib/deploy/k8s/k3s.js`: the Secret `S3_KEY_PREFIX` and `WALG_S3_PREFIX` with env.
- `carbon/docker-compose.yml`: `WALG_S3_PREFIX` with `${VC_ENV}`. The bundle also writes `VC_ENV`.
- `src/destroy.js`:
  - prefix delete, CORS origin removal, last-env bucket delete;
  - remove the generation rotation;
  - per-env backup prefix purge.
- `src/create.js`: stop seeding `storageBucketGeneration`.
- `src/lib/destroy/preview.js`: wording and fields.
- `src/status.js`: the age-based `storage settling` row (R5).
- `carbon/src/server/lib/env.ts`, `carbon/src/server/lib/storage.ts`, `carbon/.env.example`: the prefix.
- `tests/e2e/checks/app-functional.ts`, `tests/e2e/utils/classify-failure.ts`: assertions.
- Tests: listed per task. New census `tests/unit/deploy/app-bucket-single-resolver-census.test.ts`.

---

### Task 1: Stable project bucket name, generation removed

**Files:**
- Modify: `src/lib/providers/s3-base.js:1105-1129` (`deriveProjectBucketName`), `src/create.js:1341-1366`, `src/destroy.js:1385-1402`.
- Delete: `tests/unit/providers/storage-bucket-generation.test.ts`. The commit justification: generation rotation is removed by design, and Task 4's tests replace it.
- Modify: `tests/unit/destroy/update-project-config-effect.test.ts:204-250` (replace the rotation describe), `tests/unit/s3/bucket-naming.test.ts`.

**Interfaces:**
- Produces: `deriveProjectBucketName(projectConfig, suffix = 'storage') -> string`. It returns `<project>-<salt>-<suffix>`, or `<project>-<suffix>` with no salt, and ignores `storageBucketGeneration`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/s3/bucket-naming.test.ts`.
  - `it('derives one stable storage name regardless of storageBucketGeneration')`: `deriveProjectBucketName({ projectName: 'myapp', bucketSalt: 'cd9ecc', storageBucketGeneration: 'f00d42' })` returns `'myapp-cd9ecc-storage'`.
  - The same input with suffix `'backups'` returns `'myapp-cd9ecc-backups'`.
  - In the update-project-config test: `it('never writes storageBucketGeneration')`. A ctx with `results.s3Bucket = 'proj-a1b2c3-storage'` and `storageBucketGeneration: 'aaaaaa'` saves a config whose `storageBucketGeneration` is still `'aaaaaa'`; the key is untouched, with no migration.
  - In a create test (the existing source-shape test from the deleted file moves here): `src/create.js` does not match `/storageBucketGeneration/`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/s3/bucket-naming.test.ts tests/unit/destroy/update-project-config-effect.test.ts`. Expected: FAIL on the generation segment.
- [ ] **Step 3: Implement.**
  - Delete the generation branch and its comment block in `deriveProjectBucketName`.
  - Delete the seeding at `create.js:1366` and its comment.
  - Delete the rotation at `destroy.js:1385-1402`, replacing the comment with one line: the app bucket is never recreated, so there is nothing to rotate.
  - The `retainedStateBucket` comment at `destroy.js:1138-1143` and `orchestrator.js:466` mentions the rotation. Reword it to say the state name stays stable.
- [ ] **Step 4: Run the same command, plus `pnpm vitest run tests/unit/iac/state-bucket.test.ts`.** Expected: PASS. Fix `state-bucket.test.ts:183`'s comment or expectation if it asserted the rotation.
- [ ] **Step 5: Commit** `refactor(storage): one stable app bucket name per project`.

### Task 2: `resolveEnvStorage`, the single resolver

**Files:**
- Modify: `src/lib/deploy/prompts.js:470-500` and its call at `:984`.
- Test: `tests/unit/deploy/resolve-env-storage.test.ts` (new).

**Interfaces:**
- Consumes: `deriveProjectBucketName` (Task 1).
- Produces:
  ```
  resolveEnvStorage(envName: string, envConfig: object, projectConfig: object)
    -> { bucket: string, keyPrefix: string, backupBucket: string, walgPrefix: string }
  ```
  - `bucket = deriveProjectBucketName(projectConfig)`;
  - `keyPrefix = \`${envName}/\``;
  - `backupBucket = envConfig.backupS3?.bucket || deriveProjectBucketName(projectConfig, 'backups')`;
  - `walgPrefix = \`backups/${projectConfig.projectName}/${envName}/walg\``.
  - Throws `StorageBucketMismatchError` (exported) when `envConfig.s3?.bucket` is set and `!== bucket`.
- `gatheredConfig.s3Config` gains `keyPrefix` and `walgPrefix`. `resolveEnvBucketNames` is deleted, and every importer switches over.

- [ ] **Step 1: Write the failing tests.**
  - The derived values for `('staging', {}, { projectName: 'myapp', bucketSalt: 'cd9ecc' })`:
    - `bucket` is `'myapp-cd9ecc-storage'`;
    - `keyPrefix` is `'staging/'`;
    - `backupBucket` is `'myapp-cd9ecc-backups'`;
    - `walgPrefix` is `'backups/myapp/staging/walg'`.
  - Two env names give the same `bucket` and different `keyPrefix`.
  - A persisted `backupS3.bucket` wins for `backupBucket`.
  - Review Focus 2: `envConfig.s3.bucket = 'myapp-cd9ecc-storage-93872b'` throws `StorageBucketMismatchError`.
    - The message contains both bucket names, the string `"appBucket"`, and `aws s3 mv`.
    - It contains no access key, since it is built from names only.
  - A persisted `envConfig.s3.bucket` equal to the derived name does not throw.
  - `projectConfig.appBucket` (an explicit project pin, string) wins over derivation for `bucket`. It is the escape hatch the error message names.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/resolve-env-storage.test.ts`. Expected: FAIL (not exported).
- [ ] **Step 3: Implement** in `prompts.js`.
  - The full resolution order for `bucket` is `projectConfig.appBucket` then derivation. A persisted env name never overrides it; a mismatch throws (R4).
  - Catch `StorageBucketMismatchError` at the call site, print it through `p.log.error`, and `process.exit(1)` before any provider write.
  - Update the `destroy-redeploy-bucket-flow.test.ts` import (Task 4 rewrites its assertions).
- [ ] **Step 4: Run** `pnpm vitest run tests/unit/deploy`. Expected: PASS, except the flow test Task 4 owns. Mark that one `it.todo` only if it now fails solely on the rotation assertion, and say so in the report.
- [ ] **Step 5: Commit** `feat(storage): resolve each environment's bucket, key prefix and backup prefix in one place`.

### Task 3: CORS origins merge per bucket

**Files:**
- Modify: `src/lib/providers/s3-base.js:906-935`, `src/lib/deploy/orchestrator.js:217-256` and `:770-781`.
- Test: `tests/unit/providers/s3-bucket-cors.test.ts`, `tests/unit/deploy/app-bucket-cors-merge.test.ts` (new).

**Interfaces:**
- Produces:
  - `S3CompatibleProvider#getBucketCorsOrigins(bucket) -> Promise<string[]>`. It returns `[]` on `NoSuchCORSConfiguration` or a 404, and throws on any other error.
  - `S3CompatibleProvider#deleteBucketCors(bucket) -> Promise<void>`.
  - `mergeCorsOrigins(existing: string[], add: string[], remove: string[] = []) -> string[]`: deduped and sorted, exported from `orchestrator.js`.
  - `applyAppBucketCors({ createProvider, bucket, domain, spin, log })` keeps its signature and now writes the merge of existing and this env's origins.
  - New `removeAppBucketCorsOrigins({ provider, bucket, origins }) -> Promise<void>`: deletes the rule when the result is empty.

- [ ] **Step 1: Write the failing tests.**
  - `mergeCorsOrigins(['https://a.dev'], ['https://b.dev'])` returns `['https://a.dev','https://b.dev']`.
  - Re-adding an existing origin is a no-op.
  - `remove` drops only the named origins.
  - Review Focus 4: `mergeCorsOrigins(['http://localhost:3000','http://localhost:5173'], ['https://e1.dev'])` keeps all three.
  - Removal down to `[]` makes `removeAppBucketCorsOrigins` call `deleteBucketCors`, not `setBucketCors([])`.
  - `applyAppBucketCors`, with a fake provider whose `getBucketCorsOrigins` resolves `['https://prod.dev']`, calls `setBucketCors(bucket, ['https://prod.dev','https://staging.dev'])` for domain `staging.dev`.
  - A `getBucketCorsOrigins` throw: warn and do not PUT. A PUT on a failed read would drop the other envs' origins. The assertion is that the warn text contains `bucket`.
  - R7: when the existing origins already contain this env's origins, `setBucketCors` is not called (one GET, zero PUTs).
  - R7: the orchestrator starts `applyAppBucketCors` without awaiting it before the IaC step, and awaits it before the success outro. Test with a fake whose `getBucketCorsOrigins` resolves only after the fake IaC step has started; assert the IaC step started before the CORS promise settled, and that the outro waited for it.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/providers/s3-bucket-cors.test.ts tests/unit/deploy/app-bucket-cors-merge.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `GetBucketCorsCommand` and `DeleteBucketCorsCommand`. Move the `applyAppBucketCors` call at `orchestrator.js:770-781` to a promise started there and awaited next to the Task 5 note, before the outro (`:1800-1840`); its failure is reported there. Read the error name with the same shape `isTransientS3Error` uses.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(storage): environments share the bucket CORS rule by origin`.

### Task 4: Env-scoped consumers and env-scoped destroy

**Files:**
- Modify: `src/lib/deploy/bundle.js:354-366`: add `envOverrides.S3_KEY_PREFIX = options.s3.keyPrefix` and `envOverrides.VC_ENV = options.environment`. Thread `environment` through `renderBundle`'s options from `orchestrator.js:976`.
- Modify: `src/lib/deploy/k8s/k3s.js:1873`: `stringData.S3_KEY_PREFIX = s3Config.keyPrefix`.
- Modify: `orchestrator.js` persist blocks `:531` and `:1832`: write `s3.keyPrefix`.
- Modify: `src/destroy.js:1236-1300` (`deleteAppBucketEffect`).
  - Delete objects under `envConfig.s3.keyPrefix` with `deletePrefix`.
  - Remove this env's CORS origins: `https://<domain>`, or the localhost pair when there is no domain.
  - Then, only when `args.purgeBackups` is set and no other key in `projectConfig.environments` remains, call `emptyAndDeleteBucket`.
  - A non-last or non-purge destroy reports `S3 objects deleted under <prefix> (N objects); bucket kept for <k> other environment(s)` or `…; bucket kept for reuse (delete with -purge)`.
  - An env with no `keyPrefix` persisted (pre-change) and a matching bucket name: delete nothing, and log that its objects were written before per-env prefixes. Not a leak, so no ledger entry.
  - `results.s3Bucket` is set only when the bucket itself was deleted. Add `results.s3Prefix`.
- Modify: `src/lib/destroy/preview.js:95`: `Bucket: <bucket>, objects under <prefix> (bucket deleted only with -purge when no other environment uses it)`.
- Modify: `src/status.js:1046`: show `<bucket>/<prefix>`.
- Add: `S3CompatibleProvider#deletePrefix(bucket, prefix) -> Promise<{ objectsRemoved: number }>`. It pages `ListObjectsV2` with `Prefix`, deletes in batches of 1000 with `DeleteObjects`, and refuses an empty, `/`-only, or non-`/`-terminated prefix by throwing.
- Rewrite: `tests/unit/deploy/destroy-redeploy-bucket-flow.test.ts`: destroy then redeploy resolves the SAME bucket and the same `keyPrefix`.
- Tests: `tests/unit/destroy/app-bucket-env-scope.test.ts` (new), `tests/unit/providers/s3-delete-prefix.test.ts` (new), and the bundle and k3s secret tests that enumerate overrides (`bundle-env-overrides`).

**Interfaces:**
- Consumes: `resolveEnvStorage` (Task 2), `removeAppBucketCorsOrigins` (Task 3).

- [ ] **Step 1: Write the failing tests.**
  - Review Focus 1: a project with `environments: { prod: {...s3:{bucket:B,keyPrefix:'prod/'}}, staging: {...s3:{bucket:B,keyPrefix:'staging/'}} }`. Destroying `staging` with `purgeBackups: true` calls `deletePrefix(B,'staging/')`, never calls `emptyAndDeleteBucket`, and removes only `https://staging.dev` from CORS.
  - The same project, after prod alone remains, with `-purge`, calls `emptyAndDeleteBucket(B)`.
  - The last env without `-purge` calls `deletePrefix` only.
  - `deletePrefix(B,'')`, `deletePrefix(B,'/')` and `deletePrefix(B,'prod')` each throw.
  - A 2,500-object listing deletes in 3 batches.
  - The bundle override test: `.env` contains `S3_KEY_PREFIX=staging/` and `VC_ENV=staging`.
  - The k3s secret test: `stringData.S3_KEY_PREFIX === 'prod/'`.
  - The flow test: after destroy, `resolveEnvStorage('e1', seed, afterDestroy).bucket === resolveEnvStorage('e1', live, before).bucket`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/destroy tests/unit/providers tests/unit/deploy`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run the same command, then `pnpm test:unit`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(storage): destroy removes one environment's objects and keeps the shared bucket`.

### Task 5: The bucket settle gate, used by verification only

**Files:**
- Create: `src/lib/deploy/bucket-settle.js`.
- Modify: `src/lib/providers/s3-base.js`: add `bucketCreatedAt(bucket) -> Promise<Date|null>`, built from `listBuckets()` `creationDate` (`:291-296`), returning null on any error.
- Modify: `src/lib/deploy/orchestrator.js`.
  - Inside the concurrent CORS task (R7), and only when the provider class's `bucketSettleWindowMs > 0`, read `bucketCreatedAt` once and persist it as `envConfig.s3.bucketCreatedAt` (ISO string, or `null`) with the rest of the env's `s3` block. With a 0 window, do not call it and do not write the field.
  - Immediately before the success outro (`:1800-1840`), when `storageSettleStatus(createdAt, Date.now(), windowMs).settling` is true, print the R5 note with `p.log.info`. Never call `waitForBucketSettled` or any probe here.
- Modify: `src/status.js`: render the R5 `storage settling (about N min left)` row from `storageSettleStatus`, with the window read from the env provider's S3 class (`getObjectStorageProviderClass()`, a local import). No network call for this row; no row at all for a 0 window.
- Modify: the five S3 provider classes listed in the File Map: `static bucketSettleWindowMs` per R6.
- Create: `tests/unit/providers/bucket-settle-window-census.test.ts`.
- Modify: `tests/e2e/checks/app-functional.ts` (the upload check, `:890-1035`): before the first upload, read the env provider's `bucketSettleWindowMs`; when it is 0, skip the gate entirely (no import of the probe round, zero requests, zero delay). Otherwise, when `bucketNeedsSettle` is true for the env's `s3.bucketCreatedAt`, run `waitForBucketSettled` with `makeAppBucketProbeRound` and `BUCKET_SETTLE_BUDGET_MS`. On `{settled:false}` the check fails with the bucket name, its age, and `lastFailures`. Put the rounds and elapsed seconds in the check's detail.
- Test: `tests/unit/deploy/bucket-settle.test.ts` (new), `tests/unit/deploy/deploy-never-awaits-bucket-settle.test.ts` (new), and the status row in the existing status render test.

**Interfaces:**
- Produces:
  - The constants from Global Constraints.
  - `bucketNeedsSettle(createdAt: Date|null, now: number, windowMs: number) -> boolean`. Always false when `windowMs === 0`. Otherwise true when `createdAt` is null or `now - createdAt < windowMs`.
  - `storageSettleStatus(createdAt: Date|string|null, now: number, windowMs: number) -> { settling: boolean, remainingMs: number|null }`. With `windowMs === 0` it is `{ settling: false, remainingMs: 0 }` regardless of `createdAt`. Otherwise `remainingMs` is `null` when `createdAt` is null, `0` once settled.
  - `settleWindowFor(providerId: string) -> Promise<number>`: reads `bucketSettleWindowMs` off the provider's S3 class via `getObjectStorageProviderClass()`; throws if the class does not declare it as an own static.
  - `waitForBucketSettled({ probeRound, now, sleep, budgetMs }) -> Promise<{ settled: boolean, rounds: number, lastFailures: string[] }>`. `probeRound: () => Promise<{ ok: number, total: number, failures: string[] }>`; `now` and `sleep` are injected for tests.
  - `makeAppBucketProbeRound({ endpoint, bucket, keyPrefix, origin, signedHead })`. Each round fires `BUCKET_SETTLE_ROUND_SIZE` requests, half and half:
    - an unauthenticated `OPTIONS ${endpoint}/${bucket}/${keyPrefix}.settle-probe`, with `Origin: <origin>` and `Access-Control-Request-Method: PUT`. Clean means status 200 and `access-control-allow-origin === origin`;
    - signed `HeadBucket` calls through a fresh S3 client per request, so each lands on a new connection. Clean means no error.

    A failure string is `options:<status>` or `head:<error name>`.

- [ ] **Step 1: Write the failing tests.**
  - Review Focus 3, with `W = 20*60_000`: `bucketNeedsSettle(new Date(now - 21*60_000), now, W)` is false, with `now - 19*60_000` it is true, and `null` gives true. With window `0`, all three give false.
  - `storageSettleStatus(new Date(now - 4*60_000).toISOString(), now, W)` gives `{ settling: true, remainingMs: 16*60_000 }`; `now - 21*60_000` gives `{ settling: false, remainingMs: 0 }`; `null` gives `{ settling: true, remainingMs: null }`; any `createdAt` with window `0` gives `{ settling: false, remainingMs: 0 }`.
  - A streak reset: round results `[20/20, 19/20, 20/20, 20/20, 20/20]` give `settled: true, rounds: 5`.
  - Exactly `[20/20,20/20,20/20]` gives `rounds: 3`.
  - Review Focus 5 (e2e side): an always-`19/20` probe with `budgetMs: 25*60_000` and a fake clock advanced by `sleep` returns `{ settled: false }`. `rounds` is at most `Math.ceil(25*60_000/30_000)+1`, and `lastFailures` is non-empty.
  - `makeAppBucketProbeRound` against a stubbed fetch and S3 counts a missing ACAO header as a failure (`options:200-no-acao`).
  - Review Focus 5 (deploy side), in `deploy-never-awaits-bucket-settle.test.ts`:
    - behavioural, Hetzner-shaped (window 20 min): drive the orchestrator's storage finalize with a provider whose `bucketCreatedAt` resolves 1 minute ago and a spy `fetch`/S3 client; assert zero probe calls, one note line matching `/new storage bucket/`, and `envConfig.s3.bucketCreatedAt` set;
    - behavioural, window 0 (run once per non-Hetzner S3 class): zero `bucketCreatedAt`/`listBuckets` calls, zero probe calls, no note line, and no `bucketCreatedAt` key in `envConfig.s3`;
    - census: no file under `src/` other than `bucket-settle.js` references `waitForBucketSettled` or `makeAppBucketProbeRound` (the e2e harness under `tests/` may).
  - Status: a Hetzner env with `s3.bucketCreatedAt` 4 minutes old shows `storage settling (about 16 min left)`; 30 minutes old shows no such row; a DigitalOcean env with a 1-minute-old `bucketCreatedAt` shows no such row.
  - e2e check (in `tests/unit/e2e/file-upload-roundtrip.test.ts`): with a 0-window provider and a 1-minute-old bucket, the check makes zero probe requests and calls `sleep` zero times before uploading.
  - `bucket-settle-window-census.test.ts` (a walk, not a hand list):
    - (a) every file under `src/lib/providers/` with a class that `extends S3CompatibleProvider`, and every compute provider's `getObjectStorageProviderClass()` result from the provider registry, has `Object.hasOwn(Class, 'bucketSettleWindowMs')` and a non-negative integer value;
    - (b) `Object.hasOwn(S3CompatibleProvider, 'bucketSettleWindowMs')` is false, so there is no implicit default;
    - (c) every non-zero value appears in the test's `SETTLE_WINDOW_EVIDENCE` map (`{ hetzner: '2026-10-20 probes, memory drop-supabase-lean-graphite.md' }`); a non-zero value without an evidence entry fails with "a settle window needs probe evidence";
    - prove each arm bites: temporarily delete Hetzner's declaration (arm a fails) and set DigitalOcean's to 60000 (arm c fails), then restore. Record that in the report.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/bucket-settle.test.ts tests/unit/deploy/deploy-never-awaits-bucket-settle.test.ts tests/unit/providers/bucket-settle-window-census.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Use the global `fetch` for OPTIONS.
  - The origin is `https://<domain>`, or `http://localhost:3000` when there is no domain.
  - Copy follows the CLI help voice: lowercase informational hint, no em dash.
- [ ] **Step 4: Run** `pnpm vitest run tests/unit/deploy tests/unit/status tests/unit/e2e tests/unit/providers`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): report a settling new bucket instead of waiting on it`.

### Task 6: Per-env WAL-G prefix and per-env backup purge

**Files:**
- Modify: `carbon/docker-compose.yml:216-225`: `WALG_S3_PREFIX: s3://${S3_BACKUP_BUCKET:-${S3_BUCKET:-}}/backups/${PROJECT_NAME}/${VC_ENV:-local}/walg`. Update the comment.
- Modify: `src/lib/deploy/k8s/k3s.js:2481-2497`: use `s3Config.walgPrefix` (Task 2) instead of building the path. The function needs `environment` or `s3Config`; thread it from its caller.
- Modify: `carbon/k8s/base/db/statefulset.yaml:19`: the comment.
- Modify: `src/destroy.js:926-1030` (`handleBackupBucket`).
  - With `-purge`, call `deletePrefix(backupBucket, \`backups/${projectName}/${env}/\`)`.
  - Then delete the bucket with the existing purge path only when no other key remains in `projectConfig.environments`.
  - Plain destroy is unchanged: preserve.
- Check and update the readers of the old path that grep finds: `rg -n "backups/\\$\\{?PROJECT_NAME|/walg" src carbon/ha carbon/backup carbon/volumes`. Today they are `src/lib/deploy/walg-staleness.js` (comment) and `walg-audit.js` (it reads the env var, not the literal).
- Tests: `tests/unit/deploy/compose-walg-backup.test.ts`, `tests/unit/deploy/k3s-wal-archiving.test.ts`, `tests/unit/destroy/backup-bucket-env-scope.test.ts` (new).

**Interfaces:**
- Consumes: `resolveEnvStorage().walgPrefix`, `deletePrefix` (Task 4).

- [ ] **Step 1: Write the failing tests.**
  - The k3s render for env `staging` gives `WALG_S3_PREFIX === 's3://myapp-cd9ecc-backups/backups/myapp/staging/walg'`.
  - The compose file's `WALG_S3_PREFIX` line contains `${VC_ENV:-local}`, and `carbon/docker-compose.override.yml` still sets it to `""` for local dev (`tests/unit/template/dev-db-walg-disabled.test.ts` stays green).
  - Destroying `staging` with `-purge` while `prod` is live calls `deletePrefix(backups,'backups/myapp/staging/')` and does not delete the bucket.
  - Destroying the last env with `-purge` deletes the bucket.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy tests/unit/destroy tests/unit/template`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit`, plus `pnpm test:integration -- tests/integration/docker/db-first-boot.test.ts` when `DOCKER_INTEGRATION=true` is available. Expected: PASS.
- [ ] **Step 5: Commit** `fix(backups): give each environment its own WAL-G prefix`.

### Task 7: Template app applies `S3_KEY_PREFIX`

**Files:**
- Modify: `carbon/src/server/lib/env.ts:40`: `S3_KEY_PREFIX: z.string().regex(/^([a-z][a-z0-9-]{0,19}\/)?$/).default('')`.
- Modify: `carbon/src/server/lib/storage.ts:93-125`. `Key: env.S3_KEY_PREFIX + key` in `presignUpload` and `presignRead`, and in any delete or head that `grep -n "Key:" carbon/src/server` finds. The returned `key` (stored in the database) stays unprefixed, and `KEY_RE` keeps validating the unprefixed form.
- Modify: `carbon/.env.example`: document `S3_KEY_PREFIX` (empty for local), keeping `tests/unit/lib/env-docs-census.test.ts` green.
- Test: `carbon/tests/unit/server/storage-key-prefix.test.ts` (new).

- [ ] **Step 1: Write the failing tests.**
  - With `S3_KEY_PREFIX='prod/'`, `presignUpload({kind:'avatars',...})` returns a `key` matching `/^avatars\//`, and its `url` path contains `/prod/avatars/`.
  - `presignRead('avatars/u/<uuid>.png')` signs `/prod/avatars/...`.
  - With an empty prefix the URL contains `/<bucket>/avatars/`.
  - `S3_KEY_PREFIX='../'` fails env parsing.
- [ ] **Step 2: Run** `cd carbon && npx vitest run tests/unit/server/storage-key-prefix.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `cd carbon && npm run test:prepush`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(template): uploads live under the environment's key prefix`.

### Task 8: e2e assertions and the census

**Files:**
- Modify: `tests/e2e/checks/app-functional.ts:890-1035`. The upload check also asserts that the presigned URL path starts with `/<bucket>/<keyPrefix>`, read from `.vibecarbon.json` `environments.<env>.s3.keyPrefix`. The mismatch message names both.
- Modify: `tests/unit/e2e/file-upload-roundtrip.test.ts`: a prefix mismatch fails.
- Modify: `tests/e2e/utils/classify-failure.ts:144`: drop the `stateBucketGeneration`/generation-hex wording if it only described the rotated storage name, and keep it if it is about the state bucket.
- Create: `tests/unit/deploy/app-bucket-single-resolver-census.test.ts`.

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the census** (a walk, not a hand list).
  - (a) `git grep -n "deriveProjectBucketName("` over `src/` has call sites only in `s3-base.js`, `prompts.js` (`resolveEnvStorage`) and `destroy.js`. Any new call site fails with "read the bucket through resolveEnvStorage".
  - (b) Every file under `src/` that assigns `S3_BUCKET` (regex `S3_BUCKET\s*[=:]` or `\.S3_BUCKET\s*=`) also assigns `S3_KEY_PREFIX`.
  - (c) Every `WALG_S3_PREFIX` construction in `src/`, `carbon/docker-compose*.yml` and `carbon/k8s` contains an env segment (`walgPrefix` or `VC_ENV`), except the documented empty-string dev override.
  - (d) No file under `src/` mentions `storageBucketGeneration`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/app-bucket-single-resolver-census.test.ts tests/unit/e2e`. Expected: PASS on the finished tree. Then prove each arm bites: temporarily delete the `S3_KEY_PREFIX` line in `bundle.js`, see arm (b) fail, and restore it. Record that in the report.
- [ ] **Step 3: Run the gates:** `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`, and `cd carbon && npm run test:prepush`. Expected: all green.
- [ ] **Step 4: Commit** `test(storage): census for one bucket resolver and env-scoped prefixes`.

---

## Compatibility (goes in the PR body)

An environment deployed before this change has `s3.bucket` = `…-storage-<gen>`, objects at the bucket root, and WAL-G at `backups/<project>/walg`. Its next deploy stops with `StorageBucketMismatchError`. To keep its uploads, run these one-off steps:
1. Set `"appBucket": "<old bucket>"` top-level in `.vibecarbon.json`.
2. Run `aws s3 mv --recursive s3://<old>/avatars/ s3://<old>/<env>/avatars/`, and the same for `private/`.
3. Redeploy.

WAL-G starts a fresh chain at the new per-env prefix after the redeploy's first base backup. Older backups stay readable at the old path with `wal-g` by hand, and are not used by `vibecarbon restore`.

Brandon's own vibecarbon-web deployment on Hetzner is the one known case. Check first whether it uses the template's S3 uploads before following steps 1 and 2.

## Verification

- Per task: the commands in that task, green, with red-then-green evidence in the implementer report.
- End of branch:
  - root `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`;
  - `cd carbon && npm run test:prepush && npm run test:db`;
  - CI `test.yml` green.
- Real infra, which needs Brandon's OK for the spend:
  - `pnpm test:e2e:batch -- --scenario hetzner/compose-ha`, the leg that failed on 2026-10-20;
  - then `--scenario hetzner/compose`.
  - Expect no settle wait inside the cold deploy (no probe traffic between s3-setup and the outro), the young-bucket note at its end, the e2e upload check's detail showing its settle rounds after the cold deploy and no settle wait after the restore redeploy (bucket now old), and a green `verify-restore` upload check.
  - Non-Hetzner: no real-infra run is required (R6 is proven by the unit and census tests). If one runs anyway (`--provider digitalocean`, needs Brandon's OK), expect no `listBuckets` creation-time read, no note, no status row, and no settle rounds in the upload check's detail.
  - The compose cold-deploy time target (under 3 minutes) is owned by the separate compose cold-deploy plan; this plan's part is that `deploy.*` perf markers contain no storage-settle stage.
