# Backup and Restore Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every backup, restore, scale and destroy path either preserves the operator's data or fails before touching it, and says truthfully which one happened.

**Architecture:**
- **Restore resolves the exact base backup in the CLI first.** It reads wal-g's stop sentinels straight from S3, and the servers fetch that named backup into a staging directory before swapping it in. No path deletes PGDATA before a restore point is proven to exist.
- **Each database lineage gets its own archive folder.** The WAL-G prefix gains the Postgres system identifier, inside the env folder the bucket branch made. A fresh initdb gets a new folder; a restore, reseed or failover keeps its lineage, because all three preserve the identifier. The HA backup fence moves into the lineage folder with it.
- **Every promotion ends with a fresh base backup.**
- **One primary resolver.** All commands find the live primary through it.
- **Backup scripts report `pushed` or `skipped`** through a machine-readable line.

**Tech Stack:** Node ESM CLI (`src/`), POSIX sh in `carbon/backup`, `carbon/volumes/db` and `carbon/k8s/base`, wal-g 3.0.9, PG17 (`postgres:17.11-walg3.0.9-r2`), `@aws-sdk/client-s3`, vitest.

**Spec:** the data-integrity review at `/tmp/claude-1000/-home-brandon-repos-vibecarbon/0b7ee7cd-7067-44f6-a72a-5ce5d7505b2c/scratchpad/arch-review/data-integrity.md` (16 findings, C1/H1-H7/M1-M6/L1-L2).

