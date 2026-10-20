# Backup and Restore Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every backup, restore, scale and destroy path either preserves the operator's data or fails before touching it, and says truthfully which one happened.

**Architecture:**
- **Restore resolves the exact base backup in the CLI first.** It reads wal-g's stop sentinels straight from S3, and the servers fetch that named backup into a staging directory before swapping it in. No path deletes PGDATA before a restore point is proven to exist.
- **Each database lineage gets its own archive prefix.** The WAL-G prefix gains the Postgres system identifier. A fresh initdb gets a new prefix; a restore or reseed keeps its lineage, because both preserve the identifier.
- **Every promotion ends with a fresh base backup.**
- **One primary resolver.** All commands find the live primary through it.
- **Backup scripts report `pushed` or `skipped`** through a machine-readable line.

**Tech Stack:** Node ESM CLI (`src/`), POSIX sh in `carbon/backup`, `carbon/volumes/db` and `carbon/k8s/base`, wal-g 3.0.9, PG17, `@aws-sdk/client-s3`, vitest.

**Spec:** the data-integrity review at `/tmp/claude-1000/-home-brandon-repos-vibecarbon/0b7ee7cd-7067-44f6-a72a-5ce5d7505b2c/scratchpad/arch-review/data-integrity.md` (16 findings, C1/H1-H7/M1-M6/L1-L2). Each finding was re-verified on `feat/project-app-bucket` @ 7de7f0d before planning; all 16 hold, with two corrections noted below.

**Base:** stacks on `feat/project-app-bucket`. That branch already makes the prefix per environment (`backups/<project>/<env>/walg`, from `resolveEnvStorage().walgPrefix`).

## Re-verification notes
- **C1 holds.** `k3s.js:2897` says "`restore` is accepted for the caller's input hash and ignored here". `RESTORE_TARGET` is written only by `src/restore.js:604-616`, and nothing under `tests/e2e` passes `-restore`.
- **H5, correction:** there are more skip-as-success members than the review listed. `compose-backup.sh` has 5 `exit 0` skips (lines 24, 50, 55, 63, 67), including the `flock -n` "already running" skip. `cronjob.yaml` has 2 (lines 83, 99).
- **H4 holds, at `src/lib/cli/env-context.js:77-78`.** The file is under `lib/cli`, not `lib/deploy`. `git grep "servers?.[0]"` over `src/` has 29 hits, which is the census surface.
- **Every other finding holds at the cited sites.** Line offsets drift by about 1 to 15.

## Rulings (made while planning)
- **B1, lineage = the Postgres system identifier, not a CLI-minted generation.**
  - initdb mints it.
  - `pg_basebackup`, `backup-fetch` and promotion all preserve it, so restores and standbys stay in their lineage while a fresh database gets a new one.
  - Nothing has to be minted, persisted before boot, or kept in sync.
  - Prefix: `backups/<project>/<env>/walg/<sysid>`.
  - Cost if wrong: an operator restoring across lineages must name the lineage; `vibecarbon restore` lists them.
- **B2, the base backup is resolved in the CLI from S3 sentinels**, not with `wal-g backup-list` inside a container.
  - A fresh k8s cluster has no running database to exec into, and the CLI already holds an S3 client for the backup bucket.
  - The sentinel format is pinned to wal-g 3.0.9 by a fixture test.
  - Cost if wrong: a wal-g bump that renames sentinel fields fails the fixture test loudly.
- **B3, keep `recovery_target_timeline = 'current'` and pick the right base instead.** B5 puts a base backup on every new timeline, so the newest base at or before the target is on the timeline that was live at the target. Cost if wrong: a target inside the gap between a promotion and the end of its base backup fails before the wipe (preflight), not after.
- **B4, plain destroy keeps the environment's uploaded objects whenever it keeps its database backups. `-purge` deletes both.** Rows and their files are one restorable unit. This reverses the bucket branch's "plain destroy deletes the env prefix" behaviour. Cost if wrong: storage for kept uploads until `-purge`.
- **B5, base backup after promotion.** This plan owns the helper and the census across every promote site, failover included. The HA-correctness plan (`2026-10-20-ha-correctness.md`, written concurrently) owns the promote guard, the reseed source and the failover write fence. Whichever lands second rebases the one-line call into `failover.js`.
- **B6, scale fences writes with explicit downtime.** The old server's app is stopped and the database set read-only before the final WAL switch. The CLI prints the downtime window.
- **B7, retention is by time.** `retentionDays` means days: `wal-g delete before FIND_FULL <ISO date>`. It runs inside the current lineage only. Older lineages are removed only by `-purge`.

