# HA Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make compose-ha and k8s-ha failover, reseed and demotion refuse every path that can promote stale or empty data, lose acknowledged writes, report a half-failed-over environment as success, or let a standby fill the primary's disk.

**Architecture:**
- **A failover journal replaces state inference.** Every promote decision reads a persisted journal and a positive replica proof, not "`pg_is_in_recovery()` is false".
- **One preconditions gate.** Both failover tiers share one preconditions gate (`assertFailoverPreconditions`) and one step order: fence, then catch-up, then promote, then DNS. The DNS step is verified by reading the record back.
- **Retirement enforces itself.** A retired side carries a marker that its own backup job and app readiness check, and every CLI entry point re-applies the fence.
- **Lean-stack cleanups:** a WAL cap on the replication slot, no Supabase-era `ALTER SYSTEM` + restart, and the DB boot budget applied everywhere.

**Tech Stack:** Node ESM CLI (`src/`), Postgres 17 streaming replication, WAL-G, k3s/kubectl over SSH, docker compose, vitest.

**Spec:** the review `/tmp/claude-1000/-home-brandon-repos-vibecarbon/0b7ee7cd-7067-44f6-a72a-5ce5d7505b2c/scratchpad/arch-review/ha.md` (findings C1, C2, H1-H5, M1-M3, L1). Brandon, 2026-10-20: "ensure that all our outstanding issues are fully RCA'd and resolved."

**Stacks on:** `feat/project-app-bucket` (7de7f0d).

## Verification of the review (done while planning, branch @ 7de7f0d)

All 10 findings hold; none dropped. Corrections and additions:
- **C1, confirmed.**
  - `failover.js:251` skips reseed and promote on `isStandbyPromoted()`, and `replication.js:1776` is `pg_is_in_recovery() = 'f'` alone.
  - `promoteStandby` returns on the first `'f'` (`replication.js:1697`).
  - Compose accepts `probeRecovery() === 'f'` after a failed `pg_promote` (`compose/ha.js:1533,1542`).
  - `waitForStandbyCaughtUp` returns early when not streaming (`failover.js:358`).
  - `grep "replication === 'degraded'" src/failover.js` returns nothing. The flag is only written (`:1266`), never read.
- **C2, confirmed.**
  - `effects/compose-ha.js:744-745` binds `WG_PRIMARY_IP` to the born-primary node.
  - `configureStandbyReplication` dials `WG_PRIMARY_IP` (`compose/ha.js:527,537`).
  - `detectComposeHaRoleSwap` is called only from `orchestrator.js:585` (deploy), not from `failoverComposeHA` (`:1352`) or `restore.js:575`.
- **H1, confirmed.** `compose/ha.js` contains no `pg_wal_lsn_diff` or `pg_last_wal_replay_lsn` (0 matches). The old primary's `docker stop` is at `:1702`, after promote.
- **H2, confirmed.** `createDNSRecord` (`cloudflare-dns.js:110-156`) has 0 `.ok` checks.
- **H3, confirmed.** The `return { ok: false }` at `failover.js:~1328` precedes the demotion at `~1341`.
- **H4, confirmed.** `planned = await isPrimaryReady(...)` (`failover.js:1514`) is an operator-vantage probe.
- **H5, confirmed.** `max_slot_wal_keep_size` has 0 matches in `src carbon docker`, and `repl-gateway.yaml:28` is `kind: Pod`.
- **M1, confirmed, with one correction.** `wal_level` and `hot_standby` are in argv (`carbon/docker-compose.yml:145,191`; `statefulset.yaml:277,292`), but `max_wal_senders` and `wal_keep_size` are not. `primary-init.sql:25-27` sets all three via `ALTER SYSTEM`.
  - Correction: `wal_keep_size` is reloadable, and `max_wal_senders` defaults to 10 (≥ 5), so no restart is needed. Move `wal_keep_size` to argv too, so the settings live in one place.
  - The k8s restart is `kubectl delete pod db-0` (`k8s/ha/index.js:~606`), with a silent `if (i === 29) break` at `~631`. Compose runs `docker compose restart db` (`compose/ha.js:400`).
