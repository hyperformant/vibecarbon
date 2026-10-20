# Price-Optimized Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deploy with no size flags gets the cheapest server that is orderable right now and fits the measured load, for every provider, mode and role. HA standbys go to the cheapest stocked partner location, and the README shows the resulting monthly cost per environment.

**Architecture:**
- **Each provider declares candidates per role**: `static ROLE_CANDIDATES`, the x86 types it is willing to use for a `compose`, `master`, `db` or `worker` role.
- **One shared picker, `pickRoleType`** in a new `src/lib/sizing.js`, filters those candidates against:
  - the live catalog the deploy already fetches (`Provider.fetchServerTypes`);
  - the per-role RAM floor;
  - availability in the target location.

  It then sorts the survivors by live monthly price for that location and returns the cheapest. With no live catalog, it falls back to the declared order.
- **Every default-size site reads the picker:** `getRegionDefaults`, the compose path in `prompts.js`, the compose-ha and k8s-ha standby re-resolution, `scale`, the k8s "starter" profile and the e2e harness.
- **Standby location defaults and new-project region defaults** come from the same picker. Persisted choices are never moved.

**Tech Stack:** Node ESM CLI (`src/`), vitest (`tests/unit`), provider REST APIs already called by `fetchServerTypes`.

**Spec:**
- Brandon's 2026-10-20 instructions in chat:
  - "We should show best practical prices even if they are only available in one region";
  - "let's get this new stack fully speed and price optimized".
- The cost analysis at `/tmp/claude-1000/-home-brandon-repos-vibecarbon/0b7ee7cd-7067-44f6-a72a-5ce5d7505b2c/scratchpad/cost-grid.md` and `cost-grid-sources.md`, which hold the code references, live prices and peak-RAM data used below. Copy both files into `docs/superpowers/plans/2026-10-20-cost-grid-sources.md` in Task 1 so the plan's evidence travels with the repo.

## Rulings (made while planning)

- **P1, RAM floors come from measured peak × 2, rounded up to the provider's next RAM tier, and compose never goes below `COMPOSE_MIN_RAM_GB = 4`.**
  - Measured peaks (Hetzner, observability on, 2026-10-20): compose 1.10 GB, compose-ha 1.25 GB per node, k8s master 1.49, db 0.64, worker 1.05; k8s-ha master 1.56, db 0.66.
  - Floors: `compose: 4`, `master: 4` (2 × 1.56 = 3.12), `db: 2` (2 × 0.66 = 1.32), `worker: 4` (2 × 1.05 = 2.1).
  - These are a constant table in `src/lib/sizing.js`, `ROLE_MIN_RAM_GB`, with a comment citing the measurement. They are not hand-tuned per provider.
  - Cost if wrong: a busier app outgrows the floor; `vibecarbon scale -type` is the escape hatch, as today.
- **P2, the picker sorts by live price and does not trust declared order.**
  - Each provider's catalog already carries a monthly price: Hetzner per location, DigitalOcean `price_monthly`, Vultr `monthly_cost`, Linode `price.monthly`, Scaleway hourly × 730.
  - `ROLE_CANDIDATES` names the eligible family members, and the order is only the offline fallback.
  - This is why a stale hand list ("cpx32 first") can no longer pick an 8 GB server where a 4 GB one is in stock.
  - Cost if wrong: a provider whose catalog lacks price for a type falls back to declared order for that type, and a unit test pins that.
- **P3, never move a persisted choice.** Precedence is unchanged: args, then `envConfig`, then the picker.
  - The picker affects only an environment's first deploy and a new standby.
  - `serverType`, `masterServerType`, `dbServerType`, `workerServerType` and `secondaryRegion` must be persisted in the skeleton env written before provisioning (`orchestrator.js` `saveSkeletonEnv`). Then a deploy that fails and is re-run after a catalog change cannot pick a different size and make Pulumi replace a live server.
  - Cost if wrong: none for existing envs. A user who wants the cheaper size runs `vibecarbon scale -type`.