## Global Constraints
- No customers: no migration code for old prefixes or config keys. Ship a Compatibility note and no `!:` footer.
- No retry ladders. A failed backup, a failed preflight or a failed fence fails the command with one line naming the cause.
- Never print secrets. A sentinel read uses the backup credentials and logs only bucket, prefix and backup names.
- dotenv writes only through `formatDotenvLine`. Every shell edit to `wal-archive.sh` keeps its byte-parity with `carbon/k8s/base/backup/configmap-walg.yaml` (`walg-archive-script-parity.test.ts`).
- Every task ships its class census (a walk, not a hand list), and the report shows each census arm failing on a deliberate break.
- Conventional commits, pathspec commits, never `--no-verify`. Root uses pnpm; `carbon/` uses npm.

## Review Focus
1. **Restore on an env with no backup, or with a target older than the oldest base.** The command fails before stopping anything, and the database and app keep running untouched. Test: Task 1.
2. **`vibecarbon deploy prod -mode k8s -restore latest` on a fresh cluster.** Rows written before the destroy are present after it. Test: Task 2, unit plus the new e2e step.
3. **Destroy, then redeploy the same env without `-restore`.** The new database archives under a new lineage, the preserved lineage's objects are byte-identical afterwards, and `vibecarbon restore` lists both. Test: Task 3.
4. **Failover (or restore, or scale), then `restore latest`.** Post-promotion writes are present. Test: Task 4, db-tier integration.
5. **`backup create` against a standby, or a node with no S3 credentials.** It reports `skipped: <reason>` and exits non-zero; destroy and scale abort. Test: Task 6.

## File Map
- New `src/lib/walg/restore-base.js`: sentinel listing, base resolution (B2/B3).
- New `src/lib/walg/recovery-config.js`: one builder for the recovery block (compose and k8s).
- New `carbon/volumes/db/walg-env.sh` (plus its k8s ConfigMap copy): exports the lineage-scoped `WALG_S3_PREFIX`.
- `carbon/volumes/db/wal-archive.sh`, `carbon/backup/compose-backup.sh`, `carbon/k8s/base/backup/cronjob.yaml`, `carbon/k8s/base/backup/configmap-walg.yaml`, `carbon/k8s/base/db/statefulset.yaml`, `carbon/docker-compose.yml`, `docker/postgres-walg/db-entrypoint.sh`.
- `src/lib/deploy/compose/index.js` (`composeRestoreScript`, `restoreCompose`, `backupCompose`), `src/restore.js`, `src/backup.js`, `src/scale.js`, `src/destroy.js`, `src/failover.js` (one call, B5), `src/lib/deploy/k8s/k3s.js`, `src/lib/cli/env-context.js`, `src/lib/config.js`, `src/status.js`, `src/lib/walg-backups.js`.
- `carbon/src/server/db/migrate.ts` (L2).
- Tests are listed per task.

---

### Task 1: Restore resolves its base in the CLI and never wipes before it is proven (H3, H2a, M1, M2)

**Files:**
- Create: `src/lib/walg/restore-base.js`, `src/lib/walg/recovery-config.js`.
- Modify: `src/lib/deploy/compose/index.js` (`composeRestoreScript` ~1300-1360, `restoreCompose` ~1390), `carbon/k8s/base/db/statefulset.yaml` (init container `walg-restore`, ~87-195), `src/restore.js` (~460-710).
- Test: `tests/unit/walg/restore-base.test.ts`, `tests/unit/walg/recovery-config.test.ts`, `tests/unit/deploy/restore-destroy-before-verify-census.test.ts` (new); a fixture at `tests/fixtures/walg/sentinel-3.0.9.json` (captured from a real wal-g 3.0.9 push; the Docker integration test below creates one).