- **M2, confirmed.** The census `FILES` covers 2 files (`db-sts-boot-timeout-census.test.ts:35`), `k8sDbRolloutStatusArgv(timeoutSeconds = 300)` (`walg-role.js:266`), and `restore.js:673` uses `--timeout=120s`.
- **M3, confirmed.** The polls are 30 × 2 s. Task 1 folds it in: budgets then only affect RTO.
- **L1, confirmed.** `effects/k8s-ha.js:671-672` prints `--target`.

## Rulings (made while planning)

- **R1, positive replica proof.** A standby may be promoted only when all of these hold:
  - (a) It is in recovery.
  - (b) `pg_control_system().system_identifier` equals the value recorded at its last successful seed (`envConfig.ha.systemIdentifier`, written by every reseed and verified-streaming deploy).
  - (c) `envConfig.replication !== 'degraded'`.
  - (d) Planned mode only: `pg_wal_lsn_diff(pg_last_wal_replay_lsn(), <primary LSN after fence>) >= 0`.

  Not being in recovery counts as "already promoted" only when `envConfig.ha.failoverInFlight` names this standby. Cost if wrong: a legitimate rerun after a lost config write refuses and asks for `vibecarbon deploy`.
- **R2, the journal shape.**
  - `envConfig.ha.failoverInFlight = { id: <uuid>, target: 'primary'|'standby' (the role being promoted), startedAt: ISO, primaryLsn: string|null, systemIdentifier: string }`.
  - It is written through the existing atomic config save before the promote call, and cleared in the same save that persists the role swap.
- **R3, an unconfirmed promote fences.** It never un-quiesces. If the target is still in recovery, un-quiesce as today. If it is out of recovery, or the probe fails, keep the old primary fenced, leave the journal set, and exit non-zero with: `promotion state unknown: old primary kept fenced; rerun vibecarbon failover <env> to finish`.
- **R4, compose-ha role swap refuses rather than re-addressing.**
  - `failoverComposeHA` and `restore`'s standby resync call `assertNoComposeHaRoleSwap`. Role-aware WireGuard re-addressing for compose is out of scope.
  - Compose failover is one-way until `vibecarbon deploy` reconverges. Deploy already refuses swapped compose envs, so the message names the documented recovery: destroy the retired node and redeploy.
  - Cost if wrong: no compose failback without a redeploy, which matches `docs/rto-rpo.md`.
- **R5, a DNS flip counts only after it is verified.**
  - Every DNS backend's mutating call throws on `!response.ok` or a JSON `success === false`.
  - Failover reads the A record back through the same provider API and compares it to the target IP.
  - A failed or unverified flip persists the role swap, as today, then exits non-zero with `FAILOVER COMPLETED, DNS DID NOT: point A records for <domain> at <ip>`.
- **R6, demotion runs unconditionally.** It runs in a `finally` that is independent of the promoted side's arming outcome, and the two verdicts are reported separately. The role-aware reconverge from #232 stays the arming authority. This only guarantees the loser is disarmed.
- **R7, a self-enforcing retirement marker.**
  - k8s: `vibecarbon-config` key `VIBECARBON_ROLE=retired`, patched on the old cluster when reachable.
  - compose: file `<remoteDir>/.vibecarbon-retired`.
  - The backup scripts (`cronjob.yaml`, `compose-backup.sh`, `wal-archive.sh`) exit with a "retired node" error before any push. A refused push fails loudly and does not count as a skip; the skip-as-success class belongs to the backup-integrity plan.
  - `failover`, `status` and `deploy` call `reconcileRetiredFence(envConfig)` first. It re-applies the marker, app scale 0 and WALG_ROLE=standby on any reachable side that the persisted roles call retired.
  - Cost if wrong: an operator who wants the retired side back must redeploy, which they must do anyway.
- **R8, failover is classified from the standby's vantage point.** The unplanned path additionally requires that the standby's `pg_stat_wal_receiver` is not `streaming`, or that its `last_msg_receipt_time` is older than 60 s. Otherwise refuse with `the primary is still streaming to the standby; your machine cannot reach it. Rerun with -force-unplanned to fail over anyway`.
- **R9, slot cap.**
  - `max_slot_wal_keep_size=4GB` (40% of the 10Gi k8s PVC) and `wal_keep_size=512MB` move to argv in both `carbon/docker-compose.yml` and `statefulset.yaml`.
  - An invalidated slot (`wal_status = 'lost'`) is surfaced by `status`, and recovery is the existing reseed. `deploy` detects the lost slot, drops and recreates it, and reseeds.
  - repl-gateway becomes a single-replica Deployment pinned like today.
