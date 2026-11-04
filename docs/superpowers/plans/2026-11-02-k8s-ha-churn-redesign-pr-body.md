## What

Two changes to how the HA database moves, shipped together because they change the same k8s db pod template:

- **In-place standby reseed (k8s-ha).** A cold deploy, failover or restore reseeds the standby inside its running db pod. The CLI stages a verified `pg_basebackup` into `$PGDATA/.vc-reseed`, stops postgres with SIGINT to PID 1, and the kubelet restarts the container in the same pod. `db-guard.sh`, now the db container's command, swaps the staged tree in before postgres starts. The volume never detaches. The helper pod, the scale to zero and the stale-attachment repair are gone.
- **A live wal-g role (both HA tiers, and single-node compose and k8s).** The wal-g write-guard is a one-word file outside PGDATA, `/var/lib/vibecarbon/role/walg-role`, read through one parser. On k8s it sits on the db volume, with a durable intent in the CLI-owned `vibecarbon-db-role` ConfigMap that `db-guard.sh` applies on every start. On compose it is the host directory `/opt/<project>/.vibecarbon-role`, bound read-only. A failover moves the role with one write and no db restart: `primary` before `pg_promote`, `standby` on the demoted side.

## Why

On k8s-ha every standby reseed detached and re-attached the db volume four times, and every failover recreated the promoted db pod to change one env var. Each same-node detach and re-attach is the trigger of the `do-csi-stale-volumeattachment` class: a DO cold deploy timed out on exactly that churn on 2026-11-02. The env-var role also very likely dropped the promotion's `.history` and `.partial` WAL files on both tiers, because the promoted node read `standby` until its restart.

## Compatibility

No v1.0 yet, so no breaking-change marker. These are the behaviour changes an existing project meets.

**Run `vibecarbon upgrade` first.** The template and the CLI move together.

- `vibecarbon deploy` refuses a project whose scaffold predates the role file and says to run `vibecarbon upgrade`. Detection is by content:
  - every tier: `volumes/db/walg-env.sh` carries the role parser;
  - compose tiers: `docker-compose.prod.yml` binds `.vibecarbon-role`;
  - k8s tiers: the `vibecarbon-wal-archive` ConfigMap's `walg-env.sh` key carries the parser, its `db-guard.sh` key carries the reseed protocol marker line, and the db StatefulSet's command is `sh /usr/local/bin/db-guard.sh`.
- `vibecarbon scale`, `vibecarbon restore`, `vibecarbon failover` and `vibecarbon configure cicd` (for a k8s env) refuse the same scaffold with the same line, before any remote or cloud call.

**One db restart per server or cluster, on the first deploy.**

- Existing k8s and k8s-ha clusters: the first deploy with this CLI restarts each db once, for the new pod template (the `db-guard.sh` command and mount, the role mount, the intent env, no `WALG_ROLE` env). It runs under `watchDbAttach`, and the deploy writes the role ConfigMap and the role file.
- Existing compose and compose-ha servers: the first deploy recreates db once, with the role bind. The `.env` `WALG_ROLE` line is no longer read or written; one left in place is inert.

**Until that deploy, the commands that move the role or reseed refuse, before anything changes.**

- k8s-ha failover and restore refuse a cluster whose db predates the in-place reseed, with the deploy hint: "this cluster's db predates in-place reseeds; run `vibecarbon deploy <env>` once (one db restart), then retry". A failover also refuses a standby db pod with no role mount.
- compose-ha failover, and restore on compose, compose-ha and single-node k8s, refuse a db that has not been redeployed: a compose db container with no bind of the role directory, or a k8s db pod with no role mount. The refusal names `vibecarbon deploy <env>` and says nothing was started or changed.

**GitOps projects (`vibecarbon configure cicd`): run `vibecarbon deploy <env>` right after `vibecarbon upgrade`, before or together with the push.**

- `deploy.yml` and Flux sync `k8s/base`. That carries the new `vibecarbon-wal-archive` ConfigMap, whose `walg-env.sh` and backup scripts read the role file, and the backup CronJob that expects it.
- Neither applies the db StatefulSet (Flux drops it from its build), so the running db keeps its old pod template with no role mount.
- A db reading the new scripts without the role file holds WAL by design: archiving exits 1, postgres keeps every segment, and backups refuse. Nothing is lost, but WAL piles up on the db volume until `vibecarbon deploy` rolls the db onto the new template. On compose, the old db containers hold WAL the same way until they are redeployed.

