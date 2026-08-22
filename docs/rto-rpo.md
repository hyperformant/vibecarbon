# Measuring and publishing RTO/RPO (HA failover)

How the published RTO/RPO guarantees in [docs/technical.md](./technical.md#guarantees-k8s-ha)
are measured, what each figure maps to in the e2e metrics database, and how to
refresh them after a record run. The published block is rendered by
`pnpm test:e2e:rto-rpo` (`tests/e2e/metrics/rto-rpo.ts`) — never edited by hand.

## Where the measurements come from

Every e2e run records into `tests/results/e2e.db` (SQLite; schema in
`tests/e2e/metrics/db.ts`):

- **`steps`** — wall-clock per lifecycle step (`failover`, `verify-failover`, …)
  per scenario (`mode` = `k8s-ha`, `compose-ha`, …).
- **`perf_substep`** — sub-stage timings parsed from the CLI's
  `[perf] <name> <ms>ms` stderr lines (`VIBECARBON_PERF=1`, forced on by the
  e2e harness), keyed to the parent step.
- **`verifications`** — named post-step checks
  (`tests/e2e/checks/`), including the replication/continuity battery.

CI record runs (the **E2E US Perf Run** workflow) upload `e2e.db` as an
artifact, so figures can be rendered from the exact db that produced the
README perf table.

The e2e `failover` step runs `vibecarbon failover` against a **healthy
primary**, i.e. the **planned-switchover** path — with **real** standby worker
provisioning (pilot-light), the quiesce, the WAL catch-up gate, promotion,
app-tier scale-up, the readiness gate, and the DNS flip. That is the
customer-identical path (no shortcuts, per house e2e rules).

## Metric mapping

| Published figure | Source | Exact query (`sqlite3 tests/results/e2e.db`) |
| :--- | :--- | :--- |
| Failover command wall-clock (incl. provisioning) | `steps.duration_ms`, `name='failover'` | `SELECT s.duration_ms FROM steps s JOIN scenarios sc ON s.scenario_id=sc.id WHERE sc.mode='k8s-ha' AND s.name='failover' AND s.status='pass' AND sc.run_id='<run>';` |
| — worker provisioning (IaC 0→N) | `perf_substep` `failover.provisionWorkers` | `SELECT p.duration_ms FROM perf_substep p JOIN steps s ON p.step_id=s.id JOIN scenarios sc ON s.scenario_id=sc.id WHERE p.name='failover.provisionWorkers' AND sc.run_id='<run>';` |
| — standby db promotion | `perf_substep` `failover.promoteStandby` | same as above with `p.name='failover.promoteStandby'` |
| — remainder (quiesce, catch-up gate, wal-g write-guard move, app scale-up, readiness gate, DNS flip) | derived: total − provisioning − promotion | arithmetic over the three queries above |
| Planned outage-side upper bound | derived: total − provisioning | see below |
| Post-failover verification | `steps.duration_ms`, `name='verify-failover'` | same as the first query with `s.name='verify-failover'` |
| Planned RPO = 0 evidence | `verifications` `replication_failover_continuity` | `SELECT v.status FROM verifications v JOIN steps s ON v.step_id=s.id JOIN scenarios sc ON s.scenario_id=sc.id WHERE v.check_name='replication_failover_continuity' AND sc.run_id='<run>';` |

Notes:

- **`cli.failover.total`** (also in `perf_substep`) is the CLI-internal
  wall-clock; the step duration is the harness-observed one (slightly larger:
  process spawn + teardown). The step duration is published — it is the
  outside view.
- The IaC layer nests its own markers inside provisioning
  (`scale.k8s.<env>-standby.upStack` etc.). They are *components of*
  `failover.provisionWorkers` — never add them to the total.

## What each guarantee means

**Planned-switchover RTO.** The customer-visible outage opens at the quiesce
step — *after* provisioning has already secured capacity — and closes when
the promoted app tier serves and DNS propagates. It is bounded by
`failover total − failover.provisionWorkers` (the bound also contains the
pre-quiesce preflight, so it errs high — the honest direction for a
guarantee) **plus DNS propagation**, itself bounded by the 60s record TTL the
failover flip writes.

**Unplanned-failover RTO.** The outage begins at the failure itself, before
the command runs. The command-side recovery is the same dominant cost
structure as the measured planned path (provisioning + promotion + scale-up +
gate + DNS; it *skips* quiesce and the catch-up gate, and adds a best-effort
old-primary scale-down), so the measured planned wall-clock is published as
the command-side figure, plus failure-detection time (operator-dependent —
failover is deliberately manual) and DNS propagation. The e2e cannot ethically
measure detection time; it is named, not numbered.

**Planned RPO = 0.** By construction (quiesce-before-promote plus the
pre-promotion WAL catch-up gate in `src/failover.js` —
`waitForStandbyCaughtUp` refuses to promote a standby that has not replayed
the primary's final LSN) and evidenced per run: the e2e writes a marker row on
the old primary immediately before failover and asserts it survived onto the
promoted primary (`replication_failover_continuity`). The renderer **refuses
to publish** figures from any run where that check is missing or failed.

**Unplanned RPO = replication lag at failure.** Not a per-run e2e figure — it
is whatever WAL was in flight when the primary died. It is evidenced two ways:

- *Mechanism*: the e2e `replication_streaming` and
  `replication_data_propagation` checks prove the stream carries data within
  budget on every green run.
- *Operations*: `vibecarbon status <env>` prints a live replication-lag line
  (primary `pg_stat_replication` byte lag via `pg_wal_lsn_diff`, plus the
  standby's last-replay position) — that number *is* the unplanned RPO
  exposure at any moment, and monitoring it is the published guidance.

## Rendering and publishing

```bash
# From a CI record run: download the artifact, then
gh run download <actions-run-id> -n <artifact-name> -D /tmp/record-run
pnpm test:e2e:rto-rpo -- --run latest --db /tmp/record-run/e2e.db \
  --regions "ash→hil" --gh-run <actions-run-id> --write
```

`--write` re-renders the block between the
`<!-- BEGIN:rto-rpo-figures -->` / `<!-- END:rto-rpo-figures -->` markers in
`docs/technical.md` in place (print-only without `--write`). Review the diff,
then commit.

**Publication gates** (all enforced by the renderer, which fails closed):

1. The scenario must be green, with green `failover` **and** `verify-failover`
   steps.
2. `replication_failover_continuity` must be recorded and passing.
3. House marketing rule: **HA claims stay pinned to the latest green e2e
   matrix.** A green single-scenario run may render figures (mirroring the
   README perf-table row-patch precedent), but the output flags it and the
   provenance line says so — confirm the latest full matrix is green before
   shipping the claim.

## Instrumentation gaps (owed to the failover path owners)

Only two `[perf]` markers exist inside `vibecarbon failover` today
(`failover.provisionWorkers`, `failover.promoteStandby`), so quiesce, the WAL
catch-up gate, the wal-g write-guard move, app-tier scale-up, the readiness
gate, and the DNS flip are published as one **remainder** bucket. That is
sufficient for the guarantees (the outage bound needs only
total − provisioning), but a finer four-way breakdown wants markers in
`src/failover.js` at these seams: `failover.quiesce`, `failover.catchUp`,
`failover.reseed`, `failover.walgRoleMove`, `failover.appScaleUp`,
`failover.readinessGate`, `failover.dnsFlip`. `perfTimer` is zero-overhead
when `VIBECARBON_PERF` is unset. Until then, the DNS-propagation tail is
evidenced by the `verify-failover` gate log line
(`Waiting for <domain> to resolve to promoted IP …`) and bounded by the 60s
TTL.

## How the e2e verifier treats the DNS-propagation tail

The tail above is a property of the *client's* resolver chain, not of the
deployment: every resolver that answered for the domain just before the flip
keeps serving the retired address until its cached record expires. The
`verify-failover` step therefore splits its assertions in two, and neither one
measures the runner's own cache:

- **Does the promoted node serve?** The step's HTTP checks run under a
  resolution pin (`tests/e2e/utils/dns-pin.ts`, `compose-ha` only) that dials
  the promoted node's IP directly while keeping the domain in the `Host` header
  and the TLS SNI — so name-based routing and certificate validity are still
  fully asserted, but a mid-TTL cache cannot redirect a check onto the retired
  node. Before the pin, that is exactly what happened (hetzner/compose-ha,
  2026-08-11): the battery split, some checks reaching the promoted node and
  passing while others hit the stopped app tier on the demoted one.
- **Did the flip publish?** The `dns_failover_flip` verification queries the
  zone's **authoritative nameservers** — which hold no cache of their own zone —
  and asserts the A record now carries the promoted IP. It self-skips on
  `k8s-ha`, whose failover reassigns a floating IP and never rewrites DNS.

The propagation gate log line above is retained as the (now advisory) record of
how long the runner's public resolvers took to converge. `verify-deploy` and the
other verification steps are deliberately **not** pinned: that path is the
customer cold path, and pinning it would hide an unpublished record.

## Compose-HA after a failover (no automated failback)

`vibecarbon failover` on a `compose-ha` environment promotes the standby,
repoints DNS, and records the swap by flipping the `role` field on the two
`servers[]` entries. The Pulumi stacks keep their birth identity — the promoted
node is still stack `<env>-standby`, the retired node still `<env>-primary` —
and **compose-HA deploy resolves the pair from those stack names, not from the
roles**. `vibecarbon deploy` therefore REFUSES a swapped compose-HA environment
(`src/lib/deploy/compose/ha-role-swap.js`); running it would repoint DNS at the
retired node and re-seed — wipe — the promoted primary's database. There is no
bypass flag, and no automated failback: restoring HA symmetry needs role-aware
compose-HA redeploy support, which does not exist yet.

What the environment's DR posture actually is while it sits in that state:

- It is serving from **one** node. There is no standby and no streaming
  replication, so a second node loss is unprotected.
- Backups continue from the promoted node **provided the write-guard move
  succeeded**. Failover moves the wal-g write-guard onto it
  (`restoreComposeWalgRole`) and a promoted Postgres archives on the new
  timeline under the same `WALG_S3_PREFIX`, so base backups and WAL archiving
  are continuous across the failover — RPO for a *further* loss is then still
  bounded by the archiving cadence, recoverable via `vibecarbon restore <env>`.
  That move is proven, not assumed: `vibecarbon failover` exits **non-zero** if
  it did not land, so a failover that reported success is your evidence. A
  failover that exited non-zero is not — treat the environment as unbacked-up
  until you have verified it.
- `restore`, `scale` and `status` resolve the node by `role`, so they follow the
  promotion correctly. `deploy` does not — it is the blocked path. `backup`
  resolves `servers[0]` (`serverIp: 'first'`), which post-failover is the
  **retired** node, so take on-demand backups against the promoted node until
  that path is role-aware. Do not assume a `backup create` against the retired
  node is harmless: demoting its write-guard is best-effort (failover warns and
  continues if the demote fails), and a retired node still carrying
  `WALG_ROLE=primary` would push a **stale base backup** into the shared prefix.
  Check `WALG_ROLE` in `/opt/<project>/.env` on the retired node before running
  any manual backup there.

The k8s-HA equivalent is different and is **not** blocked: `swapHaRoles` swaps
`ha.primary` / `ha.standby` wholesale (each carries its own `.stack`), the
orchestrator derives `haStacks` from them, and the reconverge deploy documented
under "Recovery & Fail-back (k8s-ha)" in `docs/deploy-hetzner.md` is a green e2e
step.

## Current datapoint

First CI record run, 2026-07-18 — **E2E US Perf Run** (GitHub Actions run
29629518169, artifact `e2e-us-perf-29`), `k8s-ha` single-scenario, ash→hil:
failover step **3m 25s** (204,626 ms) including real worker provisioning
(2m 23s), promotion 8.1s, remainder 54s, outage-side bound **1m 2s**,
`replication_failover_continuity` pass. The published block in
`docs/technical.md` was rendered from that artifact's `e2e.db` by the exact
command above.

---

## Disaster-recovery runbook: fresh cluster from S3 (`vibecarbon deploy -restore`)

For when a region or cluster is lost outright (no standby to fail over to), or
when seeding a brand-new environment from a production backup. This path is
**k8s / k8s-ha only** — for restoring into an *existing* environment (any mode,
including compose), use `vibecarbon restore` instead.

### Step 1 — confirm what's in S3

List the wal-g base backups available for the environment (read-only, no
changes):

```bash
vibecarbon restore <env> -l     # or: vibecarbon backup <env> -l
```

The newest base backup plus the continuous WAL archive after it define your
recovery window: `latest` replays to the end of the WAL stream; a PITR
timestamp can land anywhere inside the window.

### Step 2 — stand up a fresh cluster seeded from the backup

```bash
# Replay everything (latest base backup + all archived WAL):
vibecarbon deploy <env> -mode k8s -restore latest -y

# Or point-in-time (ISO-8601, replay stops at the target):
vibecarbon deploy <env> -mode k8s -restore 2026-08-05T14:30:00Z -y
```

### What actually happens

1. Pulumi provisions fresh nodes, firewalls, and S3 bindings as on any cold
   deploy; the restore target is stamped into the `vibecarbon-secrets` Secret
   as `RESTORE_TARGET` (empty on normal boots, making the next step a no-op).
2. The database StatefulSet's `walg-restore` init container
   (`carbon/k8s/values/supabase.values.yaml`) sees `RESTORE_TARGET`, clears
   `PGDATA`, and runs `wal-g backup-fetch` against the backup bucket (with
   retries for stale storage frontends).
3. It then configures archive recovery: `restore_command = 'wal-g wal-fetch …'`
   pulls WAL segments back from S3, `recovery.signal` puts Postgres into
   archive recovery pinned to the base backup's own timeline, and — for PITR —
   `recovery_target_time` stops replay at the requested instant. On reaching
   the target (or the end of WAL), Postgres promotes to read-write.
4. Database migrations are **skipped** (`-restore` implies it): the restored
   dataset already carries `schema_migrations` and is authoritative. Admin-user
   seeding still runs; it is idempotent against restored data.
5. The app tier rolls out normally and the deploy finishes with the standard
   public health probe.

RPO for this path is bounded by WAL archiving cadence (continuous archiving +
the scheduled base backups); RTO is the cold-deploy time of the tier plus WAL
replay, so it grows with how much WAL sits between the base backup and the
target.