- **R10, the primary is never restarted on deploy.** Delete the `ALTER SYSTEM` lines and both restarts. Role, slot and pg_hba changes use `pg_reload_conf()`. Compose `configureStandbyReplication` gets the same streaming fast path k8s `setupReplication` has (`k8s/ha/index.js:789-810`).
- **Coordination.**
  - **`2026-10-20-backup-restore-integrity.md`** (parallel plan) owns:
    - the fresh base backup after promote, restore and scale;
    - k8s-ha `servers[].role` targeting for backup and restore;
    - the scale write fence, and skip-as-success.

    This plan does not touch those. R7's backup refusal is the one shared seam: this plan adds the retired check; that plan owns exit-code semantics.
  - **`2026-10-20-primary-only-addons.md`** stops n8n on the retired compose primary (its Task 4) and starts add-ons on promotion. R7's `reconcileRetiredFence` must call that plan's `zeroWorkloadsOnStandby` when present. If this plan lands first, it zeroes `app` only, and the addons plan extends the reconciler.
  - **`2026-10-20-k8s-ha-registry-copy.md`** adds a "standby registry has the app image" refusal. It extends `assertFailoverPreconditions` from Task 1 rather than adding its own gate.

## Global Constraints

- No retry ladders. Budgets are deadlines; correctness never depends on a poll count (R3).
- Every fix ships its class census, and each census is shown failing on a deliberate break, with the evidence recorded in the report.
- No customers: no migration code. An env without `ha.systemIdentifier` is treated as "unproven": unplanned failover refuses until a deploy records it. Ship a Compatibility note, with no `!:` footer.
- Single-dash CLI flags only. The new flag is `-force-unplanned`.
- Messages follow the CLI help voice: lowercase hints, no em dashes, say why.
- Never print secrets (replicator password, tokens) in logs, errors or tests.
- Conventional commits, pathspec commits, never `--no-verify`.

## Review Focus

1. **Failback before reconverge** (k8s-ha and compose-ha). A second `failover` right after the first refuses before any quiesce or SSH write, and names `vibecarbon deploy`. Tested in Task 1 (k8s) and Task 2 (compose).
2. **A crashed failover rerun.** The journal is set, the standby is out of recovery, and the rerun completes DNS and the swap without re-promoting or reseeding. Tested in Task 1.
3. **A Cloudflare token without DNS edit.** Failover exits non-zero and the output never says "DNS updated". Tested in Task 4.
4. **Operator partitioned from a healthy primary.** Failover refuses without `-force-unplanned`. Tested in Task 6.
5. **Warm HA redeploy.** The serving primary's postgres is not restarted (no `restart db`, no `delete pod db-0` reached). Tested in Task 8.

---

## File Map

- New `src/lib/deploy/failover-guard.js`:
  - `assertFailoverPreconditions`
  - `proveReplica`
  - the journal helpers
  - `classifyFailover`
- New `src/lib/deploy/retired-fence.js`: `reconcileRetiredFence`.
- `src/failover.js`: the k8s flow uses the guard, journal, fence-on-unknown, unconditional demotion and verified DNS.
- `src/lib/deploy/compose/ha.js`: `failoverComposeHA` gets the same guard, plus a fence, a catch-up gate, the role-swap refusal and verified DNS. `configurePrimaryReplication` loses its restart. `configureStandbyReplication` gets a streaming fast path.
- `src/lib/deploy/replication.js`: `isStandbyPromoted` is removed, `promoteStandby` becomes promote-only, and `waitForStandbyCaughtUp` is made exec-backend generic.
- `src/lib/deploy/k8s/ha/index.js`: no `delete pod db-0`; reload instead.
- `carbon/ha/primary-init.sql`: no `ALTER SYSTEM`.
- `carbon/docker-compose.yml`, `carbon/k8s/base/db/statefulset.yaml`: `max_slot_wal_keep_size`, `wal_keep_size`, `max_wal_senders` in argv.
- `carbon/k8s/base/repl-gateway/repl-gateway.yaml`: becomes a Deployment.
- `src/lib/cloudflare-dns.js` and the other `src/lib/*-dns.js`: status checks, plus a `readARecord` per backend.
- `carbon/k8s/base/backup/cronjob.yaml`, `carbon/backup/compose-backup.sh`, `carbon/volumes/db/wal-archive.sh` and its configmap copy: the retired check.
- `src/status.js`: slot health row, retired-fence reconcile.
- `src/lib/deploy/walg-role.js`, `src/restore.js`: boot budget.
- `src/lib/deploy/effects/k8s-ha.js`: the summary commands.
- Tests: per task. e2e: `tests/e2e/scenarios/` (failover steps) and `tests/e2e/checks/` (new assertions).

