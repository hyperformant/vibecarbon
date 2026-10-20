# One App Bucket Per Environment Implementation Plan (rework of the project-app-bucket branch)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each environment gets its own app uploads bucket, created on that environment's first deploy and reused forever after. The Pulumi state bucket and the backups bucket stay per project, as the branch already has them.

**Architecture:** This stacks on `feat/project-app-bucket` (HEAD `7de7f0d`) and changes only the app bucket's scope:
- `resolveEnvStorage` returns an env-specific app bucket name built by a new `deriveEnvAppBucketName`.
- The key-prefix machinery is deleted, since a bucket per env needs no prefix.
- CORS goes back to one owner per bucket, written blind with no merge.
- Destroy deletes the env's bucket only on `-purge`.

Everything else on the branch stays as it is: the per-env WAL-G prefix, the Hetzner-only settle window (R5/R6), the state-bucket last-env and generation fixes, and the `destroyedEnvironments` backup holders.

**Tech Stack:** Node ESM CLI (`src/`), the template app (`carbon/`, npm), vitest.

**Spec:** Brandon, 2026-10-20 (memory `storage-bucket-layout.md`): the app bucket is per environment; state and backups are per project; never create a bucket on redeploy. Plus the branch plan `docs/superpowers/plans/2026-10-20-project-app-bucket.md` and its ledger `.superpowers/sdd/2026-10-20-project-app-bucket/progress.md` (rulings R1-R7, A-C, final-review fixes).

## Rulings

- **E1, naming.**
  - `deriveEnvAppBucketName(projectConfig, envName)` returns `<project>-<salt>-<env>-storage` when it fits in 63 characters.
  - When it does not fit, the project part is clipped and an 8-hex hash is appended. The hash is `sha256(projectName + '\0' + salt + '\0' + env)` truncated, and it is always placed before `-storage`. The env segment is never clipped, because two envs must never collide.
  - The output passes `sanitizeBucketName`'s rules: 3-63 characters, `[a-z0-9-]`, no leading or trailing hyphen.
  - The name is a pure function of `(projectName, bucketSalt, envName)`, so it is stable forever.
  - `projectConfig.appBucket`, the old project-wide pin, is removed. An env-level pin `envConfig.s3.bucketPin` becomes the escape hatch that the mismatch error names.
- **E2, the state bucket name stops deriving from the app bucket.** Today `retainedStateBucket` and `deriveStateBucketName(appBucket, generation)` derive it from `deriveProjectBucketName(projectConfig)`. That stays: the project base is `deriveProjectBucketName(projectConfig, 'storage')`, which is still per project, and existing state buckets keep their names. Rename the parameter and the comments so nothing implies the app bucket.
  - Cost if wrong: state buckets get renamed, which a census in Task 1 forbids.
- **E3, delete `S3_KEY_PREFIX` and `keyPrefix` entirely.**
  - No customers, and a prefix serves nothing once the bucket is per env.
  - Delete it from `resolveEnvStorage`, `s3Config`, the bundle overrides, the k8s Secret and its `buildK3sApplyInputs` gate input, persistence (orchestrator and compose-ha), status, the destroy preview, the e2e prefix assertion, and the template (`env.ts`, `storage.ts`, `.env.example`, the parity test, `storage-key-prefix.test.ts`).
  - `deletePrefix` stays, because the backup-folder purge uses it.
  - `VC_ENV` stays, because WAL-G's prefix uses it.
- **E4, CORS has a single owner again.**
  - Delete `mergeCorsOrigins`, `recordedCorsOrigins`, `otherEnvCorsOrigins`, `removeAppBucketCorsOrigins` and the persisted `s3.corsOrigins`.
  - `applyAppBucketCors` PUTs exactly this env's origins: `https://<domain>`, or the localhost pair for a domainless env. It keeps two R7 behaviours:
    - it is started concurrently after s3-setup and awaited before the outro;
    - it skips the PUT when the current rule already equals this env's set, which costs one GET on a warm redeploy.
  - A failed GET no longer blocks the PUT, because no other env can be wiped.
  - Destroy does not touch CORS. Plain destroy keeps the bucket, and `-purge` deletes it.