**Interfaces:**
- Produces:
  - `listBaseBackups({ s3, bucket, prefix }) -> Promise<Array<{ name, timeline: number, startLsn: string, finishTime: Date }>>`. It reads `<prefix>/basebackups_005/*_backup_stop_sentinel.json`, and the timeline is the first 8 hex digits after `base_`.
  - `resolveRestoreBase(backups, target: 'latest' | Date) -> { name, timeline, finishTime }`. For `latest` it returns the newest by `finishTime`. For a Date it returns the newest with `finishTime <= target`. It throws `NoRestorePointError` when none exists, with the oldest and newest finish times in the message.
  - `buildRecoveryConfig({ target: 'latest' | string }) -> string[]`. These are the lines appended after stripping `restore_command`, `recovery_target_*` and `recovery_target_action`, in exactly the form compose writes today. The k8s init container gets the same lines through an env var rendered by the CLI.
- Both tiers fetch `RESTORE_BACKUP=<name>` (never `LATEST`) into `$PGDATA.restore` on the same volume, then:
  1. write `$PGDATA.restore/.vc-restore-in-progress`;
  2. `mv "$PGDATA" "$PGDATA.prev" && mv "$PGDATA.restore" "$PGDATA"`;
  3. remove the marker once `recovery.signal` and the recovery config are in place;
  4. remove `$PGDATA.prev` only after the CLI confirms promotion (`pg_is_in_recovery() = false`).
- A boot that finds `.vc-restore-in-progress` with no `RESTORE_BACKUP` set exits 1 with `restore interrupted; rerun vibecarbon restore`. Compose `db-entrypoint.sh` and the k8s init container both check it.

- [ ] **Step 1: Write the failing tests.**
  - `resolveRestoreBase`:
    - `[A(TL1, 01:00), B(TL1, 02:00), C(TL2, 03:00)]` with `latest` gives `C`;
    - the same list with target `02:30` gives `B`, and with target `00:30` throws `NoRestorePointError` matching `/oldest .*01:00/`;
    - an empty list throws.
  - `listBaseBackups` against the fixture parses `name`, `finishTime` and a `timeline` of 1.
  - `buildRecoveryConfig({target:'latest'})` contains `recovery_target_timeline = 'current'` and no `recovery_target_time`. `{target:'2026-10-20T09:55:00Z'}` contains `recovery_target_time = '2026-10-20T09:55:00Z'`.
  - Byte parity: the rendered k8s recovery env equals the compose script's lines (M2).
  - The census walks `composeRestoreScript()` output and the `walg-restore` init script in `statefulset.yaml`:
    - every `rm -rf` targeting `$PGDATA`/`${PGDATA}` appears only after the line containing `backup-fetch`, and targets `$PGDATA.prev`, `$PGDATA.restore` or the marker;
    - no `backup-fetch … LATEST` remains in either.
  - `restore.js`, unit level: with a fake S3 returning zero sentinels, `runRestore` throws `NoRestorePointError` before any `docker compose stop` or `kubectl patch` call (spy on the SSH/kubectl runners).
  - M1: the CLI's k8s wait is `max(300, ceil(sizeBytes/20MB/s))` seconds, from the sentinel's `CompressedSize` (or `UncompressedSize`). `RESTORE_TARGET`/`RESTORE_BACKUP` are cleared only after the pod is Ready, never in a `finally`. The test asserts that a rollout failure leaves the Secret keys set and the error names `kubectl logs db-0 -c walg-restore`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/walg tests/unit/deploy/restore-destroy-before-verify-census.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `restore.js` calls `listBaseBackups` and `resolveRestoreBase` before any stop. It passes `RESTORE_BACKUP` and the rendered recovery lines to `composeRestoreScript` and to the Secret patch (`stringData.RESTORE_BACKUP`, `RESTORE_RECOVERY_CONF`). Delete the review's "recovery window oldest → newest" claim at `restore.js:470-477`, and print the resolved backup name and finish time instead.
- [ ] **Step 4: Docker integration.** Add `tests/integration/docker/db-restore-staged.test.ts` (`DOCKER_INTEGRATION=true`). It runs the db image with garage or local S3 from the existing docker test fixtures and walks through:
  1. push a base backup, then write a row;
  2. call `composeRestoreScript` with a missing backup name, which exits non-zero, and the original PGDATA rows are still present;
  3. restore with the real name, which completes, and the row from before the base is present.

  Save that run's sentinel as the fixture.