---

### Task 1: Failover journal, positive replica proof and fence-on-unknown (C1, M3)

**Files:**
- Create: `src/lib/deploy/failover-guard.js`.
- Modify:
  - `src/failover.js`: `reseedAndPromoteOrAbort` (~:247) and the promote/abort block (~:1514-1560);
  - `src/lib/deploy/replication.js`: delete `isStandbyPromoted` (:1759); make `promoteStandby` (:1660-1700) return `'promoted'|'in-recovery'|'unknown'`, never inferring promotion from a first `'f'` without a prior `'t'`;
  - every reseed and verified-streaming success path in `replication.js` and `k8s/ha/index.js` records `envConfig.ha.systemIdentifier`.
- Test: `tests/unit/failover/failover-state-matrix.test.ts` (new) and `tests/unit/failover/promote-inference-census.test.ts` (new).

**Interfaces:**
- Produces, in `failover-guard.js`:
  - `readReplicaState({ exec }) -> Promise<{ inRecovery: boolean|null, systemIdentifier: string|null, replayLsn: string|null, receiverStatus: string|null, lastMsgAgeS: number|null }>`, where `exec(sql) -> Promise<string>` is the tier's psql runner.
  - `assertFailoverPreconditions({ envConfig, environment, standbyState, tier: 'compose-ha'|'k8s-ha' }) -> { mode: 'promote'|'resume' }`. It throws `FailoverRefusedError`, whose message names the reason and `vibecarbon deploy`.
  - `writeFailoverJournal(ctx, { target, primaryLsn, systemIdentifier }) -> Promise<string /* id */>` and `clearFailoverJournal(ctx) -> Promise<void>`. Both go through the existing config save used by `swapHaRoles`.
  - `FailoverRefusedError` (exported class).
- Consumed by: Task 2 (compose), Task 6 (`classifyFailover` is added to this module), and the registry-copy plan (extends `assertFailoverPreconditions`).

- [ ] **Step 1: Write the failing matrix test.** Drive `failoverHA` with injected deps (the existing `deps` seam at `failover.js:~1384`) through these fixtures.
  - `{inRecovery:true, sysid matches, not degraded}`: promotes. The journal is written before the promote seam, and cleared in the swap save.
  - `{inRecovery:false, journal names this target}`: `mode 'resume'`. No reseed seam, no promote seam; DNS and swap seams are called.
  - `{inRecovery:false, no journal}`: throws `FailoverRefusedError` matching `/not a replica/`. Zero quiesce and zero kubectl write calls.
  - `{envConfig.replication:'degraded'}`: refuses with `/degraded/`, before quiesce.
  - `{envConfig.lastFailover set and roles swapped since the last deploy}` (failback before reconverge): refuses with `/vibecarbon deploy/`.
  - `{sysid mismatch}`: refuses with `/different database/`.
  - `{no ha.systemIdentifier recorded}`, unplanned: refuses with `/vibecarbon deploy/`. Planned with a streaming standby: allowed, and sysid is compared live against the primary.
  - Promote returns `'unknown'` or `'promoted'` after the poll budget: the old primary is NOT un-quiesced (zero un-quiesce calls), the journal remains, and the exit message matches `/kept fenced/`.
  - Promote returns `'in-recovery'`: un-quiesce is called once and the journal is cleared.
- [ ] **Step 2: Write the census** `promote-inference-census.test.ts`. Walk `src/**/*.js`. Any line comparing a `pg_is_in_recovery()` result to `'f'` must sit in a file that imports from `failover-guard.js`, or be inside `readReplicaState`. Show it fails by reintroducing `isStandbyPromoted` temporarily.
- [ ] **Step 3: Run** `pnpm vitest run tests/unit/failover`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - Delete the `alreadyPromoted` probe branch.
  - Call `assertFailoverPreconditions` before `isPrimaryReady`'s quiesce.
  - Write the journal immediately before `promoteStandby`.
  - Fold M3: the promote budget becomes a deadline (`PROMOTE_DEADLINE_MS = 120_000`); correctness rests on the R3 tri-state.