- **P4, the region default for a NEW project follows price within the provider's default continent.**
  - When no region is persisted or passed, the region prompt's preselected value (and the `-y` headless choice) is the location on `DEFAULT_REGION`'s continent where the compose or cluster role set is cheapest to order now. Ties go to `DEFAULT_REGION`.
  - Every region option's label shows the from-price (`hel1 - Helsinki · from $7.09/mo`), so the user sees the trade and can pick a closer location.
  - The continent boundary keeps latency predictable: a European default never lands in the US.
  - Cost if wrong: a German user's default is Helsinki (about 20 ms more) unless they pick nbg1 at the prompt, where the price difference is visible.
- **P5, the standby default is the cheapest valid partner location.**
  - `getDefaultStandbyRegion(primary)` keeps its contract (different location, same continent), but among the candidates it picks the one where the standby's role set is cheapest to order. Ties keep the conventional pair, `nbg1 -> fsn1`.
  - This fixes DigitalOcean's `sfo3` default, which cannot order the sizes today, and the static `HA_REGIONS` partners on every provider.
  - Resolving the standby moves to after `fetchServerTypes` in `prompts.js`: today it runs at `:652`, before the catalog fetch at `:688`. That adds no network call, since the catalog fetch already happens.
  - Cost if wrong: a standby farther from the primary on the same continent, with a few ms more replication latency.
- **P6, no new serial latency.**
  - Availability and price come from the `fetchServerTypes` call the deploy already makes.
  - Where a provider needs per-zone availability calls (Scaleway), they run with `Promise.all` inside `fetchServerTypes`, and the result is cached on the class for the process, as `_locationTypes` already is.
  - `scripts/cost-grid.js` is the only new caller.
  - Cost if wrong: one extra parallel request batch on Scaleway deploys.
- **P7, fail closed when nothing fits.**
  - When no candidate is orderable in the target location for a role, the deploy stops before any provider write with one line: `no <role> server with <N> GB+ RAM is orderable in <loc> right now; orderable nearby: <loc (type $x/mo)>, ...`.
  - A persisted `secondaryRegion` or region that can no longer order its persisted type gets the same one-line refusal naming alternatives. It is never moved silently (P3).
- **P8, the README cost grid is generated, committed and dated.**
  - `scripts/cost-grid.js` queries the provider APIs (tokens from the environment, never printed) and writes the section between `<!-- cost-grid:start -->` and `<!-- cost-grid:end -->` in `README.md`.
  - The output is committed with its date. Running it in CI would need five providers' tokens and would flake on stock changes.
  - Refresh is `node scripts/cost-grid.js --write`.
  - Cost if wrong: the README goes stale between refreshes. The table carries its date, and the release checklist line in Task 7 names the refresh.
- **P9, ARM stays out of this plan** (see "Later: ARM"). The x86 guard `assertAmd64ServerType` is untouched.
- **P10, the k8s worker floor is 4 GB, the master's too.** DigitalOcean's 2 GB master runs at about 75% RAM today. P1 moves DO master and worker to `s-2vcpu-4gb` and db to `s-1vcpu-2gb`. The cluster cost is the same, $61, with more headroom where it is used.

## Global Constraints

- x86-64 only. Every candidate list contains no ARM types, which the census asserts through `Provider.isArmServerType`.
- `COMPOSE_MIN_RAM_GB = 4` (`src/lib/server-types.js:9`) stays the compose floor.
- Role floors: `ROLE_MIN_RAM_GB = { compose: 4, master: 4, db: 2, worker: 4 }`.
- Persisted values always win (P3). The picker never changes a deployed environment's type or region.
- Region labels and refusal lines follow the CLI help voice: lowercase informational hints, no em dashes, exact numbers.
- README copy: no em dashes, the word "free" never next to servers, infrastructure or deploy, emoji-restrained.
- Conventional commits, pathspec commits, never `--no-verify`, no `!:` footers. Root uses pnpm. Never print API tokens.
- **Run order relative to the other 2026-10-20 plans in this directory:**
  - after `2026-10-20-project-app-bucket.md`, which also edits `src/lib/deploy/prompts.js` (`resolveEnvStorage`, a different region of the file);
  - after `2026-10-20-cold-deploy-speed.md`, whose budgets were measured on 2 vCPU/4 GB nodes; this plan keeps every role at 2 vCPU or more except the k8s db role.
  - It shares no files with the add-ons, registry-copy or TLS plans.