- [ ] **Step 5: Run** `pnpm vitest run tests/unit` and `pnpm test:docker -- tests/integration/docker/db-restore-staged.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `fix(restore): resolve the base backup first and never wipe PGDATA before it is proven`.

### Task 2: k8s `deploy -restore` restores (C1)

**Files:**
- Modify: `src/lib/deploy/k8s/k3s.js`: `buildVibecarbonSecretData` (~1852-1888) and the `restore` handling near 2897 (delete the "ignored here" comment); `awaitDb`.
- Test: `tests/unit/deploy/k8s-deploy-restore.test.ts` (new), `tests/unit/deploy/flag-reaches-runtime-census.test.ts` (new), `tests/e2e/scenarios/_run-lifecycle.ts` (new step `restore-deploy`, k8s only).

**Interfaces:**
- Consumes: `listBaseBackups` and `resolveRestoreBase` (Task 1).
- `deployK3s` with `options.restore`:
  1. resolves the base (fail before any apply with `NoRestorePointError`);
  2. writes `RESTORE_BACKUP`, `RESTORE_TARGET` and `RESTORE_RECOVERY_CONF` into `vibecarbon-secrets` before the db StatefulSet applies;
  3. clears them only after `awaitDb` reports Ready and `pg_is_in_recovery()` is false.

  The k8s-ha standby keeps `restore: null` (existing behaviour, asserted).

- [ ] **Step 1: Write the failing tests.**
  - `buildVibecarbonSecretData({ restore: { backup: 'base_000000010000000000000003', target: 'latest' } })` contains all three keys. Without `restore`, it contains none.
  - The deploy-order test: the Secret patch happens before the StatefulSet apply, and the clear happens after `awaitDb`.
  - The census walks `SPEC` flags in `src/deploy.js` that flow into `executeDeployment` options. For each one, at least one non-hash reader under `src/lib/deploy` renders it into a manifest, Secret, env or command (an AST or regex walk for `options.<flag>` outside `build*Inputs`). Today `restore` fails this; after the fix it passes. Record each arm's deliberate break in the report.
  - The e2e step `restore-deploy` (k8s and k8s-ha), after `destroy` with backups preserved:
    1. `vibecarbon deploy <env> -mode k8s -restore latest -y`;
    2. assert that the marker row written before the destroy (the existing restore scenario's sentinel row) is present;
    3. run `tests/unit/e2e` for the step's planner.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/k8s-deploy-restore.test.ts tests/unit/deploy/flag-reaches-runtime-census.test.ts tests/unit/e2e`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** the same command, then `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(k8s): deploy -restore seeds the database from the resolved backup`.

### Task 3: One archive prefix per database lineage, and overwrite protection (H1)

**Files:**
- Create: `carbon/volumes/db/walg-env.sh`. It sources the base prefix from `WALG_S3_PREFIX_BASE` and exports `WALG_S3_PREFIX="${WALG_S3_PREFIX_BASE}/$(pg_controldata "$PGDATA" | awk -F': *' '/Database system identifier/{print $2}')"`. When `RESTORE_LINEAGE` is set and PGDATA is empty, it uses that instead.
- Modify:
  - `carbon/docker-compose.yml`: rename the env var to `WALG_S3_PREFIX_BASE` and add `WALG_PREVENT_WAL_OVERWRITE: "true"`;
  - `src/lib/deploy/k8s/k3s.js` (`buildDbManifestValues`), `statefulset.yaml` (db container, walg-restore init), `cronjob.yaml`, `configmap-walg.yaml`: the same rename and setting, sourcing `walg-env.sh`;
  - `wal-archive.sh`, `compose-backup.sh`: source `walg-env.sh`;
  - `src/lib/deploy/prompts.js` (`resolveEnvStorage().walgPrefix` keeps returning the base);
  - `src/lib/env-identity.js`: `destroyedEnvironments` carries `backup.lineage`;
  - `src/restore.js`: a `-lineage <sysid>` flag; the default is the env's recorded lineage;
  - `src/lib/walg-backups.js`: list lineages by `ListObjectsV2` with `Delimiter: '/'` under the base.
- After every successful deploy, the CLI reads `SELECT system_identifier FROM pg_control_system()` and records `envConfig.backup.lineage`.
- Test: `tests/unit/deploy/walg-lineage-prefix-census.test.ts` (new), `tests/unit/restore/restore-lineage.test.ts` (new), and the existing `walg-archive-script-parity.test.ts`.