- [ ] **Step 5: Run** `pnpm vitest run tests/unit/failover tests/unit/deploy`. Expected: PASS.
- [ ] **Step 6: Commit** `fix(failover): promote only a proven replica, and fence when promotion is unconfirmed`.

### Task 2: compose-ha uses the same guard, and refuses a role-swapped env (C1 compose, C2)

**Files:**
- Modify:
  - `src/lib/deploy/compose/ha.js`: in `failoverComposeHA` (:1352), call `assertNoComposeHaRoleSwap` and `assertFailoverPreconditions` first. In the promote loop (:1510-1550), accept "promoted" only if `readReplicaState` returned `inRecovery:true` immediately before `pg_promote`, or the journal names this target. Write and clear the journal.
  - `src/restore.js:~571-575`: call `detectComposeHaRoleSwap` before the standby resync. When it detects a swap, skip the resync and print `composeHaStandbyResyncHint`. Never call `configureStandbyReplication`.
- Test: `tests/unit/failover/compose-failover-state-matrix.test.ts` (new) and `tests/unit/deploy/configure-standby-replication-callers-census.test.ts` (new).

**Interfaces:**
- Consumes: the Task 1 `failover-guard.js` exports.

- [ ] **Step 1: Failing tests.**
  - The Task 1 matrix rows (refusals, resume, unknown, fence), against `failoverComposeHA` with injected ssh.
  - A swapped fixture (born-primary role `standby`) makes `failoverComposeHA` throw before any `sshRun*` call.
  - `restore` on a swapped env never calls `configureStandbyReplication` and prints the hint.
  - Census: every call site of `configureStandbyReplication(` in `src/` is either `effects/compose-ha.js` (guarded by `orchestrator.js:585`) or calls `detectComposeHaRoleSwap`/`assertNoComposeHaRoleSwap` earlier in the same function. Show it fails by deleting the new guard in `restore.js`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/failover tests/unit/deploy/configure-standby-replication-callers-census.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as listed.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `fix(compose-ha): failover and restore refuse to reseed from a node's own address after a role swap`.

### Task 3: compose-ha planned failover fences writes and waits for catch-up (H1)

**Files:**
- Modify:
  - `src/lib/deploy/replication.js`: make `waitForStandbyCaughtUp` take `{ primaryExec, standbyExec, isStreaming }` closures, keeping the k8s call site behaviour.
  - `src/lib/deploy/compose/ha.js`: when the old primary is reachable, `docker stop <project>-app` on it before promote. Then capture `pg_current_wal_lsn()` and gate on catch-up. On abort, `docker start <project>-app`. Record `primaryLsn` in the Task 1 journal.
- Test: `tests/unit/failover/failover-step-order-census.test.ts` (new, both tiers).

**Interfaces:**
- Produces: `waitForStandbyCaughtUp({ primaryExec, standbyExec, isStreaming, deadlineMs, sleep, now }) -> Promise<{ caughtUp: boolean, lagBytes: number|null }>`. It throws on deadline when streaming. A non-streaming standby returns `{ caughtUp: false }`, and the caller must then reseed or refuse; it is never treated as N/A.