## Review Focus

1. **A live environment deployed with today's defaults** (Hetzner compose on `cpx32`, or DO k8s master `s-2vcpu-2gb`): a redeploy after this change keeps the persisted types, and the Pulumi stack sees no server diff. A failed first deploy that is re-run also keeps the types written by the skeleton env. Test in Task 3.
2. **An offline catalog** (`fetchServerTypes` falls back): every provider's picker returns the first declared candidate that meets the floor, and it is amd64. Test in Task 1.
3. **A persisted `secondaryRegion` that can no longer order the standby type** fails closed with alternatives and is not moved. Test in Task 4.
4. **A standby priced in a different location** from the primary (cx23 in hel1, cpx22 in fsn1): compose-ha and k8s-ha get mixed types, and the existing `standbyServerType` logging shows it. Test in Task 4.
5. **Location-dependent prices** (Hetzner `sin`, `ash` and `hil` cost more): the picker uses the target location's price, not the first price in the list. Test in Task 1.

## File Map

- Create `src/lib/sizing.js`: `ROLE_MIN_RAM_GB`, `pickRoleType`, `cheapestRoleSet`, `rankLocationsByPrice`.
- Modify `src/lib/providers/{hetzner,digitalocean,vultr,linode,scaleway}.js`:
  - `static ROLE_CANDIDATES`;
  - a `static priceFor(type, location)` reader over the live catalog;
  - `getRegionDefaults` delegates to the picker;
  - `getDefaultStandbyRegion` delegates to `rankLocationsByPrice`.
- Modify `src/lib/providers/base.js`: the abstract `ROLE_CANDIDATES` and `priceFor` contract.
- Modify `src/lib/deploy/prompts.js:620-740`:
  - compose uses `roleDefaults.compose`, not `dbType`;
  - the standby is resolved after the catalog fetch;
  - region options carry from-prices;
  - P7 refusals.
- Modify `src/lib/deploy/orchestrator.js` `saveSkeletonEnv`: persist the four types (P3).
- Modify `src/lib/deploy/effects/compose-ha.js:111-133`, `src/lib/deploy/effects/k8s-ha.js` (standby type), `src/scale.js:182` and `src/lib/server-types.js` (`K8S_PROFILES.starter` derives from the picker): the picker replaces `resolveServerTypeForRegion` defaults where no type is persisted.
- Modify `tests/config.ts:18,211-213,295`: default scenarios stop pinning `serverType`. `tests/e2e/utils/ssh.ts` `getServerIps` also returns the k8s-ha primary worker for resource metrics.
- Create `scripts/cost-grid.js`, the `README.md` section, and `docs/superpowers/plans/2026-10-20-cost-grid-sources.md`.
- Tests are named per task. New census: `tests/unit/providers/role-candidates-census.test.ts`.

---

### Task 1: The picker and the role floors

**Files:**
- Create: `src/lib/sizing.js`, `tests/unit/lib/sizing.test.ts`.
- Copy: the two cost-grid scratch files into `docs/superpowers/plans/2026-10-20-cost-grid-sources.md`, one file with both sections.

**Interfaces:**
- Produces:
  - `ROLE_MIN_RAM_GB: Readonly<{ compose: 4, master: 4, db: 2, worker: 4 }>`;
  - `pickRoleType({ candidates: string[], catalog: Map<string,{ramGb:number, arch:string}>|null, orderable: Set<string>|null, priceFor: (type)=>number|null, minRamGb: number }) -> string|null`:
    - It filters to `orderable` (when non-null), `ramGb >= minRamGb` and `arch === 'x86'`, then sorts ascending by `priceFor`, with unknown prices after known ones in declared order.
    - With `catalog === null` it returns the first candidate (declared order).
    - It returns `null` when nothing survives.
  - `cheapestRoleSet(Provider, location, roles: string[]) -> { types: Record<role,string>, monthly: number } | null`;
  - `rankLocationsByPrice(Provider, locations: string[], roles: string[]) -> Array<{ location, monthly, types }>`, ascending, omitting locations where any role is unorderable.