- **E5, destroy semantics.**
  - Plain destroy keeps the env's app bucket, and its uploads, intact. This follows the backup-restore plan's rule that uploads and database backups are kept or purged together.
  - `-purge` calls `emptyAndDeleteBucket(envBucket)` and deletes the env's backup folder, through the existing `handleBackupBucket` per-env purge.
  - The shared backup bucket and state bucket are deleted only when no live env and no backup-holding `destroyedEnvironments` entry remains. That logic exists from the fix wave and does not change.
  - A destroyed env's seed keeps `s3.bucket`, so a later redeploy reuses the same bucket. Add `s3` to `ENV_IDENTITY_FIELDS` if it is not already carried, and test it.
- **E6, mismatch guard.**
  - An env whose persisted `s3.bucket` differs from the derived per-env name fails closed with `StorageBucketMismatchError` before any provider write. That covers the per-project names from this branch and the old `…-storage-<gen>` names.
  - The message gives the one-off steps: set `envConfig.s3.bucketPin` to the old bucket to keep using it, or copy the objects across with `aws s3 sync s3://<old> s3://<new>` and redeploy. There is no migration code.
- **E7, the settle window is per env bucket.** Unchanged code (R5/R6): the young-bucket note, the status row and the e2e gate now apply to each env's first deploy. The probe drops `keyPrefix` and uses a fixed object key `.settle-probe`.
- **E8, a seam for the security plan.** `resolveEnvStorage` returns `{ bucket, backupBucket, walgPrefix }`. A scoped app key, from the security plan's S3 scoping task, targets exactly `bucket`, which this plan's census makes the only app-bucket source. Put a one-line comment at the resolver saying so.

## Global Constraints

- No customers: no migration code. Old per-project or generation names fail closed (E6). Ship with a Compatibility note in the PR body and no `!:` footer.
- No retry ladders. Pathspec commits, conventional messages, never `--no-verify`. Root uses pnpm; `carbon/` uses npm. dotenv writes go only through `formatDotenvLine`. Never print secret values.
- Bucket names are 3-63 characters of `[a-z0-9-]` and are a pure function of `(projectName, bucketSalt, envName)` (E1).
- The settle constants and the per-provider `bucketSettleWindowMs` are unchanged.

## Review Focus

1. **Two envs in one project.** Two different bucket names. `destroy staging -purge` deletes only staging's bucket and staging's backup folder. Prod's bucket, the backup bucket and the state bucket survive. Task 3.
2. **A maximum-length project name (63 characters, sanitized) with a 20-character env.** A valid name of 63 characters or fewer, distinct across envs, and stable across calls. Task 1.
3. **Destroy, then redeploy the same env** (plain destroy). The redeploy resolves the same bucket name and `createBucket` reports that it exists. No settle note on Hetzner, because the bucket is old. Task 3.
4. **An env persisted with this branch's per-project bucket name** (`<project>-<salt>-storage`). The deploy fails closed with E6's steps before any write. Task 1.
5. **A domainless env redeployed with a domain.** The rule becomes exactly `https://<domain>`, and the localhost pair is gone. Task 2.

## File Map

- `src/lib/providers/s3-base.js`: new `deriveEnvAppBucketName`; rename the `deriveStateBucketName` parameter (E2).
- `src/lib/deploy/prompts.js`: `resolveEnvStorage` (E1, E3, E6, E8).
- `src/lib/deploy/orchestrator.js`: CORS simplification (E4) and removal of the persisted fields (E3).
- `src/lib/deploy/bundle.js`, `src/lib/deploy/k8s/k3s.js`, `src/lib/deploy/effects/compose-ha.js`: drop `keyPrefix` (E3).
- `src/destroy.js`, `src/lib/destroy/preview.js`, `src/status.js`: E5 and E3.
- `src/lib/deploy/bucket-settle.js`, `tests/e2e/checks/app-functional.ts`: E7 and E3.
- `carbon/src/server/lib/{env,storage}.ts`, `carbon/.env.example`: E3.
- Census: `tests/unit/deploy/app-bucket-single-resolver-census.test.ts` (rewrite).
- Docs: `AGENTS.md`, `docs/deploy-hetzner.md` (only the lines this rework makes false).

---

### Task 1: Per-env bucket name and resolver

**Files:**
- Modify: `src/lib/providers/s3-base.js`, `src/lib/deploy/prompts.js` (`resolveEnvStorage`, `StorageBucketMismatchError` message).
- Test: `tests/unit/s3/bucket-naming.test.ts`, `tests/unit/deploy/resolve-env-storage.test.ts`, `tests/unit/iac/state-bucket.test.ts`.