- [ ] **Step 1: Failing step-order census.**
  - Record seam call order for `failoverHA` and `failoverComposeHA` in planned mode with injected deps. Assert `fence < captureLsn < catchUp < promote < dns`.
  - In unplanned mode (Task 6 classification injected), assert `promote < dns` and no fence call on the unreachable side.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/failover/failover-step-order-census.test.ts`. Expected: FAIL for compose.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run tests/unit/failover tests/unit/deploy`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(compose-ha): planned failover stops writes and waits for the standby to catch up before promoting`.

### Task 4: DNS mutations check status, and failover verifies the flip (H2)

**Files:**
- Modify:
  - `src/lib/cloudflare-dns.js`: `createDNSRecord` (:110-156) and `createHealthCheck` (:355-383) throw on `!response.ok || json.success === false`. Use the error shape the vultr/do/linode backends use, never including the token.
  - Every `src/lib/*-dns.js`: export `readARecord(apiToken, zoneRef, name) -> Promise<string|null>`.
  - `src/failover.js:~1644-1664` and `src/lib/deploy/compose/ha.js:~1758-1770`: implement R5. Read back, persist the swap, then throw `FailoverDnsError` when the flip failed or the read-back mismatches. A missing DNS token also ends in a non-zero exit.
- Test:
  - `tests/unit/dns/dns-mutation-status-census.test.ts` (new);
  - `tests/unit/dns/cloudflare-create-record.test.ts` (new);
  - failover rows added to both state-matrix files.

**Interfaces:**
- Produces: `readARecord` per backend; `FailoverDnsError` exported from `failover-guard.js`.

- [ ] **Step 1: Failing tests.**
  - A Cloudflare 403 makes `createDNSRecord` reject with a message containing `403`. The spinner never prints `DNS updated`.
  - Census: for every `src/lib/*-dns.js`, each function containing a `fetch`/`fetchWithRetry` call with `method: 'POST'|'PUT'|'PATCH'|'DELETE'` also contains `.ok` or delegates to a helper that does. A walk, not a list. Show it fails by removing Cloudflare's new check.
  - `updateDns` rejection or read-back mismatch: both tiers call `swapRoles`/persist, then exit non-zero with `/DNS DID NOT/`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/dns tests/unit/failover`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command, plus `pnpm vitest run tests/unit/deploy`.** Expected: PASS.
- [ ] **Step 5: Commit** `fix(failover): a DNS flip counts only after the provider confirms it`.

### Task 5: k8s old-primary demotion is independent of the promoted side's outcome (H3)

**Files:**
- Modify: `src/failover.js` `restorePromotedWalgRole` (:1295-1352). Demote the old primary in a `finally`, and return `{ promoted: {ok, error?}, demoted: {ok, error?} }`. The caller's banner reports each verdict.
- Test: `tests/unit/failover/walg-role-demotion-independent.test.ts` (new).

- [ ] **Step 1: Failing test.**
  - `kubectl` rejects on the promoted `rollout status`. Assert that the old-primary `set env ... WALG_ROLE=standby` call is still made, and that the exit is non-zero with both verdicts named.
  - Census: an AST or source check that `restorePromotedWalgRole` has no `return` statement lexically before the demotion call outside the `finally`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run tests/unit/failover`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(k8s-ha): always disarm the old primary's backups, even when arming the new one fails`.

### Task 6: Self-enforcing retirement and standby-vantage classification (H4)

**Files:**
- Create: `src/lib/deploy/retired-fence.js`.
- Modify:
  - `failover-guard.js`: add `classifyFailover`.
  - `src/failover.js:1514` and `compose/ha.js`'s reachability check: use `classifyFailover`. Add the `-force-unplanned` flag to the `failover` SPEC (`failover.js:82-99`), with help text in the CLI voice.
  - `carbon/k8s/base/backup/cronjob.yaml`, `carbon/backup/compose-backup.sh`, `carbon/volumes/db/wal-archive.sh` and its configmap copy (keep the parity test green): exit 1 with `retired node: backups refused` when the marker is set.
  - `src/status.js`, `src/failover.js`, the deploy orchestrator entry: call `reconcileRetiredFence` before other work for HA envs.
- Test: `tests/unit/failover/classify-failover.test.ts`, `tests/unit/deploy/retired-fence.test.ts`, `tests/unit/deploy/retired-fence-entrypoints-census.test.ts` (all new).

**Interfaces:**
- Produces:
  - `classifyFailover({ primaryReachable: boolean, standbyState }) -> 'planned'|'unplanned'|'refuse-primary-alive'` (R8: receiver `streaming` with `lastMsgAgeS < 60` gives `'refuse-primary-alive'`).
  - `reconcileRetiredFence({ envConfig, projectConfig, tier, deps }) -> Promise<{ fenced: string[] /* ips */, unreachable: string[] }>`. It is idempotent and makes no writes when already fenced.

- [ ] **Step 1: Failing tests.**
  - Classification fixtures:
    - operator→primary down and the standby streaming fresh: `'refuse-primary-alive'`, and failover exits non-zero naming `-force-unplanned`;
    - a stale receiver: `'unplanned'`;
    - primary reachable: `'planned'`.
  - Reconciler: given swapped roles and a reachable retired side with app replicas 2 and WALG_ROLE=primary, it issues scale 0, WALG_ROLE=standby and the marker. A second run issues zero writes.
  - Backup scripts: with the marker present, each script exits 1 before any `wal-g` invocation. Run the shell under a stubbed `wal-g` on PATH, as `compose-walg-backup` tests do.
  - Entry-point census: `status`, `failover` and the deploy orchestrator each call `reconcileRetiredFence` for HA tiers. Show it fails by removing one call.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/failover tests/unit/deploy/retired-fence*.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** On k8s, patch `VIBECARBON_ROLE=retired` into `vibecarbon-config`. On compose, touch the marker file. When the addons plan's `zeroWorkloadsOnStandby` exists, the reconciler calls it; otherwise it zeroes `app` only.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(ha): a retired side fences itself, and failover asks the standby whether the primary is alive`.