- [ ] **Step 1: Write the failing tests.**
  - With candidates `['cpx32','cpx22','cx23']`, orderable `{cpx22, cpx32}`, prices `{cx23: 6.49, cpx22: 22.99, cpx32: 41.99}` and floor 4, it returns `'cpx22'`, not the declared-first `cpx32`.
  - With orderable `{cx23, cpx22}` it returns `'cx23'`.
  - Floor 2 with a 2 GB `cpx12` at 13.49 and `cx23` at 6.49 orderable returns `'cx23'`: RAM above the floor is fine when cheaper.
  - Review Focus 2: `catalog: null` returns the first candidate.
  - An ARM type in the catalog is skipped even if cheapest.
  - Nothing orderable returns `null`.
  - Review Focus 5: `priceFor` called with the target location returns `20.49` for `ash` and `5.99` for `nbg1`, and the picker ranks by the location's value. Assert through a stub `priceFor` that records the location argument.
  - `rankLocationsByPrice` over `hel1/nbg1/fsn1` for `['compose']` with the 2026-10-20 Hetzner fixture (cx23 orderable in hel1 only) returns `hel1` first with `monthly: 6.49`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/lib/sizing.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/lib/sizing.js` with the signatures above. Add a comment block above `ROLE_MIN_RAM_GB` citing the measured peaks from P1 and the sources doc.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(sizing): pick the cheapest orderable server that fits each role`.

### Task 2: Provider candidates, prices and the census

**Files:**
- Modify: `src/lib/providers/base.js`, and the five provider modules.
- Create: `tests/unit/providers/role-candidates-census.test.ts`.
- Modify: `tests/unit/providers/hetzner-availability.test.ts`, `digitalocean.test.ts`, `scaleway.test.ts`, `provider-contract.test.ts`.

**Interfaces:**
- Consumes: Task 1.
- Produces, per provider:
  - `static ROLE_CANDIDATES: { compose: string[], master: string[], db: string[], worker: string[] }` (x86 only);
  - `static priceFor(type: string, location: string) -> number|null`, monthly, in the account's billing currency, read from the cached live catalog;
  - `getRegionDefaults(region)` returns `{ composeType, masterType, dbType, workerType }`, each from `pickRoleType` with `ROLE_MIN_RAM_GB`. `composeType` is new, and `dbType` keeps its meaning for k8s.
- Starting candidate lists, from cost-grid-sources "Revision 2" (the picker decides among them):
  - Hetzner: compose, master and worker `['cx23','cpx22','cpx11','cpx21']`; db `['cx23','cpx12','cpx22','cpx11']`.
  - DigitalOcean: compose, master and worker `['s-2vcpu-4gb']`; db `['s-1vcpu-2gb','s-2vcpu-4gb']`.
  - Vultr: all roles `['vc2-2c-4gb']`, db adds `'vc2-1c-2gb'`.
  - Linode: compose, master and worker `['g6-standard-2']`; db adds `'g6-standard-1'`.
  - Scaleway: compose `['DEV1-M','PLAY2-NANO','BASIC3-X2C-4G']`.
  - Each implementer confirms every name exists in that provider's live catalog fixture in `tests/unit/providers/`. If one doesn't, drop it and say so in the report.
- Scaleway `DEV1-M`: before adding it, confirm in `src/lib/iac/programs/scaleway-compose.js` that the program's 40 GB SBS root volume is accepted for `DEV1-M` (the catalog's `block_bandwidth` set). If it is not, leave it out and report.