**Interfaces:**
- Consumes: `listBaseBackups({ prefix })` (Task 1) is called with `<base>/<lineage>`.
- Produces: `listLineages({ s3, bucket, base }) -> Promise<Array<{ lineage: string, newestFinish: Date|null }>>`.

- [ ] **Step 1: Write the failing tests.**
  - The census renders both tiers. Every WAL-G-using container or script either sources `walg-env.sh` or is `walg-env.sh`. `WALG_PREVENT_WAL_OVERWRITE` is `"true"` in the compose db env, the db container, the walg-restore init container and the backup CronJob. No file under `carbon/` sets `WALG_S3_PREFIX` directly except `walg-env.sh` and the documented empty dev override.
  - Restore with no `-lineage` uses `envConfig.backup.lineage`. When the env has none and two lineages exist, the command fails, listing both with their newest finish times.
  - A destroy-then-redeploy fixture: `destroyedEnvironments.<env>.backup.lineage` survives destroy.
  - Docker integration, extending Task 1's test: initdb A, push, then wipe the volume and initdb B. Assert B's pushes land under a different `<sysid>` and A's sentinel object is unchanged (same ETag).
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/walg-lineage-prefix-census.test.ts tests/unit/restore tests/unit/deploy/walg-archive-script-parity.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files. Update the bucket branch's census arm (c) in `app-bucket-single-resolver-census.test.ts` to accept `WALG_S3_PREFIX_BASE`.
- [ ] **Step 4: Run** `pnpm test:unit` and the Docker test. Expected: PASS.
- [ ] **Step 5: Commit** `fix(backups): each database lineage archives under its own prefix and never overwrites WAL`.

### Task 4: A fresh base backup after every promotion (H2b)

**Files:**
- Create: `src/lib/walg/post-promote-backup.js`.
- Modify: `src/restore.js` (compose and k8s paths), `src/scale.js` (after `restoreDb`), `src/failover.js` (compose-ha and k8s-ha promote paths, one call each, B5), `src/lib/deploy/k8s/ha/index.js` (`restorePromotedWalgRole`).
- Test: `tests/unit/walg/post-promote-backup-census.test.ts` (new), and `tests/integration/docker/db-restore-staged.test.ts` (extend).

**Interfaces:**
- Produces: `pushBaseBackupAfterPromote({ tier, target }) -> Promise<{ name: string }>`. It calls `backupCompose` or `triggerBackupJob` and requires the Task 6 result to be `pushed`. It runs after the RTO-critical steps (DNS flip, health), and its failure fails the command with `promoted, but the first base backup on the new timeline failed: <cause>; run vibecarbon backup <env> now`.