**Interfaces:**
- Produces:
  - `deriveEnvAppBucketName(projectConfig: {projectName, bucketSalt?}, envName: string) -> string`;
  - `resolveEnvStorage(envName, envConfig, projectConfig) -> { bucket, backupBucket, walgPrefix }`, with `keyPrefix` removed;
  - `bucket = envConfig.s3?.bucketPin || deriveEnvAppBucketName(projectConfig, envName)`.

- [ ] **Step 1: Write the failing tests.**
  - `deriveEnvAppBucketName({projectName:'myapp', bucketSalt:'cd9ecc'}, 'staging')` returns `'myapp-cd9ecc-staging-storage'`.
  - Review Focus 2: a 63-character sanitized project with a 20-character env gives a name of 63 characters or fewer that matches `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/`. It contains the full env string, differs for `env-a` and `env-b`, and is identical across two calls.
  - Unsalted `{projectName:'old'}` gives `'old-prod-storage'`.
  - `resolveEnvStorage('prod', {}, P)` deep-equals `{ bucket: 'myapp-cd9ecc-prod-storage', backupBucket: 'myapp-cd9ecc-backups', walgPrefix: 'backups/myapp/prod/walg' }`, with no `keyPrefix` key.
  - Review Focus 4: `envConfig.s3.bucket = 'myapp-cd9ecc-storage'` throws `StorageBucketMismatchError`. Its message contains both names, `bucketPin` and `aws s3 sync`, and no credentials.
  - `envConfig.s3.bucketPin = 'legacy-b'` gives `bucket === 'legacy-b'`, and the persisted `s3.bucket === 'legacy-b'` does not throw.
  - E2: the state bucket name for `P` is unchanged from the branch's value. Assert the literal `deriveStateBucketName('myapp-cd9ecc-storage', undefined)` that the state-bucket test pins today.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/s3/bucket-naming.test.ts tests/unit/deploy/resolve-env-storage.test.ts tests/unit/iac/state-bucket.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** E1, E2, E6 and E8.
  - Use `node:crypto` `createHash('sha256')` for the hash.
  - Delete `projectConfig.appBucket` support and its tests, with the justification in the commit.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `refactor(storage): one app bucket per environment`.

### Task 2: Delete the key prefix and the shared-CORS machinery

**Files:**
- Modify: the E3 list (CLI: `bundle.js`, `k3s.js` Secret and `buildK3sApplyInputs`, orchestrator persistence, `compose-ha.js` persistence, `status.js`, `preview.js`, `bucket-settle.js`, `app-functional.ts`; template: `env.ts`, `storage.ts`, `.env.example`).
- Modify: `src/lib/deploy/orchestrator.js` CORS (E4).
- Delete tests: `carbon/tests/unit/server/storage-key-prefix.test.ts`, `tests/unit/template/s3-key-prefix-parity.test.ts`, and the merge cases in `tests/unit/deploy/app-bucket-cors-merge.test.ts` (rename the file `app-bucket-cors.test.ts`). The commit justification: the prefix and the shared rule are removed by design.
- Update tests: `env-scope-writers.test.ts` (drop the `S3_KEY_PREFIX` assertions and keep `VC_ENV`), `compose-ha-persist-s3-fields.test.ts`, the status render test, `file-upload-roundtrip.test.ts`, and `carbon/tests/unit/server/storage.test.ts` (the env mock).

**Interfaces:**
- Consumes: `resolveEnvStorage` (Task 1).
- Produces: `applyAppBucketCors({ createProvider, bucket, domain, log }) -> Promise<void>`, with the signature trimmed; `startAppBucketFinalize(...).finish(log) -> Promise<{ bucketCreatedAt?: string|null }>`.

- [ ] **Step 1: Write the failing tests.**
  - Review Focus 5: with a fake provider whose GET returns `['http://localhost:3000','http://localhost:5173']`, domain `e1.dev` causes a PUT of exactly `['https://e1.dev']`.
  - A GET equal to the own set causes zero PUTs.
  - A GET that throws still PUTs this env's set.
  - The rendered server `.env` and the k8s Secret contain `VC_ENV` and no `S3_KEY_PREFIX`.
  - The persisted env `s3` block has no `keyPrefix` or `corsOrigins` keys.
  - The template presign URL path is `/<bucket>/avatars/...`, with no prefix.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy tests/unit/status tests/unit/e2e` and `cd carbon && npx vitest run tests/unit/server`. Expected: the new assertions FAIL.
- [ ] **Step 3: Implement** E3 and E4, keeping the R7 concurrency (start after s3-setup, await before the outro).
- [ ] **Step 4: Run** `pnpm test:unit` and `cd carbon && npm run test:prepush`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(storage): drop the key prefix and the shared CORS rule`.