- [ ] **Step 1: Write the census** (a walk, not a hand list):
  - (a) For every provider registered in the provider registry and every mode in its `SUPPORTED_TIERS`, each role the mode uses (compose and compose-ha use `compose`; k8s and k8s-ha use master, db and worker) has a non-empty `ROLE_CANDIDATES[role]`, declared as an own static on the class.
  - (b) No candidate satisfies `Provider.isArmServerType`.
  - (c) Every candidate exists in that provider's offline fallback catalog (`FALLBACK_SERVER_TYPES` or equivalent), so the offline path can resolve it.
  - (d) With each provider's committed live-catalog fixture, `getRegionDefaults(DEFAULT_REGION)` returns types whose RAM is at least `ROLE_MIN_RAM_GB` for each role.
  - (e) No file under `src/` other than `sizing.js` and the provider modules references `regionDefaults.dbType` for a compose size (`git grep -n "dbType" src/lib/deploy/prompts.js` must not appear in the compose branch). Assert by reading the compose branch's source between the `isComposeDeploy` markers.
  - Prove each arm bites: temporarily delete Hetzner's `db` list and add `'cax11'` to DO's compose list, see (a) and (b) fail, then restore. Record that in the report.
- [ ] **Step 2: Write the provider tests.**
  - Hetzner with the 2026-10-20 fixture: `getRegionDefaults('nbg1')` gives `{ composeType:'cpx22', masterType:'cpx22', dbType:'cpx12', workerType:'cpx22' }`, and `getRegionDefaults('hel1')` gives `cx23` for all four.
  - DO: `{ composeType:'s-2vcpu-4gb', masterType:'s-2vcpu-4gb', dbType:'s-1vcpu-2gb', workerType:'s-2vcpu-4gb' }`.
  - Scaleway `fr-par-1`: `composeType:'DEV1-M'` (if kept).
  - `priceFor('cpx22','sin')` is `30.99` and `priceFor('cpx22','nbg1')` is `22.99` against the fixture.
- [ ] **Step 3: Run** `pnpm vitest run tests/unit/providers`. Expected: FAIL.
- [ ] **Step 4: Implement.** Keep `fetchServerTypes` doing the only network work, and add the per-zone Scaleway availability fetch with `Promise.all` if it is not already there (P6). Delete the `smallShared`/`mediumShared` lists and the hand `offline` triple in `HetznerProvider.getRegionDefaults`. The offline path becomes `pickRoleType` with `catalog: null`.
- [ ] **Step 5: Run** `pnpm vitest run tests/unit/providers tests/unit/deploy`. Expected: PASS. Update any test that pinned the old `cpx32` compose default, with the justification in the commit.
- [ ] **Step 6: Commit** `feat(providers): role candidates and live prices drive default sizes`.

### Task 3: Deploy prompts use the role defaults and persist what they picked

**Files:**
- Modify: `src/lib/deploy/prompts.js:620-740`, `src/lib/deploy/orchestrator.js` (`saveSkeletonEnv`, about `:517-560`).
- Test: `tests/unit/deploy/compose-default-size.test.ts` (new), `tests/unit/deploy/skeleton-env-persists-types.test.ts` (new), `tests/unit/deploy/prompt-credential-order.test.ts`.

**Interfaces:**
- Consumes: `getRegionDefaults().composeType` (Task 2).