- [ ] **Step 1: Write the failing tests.**
  - The census walks `src/` for promote sites: `pg_promote(`, `promoteStandby(`, the `restoreCompose(` and `runK8sRestore(` callers, and the scale `restoreDb` call. It asserts each enclosing exported command function also calls `pushBaseBackupAfterPromote`, and lists the sites it found (expect at least 5).
  - Docker integration: base, then restore (promote, TL2), then write, then `restore latest`. The post-promotion write is present.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/walg/post-promote-backup-census.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit` and the Docker test. Expected: PASS.
- [ ] **Step 5: Commit** `fix(backups): every promotion ends with a base backup on the new timeline`.

### Task 5: One primary resolver (H4)

**Files:**
- Modify: `src/lib/cli/env-context.js` (new `resolvePrimary(envConfig)`), `src/failover.js` (`swapHaRoles` also rewrites `servers[].role`), and the 29 `servers?.[0]` sites the census finds (`destroy.js` ~3456, `failover.js` ~1708, `status.js` ~374, `select-environment.js` ~100, `remote-containers.js` ~80, and the rest).
- Test: `tests/unit/cli/resolve-primary.test.ts` (new), `tests/unit/cli/no-positional-primary-census.test.ts` (new).

**Interfaces:**
- Produces: `resolvePrimary(envConfig) -> { ip: string, name?: string }`.
  - k8s-ha: `ha.primary.masterIp`.
  - compose-ha: the `servers[]` entry with `role === 'primary'`.
  - Single-node modes: the only server.
  - Throws `AmbiguousPrimaryError` when an HA env has zero or two primaries.
- The orchestrator writes `role` on every k8s-ha `servers[]` entry, and `swapHaRoles` swaps those roles in the same write.

- [ ] **Step 1: Write the failing tests.**
  - After `swapHaRoles` on a k8s-ha fixture, `resolvePrimary` returns the promoted master IP, and `resolveEnvContext(env, 'primary')` matches it.
  - compose-ha: after the swap, the same holds.
  - Two `role:'primary'` entries throw.
  - The census bans `servers?.[0]` and `servers[0]` under `src/` outside `env-context.js` and the deploy writers that construct the array (an allowlist of writer files, each with a one-line reason).
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/cli`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(cli): every command finds the live primary through one resolver`.

### Task 6: Backups report pushed or skipped, and destroy acts on it (H5, M3, L1)

**Files:**
- Modify: `carbon/backup/compose-backup.sh` and `cronjob.yaml`. Every exit path prints exactly one `BACKUP_RESULT=pushed:<name>` or `BACKUP_RESULT=skipped:<reason>`. The `flock` "already running" skip becomes `skipped:already-running` and exits 75 (EX_TEMPFAIL). Other skips exit 0 with the marker. Errors stay non-zero.
- Modify: `src/lib/deploy/compose/index.js` (`backupCompose` returns `{ result: 'pushed'|'skipped', name?, reason? }`), `src/lib/deploy/k8s/*` (`triggerBackupJob`, same return, read from the Job's logs).
- Modify: `src/backup.js` (~630-683: print the pushed name; delete the legacy tar.gz download offer and its wrong prefix, L1), `src/destroy.js` (~3455-3480: k8s calls `triggerBackupJob`; requested-but-failed or skipped aborts unless `-force`; with `-y` and backups kept, back up by default), and `src/scale.js` (requires `pushed`).
- Test: `tests/unit/backup/backup-result-marker.test.ts` (new; it runs `compose-backup.sh` under `sh` with stubbed `wal-g`/`psql`/`flock` on PATH, one case per branch), `tests/unit/backup/backup-result-consumed-census.test.ts` (new), `tests/unit/destroy/destroy-prebackup.test.ts` (new).

**Interfaces:**
- Produces: `parseBackupResult(stdout) -> { result, name?, reason? }`. It throws when there are zero or two markers.

- [ ] **Step 1: Write the failing tests.**
  - Each `compose-backup.sh` branch (no target, no creds, standby role, in recovery, already running, success) prints its marker. The success case prints the name from stubbed `wal-g backup-push` output.
  - The census: every call of `backupCompose(` or `triggerBackupJob(` under `src/` destructures or uses `.result`.
  - Destroy on k8s with "yes" calls `triggerBackupJob`. A `skipped` result aborts with `backup skipped (<reason>); destroy stopped; rerun with -force to destroy anyway`. `-force` continues.
  - `backup create` prints the backup name, and no longer prints "No backups found in S3".
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/backup tests/unit/destroy/destroy-prebackup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(backups): report pushed or skipped, and stop destroy on a missing backup`.

### Task 7: Compose scale fences writes before the cutover (H6)

**Files:**
- Modify: `src/scale.js` (~487-842).
- Test: `tests/unit/scale/compose-scale-fence.test.ts` (new), `tests/unit/scale/primary-destroy-fence-census.test.ts` (new).

**Interfaces:**
- Produces: `fenceComposePrimary({ ip, sshKeyPath, projectName }) -> Promise<{ lastArchivedWal: string }>`. Over SSH it does the following:
  1. stop `app`;
  2. `ALTER SYSTEM SET default_transaction_read_only = on; SELECT pg_reload_conf();`;
  3. `SELECT pg_walfile_name(pg_switch_wal())`;
  4. poll `pg_stat_archiver.last_archived_wal` until it reaches that file (fixed budget 120 s, then fail with the file name);
  5. set `WALG_ROLE=standby` in the old server's `.env` and remove its backup cron entry.
- Scale order becomes: provision and prepare the new server in parallel, as today, then fence the old one, take the final backup (`pushed` required), restore on the new one (Task 1), push the post-promote base (Task 4), and flip DNS. The old server is destroyed last. The CLI prints `writes paused from <t> until DNS flip` with the elapsed time.

- [ ] **Step 1: Write the failing tests.**
  - The step-order test, using fakes that record the calls: fence, then `backupCompose`, then `restoreCompose`, then `pushBaseBackupAfterPromote`, then the DNS flip, then destroy.
  - The fence's archive wait failing aborts the scale before any restore, and the old server's app is restarted with read-only off. The test asserts that rollback call.
  - The census: every code path under `src/` that destroys a server which ran a primary database (the `destroyServer` callers in `scale.js` and `destroy.js`) passes through `fenceComposePrimary` or a destroy command that has already taken a `pushed` backup.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/scale`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(scale): fence writes on the old server before the database cutover`.

### Task 8: Destroy keeps uploads whenever it keeps backups (H7, B4)

**Files:**
- Modify: `src/destroy.js` (`deleteAppBucketEffect` ~1287-1325: `deletePrefix(bucket, keyPrefix)` runs only with `-purge`; plain destroy keeps the prefix and records it), `src/lib/destroy/preview.js` (~96-111: "objects under <prefix> PRESERVED with the database backups"), `docs/` lines that describe plain-destroy object deletion.
- Test: `tests/unit/destroy/restorable-unit.test.ts` (new); update `tests/unit/destroy/app-bucket-env-scope.test.ts` (the bucket branch's plain-destroy case).

- [ ] **Step 1: Write the failing tests.**
  - A plain destroy calls neither `deletePrefix` nor `emptyAndDeleteBucket` on the app bucket. `-purge` deletes the prefix, and deletes the bucket when no other env holds it.
  - The census walks destroy-plan effects. No effect deletes app-bucket objects unless `args.purgeBackups` is set (a source walk over `deletePrefix(`/`emptyAndDeleteBucket(` call sites plus a behavioural run of `buildDestroyPlan` with and without `-purge`).
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/destroy`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(destroy): keep an environment's uploads with its database backups`.

### Task 9: Project config writes are atomic and never stale (M6)

**Files:**
- Modify: `src/lib/config.js`.
  - New `updateProjectConfig(mutator)`: take a lockfile (`.vibecarbon.json.lock`, `O_EXCL`, 30 s budget, stale-lock detection by PID), reload, apply `mutator(config)`, write `.vibecarbon.json.tmp`, `fsync`, then `rename`.
  - `saveProjectConfig` becomes internal to it.
- Migrate the writers to `updateProjectConfig` with per-env patches: `destroy.js` (~1479-1508), `scale.js` (~923, ~2048), `orchestrator.js` (~782 and the final save), `failover.js` (`swapHaRoles`), `effects/compose-ha.js` mid-flight persist.
- Test: `tests/unit/config/update-project-config.test.ts` (new), `tests/unit/config/no-stale-save-census.test.ts` (new).

- [ ] **Step 1: Write the failing tests.**
  - Two interleaved `updateProjectConfig` calls (one sets `environments.prod.ha` swapped, one deletes `environments.staging`) both survive.
  - A crash between the tmp write and the rename leaves the original file intact.
  - The census: no call of `saveProjectConfig(` remains under `src/` outside `config.js`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/config`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(config): atomic, locked read-modify-write for .vibecarbon.json`.

### Task 10: Retention by time, and k8s honours the configured schedule (M4, B7)

**Files:**
- Modify: `carbon/backup/compose-backup.sh` (~71-79), `cronjob.yaml` (~22, ~111-121), `carbon/k8s/base/config/configmap.yaml` (~32), `src/lib/deploy/k8s/k3s.js` (render the CronJob `schedule` and `BACKUP_RETENTION_DAYS` from `envConfig.backup`), `src/lib/deploy/compose/index.js` (~1253-1257).
- Retention: `wal-g delete before FIND_FULL "$(date -u -d "-${RETAIN_DAYS} days" +%Y-%m-%dT%H:%M:%SZ)" --confirm`, inside the current lineage only (Task 3's `walg-env.sh`).
- Test: `tests/unit/deploy/backup-config-reaches-runtime-census.test.ts` (new), plus the script tests from Task 6's harness for the retention command.

- [ ] **Step 1: Write the failing tests.**
  - The census: every `envConfig.backup.*` field (`schedule`, `retentionDays`) appears in the rendered compose cron/env and in the rendered k8s CronJob/ConfigMap for a fixture env with `schedule: '0 */6 * * *', retentionDays: 14`.
  - The script test: the retention invocation contains `delete before FIND_FULL` and no `retain FULL`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/backup-config-reaches-runtime-census.test.ts tests/unit/backup`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(backups): retain by days and render the k8s schedule from config`.