**`failover -abort`, then deploy (k8s-ha and compose-ha).**

- The abort keeps the old primary. The failover it calls off may already have promoted the standby.
- Before it stops the standby, the abort reads its lineage. A standby out of recovery is recorded as discardable in `.vibecarbon.json` (`ha.discardableStandby`: address, system identifier, timeline).
- The next `vibecarbon deploy <env>` reseeds over that exact copy. Before this change that deploy refused the standby as promoted outside vibecarbon, so abort then deploy was blocked.
- A promotion the abort did not record still refuses, and so does a record for another lineage. The discard covers that copy's writes, including any it takes after the abort. The record is cleared once a reseed replaced the standby's data directory, once a deploy verifies the standby streaming, and by any failover's role swap, so it never outlives a role change. An abort that could not read the standby records nothing and warns. `docs/technical.md`, "Deploy after `failover -abort`", says what to do then.

**compose-ha cold deploys run the same lineage check as k8s-ha.**

- Before the reseed, the deploy reads both databases' lineage, after one bounded 60 s wait for the standby's db to accept connections.
- It refuses a standby promoted outside vibecarbon (same system identifier, higher timeline than the primary), unless the abort recorded that copy.
- It refuses a standby whose recovery state and lineage cannot be read, and names the compose rebuild: on the standby server only, `docker rm -f <project>-db`, `docker volume rm <project>_db_data`, then `vibecarbon deploy <env>` (`docs/technical.md`, "Rebuilding a compose-ha standby whose db cannot start"). Before this change compose reseeded without either check.

**A k8s-ha standby whose postgres cannot start.**

- The in-place reseed needs a running standby db pod to stage into, so a crash-looping standby has no automatic reseed path.
- The deploy refuses and names the manual rebuild. That covers the standby's db rollout wait, the self-heal wait, the reseed guard's not-running refusal, and a db that never accepted connections.
- The rebuild runs on the standby cluster only: scale `statefulset/db` to 0, wait for `db-0` to go, delete `pvc/data-db-0`, scale back to 1, then `vibecarbon deploy <env>`. The fresh volume initdbs a new database, and the deploy's cold reseed seeds it from the primary, the same path a new standby cluster takes. `docs/technical.md`, "Rebuilding a k8s-ha standby whose db cannot start", walks it.
- A CLI command for it is a tracked follow-up.

**Unaffected.** vibecarbon-web runs `vibecarbon@0.49.0` with its own template.

## Testing

- Unit: `pnpm lint` and `pnpm test:unit` green on every commit (pre-commit gate). New and changed coverage includes:
  - the abort's lineage record, the shared lineage verdict, and abort-then-deploy on both tiers (the recorded copy reseeds; an unrecorded promotion and a record for another lineage refuse);
  - the standby rebuild hint at each deploy refusal;
  - the lockstep preflight's marker and command checks;
  - one demotion order on both tiers;
  - one role read-back with its census;
  - role-mount refusal parity on the thrown errors.

Real infrastructure (`running-e2e-matrix`, clean checkout of the branch):

| scenario | result |
| --- | --- |
| DO k8s-ha cold deploy (`standby_db_created_once`, `primary_db_created_once`, `k8s-ha reseed: staged=yes swapped=in-place`) | _pending_ |
| Hetzner k8s-ha cold deploy | _pending_ |
| DO k8s-ha failover, failback, restore (`promoted_db_not_recreated`, `promotion_history_archived`, `reseed_in_place`) | _pending_ |
| Hetzner k8s-ha failover, failback, restore | _pending_ |
| compose-ha failover, Hetzner then DO (`promotion_history_archived`, no `up -d --no-deps db`) | _pending_ |
| compose-ha scale, standby replacement (role file `standby` before its first `up`) | _pending_ |
| one-roll migration: a `main`-deployed k8s-ha rig redeployed with this branch (one db restart per cluster; a failover before the redeploy refuses at STEP 1) | _pending_ |
| `failover -abort` after the promote landed, then `vibecarbon deploy` (k8s-ha and compose-ha) | _pending_ |
| standby rebuild on a kept k8s-ha rig (scale 0, delete `data-db-0`, scale 1, deploy) | _pending_ |
| `vc_kill_tree` under busybox on the published db image; `ReseedStageTimeoutError` and cleanup on a throttled relay link (manual) | _pending_ |
