# Roadmap

Last updated: 2026-09-15 (evening)

One line per item. Status is claimed here and checked against branches, PRs
and specs by the project-manager pass; when they disagree, the repo wins.

## Now (in review)

- **Follow-ups from the region move** — PR #100. `deploy -server-type <id>`;
  `destroy` records the environment's identity under
  `destroyedEnvironments.<env>` and `deploy` seeds a same-named env from it
  (a sibling key, not a stub — every other command treats presence in
  `environments` as "deployed"); `restore -source` is `latest` or an
  ISO-8601 timestamp (the PITR form was rejected by the legacy filename
  validator) and `backup -action download` refuses wal-g environments up
  front; `ANALYZE` after restore on compose and k8s.

## Next

- (none — the four region-move follow-ups moved to Now with PR #100)

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

- 2026-09-15 — **Env preflight, state-bucket handoff, `-confirm`** (PR #98).
- 2026-09-15 — **Region-move runbook** (PR #97), `docs/ROADMAP.md` seeded
  (PR #99).
- 2026-09-15 — **e2e matrix in EU on the cheapest shared line** (PR #95):
  `capacityPreferences.hetzner` → `nbg1/hel1/fsn1`, `cx23 → cpx22 → ccx13`,
  type-pair-major resolver, CI `regions` default un-pinned from `ash,hil`.