- [ ] **Step 1: Write the failing tests.**
  - The compose branch with no args and no `envConfig` sizes resolves `serverType === regionDefaults.composeType` (`cpx22` for Hetzner nbg1 with the fixture), not `dbType`.
  - Review Focus 1, persisted: `envConfig.serverType = 'cpx32'` resolves `'cpx32'`, and `envConfig.masterServerType = 's-2vcpu-2gb'` on DO resolves `'s-2vcpu-2gb'`.
  - Review Focus 1, skeleton: `saveSkeletonEnv` writes `serverType`, `masterServerType`, `dbServerType`, `workerServerType` (each when defined) and `secondaryRegion` before the IaC step. Drive it with the existing orchestrator test harness, and assert that the persisted env contains the resolved types after a fake IaC failure.
  - P7: a fixture with no orderable `compose` candidate in the chosen region makes the prompt phase exit 1 before any provider write. The `p.log.error` line matches `/no compose server with 4 GB\+ RAM is orderable in nbg1 right now; orderable nearby: hel1 \(cx23 \$6\.49\/mo\)/`.
  - `prompt-credential-order.test.ts` still passes unchanged in this task. Task 5 owns the reorder (P11).
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/compose-default-size.test.ts tests/unit/deploy/skeleton-env-persists-types.test.ts tests/unit/deploy/prompt-credential-order.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In the P7 message, "nearby" means same-continent locations from `rankLocationsByPrice`, at most 3.
- [ ] **Step 4: Run** `pnpm vitest run tests/unit/deploy`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(deploy): compose gets the cheapest 4 GB server, and a deploy remembers the sizes it picked`.

### Task 4: Standby location and standby size from the picker

**Files:**
- Modify: each provider's `getDefaultStandbyRegion`, `src/lib/deploy/prompts.js` (move the standby block from `:652` to after `fetchServerTypes`), `src/lib/deploy/effects/compose-ha.js:111-133`, and the standby type resolution in `src/lib/deploy/effects/k8s-ha.js`.
- Test: `tests/unit/deploy/compose-ha-standby-region.test.ts`, `compose-ha-standby-server-type.test.ts`, `tests/unit/providers/standby-region-by-price.test.ts` (new).

**Interfaces:**
- Consumes: `rankLocationsByPrice`, `cheapestRoleSet` (Task 1).
- Produces: `getDefaultStandbyRegion(primaryRegion, roles = ['compose'])`. It returns the cheapest same-continent partner (not the primary) where every role is orderable. It falls back to today's static choice when the catalog is not loaded or no partner qualifies; the P7 refusal then fires at type resolution.

- [ ] **Step 1: Write the failing tests.**
  - Hetzner fixture, primary `hel1`, roles `['compose']`: `fsn1` and `nbg1` both price `cpx22` at 22.99, so the tie keeps the conventional choice. Assert `getDefaultStandbyRegion('nbg1') === 'fsn1'` and `getDefaultStandbyRegion('hel1')` is in `{fsn1, nbg1}` and deterministic.
  - DigitalOcean fixture where `sfo3` cannot order `s-2vcpu-4gb`: `getDefaultStandbyRegion('nyc3')` is `'tor1'`, the cheapest stocked partner, not `'sfo3'`.
  - The `prompts.js` standby block runs after the catalog fetch: a source-order assertion, so `getDefaultStandbyRegion` is called after `fetchServerTypes`, plus a behavioral test that the DO default is `tor1` in a headless `-y` run.
  - This puts the standby prompt between the API token and the S3 keys, the first half of P11 (Task 5). Update `prompt-credential-order.test.ts` here to token, standby, S3 keys. Task 5 then inserts the region select before the standby.
  - Review Focus 3: a persisted `envConfig.secondaryRegion = 'sfo3'` whose standby type is unorderable there exits 1 with the P7 line naming `tor1`, and `secondaryRegion` stays `'sfo3'` in config.
  - Review Focus 4: compose-ha with primary `hel1` (`cx23`) and standby `fsn1` gives `ctx.standbyServerType === 'cpx22'`, and the info line `Standby server type adjusted for fsn1: cx23 -> cpx22` is logged. In k8s-ha, each standby role is re-picked for its location.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/compose-ha-standby-region.test.ts tests/unit/deploy/compose-ha-standby-server-type.test.ts tests/unit/providers/standby-region-by-price.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `pickRoleType` instead of the default branch of `resolveServerTypeForRegion` when no standby type is persisted. Keep its ARM-rescue behaviour for persisted types.
- [ ] **Step 4: Run** `pnpm vitest run tests/unit/deploy tests/unit/providers`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ha): standbys default to the cheapest stocked partner location`.

### Task 5: New-project region default and priced region options

**Files:**
- Modify: `src/lib/deploy/prompts.js` (the region select, about `:620-650`).
- Test: `tests/unit/deploy/region-default-by-price.test.ts` (new).

**Interfaces:**
- Consumes: `rankLocationsByPrice` (Task 1).
- The region select currently runs before `promptApiToken`, and a live price needs the token. The S3 keys need the region, because the object-storage endpoint follows the location, so the region cannot move after the keys.
- **Ruling P11:** the new order is API token, `fetchServerTypes`, region select (priced), standby (Task 4), then the S3 keys, then sizes.
  - This deliberately ends the "token and S3 keys back to back" contract: the region and standby prompts are one Enter each in the common case, while a priced region choice is the point of this task.
  - Update `prompt-credential-order.test.ts` to pin the new order, with the justification in the commit.
  - The previous region prompt never needed the token, so a run with a persisted region and saved credentials has no new prompt at all.
  - Cost if wrong: a reviewer prefers the old order. Reverting is a block move, and the prices then show only after a second run.