**Base:** `feat/backup-restore-integrity`, stacked on env app bucket (#233, merged), security (#234), HA correctness (#235) and primary-only add-ons (#236). The prefix is already per environment (`backups/<project>/<env>/walg`, from `resolveEnvStorage().walgPrefix`, `src/lib/deploy/prompts.js:514-531`).

## Refresh 2026-10-21

Re-checked every cited file, line and claim against `d1fe1b2` (the top of the stack). What changed:

- **Task 8 (H7, destroy keeps uploads) is dropped. #233 shipped it.** `deleteAppBucketEffect` (`src/destroy.js:1339`) keeps the env's own app bucket on a plain destroy and deletes it only with `-purge`. The preview says the same (`src/lib/destroy/preview.js:98-108`), and `tests/unit/destroy/app-bucket-env-scope.test.ts:131-150` pins both cases. Ruling B4 stands and is now the shipped behaviour. The heading stays so the task numbers other plans cite (Task 9's `updateProjectConfig`) stay stable.
- **Task 3 (one prefix per lineage) is still fully needed. The HA backup fence does not cover H1.** The fence (`src/lib/deploy/backup-fence.js`, `vibecarbon-fence.json` at the root of `WALG_S3_PREFIX`, recorded as `ha.backupFence`) only refuses a push from the *same* system identifier on an older timeline. Its header says it outright: "Another system identifier is another database (a destroyed and recreated env): allowed." So a destroyed-then-redeployed env still archives into, and takes `LATEST` over, the preserved archive. Single-node envs never write a fence at all. Task 3 is reshaped in three ways:
  - the fence object moves into the lineage folder with `WALG_S3_PREFIX`, and every in-container `wal-g` exec the CLI builds (fence write, `walg-audit.js`, the backup scripts) must source `walg-env.sh`;
  - the census also covers those JS-built shell scripts;
  - recording the lineage after every deploy would point restore at the new, empty lineage after a DR redeploy, so the env keeps its prior lineages and restore refuses on ambiguity (new ruling B8).
- **Task 4 (base backup after promotion) is still fully needed. Nothing on the stack pushes a base backup after a promotion** (`git grep "backupCompose(\|triggerBackupJob("` finds only `backup.js`, `scale.js` and `destroy.js`). The HA work fixed who may push (the WALG_ROLE move in `restorePromotedWalgRole`/`restoreComposeWalgRole`, the retirement fence, the backup fence). It did not give the new timeline a base. The task is reshaped:
  - the call goes after the WALG_ROLE move and the swap save that clears `ha.failoverInFlight`, because a push on a node still at `WALG_ROLE=standby` is a skip;
  - `restorePromotedWalgRole` lives in `src/failover.js:1583`, not `k8s/ha/index.js`;
  - `deploy -restore` (Task 2) is added as a promote site.
- **Task 7 (compose scale fence) is reshaped to reuse what HA shipped.** It uses `fenceDatabaseWrites`/`unfenceDatabaseWrites` (`src/lib/deploy/replication.js:1816,1866`), `stopOldPrimaryWriters`/`startOldPrimaryWriters` with `composeWriterServices` (`compose/ha.js:1578,1616`, `services/standby-policy.js:101`, so the primary-only add-ons stop too) and `demoteComposeWalgRole` (`compose/ha.js:1396`), so no second implementation of any of them is written. The scale restores the exact name the fenced backup pushed, never a re-listed `latest`. The outro's "(zero downtime)" (`src/scale.js:1034`) goes.
- **Task 1:**
  - The k8s restore marker now lives on Secret `vibecarbon-infra-secrets` (#234 split the Secrets), set by `setRestoreMarker` (`src/restore.js:702`).
  - M1 is partly done. `dca3d06` raised the rollout wait to `DB_STS_BOOT_TIMEOUT_S = 600` (`replication.js:39`), but the marker is still cleared in a `finally` (`restore.js:809`), which is the half that matters. The size-scaled budget keeps 600 s as its floor.
  - `244f57e` already proves the restored primary writable (`assertRestoredPrimaryWritable`, `restore.js:677`). That stays, and the recovery builder also strips `default_transaction_read_only` so a fenced base comes back writable by construction.
  - The k8s init container carries a quarantined staleness ladder (`docs/mitigations.yml`, site `walg-restore WALG_FETCH_ATTEMPTS`). The staged rewrite keeps that site as it is and adds no new retry. The CLI's sentinel read gets none.
  - The single-server failover guide lists backups by SSH to the server that just died (`failover.js:2375-2403`). It moves to `listBaseBackups`.
  - The `.vc-restore-in-progress` check moves out of the db image (`docker/postgres-walg/db-entrypoint.sh` would force a db image republish and a 7-file tag bump) into a mounted guard script.
- **Task 2:** `buildVibecarbonSecretData` is now `buildInfraSecretData` (`k3s.js:1894`). The "ignored here" comment is at `k3s.js:3014`, and its reasoning ("the app's startup migrations apply what the backup lacks") is stale since #234: the `migrate` init container applies them. The db wait is `awaitDbRollout` (`k3s.js:2470`).
- **Task 5:** the census surface is smaller. Outside the DNS writers there are 16 positional hits now (the plan said 29); `backup.js` already resolves `serverIp: 'primary'`. `rolePrimaryOf` (`orchestrator.js:476`) is already a role resolver, so the task extracts it rather than writing a new one. k8s-ha `servers[]` still carries only `name` (`orchestrator.js:1990-2007`), and `swapHaRoles` (`failover.js:1373`) still leaves `servers[]` alone.
- **Task 6:** `triggerBackupJob` lives in `src/backup.js:235`. The backup scripts gained exit-1 refusals (the retired-node marker and the backup fence), which stay errors with no marker. The e2e backup step greps `/uploaded to s3/i` (`tests/e2e/scenarios/_run-lifecycle.ts:3817`), so it moves to the marker-driven wording in the same task. The plan's "confirm that name is newest in backup-list" is dropped: a fresh push can be missing from a listing for a while (Hetzner read-after-write staleness), and the marker already names the backup.
- **Task 9:** the save sites grew with the HA work (`failover-guard.js` ×4, `orchestrator.js` ×3, `access.js` ×3, `write-fence.js` ×2, `effects/compose-ha.js` ×2, `scale.js` ×2, `destroy.js` ×2, plus `operator-ip.js`, `failover-abort.js`, `compose/ha.js` `swapComposeHaRoles`, `backup-fence.js`, `failover.js` `swapHaRoles`, `configure.js`). `a963dc6`'s `envS3Record` builder stays the only way an `s3` block is built.
- **Task 10:** the retention site is now `setupComposeBackupCron` (`compose/index.js:1266-1275`). The task adds a check that `wal-g delete before` leaves `vibecarbon-fence.json` alone, as the fence commit checked for `delete retain`.
- **Task 11:** the observability add-on has Prometheus and postgres-exporter but no Alertmanager and no `rule_files`. A Prometheus rule would alert nobody, so the alert becomes a Grafana panel on the shipped `postgresql.json` dashboard. `status` already has a `Backup fence` row (`status.js:1343`). The backups row sits next to it.
- **Task 12:** #234 moved migrations out of the app process. They now run in `migrate-cli.ts` (compose `app-migrate`, the k8s `migrate` init container), and the app only verifies (`verifyMigrations`, run as `app_service`). The ledger check goes in both places: `runMigrations` throws, which fails the migrate step and the deploy, and `verifyMigrations` compares hashes, not the max timestamp.
- **New finding (see Decisions):** a compose-ha scale of the standby arm runs `restoreCompose(newIp, 'latest')` on the replacement standby (`scale.js:851`, no role check). That makes the replacement an independent promoted database, not a streaming replica, and nothing reseeds it before the outro. Task 7 now owns the per-role arm split.
- **Re-verification notes below are updated** to the current line numbers.

### Decisions for the controller
1. **B2 needs local backup credentials for restore.** Today `restore.js:366-368` says the operator needs no local S3 credentials. B2 reads sentinels from the CLI, so restore resolves the credentials the way `backup -l` does (`resolveS3Config`, `backup.js:523-550`: `Provider.promptObjectStorageCredentials`). With `-y` and no credentials in the environment, restore fails before stopping anything and names the variable. Recommended: accept it. The alternative is an in-container `wal-g backup-list --detail --json` on compose plus a one-shot pod on k8s, which is two resolvers.
2. **B8, lineage choice after a DR redeploy.** Recommended: the env records `backup.lineage` and keeps `backup.priorLineages`. A restore with no `-lineage` uses the current lineage only when it has a base that covers the target and no prior lineage has a newer one; otherwise it refuses and lists both. A fresh deploy into an env whose folder already has another lineage with base backups prints the `restore -lineage` command. The review's alternative was refusing a fresh DB without `-restore`/`-fresh-db`.
3. **compose-ha scale, standby arm.** Recommended (in Task 7): the standby arm never restores. It reseeds the replacement from the role primary through the shared staged reseed and proves it streaming, as restore's compose-ha reseed does. When the primary arm runs, the standby is reseeded from the new primary afterwards, or marked `replication: 'degraded'` with the deploy hint. Not checked on real infra.
4. **Task 11 alert.** Recommended: a dashboard panel only, and alert delivery stays out of scope. Adding Alertmanager is a separate add-on decision.

## Re-verification notes (refreshed 2026-10-21 at d1fe1b2)
- **C1 holds.** `k3s.js:3014` still says "`restore` is accepted for the caller's input hash and ignored here". `RESTORE_TARGET` is written only by `setRestoreMarker` (`src/restore.js:702-713`), onto `vibecarbon-infra-secrets`. Nothing under `tests/e2e` passes `-restore`.
- **H2/H3 hold.**
  - `composeRestoreScript` (`compose/index.js:1316-1366`) wipes at 1336-1338, then runs `backup-fetch "$PGDATA" LATEST` at 1341.
  - The k8s `walg-restore` init (`statefulset.yaml:98-200`) wipes at 111-114, then fetches `LATEST` at 139.
- **H4 holds**, at `src/lib/cli/env-context.js:76-78`. The non-DNS positional hits are `destroy.js` 1953/1973/1982/2101/3573, `failover.js` 242/2376, `select-environment.js:100`, `orchestrator.js:1516-1519`, `remote-containers.js:75,80`, `status.js:510`. The `servers[0]` hits in the six `*-dns.js` writers are the apex-record callers, which take the target list from their caller.
- **H5, current counts.**
  - `compose-backup.sh` has 5 `exit 0` skips: 35 (`flock -n`), 61, 66, 74, 78. It has 4 `exit 1` refusals: 29 (retired node), 92, 103, 107 (backup fence).
  - `cronjob.yaml` has 2 skips (103, 119).
- **H6 holds.** `scaleServers` (`scale.js:547`) starts the old-server backup at 580-588, awaits it at 846 and runs `restoreCompose(newIp, 'latest')` at 851. The old server's app and add-ons are never stopped and its database never fenced.
- **H7 is fixed by #233** (see Refresh).
- **M3 holds** at `destroy.js:3572-3596`: positional `servers[0]`, no k8s branch, and "Continuing with destroy..." on failure.
- **M4 holds.**
  - compose: `delete retain FULL ${RETAIN}`, `compose-backup.sh:118-120`, fed from `setupComposeBackupCron` (`compose/index.js:1266-1275`).
  - k8s: `cronjob.yaml:22` hardcodes `0 2 * * *`, the retention is at 170-171, and `configmap.yaml:32` sets `BACKUP_RETENTION_DAYS: "7"`.
  - The defaults are at `prompts.js:1074-1076`.
- **M6 holds.** `saveProjectConfig` (`config.js:127-130`) is a plain `writeFileSync` with no lock.
- **L1 holds** at `backup.js:644-688`.
- **L2 holds.** `verifyMigrations` (`carbon/src/server/db/migrate.ts:59-66`) compares only `max(created_at)`.

## Rulings (made while planning; B4/B5/B6 updated 2026-10-21)
- **B1, lineage = the Postgres system identifier, not a CLI-minted generation.**
  - initdb mints it.
  - `pg_basebackup`, `backup-fetch` and promotion all preserve it, so restores, standbys and failovers stay in their lineage while a fresh database gets a new one.
  - Nothing has to be minted, persisted before boot, or kept in sync.
  - Prefix: `backups/<project>/<env>/walg/<sysid>`. It stays inside the per-project backup bucket's env folder, so no bucket is created.
  - The HA backup fence's "same sysid, newer timeline" rule still works inside one lineage folder, because a failover never changes the sysid.
  - Cost if wrong: an operator restoring across lineages must name the lineage; `vibecarbon restore` lists them.
- **B2, the base backup is resolved in the CLI from S3 sentinels**, not with `wal-g backup-list` inside a container.
  - A fresh k8s cluster has no running database to exec into, and a dead single server has no container at all.
  - The sentinel format is pinned to wal-g 3.0.9 by a fixture test.
  - Cost if wrong: a wal-g bump that renames sentinel fields fails the fixture test loudly.
  - Cost accepted: restore needs the backup credentials locally (Decision 1).
- **B3, keep `recovery_target_timeline = 'current'` and pick the right base instead.** B5 puts a base backup on every new timeline, so the newest base at or before the target is on the timeline that was live at the target. Cost if wrong: a target inside the gap between a promotion and the end of its base backup fails before the wipe (preflight), not after.
- **B4, plain destroy keeps the environment's uploaded objects whenever it keeps its database backups. `-purge` deletes both.** Shipped by #233. Task 8 is dropped.
- **B5, base backup after promotion.** This plan owns the helper and the census across every promote site, failover included. HA correctness has landed (promote guard, reseed source, write fence, backup fence, failover journal). The call goes after the WALG_ROLE move and after the save that clears `ha.failoverInFlight`, so a failed push never leaves a journal behind.
- **B6, scale fences writes with explicit downtime.** It reuses the HA write fence (`fenceDatabaseWrites`) and the writer stop (`stopOldPrimaryWriters` with `composeWriterServices`, so the primary-only add-ons stop too). The CLI prints the downtime window.
- **B7, retention is by time.** `retentionDays` means days: `wal-g delete before FIND_FULL <ISO date>`. It runs inside the current lineage only. Older lineages are removed only by `-purge`.
- **B8 (new), the lineage on the record.** After every deploy the CLI records `envConfig.backup.lineage`. A changed value pushes the old one onto `backup.priorLineages` (newest first, with its newest finish time). The `backup` block already rides `destroyedEnvironments` (`env-identity.js:35`). Restore without `-lineage` refuses when the choice is ambiguous (Decision 2).

## Global Constraints
- No customers, pre-1.0: no migration code for old prefixes or config keys, and no legacy compatibility code (including for Supabase-era environments). Ship a Compatibility note and no `!:` footer or `BREAKING CHANGE`.
- No Supabase vocabulary in code, comments, docs or messages.
- No retry ladders. A failed backup, a failed preflight or a failed fence fails the command with one line naming the cause. The existing quarantined staleness sites in `docs/mitigations.yml` keep their names and get no new members.
- Storage layout: an app bucket per env; state and backups per project, with env folders. No path in this plan creates a bucket. Restore, redeploy and the sentinel reader only read, list or put objects inside the env's folder.
- Never print secrets. A sentinel read uses the backup credentials and logs only bucket, prefix and backup names.
- dotenv writes only through `formatDotenvLine` (the old server's `WALG_ROLE` edit goes through `demoteComposeWalgRole`, which already does). Every shell edit to `wal-archive.sh` keeps its byte-parity with `carbon/k8s/base/backup/configmap-walg.yaml` (`walg-archive-script-parity.test.ts`). `walg-env.sh` gets the same parity.
- No db image change. Nothing here edits `docker/postgres-walg/`, so no tag bump and no `publish-db-image` run.
- Every task ships its class census (a walk, not a hand list), and the report shows each census arm failing on a deliberate break.
- Conventional commits, pathspec commits, never `--no-verify`. Root uses pnpm; `carbon/` uses npm.

## Review Focus
1. **Restore on an env with no backup, or with a target older than the oldest base.** The command fails before stopping anything, and the database and app keep running untouched. Test: Task 1.
2. **`vibecarbon deploy prod -mode k8s -restore latest` on a fresh cluster.** Rows written before the destroy are present after it. Test: Task 2, unit plus the new e2e step.
3. **Destroy, then redeploy the same env without `-restore`.**
   - The new database archives under a new lineage.
   - The preserved lineage's objects are byte-identical afterwards.
   - `vibecarbon restore` lists both and refuses to guess.

   Test: Task 3.
4. **Failover (or restore, scale, or `deploy -restore`), then `restore latest`.** Post-promotion writes are present. Test: Task 4, db-tier integration.
5. **`backup create` against a standby, a retired node, or a node with no S3 credentials.** It reports `skipped: <reason>` (or the refusal) and exits non-zero; destroy and scale abort. Test: Task 6.
6. **Compose-ha scale.** The replacement standby streams from the primary afterwards and is never a second promoted database. Test: Task 7.

## File Map
- New `src/lib/walg/restore-base.js`: sentinel listing, base resolution, lineage listing (B2/B3/B8).
- New `src/lib/walg/recovery-config.js`: one builder for the recovery block (compose and k8s).
- New `src/lib/walg/post-promote-backup.js` (B5).
- New `carbon/volumes/db/walg-env.sh`, with its byte-identical copy in `carbon/k8s/base/backup/configmap-walg.yaml`: exports the lineage-scoped `WALG_S3_PREFIX`.
- New `carbon/volumes/db/db-guard.sh`: the compose db entrypoint wrapper that refuses an interrupted restore, then execs the image entrypoint.
- `carbon/volumes/db/wal-archive.sh`, `carbon/backup/compose-backup.sh`, `carbon/k8s/base/backup/cronjob.yaml`, `carbon/k8s/base/backup/configmap-walg.yaml`, `carbon/k8s/base/db/statefulset.yaml`, `carbon/k8s/base/config/configmap.yaml`, `carbon/docker-compose.yml`.
- `src/lib/deploy/compose/index.js` (`composeRestoreScript`, `restoreCompose`, `backupCompose`, `setupComposeBackupCron`), `src/lib/deploy/backup-fence.js`, `src/lib/deploy/walg-audit.js`, `src/restore.js`, `src/backup.js`, `src/scale.js`, `src/destroy.js`, `src/failover.js`, `src/lib/deploy/compose/ha.js`, `src/lib/deploy/k8s/k3s.js`, `src/lib/deploy/orchestrator.js`, `src/lib/cli/env-context.js`, `src/lib/config.js`, `src/status.js`, `src/lib/walg-backups.js` (retired in favour of `restore-base.js`).
- `carbon/src/server/db/migrate.ts` (L2).
- `services/observability/volumes/grafana/dashboards/postgresql.json` (M5 panel).
- `tests/e2e/scenarios/_run-lifecycle.ts` (Task 2 step, Task 6 wording).
- Tests are listed per task.

---

### Task 1: Restore resolves its base in the CLI and never wipes before it is proven (H3, H2a, M1, M2)

**Files:**
- Create: `src/lib/walg/restore-base.js`, `src/lib/walg/recovery-config.js`, `carbon/volumes/db/db-guard.sh`.
- Modify:
  - `src/lib/deploy/compose/index.js`: `composeRestoreScript` 1316-1366, `restoreCompose` 1401-1549;
  - `carbon/k8s/base/db/statefulset.yaml`: init container `walg-restore`, 98-200, and its env;
  - `carbon/docker-compose.yml`: the db `entrypoint` becomes `db-guard.sh`, mounted from `carbon/volumes/db`;
  - `src/restore.js`: `run` 269-470, `pickInteractiveSource` 476-510, `setRestoreMarker` 702, `runK8sRestore` 715-830;
  - `src/failover.js`: `failoverSingleServer` 2375-2403 lists through `listBaseBackups`;
  - `src/backup.js`: `runList` (`-l`) lists through `listBaseBackups`;
  - `src/lib/walg-backups.js`: deleted once no caller remains. `walg-audit.js:100,345` takes `parseWalgBackupList` along into `restore-base.js` or inlines its count.
- Test: `tests/unit/walg/restore-base.test.ts`, `tests/unit/walg/recovery-config.test.ts`, `tests/unit/deploy/restore-destroy-before-verify-census.test.ts` (new); a fixture at `tests/fixtures/walg/sentinel-3.0.9.json` (captured from a real wal-g 3.0.9 push; the Docker integration test below creates one); update `tests/unit/restore/k8s-ha-reseed.test.ts` and `compose-ha-reseed.test.ts` for the new call order.

**Interfaces:**
- Produces:
  - `listBaseBackups({ s3, bucket, prefix }) -> Promise<Array<{ name, timeline: number, startLsn: string, finishTime: Date, sizeBytes: number }>>`. It reads `<prefix>/basebackups_005/*_backup_stop_sentinel.json`. The timeline is the first 8 hex digits after `base_`. `sizeBytes` is `CompressedSize`, or `UncompressedSize` when the compressed size is absent. It never creates or probes for a bucket. A missing bucket or prefix is an empty list with the bucket named, not an error that suggests a create.
  - `resolveRestoreBase(backups, target: 'latest' | Date) -> { name, timeline, finishTime, sizeBytes }`. For `latest` it returns the newest by `finishTime`. For a Date it returns the newest with `finishTime <= target`. It throws `NoRestorePointError` when none exists, with the oldest and newest finish times in the message.
  - `buildRecoveryConfig({ target: 'latest' | string }) -> { strip: string[], lines: string[] }`.
    - `strip` lists the settings removed from `postgresql.auto.conf` before appending: `restore_command`, `recovery_target_*`, `recovery_target_action`, and `default_transaction_read_only`, so a base taken under a stranded write fence comes back writable by construction. `assertRestoredPrimaryWritable` stays as the proof.
    - `lines` are the appended lines, in exactly the form compose writes today.
    - The k8s init container gets both through `RESTORE_RECOVERY_CONF`, rendered by the CLI.
- Both tiers fetch `RESTORE_BACKUP=<name>` (never `LATEST`) into `$PGDATA.restore` on the same volume, then:
  1. write `$PGDATA.restore/.vc-restore-in-progress`;
  2. `mv "$PGDATA" "$PGDATA.prev" && mv "$PGDATA.restore" "$PGDATA"`;
  3. remove the marker once `recovery.signal` and the recovery config are in place;
  4. remove `$PGDATA.prev` only after the CLI confirms promotion (`pg_is_in_recovery() = false`) and `assertRestoredPrimaryWritable` passed.
- A boot that finds `.vc-restore-in-progress` with no `RESTORE_BACKUP` set exits 1 with `restore interrupted; rerun vibecarbon restore`. Compose checks it in `db-guard.sh` (the db container's entrypoint, which then `exec`s `db-entrypoint.sh`). k8s checks it in the `walg-restore` init container, which runs on every boot.
- The k8s marker keys (`RESTORE_TARGET`, `RESTORE_BACKUP`, `RESTORE_RECOVERY_CONF`) are set on `vibecarbon-infra-secrets` by one `setRestoreMarker({ backup, target, recoveryConf })`.
- The k8s fetch keeps the quarantined staleness ladder exactly as `docs/mitigations.yml` names it (`walg-restore WALG_FETCH_ATTEMPTS`). Each retry clears `$PGDATA.restore`, never `$PGDATA`. The CLI-side sentinel read gets no retry.
- Credentials for the sentinel read come from `resolveS3Config` (moved from `backup.js` to `restore-base.js` and shared). With `-y` and no credentials, restore fails before any stop and names the variable.

- [ ] **Step 1: Write the failing tests.**
  - `resolveRestoreBase`:

    ```ts
    const A = { name: 'base_000000010000000000000002', timeline: 1, finishTime: new Date('2026-10-20T01:00:00Z') };
    const B = { name: 'base_000000010000000000000004', timeline: 1, finishTime: new Date('2026-10-20T02:00:00Z') };
    const C = { name: 'base_000000020000000000000006', timeline: 2, finishTime: new Date('2026-10-20T03:00:00Z') };
    expect(resolveRestoreBase([A, B, C], 'latest').name).toBe(C.name);
    expect(resolveRestoreBase([A, B, C], new Date('2026-10-20T02:30:00Z')).name).toBe(B.name);
    expect(() => resolveRestoreBase([A, B, C], new Date('2026-10-20T00:30:00Z'))).toThrow(/oldest .*01:00/);
    expect(() => resolveRestoreBase([], 'latest')).toThrow(NoRestorePointError);
    ```
  - `listBaseBackups` against the fixture parses `name`, `finishTime`, `sizeBytes` and a `timeline` of 1, and calls only `ListObjectsV2`/`GetObject` (no create/head-bucket call on the fake client).
  - `buildRecoveryConfig({target:'latest'})` contains `recovery_target_timeline = 'current'` and no `recovery_target_time`. `{target:'2026-10-20T09:55:00Z'}` contains `recovery_target_time = '2026-10-20T09:55:00Z'`. Both strip `default_transaction_read_only`.
  - Byte parity: the rendered k8s `RESTORE_RECOVERY_CONF` equals the compose script's strip-and-append lines (M2).
  - The census walks `composeRestoreScript()` output and the `walg-restore` init script in `statefulset.yaml`:
    - every `rm -rf` targeting `$PGDATA`/`${PGDATA}` appears only after the line containing `backup-fetch`, and targets `$PGDATA.prev`, `$PGDATA.restore` or the marker;
    - no `backup-fetch … LATEST` remains in either;
    - the staleness retry's clear targets `$PGDATA.restore`.
  - `restore.js`, unit level: with a fake S3 returning zero sentinels, `runComposeRestore` and `runK8sRestore` throw `NoRestorePointError` before any `docker compose stop`, `kubectl patch` or `scale` call (spy on the SSH/kubectl runners).
  - M1:
    - the k8s rollout wait is `max(DB_STS_BOOT_TIMEOUT_S, ceil(sizeBytes / 20 MiB/s))` seconds;
    - the marker keys are cleared only after the pod is Ready and `assertWritable` passed, never in a `finally`;
    - a rollout failure leaves the Secret keys set, and the error names `kubectl logs ${DB_POD} -c walg-restore`.
  - The interrupted-restore guard: `db-guard.sh` under `sh` with a PGDATA holding `.vc-restore-in-progress` and no `RESTORE_BACKUP` exits 1 with the message. Without the marker it execs the stub entrypoint.
  - The failover single-server guide and `backup -l` list through `listBaseBackups` and never SSH (a census: no `wal-g backup-list` string remains under `src/`).
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/walg tests/unit/deploy/restore-destroy-before-verify-census.test.ts tests/unit/restore`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `restore.js` resolves credentials, calls `listBaseBackups` and `resolveRestoreBase` before `assertNoFailoverInFlight`'s later work and before any stop, and passes `RESTORE_BACKUP` plus the rendered recovery config to `composeRestoreScript` and to `setRestoreMarker`.
  - Replace the "recovery window oldest → newest" line (`restore.js:507`) and the "operator does NOT need local S3 credentials" comment (`restore.js:366-368`). Print the resolved backup name and its finish time in the confirmation block (`restore.js:395-398`).
- [ ] **Step 4: Docker integration.** Add `tests/integration/docker/db-restore-staged.test.ts` (`DOCKER_INTEGRATION=true`). It runs the db image `postgres:17.11-walg3.0.9-r2` with a MinIO container (digest-pinned, a release at least two weeks old) and walks through:
  1. push a base backup, then write a row;
  2. call `composeRestoreScript` with a missing backup name, which exits non-zero, and the original PGDATA rows are still present;
  3. restore with the real name, which completes, and the row from before the base is present.

  Save that run's sentinel as the fixture.
- [ ] **Step 5: Run** `pnpm vitest run tests/unit` and `pnpm test:docker -- tests/integration/docker/db-restore-staged.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `fix(restore): resolve the base backup first and never wipe PGDATA before it is proven`.

### Task 2: k8s `deploy -restore` restores (C1)

**Files:**
- Modify: `src/lib/deploy/k8s/k3s.js`:
  - `buildInfraSecretData` (1894) takes `restore`;
  - `applyK3sManifests` (doc at 3005-3017): delete the "ignored here" paragraph;
  - the db wait after `awaitDbRollout` (2470);
  - the `options.restore` pass-through at 4698/4725.
- Modify: `src/lib/deploy/orchestrator.js:1448-1452`, so the resolved base travels with `args.restore`.
- Test: `tests/unit/deploy/k8s-deploy-restore.test.ts` (new), `tests/unit/deploy/flag-reaches-runtime-census.test.ts` (new), `tests/e2e/scenarios/_run-lifecycle.ts` (new step `restore-deploy`, k8s only).

**Interfaces:**
- Consumes: `listBaseBackups`, `resolveRestoreBase`, `buildRecoveryConfig`, `setRestoreMarker`'s key set (Task 1), and `assertRestoredPrimaryWritable` (`restore.js:677`).
- `deployK3s` with `options.restore`:
  1. resolves the base (fail before any apply with `NoRestorePointError`);
  2. writes `RESTORE_BACKUP`, `RESTORE_TARGET` and `RESTORE_RECOVERY_CONF` into `vibecarbon-infra-secrets` before the db StatefulSet applies;
  3. after `awaitDbRollout` reports Ready, `pg_is_in_recovery()` is false and `assertRestoredPrimaryWritable` passed, clears them;
  4. lets the app rollout's `migrate` init container apply what the backup lacks (no restore special case, but the comment now says so truthfully).

  The k8s-ha standby keeps `restore: null` (existing behaviour, asserted). The deploy's HA finalize rewrites the backup fence from the restored primary, as every HA deploy does.

- [ ] **Step 1: Write the failing tests.**
  - `buildInfraSecretData({ envLocal, restore: { backup: 'base_000000010000000000000003', target: 'latest', recoveryConf: '…' } })` contains all three keys. Without `restore`, it contains none.
  - The deploy-order test: the Secret patch happens before the StatefulSet apply, and the clear happens after `awaitDbRollout` and the writable check. A failed rollout leaves the keys set.
  - The census walks `SPEC` flags in `src/deploy.js` that flow into `executeDeployment` options. For each one, at least one non-hash reader under `src/lib/deploy` renders it into a manifest, Secret, env or command (an AST or regex walk for `options.<flag>`/`args.<flag>` outside the input-hash builder at `k3s.js:325-339`). Today `restore` fails this; after the fix it passes. Record each arm's deliberate break in the report.
  - The e2e step `restore-deploy` (k8s and k8s-ha), after `destroy` with backups preserved:
    1. `vibecarbon deploy <env> -mode k8s -restore latest -y`;
    2. assert that the marker row written before the destroy (the existing restore scenario's sentinel row) is present;
    3. run `tests/unit/e2e` for the step's planner and the hollow-pass census.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/k8s-deploy-restore.test.ts tests/unit/deploy/flag-reaches-runtime-census.test.ts tests/unit/e2e`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** the same command, then `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(k8s): deploy -restore seeds the database from the resolved backup`.

### Task 3: One archive folder per database lineage, and overwrite protection (H1, B1, B8)

**Files:**
- Create: `carbon/volumes/db/walg-env.sh`, plus its copy as a key in `carbon/k8s/base/backup/configmap-walg.yaml`.
  - It reads the base from `WALG_S3_PREFIX_BASE`. When that is empty it exports an empty `WALG_S3_PREFIX`, which keeps the dev "no target" skip.
  - When `RESTORE_LINEAGE` is set, it exports `WALG_S3_PREFIX="${WALG_S3_PREFIX_BASE}/${RESTORE_LINEAGE}"`.
  - Otherwise it uses the sysid from `pg_controldata "$PGDATA" | awk -F': *' '/Database system identifier/{print $2}'`.
  - A PGDATA it cannot read exits 1 with `walg-env: no database system identifier in $PGDATA`.
- Modify:
  - `carbon/docker-compose.yml:286-298`: rename the db env var to `WALG_S3_PREFIX_BASE` and add `WALG_PREVENT_WAL_OVERWRITE: "true"`. `docker-compose.override.yml:29` keeps the documented empty dev override under the new name.
  - `src/lib/deploy/k8s/k3s.js` (`buildDbManifestValues`, 2579-2604), `statefulset.yaml` (db container env 343, the walg-restore init, the header doc at 19), `cronjob.yaml`, `configmap-walg.yaml`: the same rename and setting, all sourcing `walg-env.sh`.
  - `wal-archive.sh` (both copies), `compose-backup.sh`, the CronJob script: source `walg-env.sh` before the fence read.
  - The CLI-built in-container scripts source it too: the fence read/write in `src/lib/deploy/backup-fence.js` (script at 128-140), the audit probe in `src/lib/deploy/walg-audit.js:154-175`, and `backupCompose` (via `compose-backup.sh`). So `vibecarbon-fence.json` lands in the lineage folder.
  - `src/lib/deploy/prompts.js:514-531`: `resolveEnvStorage().walgPrefix` keeps returning the base.
  - `src/lib/deploy/orchestrator.js`: after every successful deploy, read `SELECT system_identifier FROM pg_control_system()` on the role primary and record `envConfig.backup.lineage`. A changed value pushes the old one onto `backup.priorLineages` (B8). The `backup` block already rides `destroyedEnvironments` (`src/lib/env-identity.js:35`), so `env-identity.js` gets a test, not an edit.
  - `src/restore.js` and `deploy -restore` (Task 2): a `-lineage <sysid>` flag, with the B8 default and refusal; the init container and `composeRestoreScript` get `RESTORE_LINEAGE`.
  - `src/lib/walg/restore-base.js`: `listLineages` by `ListObjectsV2` with `Delimiter: '/'` under the base.
  - A fresh deploy into an env whose base already holds another lineage with base backups prints `vibecarbon restore <env> -lineage <sysid>` for each (no refusal, Decision 2).
- Test: `tests/unit/deploy/walg-lineage-prefix-census.test.ts` (new), `tests/unit/restore/restore-lineage.test.ts` (new), the existing `walg-archive-script-parity.test.ts` (extended to `walg-env.sh`), and `tests/unit/deploy/backup-fence.test.ts` (the stub-binary harness now runs the scripts with `walg-env.sh` sourced).

**Interfaces:**
- Consumes: `listBaseBackups({ prefix })` (Task 1), called with `<base>/<lineage>`.
- Produces: `listLineages({ s3, bucket, base }) -> Promise<Array<{ lineage: string, newestFinish: Date|null }>>` and `resolveRestoreLineage({ envConfig, lineages, flag }) -> string`, which throws `AmbiguousLineageError` listing each lineage with its newest finish time.

- [ ] **Step 1: Write the failing tests.**
  - The census renders both tiers and walks every shell script the CLI builds for `docker compose exec`/`kubectl exec` (grep for `wal-g ` in `src/`):
    - every WAL-G-using container, script or CLI-built script either sources `walg-env.sh` or is `walg-env.sh`;
    - `WALG_PREVENT_WAL_OVERWRITE` is `"true"` in the compose db env, the db container, the walg-restore init container and the backup CronJob;
    - no file under `carbon/` or `src/` sets `WALG_S3_PREFIX` directly except `walg-env.sh`;
    - `WALG_S3_PREFIX_BASE` carries the env segment (this replaces arm (d) of `app-bucket-single-resolver-census.test.ts:125-146`, which moves to the new name).
  - Restore with no `-lineage`:
    - uses `envConfig.backup.lineage` when it covers the target and no prior lineage is newer;
    - when the current lineage has no base and a prior one does, it fails, listing both with their newest finish times;
    - `-lineage` overrides.
  - A destroy-then-redeploy fixture: `destroyedEnvironments.<env>.backup.lineage` survives destroy. The redeploy pushes it to `priorLineages`.
  - The fence: `writeBackupFence`'s script sources `walg-env.sh` before `wal-g st put`, and the backup-fence harness's refusals still fire with a lineage-suffixed prefix.
  - Docker integration, extending Task 1's test:
    - initdb A, push, then wipe the volume and initdb B;
    - B's pushes land under a different `<sysid>`, and A's sentinel object is unchanged (same ETag);
    - with `WALG_PREVENT_WAL_OVERWRITE=true`, re-pushing an existing segment name with different bytes fails.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/walg-lineage-prefix-census.test.ts tests/unit/restore tests/unit/deploy/walg-archive-script-parity.test.ts tests/unit/deploy/backup-fence.test.ts tests/unit/deploy/app-bucket-single-resolver-census.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit` and the Docker test. Expected: PASS.
- [ ] **Step 5: Commit** `fix(backups): each database lineage archives under its own folder and never overwrites WAL`.

### Task 4: A fresh base backup after every promotion (H2b, B5)

**Files:**
- Create: `src/lib/walg/post-promote-backup.js`.
- Modify:
  - `src/restore.js`: `runComposeRestore` after `restoreCompose` and the writable check; `runK8sRestore` after `scaleUpApp` and before the k8s-ha standby reseed's verdict is printed;
  - `src/scale.js`: after the restore on the new server, before the DNS flip (Task 7 places it);
  - `src/failover.js`, k8s-ha: after `restorePromotedWalgRole` (1583) returns `promoted: true` and after `swapHaRoles` (1373);
  - `src/lib/deploy/compose/ha.js`, compose-ha failover: after `restoreComposeWalgRole` (1288) and `swapComposeHaRoles` (1634);
  - `src/lib/deploy/k8s/k3s.js`: the `deploy -restore` path (Task 2), after the marker clear.
- Test: `tests/unit/walg/post-promote-backup-census.test.ts` (new), `tests/unit/failover/failover-step-order-census.test.ts` (extend), and `tests/integration/docker/db-restore-staged.test.ts` (extend).

**Interfaces:**
- Consumes: `backupCompose` / `triggerBackupJob` returning `{ result, name, reason }` (Task 6).
- Produces: `pushBaseBackupAfterPromote({ tier, ip, sshKeyPath, projectName }) -> Promise<{ name: string }>`.
  - It requires `pushed`.
  - It runs after the RTO-critical steps (DNS flip, health, add-on starts), after the WALG_ROLE move, and after the save that clears `ha.failoverInFlight`.
  - Its failure fails the command with `promoted, but the first base backup on the new timeline failed: <cause>; run vibecarbon backup <env> now`.
  - When the WALG_ROLE move already failed (`walgRoleDegradedMessage`), it is not attempted, and the degraded message names the missing base too (one error, not two).
  - `failover -abort` keeps the old primary on its own timeline, so it does not call it.

- [ ] **Step 1: Write the failing tests.**
  - The census walks `src/` for promote sites: `promoteWithProof(`, `promoteStandby(`, `promoteComposeStandby(`, `pg_promote(`, the `restoreCompose(` and `runK8sRestore(` callers, the scale restore, and the `deploy -restore` marker clear. It asserts each enclosing exported command function also calls `pushBaseBackupAfterPromote`, and lists the sites it found (expect at least 6). The allowlist is `failover-abort.js` (keeps the old primary) and the replication reseed (a standby, no promote), each with its one-line reason.
  - The failover step-order census: on both tiers, `pushBaseBackupAfterPromote` comes after the WALG_ROLE move and the swap save.
  - Docker integration:
    1. base, then restore (promote, TL2), then write, then `restore latest`; the post-promotion write is present;
    2. base, then a promote of a streaming standby, then write, then `restore latest`; the write is present.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/walg/post-promote-backup-census.test.ts tests/unit/failover`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit` and the Docker test. Expected: PASS.
- [ ] **Step 5: Commit** `fix(backups): every promotion ends with a base backup on the new timeline`.

### Task 5: One primary resolver (H4)

**Files:**
- Modify:
  - `src/lib/cli/env-context.js`: new `resolvePrimary(envConfig)`, extracted from `rolePrimaryOf` (`orchestrator.js:476-484`), which then calls it;
  - `src/failover.js`: `swapHaRoles` (1373) also swaps `servers[].role`;
  - `src/lib/deploy/orchestrator.js:1990-2007`: k8s-ha `servers[]` entries carry `role`;
  - the positional sites the census finds: `destroy.js` 1953/1973/1982/2101/3573, `failover.js` 242/2376, `select-environment.js:100`, `orchestrator.js:1516-1519`, `remote-containers.js:75,80`, `status.js:510`, and the fallback in `env-context.js:78`.
- Test: `tests/unit/cli/resolve-primary.test.ts` (new), `tests/unit/cli/no-positional-primary-census.test.ts` (new).

**Interfaces:**
- Produces: `resolvePrimary(envConfig) -> { ip: string, name?: string }`.
  - k8s-ha: `ha.primary.masterIp`.
  - compose-ha: the `servers[]` entry with `role === 'primary'`.
  - Single-node modes: the only server.
  - Throws `AmbiguousPrimaryError` when an HA env has zero or two primaries, or a `servers[]` role that disagrees with `ha.primary`.
- The retired side stays what `retired-fence.js` computes from the same persisted roles. It is not re-derived here.

- [ ] **Step 1: Write the failing tests.**
  - After `swapHaRoles` on a k8s-ha fixture, `resolvePrimary` returns the promoted master IP, and `resolveEnvContext(env, 'primary')` matches it.
  - compose-ha: after `swapComposeHaRoles`, the same holds.
  - Two `role:'primary'` entries throw.
  - The census bans `servers?.[0]` and `servers[0]` under `src/` outside `env-context.js` and the deploy writers that construct the array. The allowlist is a list of writer files, each with a one-line reason; the six `*-dns.js` writers are allowed because they receive their target list from a caller that resolved it.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/cli`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(cli): every command finds the live primary through one resolver`.

### Task 6: Backups report pushed or skipped, and destroy acts on it (H5, M3, L1)

**Files:**
- Modify: `carbon/backup/compose-backup.sh` and `cronjob.yaml`.
  - Every exit-0 path prints exactly one `BACKUP_RESULT=pushed:<name>` or `BACKUP_RESULT=skipped:<reason>`. The compose skips are at 35, 61, 66, 74 and 78; the CronJob skips at 103 and 119.
  - The `flock` "already running" skip (35) becomes `skipped:already-running` and exits 75 (EX_TEMPFAIL).
  - The refusals stay exit 1 with their current line and no marker: retired node (29), backup fence (92, 103, 107, and the CronJob's matching lines).
  - `<name>` comes from `wal-g backup-push`'s own output line.
- Modify:
  - `src/lib/deploy/compose/index.js`: `backupCompose` (1230) returns `{ result: 'pushed'|'skipped', name?, reason? }`;
  - `src/backup.js`: `triggerBackupJob` (235) has the same return, read from the Job's logs; `runCreate` (600-690) prints the pushed name or the skip, and exits 1 on a skip; delete the legacy tar.gz download offer (644-688) and its wrong `backups/` prefix (L1), and remove `listS3Backups`/`downloadS3Backup` (`src/lib/backup-s3.js`) only if `runDownload` (566) no longer calls them;
  - `src/destroy.js` (3572-3596): the target is `resolvePrimary` (Task 5); k8s calls `triggerBackupJob`; a requested backup that fails or reports `skipped` aborts unless `-force`; with `-y` and backups kept, it backs up by default;
  - `src/scale.js`: requires `pushed` (Task 7 consumes the name);
  - `tests/e2e/scenarios/_run-lifecycle.ts:3805-3830`: the backup step asserts `BACKUP_RESULT`-driven output (`base backup pushed: base_…`) instead of `/uploaded to s3/i`.
- Test: `tests/unit/backup/backup-result-marker.test.ts` (new; it runs `compose-backup.sh` under `sh` with stubbed `wal-g`/`psql`/`flock` on PATH, one case per branch, reusing the stub-binary pattern of `tests/unit/deploy/backup-fence.test.ts`), `tests/unit/backup/backup-result-consumed-census.test.ts` (new), `tests/unit/destroy/destroy-prebackup.test.ts` (new).

**Interfaces:**
- Produces: `parseBackupResult(stdout) -> { result, name?, reason? }`. It throws when there are zero or two markers.

  ```ts
  expect(parseBackupResult('…\nBACKUP_RESULT=pushed:base_000000020000000000000007\n')).toEqual({ result: 'pushed', name: 'base_000000020000000000000007' });
  expect(parseBackupResult('BACKUP_RESULT=skipped:standby-role\n')).toEqual({ result: 'skipped', reason: 'standby-role' });
  expect(() => parseBackupResult('no marker')).toThrow(/no BACKUP_RESULT/);
  ```

- [ ] **Step 1: Write the failing tests.**
  - Each `compose-backup.sh` branch prints its marker: no target, no creds, standby role, in recovery, already running (exit 75), success. The success case prints the name from stubbed `wal-g backup-push` output. The retired and fence refusals print no marker and exit 1.
  - The census: every call of `backupCompose(` or `triggerBackupJob(` under `src/` destructures or uses `.result`.
  - Destroy on k8s with "yes" calls `triggerBackupJob` on `resolvePrimary`'s IP. A `skipped` result aborts with `backup skipped (<reason>); destroy stopped; rerun with -force to destroy anyway`. `-force` continues.
  - `backup create` prints the backup name, never prints "No backups found in S3", and offers no download.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/backup tests/unit/destroy/destroy-prebackup.test.ts tests/unit/deploy/backup-fence.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(backups): report pushed or skipped, and stop destroy on a missing backup`.

### Task 7: Compose scale fences writes before the cutover, and the standby arm reseeds (H6, B6, Decision 3)

**Files:**
- Modify: `src/scale.js` (`scaleServers` 547-1000, `scaleFinishComposeOutro` 1028-1036).
- Test: `tests/unit/scale/compose-scale-fence.test.ts` (new), `tests/unit/scale/primary-destroy-fence-census.test.ts` (new), `tests/unit/scale/compose-ha-standby-arm.test.ts` (new); update `tests/unit/scale/backup-overlap.test.ts` (the background backup becomes a post-fence backup).

**Interfaces:**
- Produces: `fenceComposePrimary({ ip, sshKeyPath, projectName, services }) -> Promise<{ switchWal: string }>`. Over SSH, reusing the shipped pieces:
  1. `stopOldPrimaryWriters(ip, sshKeyPath, projectName, composeWriterServices(services))` (app plus the primary-only add-ons);
  2. `fenceDatabaseWrites({ exec: composePsqlRunner(...) })`;
  3. `SELECT pg_walfile_name(pg_switch_wal())`;
  4. poll `pg_stat_archiver.last_archived_wal` until it reaches that file. The budget is a fixed 120 s, then it fails with the file name. This is a deadline, not a retry.

  Rollback, used by any failure before the new server's restore succeeds: `unfenceDatabaseWrites`, then `startOldPrimaryWriters` with the containers the stop returned.
- Single-node compose and the compose-ha primary arm run this order:
  1. provision and prepare the new server, as today;
  2. fence the old one;
  3. take the final backup (`pushed` required, Task 6);
  4. restore that exact name on the new one (Task 1, `RESTORE_BACKUP=<name>`, no listing);
  5. `demoteComposeWalgRole` on the old server, which also stops its archiving, and remove its backup cron;
  6. push the post-promote base on the new one (Task 4);
  7. flip DNS.

  The old server is destroyed last. The CLI prints `writes paused from <t> until DNS flip` with the elapsed time.
- The compose-ha standby arm never restores. It reseeds the replacement from `resolvePrimary` through the shared staged reseed (`replication.js`, the same call restore's compose-ha reseed uses) and proves it streaming with an identifier (`recordSystemIdentifier`). When the primary arm also ran, the standby arm waits for it and reseeds from the new primary. A reseed that cannot be proven marks the env `replication: 'degraded'` through `markStandbyUnproven` and prints the deploy hint.
- The outro drops "(zero downtime)" and prints the measured write pause.

- [ ] **Step 1: Write the failing tests.**
  - The step-order test, using fakes that record the calls: writer stop, write fence, switch, archive wait, `backupCompose`, `restoreCompose(name)`, demote, `pushBaseBackupAfterPromote`, DNS flip, destroy.
  - The fence's archive wait failing aborts the scale before any restore. The test asserts the rollback calls: unfence, then writer start.
  - The compose-ha standby arm calls the staged reseed and never `restoreCompose`. With both arms, the standby reseed's source is the new primary's IP.
  - The census: every code path under `src/` that destroys a server which ran a primary database (the `deleteServer` callers in `scale.js` and `destroy.js`) passes through `fenceComposePrimary` or a destroy command that has already taken a `pushed` backup.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/scale`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(scale): fence writes on the old server before the database cutover, and reseed a replaced standby`.

### Task 8: Destroy keeps uploads whenever it keeps backups (H7, B4). DROPPED 2026-10-21

Shipped by #233 (`63c1bad`):
- `deleteAppBucketEffect` (`src/destroy.js:1339-1390`) keeps the env's own app bucket and its uploads on a plain destroy, and deletes it only with `-purge` (never a pinned or legacy shared bucket).
- The preview (`src/lib/destroy/preview.js:98-108`) says the same.
- `tests/unit/destroy/app-bucket-env-scope.test.ts:131-150` pins both cases.

Nothing remains. The number is kept so cross-plan references stay valid.

### Task 9: Project config writes are atomic and never stale (M6)

**Files:**
- Modify: `src/lib/config.js`.
  - New `updateProjectConfig(mutator)`: take a lockfile (`.vibecarbon.json.lock`, `O_EXCL`, 30 s budget, stale-lock detection by PID), reload, apply `mutator(config)`, write `.vibecarbon.json.tmp`, `fsync`, then `rename`.
  - `saveProjectConfig` (127-130) becomes internal to it.
- Migrate every writer to `updateProjectConfig` with a per-env patch:
  - `failover-guard.js` (×4), `orchestrator.js` (×3, including the final save), `access.js` (×3), `scale.js` (1024, 2166), `write-fence.js` (×2), `effects/compose-ha.js` (×2, the mid-flight persist);
  - `destroy.js` (×2), `operator-ip.js`, `failover-abort.js`, `compose/ha.js` (`swapComposeHaRoles`), `backup-fence.js` (the `ha.backupFence` record), `failover.js` (`swapHaRoles`), `configure.js`.
  - The `s3` blocks keep going through `envS3Record` (`src/lib/deploy/s3-record.js`).
- Test: `tests/unit/config/update-project-config.test.ts` (new), `tests/unit/config/no-stale-save-census.test.ts` (new).

- [ ] **Step 1: Write the failing tests.**
  - Two interleaved `updateProjectConfig` calls (one runs `swapHaRoles`' patch on `environments.prod`, one deletes `environments.staging`) both survive.
  - A `failoverInFlight` journal written by one call and a `destroyedEnvironments` record written by another both survive.
  - A crash between the tmp write and the rename leaves the original file intact.
  - The census: no call of `saveProjectConfig(` remains under `src/` outside `config.js`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/config`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(config): atomic, locked read-modify-write for .vibecarbon.json`.

### Task 10: Retention by time, and k8s honours the configured schedule (M4, B7)

**Files:**
- Modify:
  - `carbon/backup/compose-backup.sh` (118-120, and the `RETAIN` doc at 18);
  - `cronjob.yaml` (`schedule` 22, `BACKUP_RETENTION_DAYS` 51-55 and 82, retention 170-171);
  - `carbon/k8s/base/config/configmap.yaml` (32);
  - `src/lib/deploy/k8s/k3s.js`: render the CronJob `schedule` and `BACKUP_RETENTION_DAYS` from `envConfig.backup`;
  - `src/lib/deploy/compose/index.js` (`setupComposeBackupCron`, 1266-1275).
- Retention: `wal-g delete garbage BACKUPS --confirm && wal-g delete before FIND_FULL "$(date -u -d "-${RETAIN_DAYS} days" +%Y-%m-%dT%H:%M:%SZ)" --confirm`. The orphan sweep stays first (`walg-retention-orphan-sweep.test.ts`). It runs inside the current lineage only (Task 3's `walg-env.sh`), after the fence check.
- Test: `tests/unit/deploy/backup-config-reaches-runtime-census.test.ts` (new), plus the script tests from Task 6's harness for the retention command.

- [ ] **Step 1: Write the failing tests.**
  - The census: every `envConfig.backup.*` field (`schedule`, `retentionDays`) appears in the rendered compose cron/env and in the rendered k8s CronJob/ConfigMap for a fixture env with `schedule: '0 */6 * * *', retentionDays: 14`. Run it against Task 2's flag census so the two share the walk.
  - The script test: the retention invocation contains `delete before FIND_FULL` and no `retain FULL`.
  - Docker integration (extend Task 1's test): after `delete before FIND_FULL`, `vibecarbon-fence.json` in the lineage folder is unchanged (same ETag).
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/backup-config-reaches-runtime-census.test.ts tests/unit/backup`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit` and the Docker test. Expected: PASS.
- [ ] **Step 5: Commit** `fix(backups): retain by days and render the k8s schedule from config`.

### Task 11: `status` shows backup health (M5)

**Files:**
- Modify: `src/status.js`, next to the `Backup fence` row (1343-1344). Add a "Backups" row with:
  - the newest base age, from `listBaseBackups` in the recorded lineage (Task 1, Task 3);
  - the last archived WAL time and `failed_count`, from `pg_stat_archiver` through the role primary's psql runner (`resolvePrimary`, Task 5);
  - the count of `WAL_ARCHIVE_FAILED` lines in the last 24 h (compose: `backups/backup.log`; k8s: the last 3 Job pod logs).

  It goes red when the newest base is older than `2 × schedule interval`, or the last archived WAL is older than `2 × archive_timeout`.
- Modify: `services/observability/volumes/grafana/dashboards/postgresql.json` and its `dashboards.dev` copy: a panel for `pg_stat_archiver_last_archive_age` from the shipped postgres-exporter v0.19.1 (confirm the metric name against that exporter version before writing the panel). No Prometheus rule, since the add-on has no Alertmanager (Decision 4).
- Test: `tests/unit/status/backup-health-row.test.ts` (new).

- [ ] **Step 1: Write the failing tests.** Fixtures:
  - a fresh base with recent WAL is green;
  - a 3-day-old base with a daily schedule is red with `newest base backup 3 days old`;
  - zero bases give `no base backup in lineage <sysid>`;
  - a retired HA side is never the row's source.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/status`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(status): show backup and WAL archiving health`.

### Task 12: Every journal migration is proven applied (L2)

**Files:**
- Modify: `carbon/src/server/db/migrate.ts`.
  - `ledger` (40-49) also returns the set of `hash` values.
  - `runMigrations` (102-128): after `migrate()`, compare the ledger hashes with every journal entry's hash (`readMigrationFiles` gives `hash`). A missing one throws `migration <tag> was skipped (its timestamp is older than the newest applied one); regenerate it`. So the migrate step (`migrate-cli.ts`: compose `app-migrate`, the k8s `migrate` init container) exits 1 and the deploy fails.
  - `verifyMigrations` (59-66) does the same set comparison instead of `latest >= newest`, so the app's startup check and the standby check report `upToDate: false`. `app_service` already reads the ledger.
- Add a journal-monotonic check to the template's structural tests (`carbon/tests/structural/template-migrations-census.test.ts`), covering all entries, not just the baseline.
- Test: `carbon/tests/db/migrate-journal-complete.test.ts` (new, real Postgres): an out-of-order journal entry makes `runMigrateStep` throw and `verifyMigrations` report not up to date.

- [ ] **Step 1: Write the failing tests.**

  ```ts
  // carbon/tests/db/migrate-journal-complete.test.ts
  it('a journal entry older than the newest applied one fails the migrate step', async () => {
    const folder = await journalWithLateOldEntry(); // 0000 applied, then 0002 applied, then 0001 added with an older `when`
    await expect(runMigrateStep(conn, APP_PW, folder)).rejects.toThrow(/migration 0001_.* was skipped/);
    expect(await verifyMigrationsOnOwnConnection(conn, folder)).toEqual({ upToDate: false });
  });
  ```
- [ ] **Step 2: Run** `cd carbon && npx vitest run tests/db/migrate-journal-complete.test.ts tests/structural/template-migrations-census.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `cd carbon && npm run test:prepush && npm run test:db`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(template): refuse to migrate or start when a journal migration was skipped`.

---

## Execution order
1, 6, 5, 2, 3, 4, 7, 9, 10, 11, 12.
- Task 6's result shape is consumed by Tasks 4 and 7.
- Task 5's resolver is consumed by Tasks 6, 7 and 11.
- Task 3 changes the prefixes Tasks 1 and 2 read.
- Task 9 may move earlier if price-optimized-defaults is about to start (see below).

## Cross-plan dependencies
- **Env app bucket (#233, merged):** Task 3 moves its census arm (d) (`app-bucket-single-resolver-census.test.ts:125`) to `WALG_S3_PREFIX_BASE`. Task 8 is dropped because #233 shipped B4.
- **Security (#234):**
  - The restore marker lives on `vibecarbon-infra-secrets`.
  - Migrations run in a separate migrate step: compose restore already reruns `app-migrate` (`a970088`), and the k8s app rollout reruns the `migrate` init container.
  - Task 12 checks the ledger in that step.
- **HA correctness (#235, landed on this stack):**
  - It owns the promote guard, the reseed source, the write fence, the retirement fence, the backup fence (`ha.backupFence`) and the failover journal (`ha.failoverInFlight`, with restore and scale refusing while it is set).
  - This plan adds `pushBaseBackupAfterPromote` after its WALG_ROLE move and swap save (Task 4), the `servers[].role` swap (Task 5), and the lineage folder the backup fence moves into (Task 3).
  - Task 7 reuses its write fence and writer stop.
- **Primary-only add-ons (#236, landed on this stack):** Task 7's writer stop is `composeWriterServices`, so n8n and metabase stop with the app during a scale. Its post-restore recreate keeps `STANDBY_SCALE_FLAG`.
- **TLS cert reuse:** its snapshots live under `tls/<project>/<env>/`, outside `walg/`, so lineage folders don't collide. Its purge must also run only on `-purge` (B4 symmetry).
- **Price-optimized defaults:** it persists server types before provisioning. Task 9's `updateProjectConfig` should land first, so that plan writes through it.
- **Cold-deploy speed:** no overlap.

## Compatibility (PR body)
- Existing environments archive at `backups/<project>/<env>/walg`. After this change they archive at `…/walg/<sysid>`, and the HA backup fence object moves with them. The first base backup at the new path comes from the next scheduled or manual backup (Task 4 runs on promote only), so run `vibecarbon backup <env>` once after upgrading.
- Old objects at the un-suffixed path stay readable with `wal-g` by hand.
- `vibecarbon restore` now reads the backup list from object storage, so it needs the backup credentials locally (the same ones `backup -l` uses), and `-y` runs need them in the environment. It accepts `-lineage <sysid>` and refuses when the lineage is ambiguous.
- `vibecarbon scale` on compose now pauses writes during the cutover and prints the window. A compose-ha standby replacement is reseeded from the primary instead of restored.
- `backup create` exits non-zero when the backup was skipped, and no longer offers a download.
- Retention counts days, not backups.

## Verification
- **Per task:** the listed commands, red then green, with each census arm shown failing on a deliberate break.
- **End of branch:**
  - `pnpm lint && pnpm test:unit && pnpm test:integration`;
  - `pnpm test:docker`;
  - `cd carbon && npm run test:prepush && npm run test:db`.
- **Real infra (needs Brandon's OK):**
  - `--scenario hetzner/k8s` exercises the new `restore-deploy` step;
  - `hetzner/compose` covers the scale fence and restore;
  - `hetzner/compose-ha` covers restore after failover keeping post-failover writes, and the scale standby reseed.