### Task 7: Slot WAL cap, durable gateway, slot health (H5)

**Files:**
- Modify:
  - `carbon/docker-compose.yml` and `carbon/k8s/base/db/statefulset.yaml`: add `max_slot_wal_keep_size=4GB`, `wal_keep_size=512MB` and `max_wal_senders=10` to argv (R9).
  - `carbon/k8s/base/repl-gateway/repl-gateway.yaml`: `kind: Deployment`, `replicas: 1`, same pod spec. Update the re-render in `k8s/ha/index.js:191-216` to `kubectl rollout restart` or apply rather than delete-recreate the bare Pod.
  - `demoteComposeWalgRole` (`compose/ha.js:1314`) and the k8s demotion: `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE NOT active`.
  - `src/status.js`: an HA row `replication slot: <wal_status>, <retained MB> retained`. `lost` renders as an error with `run vibecarbon deploy <env> to reseed`.
  - Deploy: when `wal_status = 'lost'`, drop, recreate and reseed (the existing reseed path).
- Test:
  - `tests/unit/deploy/slot-wal-cap-census.test.ts` (new): both argv lists carry all three settings, and the values are equal across files.
  - `tests/unit/deploy/repl-gateway-kind.test.ts` (new).
  - The status render test row.
  - A reseed-on-lost unit test.

- [ ] **Step 1: Failing tests** as listed. Show the census fails when one file drops the setting.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy tests/unit/status`. Expected: FAIL.
- [ ] **Step 3: Implement.** Integration: `DOCKER_INTEGRATION=true pnpm vitest run --project integration-docker tests/integration/docker/db-first-boot.test.ts` stays green with the new argv (proves Postgres accepts them).
- [ ] **Step 4: Run the unit command and that integration test.** Expected: PASS.
- [ ] **Step 5: Commit** `fix(ha): cap the WAL a replication slot can hold and surface a lost slot`.

### Task 8: No primary restart on HA deploys (M1)

**Files:**
- Modify:
  - `carbon/ha/primary-init.sql`: delete lines 25-27. Keep the role and slot SQL, and end with `SELECT pg_reload_conf();`.
  - `src/lib/deploy/compose/ha.js:387-403`: delete `docker compose restart db`, and reload instead.
  - `src/lib/deploy/k8s/ha/index.js:~595-640`: delete the `delete pod db-0` block, the silent wait loop and the app `rollout restart`. Reload instead.
  - `src/lib/deploy/effects/compose-ha.js:811`: call `configureStandbyReplication` only when the standby is not verifiably streaming from the current primary. Use the same probe k8s `setupReplication` uses (`k8s/ha/index.js:789-810`), extracted to a shared helper with an exec-backend closure.
- Test: `tests/unit/deploy/no-warm-primary-restart-census.test.ts` (new); a compose streaming fast-path unit test.

- [ ] **Step 1: Failing tests.**
  - Census:
    - (a) No file under `src/lib/deploy/compose/` or `src/lib/deploy/k8s/ha/` contains `restart db` or `delete pod ${DB_POD}`/`db-0` on a deploy-reachable function. Walk the exported deploy effects' call graph by name, or ban the literals outright in those two directories with an allowlist of zero.
    - (b) `primary-init.sql` has no `ALTER SYSTEM` for any setting present in `statefulset.yaml` db args. Parse the YAML and compare the sets.
  - Compose: a streaming standby fixture means `configureStandbyReplication` is not called; a non-streaming one means it is called once.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test:unit` and the Task 7 docker integration test. Expected: PASS.