### Task 11: `status` shows backup health (M5)

**Files:**
- Modify: `src/status.js` and `src/lib/status/*`. Add a "backups" row: newest base age (from `listBaseBackups`, Task 1), last archived WAL time and `failed_count` (`pg_stat_archiver` via the existing db exec helper), and the count of `WAL_ARCHIVE_FAILED` lines in the last 24 h (compose: `backups/backup.log`; k8s: the last 3 Job pod logs).
  - Red when the newest base is older than `2 × schedule interval`, or the last archived WAL is older than `2 × archive_timeout`.
- Modify: `services/observability` Prometheus rules: an alert on `pg_stat_archiver_last_archived_age` (postgres-exporter metric) over 30 min.
- Test: `tests/unit/status/backup-health-row.test.ts` (new).

- [ ] **Step 1: Write the failing tests.** Fixtures: a fresh base with recent WAL is green; a 3-day-old base with a daily schedule is red with `newest base backup 3 days old`; zero bases give `no base backup in lineage <sysid>`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/status`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(status): show backup and WAL archiving health`.

### Task 12: Every journal migration is proven applied (L2)

**Files:**
- Modify: `carbon/src/server/db/migrate.ts` (~94-99). After `migrate()`, read `drizzle.__drizzle_migrations.hash` and compare it with every journal entry's hash. A missing one fails startup with `migration <tag> was skipped (its timestamp is older than the newest applied one); regenerate it`.
- Add a journal-monotonic check to the template's structural tests (`carbon/tests/structural/template-migrations-census.test.ts`) covering all entries, not just the baseline.
- Test: `carbon/tests/db/migrate-journal-complete.test.ts` (new, real Postgres): an out-of-order journal entry makes startup throw.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run** `cd carbon && npx vitest run tests/db/migrate-journal-complete.test.ts tests/structural/template-migrations-census.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `cd carbon && npm run test:prepush && npm run test:db`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(template): refuse to start when a journal migration was skipped`.