### Task 3: Destroy keeps or purges the env's own bucket

**Files:**
- Modify: `src/destroy.js` (`deleteAppBucketEffect` per E5), `src/lib/destroy/preview.js` (wording), `src/lib/env-identity.js` (carry `s3` per E5, if not carried already).
- Test: rewrite `tests/unit/destroy/app-bucket-env-scope.test.ts`; update `tests/unit/deploy/destroy-redeploy-bucket-flow.test.ts`.

**Interfaces:**
- Consumes: `deriveEnvAppBucketName` (Task 1); `otherEnvironmentNames`, `handleBackupBucket` and `retainStateBucket` (unchanged).

- [ ] **Step 1: Write the failing tests.**
  - Review Focus 1: a project with `prod` and `staging`. `destroy staging -purge` calls `emptyAndDeleteBucket('myapp-cd9ecc-staging-storage')` once and never names prod's bucket. It purges only `backups/myapp/staging/`, and keeps the backup bucket and the state bucket.
  - Plain `destroy staging` calls neither `emptyAndDeleteBucket` nor `deletePrefix` on the app bucket. The output contains `kept` and `-purge`.
  - The last env with `-purge` deletes its app bucket, the backup bucket and the state bucket. The existing fix-wave tests stay green.
  - Review Focus 3: after a plain destroy, `resolveEnvStorage('staging', seed, after).bucket` equals the name before the destroy, and the seed carries `s3.bucket`.
  - The preview for plain destroy reads `Bucket: <name> (kept; deleted with -purge)`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/destroy tests/unit/deploy/destroy-redeploy-bucket-flow.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement E5.** Delete the prefix branches and the now-dead "objects written before per-environment prefixes" path.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(destroy): keep an environment's bucket unless -purge`.

### Task 4: Census, e2e and docs

**Files:**
- Rewrite: `tests/unit/deploy/app-bucket-single-resolver-census.test.ts`.
- Modify: `tests/e2e/checks/app-functional.ts`. The upload check asserts that the presigned URL path starts with `/<bucket>/`, where the bucket is `.vibecarbon.json` `environments.<env>.s3.bucket`, and that the bucket ends with `-<env>-storage` unless it is pinned.
- Modify: `AGENTS.md` and `docs/deploy-hetzner.md`, only the lines this rework makes false (shared bucket, prefixes, CORS merge).
- Modify: `.superpowers/sdd/2026-10-20-project-app-bucket/pr-compat.md` (uncommitted). Replace the prefix steps with E6's steps, drop the CORS-race paragraph, and keep the `vibecarbon backup <env>` step.

- [ ] **Step 1: Write the census** (walks, not hand lists).
  - (a) Call sites of `deriveEnvAppBucketName(` under `src/` appear only in `s3-base.js`, `prompts.js` and `destroy.js`. Call sites of `deriveProjectBucketName(` are limited to the backups and state derivations. The failure message is "read the app bucket through resolveEnvStorage".
  - (b) No file under `src/`, `carbon/src` or `carbon/k8s` mentions `S3_KEY_PREFIX` or `keyPrefix`.
  - (c) No file under `src/` mentions `corsOrigins` or `mergeCorsOrigins`.
  - (d) The existing per-env `WALG_S3_PREFIX` arm stays.
  - (e) The existing `storageBucketGeneration` arm stays.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/app-bucket-single-resolver-census.test.ts tests/unit/e2e`. Expected: PASS. Prove arms (b) and (c) bite with a temporary edit, then restore, and record it in the report.
- [ ] **Step 3: Gates.** Run `pnpm lint && pnpm test:unit && pnpm test:integration`, `cd carbon && npm run test:prepush`, and `DOCKER_INTEGRATION=true pnpm vitest run --project integration-docker tests/integration/docker/db-first-boot.test.ts`. Expected: all green.
- [ ] **Step 4: Commit** `test(storage): census for per-environment app buckets`.

## Verification

- Per task: the commands in that task, green, with red-then-green evidence.
- End of branch: a whole-branch review over `0e12659..HEAD`, covering this rework and the original branch together.
- Real infra (needs Brandon's OK for the spend): `--scenario hetzner/compose-ha` first, which exercises a two-env-shaped cold deploy and the young-bucket path. On the restore redeploy, expect no settle wait and a green upload check.
