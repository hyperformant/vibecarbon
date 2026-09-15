# Roadmap

Last updated: 2026-09-15

One line per item. Status is claimed here and checked against branches, PRs
and specs by the project-manager pass; when they disagree, the repo wins.

## Now (in review)

- **Env preflight, state-bucket handoff, `-confirm`** — PR #98. Deploy stops
  before provisioning when `.env` lacks compose-required keys; `destroy`
  records the kept Pulumi state bucket as `retainedStateBucket` so the next
  deploy reuses it; `-confirm <value>` on destroy/restore/failover for
  scripted production runs, fail-fast off a TTY.
- **Region-move runbook** — PR #97. `docs/deploy-hetzner.md` § "Moving to a
  different region or server type".

## Next

- **`deploy -server-type <id>`** — scripted compose deploys with no
  `serverType` in the env block take the region's *medium-tier* default
  (`cpx32`/`cx33`, ~2x the price of `cpx22`); the only override is editing
  `.vibecarbon.json`. Add the flag (name matches `failover -server-type`;
  `scale -type` means "scale *to*", so it stays).
- **`destroy` keeps a `status: "destroyed"` stub** — today it deletes
  `environments.<env>` entirely, so a manual destroy→deploy needs the
  identity/DNS/backup block re-typed by hand (see the runbook). Keep those
  fields, strip runtime ones, have `deploy` treat the stub as fresh and
  `destroy` on a stub say "already destroyed".
- **Trim the wal-g-incompatible backup surface** — `backup -action download`
  and `restore -source <file>` only handle legacy `backups/*.tar.gz` dumps
  that wal-g never writes; `runComposeRestore` throws on a local file. Either
  remove them from help for wal-g environments, or implement a real
  round-trip (pg_dump over SSH → local `.sql.gz` → restore).
- **`ANALYZE` after restore** — planner stats are not part of a base backup;
  `pg_stat_user_tables.n_live_tup` reads 0 for every table until autovacuum
  runs, which looks like data loss to anyone verifying a restore.

## Later

- **`vibecarbon migrate <env> -region <id> -server-type <id>`** — one command
  for the replace + restore that moving a region or server type requires
  today: backup → destroy (carrying the identity block) → deploy at the new
  placement → `restore -source latest` (guarding that `latest` still
  predates the destroy) → `COUNT(*)` verification against a pre-move
  baseline. Resumable via a `.vibecarbon/migrate-state-<env>.json`, same
  pattern as deploy-state. Open questions parked with it: v1 modes (compose
  only vs. compose + k8s; HA needs two regions and standby re-seeding),
  whether it depends on the destroy stub above or carries identity itself,
  and whether a blue/green variant (deploy alongside, cut DNS, destroy old)
  is worth its data-drift window. Prompted by the 2026-09-15 vibecarbon-web
  move, which needed six documented gotchas to do by hand.
- **Region prompt price hint** — Hetzner US locations (`ash`, `hil`) carry
  no `cx` line and price CPX ~3x the EU rate since 2026-06-15; the region
  picker should say so.

## Recently shipped

- 2026-09-15 — **e2e matrix in EU on the cheapest shared line** (PR #95):
  `capacityPreferences.hetzner` → `nbg1/hel1/fsn1`, `cx23 → cpx22 → ccx13`,
  type-pair-major resolver, CI `regions` default un-pinned from `ash,hil`.