---

## Cross-plan dependencies
- **Bucket branch (base):** Task 3 changes its census arm (c) to accept `WALG_S3_PREFIX_BASE`. Task 8 reverses its plain-destroy prefix deletion (B4).
- **HA correctness (`2026-10-20-ha-correctness.md`):**
  - It owns the promote guard, the reseed source and the failover write fence.
  - This plan adds one `pushBaseBackupAfterPromote` call in `failover.js` (Task 4) and the `servers[].role` swap (Task 5).
  - Land HA correctness first. Its failover changes are the larger edit to `failover.js`, and this plan rebases onto them.
- **TLS cert reuse:** its snapshots live under `tls/<project>/<env>/`, outside `walg/`, so lineage prefixes don't collide. Its purge must also run only on `-purge` (B4 symmetry).
- **Primary-only add-ons:** both plans edit `src/scale.js` (its restore recreate, this plan's fence). Land add-ons first.
- **Price-optimized defaults:** it persists server types before provisioning. Task 9's `updateProjectConfig` should land first, so that plan writes through it.
- **Cold-deploy speed:** no overlap.

## Compatibility (PR body)
- Existing environments archive at `backups/<project>/<env>/walg`. After this change they archive at `…/walg/<sysid>`, and the first base backup at the new path comes from the deploy's post-change backup (Task 4 runs on promote only). So run `vibecarbon backup <env>` once after upgrading.
- Old objects at the un-suffixed path stay readable with `wal-g` by hand.
- Plain destroy now keeps uploaded files; `-purge` removes them.
- `vibecarbon scale` on compose now pauses writes during the cutover and prints the window.

## Verification
- **Per task:** the listed commands, red then green, with each census arm shown failing on a deliberate break.
- **End of branch:**
  - `pnpm lint && pnpm test:unit && pnpm test:integration`;
  - `pnpm test:docker`;
  - `cd carbon && npm run test:prepush && npm run test:db`.
- **Real infra (needs Brandon's OK):** `--scenario hetzner/k8s` (exercises the new `restore-deploy` step), `hetzner/compose` (scale fence, restore), `hetzner/compose-ha` (restore after failover keeps post-failover writes).