- [ ] **Step 1: Write the failing tests.**
  - A new project (no persisted region, no `-region`), Hetzner fixture, compose: the preselected and `-y` region is `hel1`, and its option label is `hel1 - Helsinki · from $7.09/mo`. That price is `cx23` 6.49 plus 0.60 primary IPv4, from the provider's `static IPV4_MONTHLY` (Hetzner 0.60, Scaleway 3.65, others 0), declared with a source comment.
  - A persisted `region: 'nbg1'` stays `nbg1`.
  - `-region fsn1` stays `fsn1`.
  - A DO new project keeps `nyc3`: a tie at $24 goes to `DEFAULT_REGION`.
  - No location from another continent is ever preselected: a fixture where `ash` is cheapest still preselects an EU location for Hetzner.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/region-default-by-price.test.ts tests/unit/deploy/prompt-credential-order.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run tests/unit/deploy`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): new projects default to the cheapest region on the default continent, with prices shown`.

### Task 6: scale, profiles and the e2e harness use the same picker

**Files:**
- Modify: `src/scale.js:180-185`, `src/lib/server-types.js` (`K8S_PROFILES.starter` resolves through `getRegionDefaults`; `production` and `enterprise` stay hand-named larger tiers).
- Modify: `tests/config.ts:18,211-213,295`: default scenarios stop pinning `serverType` and `instanceType`. Keep any pin a scenario needs to exercise an explicit `-server-type` path, with a comment naming why.
- Modify: `tests/e2e/utils/ssh.ts` `getServerIps`: include the k8s-ha primary worker IP from `.vibecarbon.json`.
- Test: `tests/unit/e2e/default-scenarios-unpinned-census.test.ts` (new), `tests/unit/e2e/server-ips.test.ts` (or the existing test for `getServerIps`), `tests/unit/scale/*` touched by the default change.