- [ ] **Step 5: Commit** `fix(ha): stop restarting the serving primary on every deploy`.

### Task 9: The DB boot budget everywhere (M2)

**Files:**
- Modify:
  - `src/lib/deploy/walg-role.js:266`: `k8sDbRolloutStatusArgv(timeoutSeconds = DB_STS_BOOT_TIMEOUT_S)`, with the client cap at +30 s.
  - `src/restore.js:673`: `--timeout=${DB_STS_BOOT_TIMEOUT_S}s`.
  - `tests/unit/deploy/db-sts-boot-timeout-census.test.ts`: walk every `src/**/*.js` that references `DB_STATEFULSET` or `statefulset/db`. Fail on any literal `--timeout=<n>s` below 600, and on any argv builder whose default parameter is a numeric literal below 600.
- [ ] **Step 1: Widen the census first.** It fails on the two known sites; record the output.
- [ ] **Step 2: Fix both sites.** Run `pnpm vitest run tests/unit/deploy/db-sts-boot-timeout-census.test.ts tests/unit/failover`. Expected: PASS.
- [ ] **Step 3: Commit** `fix(k8s): failover and restore wait the full database boot budget`.

### Task 10: Printed commands name real flags (L1)

**Files:**
- Modify: `src/lib/deploy/effects/k8s-ha.js:671-672`: print `vibecarbon failover <env>` and `vibecarbon failover <env> -dry`.
- Test: `tests/unit/cli/printed-command-flags-census.test.ts` (new).
  - Walk `src/**/*.js` string and template literals matching `vibecarbon <cmd>( -[a-z-]+)*`.
  - For each, load that command's exported SPEC and assert every `-flag` exists. Also fail on any `--flag`.
  - Show it fails on the old line.
- [ ] **Step 1: Census first (fails).** **Step 2: Fix.** **Step 3: Run** `pnpm vitest run tests/unit/cli`. Expected: PASS. **Step 4: Commit** `fix(k8s-ha): the deploy summary prints failover commands that exist`.

### Task 11: e2e assertions that would have caught these

**Files:**
- Modify:
  - `tests/e2e/scenarios/` (the k8s-ha and compose-ha failover steps): after `verify-failover`, add an immediate second `failover` invocation that must exit non-zero with `/vibecarbon deploy/`, with no infra change. Confirm via `status` that roles are unchanged and DNS still points at the promoted side.
  - `tests/e2e/checks/` (new `checks/ha-integrity.ts`):
    - `dns_flip_verified`: the A record equals the promoted IP through the provider API;
    - `old_primary_disarmed`: `WALG_ROLE=standby` and the retired marker on the old side;
    - `primary_not_restarted`: the db container or pod start time is unchanged across `reconverge-deploy` on the promoted primary;
    - `slot_capped`: `SHOW max_slot_wal_keep_size` = `4GB` on the primary.
  - `tests/unit/e2e/hollow-pass-census.test.ts`: register the new checks so a missing SSH handle fails them.
- [ ] **Step 1:** Unit tests for each check's pass and fail parsing, under `tests/unit/e2e/ha-integrity.test.ts`. Run: FAIL, then implement, then PASS.
- [ ] **Step 2: Commit** `test(e2e): failback-before-reconverge refuses, DNS flip and disarm are verified`.
- [ ] **Step 3: Real infra** (needs Brandon's OK): `pnpm test:e2e:batch -- --scenario hetzner/k8s-ha`, then `--scenario hetzner/compose-ha`.

---

## Compatibility (PR body)

- An HA env deployed before this change has no `ha.systemIdentifier`. Unplanned failover refuses until the next `vibecarbon deploy` records it. Planned failover with a streaming standby works.
- compose-ha failover stays one-way until a redeploy. A second failover now refuses instead of reseeding the retired node from itself.
- `failover` gains `-force-unplanned` for an operator who knows the primary is gone even though the standby still reports a recent stream.

## Verification

- Per task: the named commands, RED then GREEN in each report, and every census shown biting.
- End of branch:
  - `pnpm lint && pnpm test:unit && pnpm test:integration`;
  - `DOCKER_INTEGRATION=true pnpm test:docker` (db argv);
  - `cd carbon && npm run test:prepush`;
  - CI `test.yml`.
- Real infra (needs Brandon's OK): hetzner/k8s-ha and hetzner/compose-ha, with the Task 11 assertions green.