- [ ] **Step 1: Write the failing tests.**
  - Census: for every default scenario in `tests/config.ts` (the bare Hetzner four and each provider's defaults), no `serverType`, `masterServerType`, `dbServerType`, `workerServerType` or `instanceType` key is set unless it sits in an allow-list in the test with a reason string. The allow-list starts empty.
  - `getServerIps` for a k8s-ha config with `ha.primary.workerIps: ['10.0.0.9']` includes `'10.0.0.9'`.
  - The `starter` profile on the Hetzner hel1 fixture resolves to `cx23` for all three roles.
  - `scale` with no persisted type uses `getRegionDefaults(region).composeType`.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/e2e tests/unit/scale`. Expected: FAIL.
- [ ] **Step 3: Implement.** The e2e region resolver (`tests/e2e/utils/region-resolver.ts`) already picks a location with capacity. It must now pick only among locations where `cheapestRoleSet` resolves for the scenario's roles, so the harness exercises the customer default instead of a pinned SKU.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `test(e2e): the matrix deploys the sizes customers get by default`.

### Task 7: README cost grid, generated

**Files:**
- Create: `scripts/cost-grid.js`, `tests/unit/scripts/cost-grid.test.ts`.
- Modify: `README.md` (new "What it costs to run" section between the markers, placed after the deploy-modes overview; locate by heading), `docs/release.md` or the release checklist the repo uses (one line: refresh the cost grid before a release that changes defaults).

**Interfaces:**
- `renderCostGrid({ providers: Array<{ id, currency, rows: Record<mode, { monthly: number, locations: string[] } | 'unsupported'> }>, date: string, peaks }) -> string`. This is pure and tested with fixtures.
- `computeEnvMonthly(Provider, mode) -> { monthly, locations }`. It uses `rankLocationsByPrice` over the provider's `REGIONS`, the standby via `getDefaultStandbyRegion`, and per-env extras: `IPV4_MONTHLY` per server, Hetzner floating IP 3.50 for k8s, the db volume at the provider's per-GB price × 11 GB for k8s, and Scaleway's 40 GB SBS root.
  - Extras are declared once, in a table in `scripts/cost-grid.js`, with source URLs. Billing extras do not go into provider classes.
- CLI: `node scripts/cost-grid.js` prints the markdown; `--write` replaces the README section. It reads tokens from the environment or the existing env loader, and skips a provider with a one-line note when its token is missing. Public APIs (Vultr plans, Linode types) need none.

- [ ] **Step 1: Write the failing tests.**
  - `renderCostGrid` with the 2026-10-20 fixture values from cost-grid.md produces the table row `| Hetzner (USD account) | $7.09 (hel1) | $30.68 (hel1 + fsn1) | $25.61 (hel1) | $67.63 (hel1 + fsn1) |`.
  - The output contains no em dash (`/—/`), no `free` within 3 words of `server|infrastructure|deploy`, and the date line.
  - `--write` replaces only the text between the markers (fixture README with content on both sides).
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/scripts/cost-grid.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Then run `node scripts/cost-grid.js --write` with the tokens the operator has. Commit the README with whatever providers resolved, and name any skipped provider in the commit body.
  - The prose around the table comes from cost-grid.md: the "You pay your cloud provider directly" intro, the "What each mode runs" table and the footnote line.
  - The defaults-today collapsible from cost-grid.md is dropped, since after this plan the defaults are the best practical prices.
  - The footnote names the ARM saving as "later".
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`. Expected: PASS.
- [ ] **Step 5: Commit** `docs(readme): monthly cost per environment for every provider and mode`.

---

## Later: ARM (not in this plan)

The win: Hetzner `cax11` costs $6.99 and is stocked in every EU location, which would take compose-ha to about $14.68 and k8s-ha to about $45.13, against $30.68 and $67.63 on x86 today.

What arm64 end to end needs:
1. **Lift the guard.** `assertAmd64ServerType` (`src/lib/deploy/prompts.js:719-735`, `scale.js:1069`, `failover.js:1000,1800`, `scale-plan.js:59`) and the catalog ARM filter (`hetzner.js:497`) become an arch property on the role pick. Mixed-arch HA pairs stay forbidden, because a streaming replica needs the same arch.
2. **Ship arm64 app images.** compose builds locally and sideloads the result. The cold-deploy speed plan replaces this with a published runtime base image plus app layers sent from the operator, so the runtime base must be published multi-arch, and the app layers built for the server's arch.
   - Building arm64 on an x86 laptop means QEMU, which the speed plan avoids. The practical routes are a native arm64 build on the server (`direct` mode, rejected as the default in 2026-05 for flakiness) or the GHA `push` mode with a multi-arch build.
   - compose-ha already builds on the servers, so on ARM it builds natively and needs only (1) and (3).
3. **Pin multi-arch images.** The db image `ghcr.io/hyperformant/postgres` is already multi-arch (release.yml requires it). Traefik, docker-socket-proxy and the observability images publish arm64, but each needs its digest pin checked to be a multi-arch index rather than an amd64 manifest. A census can walk the compose files for that.
4. **k3s on arm64.** k3s itself supports arm64, but the in-cluster registry, cert-manager and every k8s manifest image need the same index check.
5. **e2e:** one ARM scenario per mode that changes, starting with `hetzner/compose-ha`, where the saving is largest.

Order when picked up: compose-ha first, since it needs only items 1 and 3. Then compose, after the speed plan's image delivery lands. k8s and k8s-ha come last.

## Verification

- Per task: the commands listed, green, with red-then-green evidence in the implementer report.
- End of branch:
  - `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`;
  - CI `test.yml` green.
- Real infra, which needs Brandon's OK for the spend:
  - `pnpm test:e2e:batch -- --provider hetzner`, now on unpinned defaults. Expect compose on `cx23` in hel1 when stocked, and compose-ha with a `cpx22` standby. Every mode's peak RAM must stay under half its node RAM, the P1 rule, as recorded in `tests/results/e2e.db`.
  - Optionally `--provider digitalocean` to prove the `tor1` standby default.
