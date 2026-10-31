# Price-Optimized Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Refresh 2026-10-22.** Re-checked against `feat/price-optimized-defaults` at `dbc4688`, stacked on #241 (cold-deploy speed) → #239 → #238 → #237 → #236 → #235 → #234, all open; #240 (node runtime base and mirrors) is a separate PR off main. Every file:line below was re-read on that tree, and every price was re-read from the provider APIs on 2026-10-22 (table "Prices verified 2026-10-22"). Rulings R1-R12 from the pre-flight scan live in the SDD ledger (`.superpowers/sdd/2026-10-20-price-optimized-defaults/progress.md`); the ones that change a task are written into it here. What changed:
> - **Hetzner `cx23` is orderable nowhere today** (`available: false` in fsn1, nbg1 and hel1; it was orderable in hel1 on 2026-10-20). The cheapest x86 server that fits compose is `cpx22` at $22.99 in every EU location, so the Hetzner row of the grid moves from $7.09 / $30.68 / $25.61 / $67.63 to **$23.59 / $47.18 / $65.61 / $107.64**. The picker design is unchanged and is now the reason it matters: when `cx23` restocks, new environments get it without a code change. The hel1-only `cx23` case becomes a synthetic "flux" fixture in the tests, not the live one.
> - **No provider caches prices today.** P2 claimed "each provider's catalog already carries a monthly price". The API payloads do, but every `fetchServerTypes` drops them (`hetzner.js:453-543`, `digitalocean.js:444-521`, `vultr.js:304-350`, `linode.js:433-488`, `scaleway.js:523-570`). Task 2 adds the capture (R3).
> - **No committed live-catalog fixtures exist** in `tests/unit/providers/`. Task 1 creates them from the 2026-10-22 capture (R4).
> - **The picker's `arch` filter would drop every DigitalOcean, Vultr and Linode type**: only Hetzner stores `architecture` in `SERVER_TYPES`. The picker reuses `filterAmd64Types` and `Provider.isArmServerType` instead (R1).
> - **`pickRoleType`'s `priceFor` took no location**, while Review Focus 5 asserts the location argument. It now takes `(type, location)` (R2).
> - **The offline fallback was region-blind.** "First declared candidate" would hand `cx23` to ash/hil, where it does not exist, and break `hetzner-availability.test.ts`'s retired-SKU guards. Declared order is now "most reliably stocked first", and the offline pick filters by the provider's existing offline region rules (R5).
> - **DigitalOcean's HA defaults cannot place today.** `getDefaultStandbyRegion('nyc3')` is `sfo3`, where neither `s-2vcpu-4gb` nor `s-2vcpu-2gb` is sold, and `resolveServerTypeForRegion` (`digitalocean.js:617-628`) returns the unsellable default anyway. Task 4 fixes this. DO's `-amd`/`-intel` 4 GB and 2 GB variants ($28 / $14) are added as stock-out candidates (R6).
> - **`K8S_PROFILES.starter` is obsolete here**: `buildK8sProfileOptions` and `detectCurrentProfile` have no production caller (they are re-exported from `src/deploy.js:475-500` for tests only). Task 6 drops that item.
> - **Scaleway's catalog walk is serial per zone** (`scaleway.js:530`) and never reads `/products/servers/availability`; today `BASIC3-X2C-4G`, the current default, is `scarce` in fr-par-1. Task 2 parallelizes the walk and adds availability (P6).
> - **The e2e harness pins types through `capacityPreferences.typePairs`** (`tests/config.ts:183-301`) and seeds `serverType` into `.vibecarbon.json` (`tests/e2e/utils/cli-runner.ts:429`), not through per-scenario keys. Task 6 is reshaped around that (R9), and the cold-deploy budgets of #241 (`tests/e2e/checks/deploy-budget.ts:39-44`) then judge the new sizes (R10, a decision for Brandon).
> - **There is no release checklist file** (`docs/release.md` does not exist). The refresh line goes into AGENTS.md's release-gate bullets (R11). The README markers follow the perf table's convention, `<!-- BEGIN:cost-grid -->` / `<!-- END:cost-grid -->` (R12).
> - **Line moves:** `prompts.js` region select `:749-761`, standby `:764-786`, API token `:788`, `fetchServerTypes` `:800`, compose sizes `:806-812`, k8s sizes `:813-826`, amd64 guard `:836-847`; `saveSkeletonEnv` `orchestrator.js:1133-1172` (called at `:1198`, `:1489`, `:1549`); compose-ha standby `compose-ha.js:145-193`; k8s-ha standby `k8s-ha.js:124`, `:142-158`, `:445-456`; scale default `scale.js:326`.
> - **Policy facts honoured:** amd64-only (no ARM candidate anywhere, census-enforced); config writes go through `updateProjectConfig` (`src/lib/config.js:366`, already used by `saveSkeletonEnv`); scale tests stub the backup-credential preflight; Scaleway compose scale is refused, so no scale test uses Scaleway.

**Goal:** A deploy with no size flags gets the cheapest server that is orderable right now and fits the measured load, for every provider, mode and role. HA standbys go to the cheapest stocked partner location, and the README shows the resulting monthly cost per environment.

**Architecture:**
- **Each provider declares candidates per role**: `static ROLE_CANDIDATES`, the x86 types it is willing to use for a `compose`, `master`, `db` or `worker` role. Declared order is the offline order, most reliably stocked first.
- **Each provider caches live prices** in `fetchServerTypes` (no new request: the price is in the payload it already reads) and exposes `static priceFor(type, location)`.
- **One shared picker, `pickRoleType`** in a new `src/lib/sizing.js`, filters those candidates against:
  - the live catalog the deploy already fetches (`Provider.fetchServerTypes`);
  - the per-role RAM floor;
  - amd64 (`filterAmd64Types` and `Provider.isArmServerType`);
  - availability in the target location.

  It then sorts the survivors by live monthly price for that location and returns the cheapest. With no live catalog, it uses the offline catalog and the provider's offline region rules, in declared order.
- **Every default-size site reads the picker:** `getRegionDefaults`, the compose path in `prompts.js`, the compose-ha and k8s-ha standby re-resolution, `scale` and the e2e harness.
- **Standby location defaults and new-project region defaults** come from the same picker. Persisted choices are never moved.

**Tech Stack:** Node ESM CLI (`src/`), vitest (`tests/unit`), provider REST APIs already called by `fetchServerTypes`.

**Spec:**
- Brandon's 2026-10-20 instructions in chat:
  - "estimate the monthly cost per environment for all our providers and modes so that we can add a grid like this to our readme";
  - "We should show best practical prices even if they are only available in one region";
  - "let's get this new stack fully speed and price optimized".
- The cost analysis at `/tmp/claude-1000/-home-brandon-repos-vibecarbon/0b7ee7cd-7067-44f6-a72a-5ce5d7505b2c/scratchpad/cost-grid.md` and `cost-grid-sources.md` (2026-10-20), and the raw API capture of 2026-10-22 at `/tmp/claude-1000/-home-brandon-repos-vibecarbon/0b7ee7cd-7067-44f6-a72a-5ce5d7505b2c/scratchpad/prices-2026-10-22/`. Task 1 copies the two analysis files, updated to the 2026-10-22 table below, into `docs/superpowers/plans/2026-10-20-cost-grid-sources.md`, so the plan's evidence travels with the repo.

## Prices verified 2026-10-22

Every number was read on 2026-10-22 from the provider's API (read-only GETs with the e2e tokens, never printed) unless the Source column says otherwise. Net of VAT. Hetzner bills this account in USD.

| Provider | Item | Price | Where orderable today | Source |
|---|---|---|---|---|
| Hetzner | `cx23` (2 vCPU, 4 GB, x86) | $6.49 | **nowhere** (`available: false` in fsn1/nbg1/hel1) | `/v1/server_types`, `/v1/pricing` |
| Hetzner | `cpx12` (1 vCPU, 2 GB) | $13.49 EU, $17.99 sin | fsn1, nbg1, hel1, sin | same |
| Hetzner | `cpx22` (2 vCPU, 4 GB) | $22.99 EU, $30.99 sin | fsn1, nbg1, hel1, sin | same |
| Hetzner | `cpx32` (4 vCPU, 8 GB) | $41.99 | fsn1, nbg1, hel1, sin | same |
| Hetzner | `cpx11` (2 vCPU, 2 GB) | $20.49 ash/hil ($5.99 EU, priced but deprecated there) | ash, hil | same |
| Hetzner | `cpx21` (3 vCPU, 4 GB) | $37.49 ash/hil | ash, hil | same |
| Hetzner | `ccx13` (2 dedicated vCPU, 8 GB) | $50.49 EU, $50.99 US | all six | same |
| Hetzner | `cax11` (ARM, excluded) | $6.99 | fsn1, nbg1, hel1 | same |
| Hetzner | primary IPv4 / floating IPv4 / volume | $0.60 / $3.50 / $0.0767 per GB-month | all | `/v1/pricing` |
| Hetzner | Object Storage base | €6.49 or $7.99 per month | n/a | hetzner.com/storage/object-storage (page slider data, fetched 2026-10-22) |
| DigitalOcean | `s-1vcpu-2gb` / `s-2vcpu-2gb` / `s-2vcpu-4gb` | $12 / $18 / $24 | ams3, blr1, fra1, lon1, nyc1, nyc3, sfo2, sgp1, syd1, tor1 (**not sfo3, atl1**) | `/v2/sizes` |
| DigitalOcean | `s-1vcpu-2gb-amd`/`-intel`, `s-2vcpu-4gb-amd`/`-intel` | $14, $28 | `-amd`: ams3, blr1, lon1, nyc3, sfo3, sgp1, syd1; `-intel`: ams3, blr1, fra1, sfo3, sgp1, tor1 | `/v2/sizes` |
| DigitalOcean | volumes / Spaces / reserved IP | $0.10 per GiB-month / $5 per month / no charge while assigned | n/a | DO docs and pricing pages, fetched 2026-10-22 |
| Vultr | `vc2-1c-2gb` / `vc2-2c-4gb` / `vhf-2c-4gb` | $10 / $20 / $24 | all 8 code regions | `/v2/plans` (public) |
| Vultr | Object Storage Standard | $18 per month (Legacy $6 tier has no locations) | ewr, sgp, sjc, ams, blr, del, atl | `/v2/object-storage/tiers` |
| Linode | `g6-standard-1` / `g6-standard-2` | $12 / $24 (id-cgk $14.40 / $28.80, br-gru $16.80 / $33.60) | global catalog | `/v4/linode/types` (public) |
| Linode | Object Storage / volume | $5 per month / $0.10 per GB-month | n/a | `/v4/object-storage/types`, `/v4/volumes/types` |
| Scaleway | `DEV1-M` (3 vCPU, 4 GB, x86) | €14.74 | `available` in fr-par-1, fr-par-2, nl-ams-1, nl-ams-2 | `/instance/v1/zones/*/products/servers` + `/availability` |
| Scaleway | `PLAY2-NANO` (2 vCPU, 4 GB) | €20.10 | `scarce` fr-par-1, `available` elsewhere | same |
| Scaleway | `BASIC3-X2C-4G` (2 vCPU, 4 GB, today's default) | €28.80 | `scarce` fr-par-1 and fr-par-2, `available` in nl-ams-* | same |
| Scaleway | Zonal flexible IPv4 | €0.005 per hour (€3.65 per month) | n/a | public product catalog |
| Scaleway | 40 GB SBS root | €3.45 per month at €0.000118 per GB-hour | n/a | public product catalog. **Unverified:** which SBS SKU an `sbs_volume` root bills as (Low Latency 5K is €0.00013, which would make it €3.80) |
| Scaleway | Object Storage | usage-based | n/a | **unverified 2026-10-22**, carried from 2026-10-20 |

Peak RAM (tests/results/e2e.db, `metric_type = 'resource'`, lean stack only: recorded after 2026-10-17, all on 2026-10-20, Hetzner, observability on), re-queried 2026-10-22: compose 1,101 MB; compose-ha 1,245 / 1,239 MB; k8s master 1,488, db 636, worker 1,050; k8s-ha primary master 1,559, db 659, standby master 1,363, db 653. There is no lean-stack data for any other provider (the DigitalOcean rows are from August, the Supabase era).

## Rulings (made while planning)

- **P1, RAM floors come from measured peak × 2, rounded up to the provider's next RAM tier, and compose never goes below `COMPOSE_MIN_RAM_GB = 4`.**
  - Measured peaks: the table above.
  - Floors: `compose: 4`, `master: 4` (2 × 1.56 = 3.12), `db: 2` (2 × 0.66 = 1.32), `worker: 4` (2 × 1.05 = 2.1).
  - These are a constant table in `src/lib/sizing.js`, `ROLE_MIN_RAM_GB`, with a comment citing the measurement. They are not hand-tuned per provider.
  - Cost if wrong: a busier app outgrows the floor; `vibecarbon scale -type` is the escape hatch, as today.
- **P2, the picker sorts by live price and does not trust declared order.**
  - Every provider's API payload carries a monthly price: Hetzner per location (`prices[].price_monthly.net`), DigitalOcean `price_monthly`, Vultr `monthly_cost`, Linode `price.monthly` plus `region_prices[]`, Scaleway `monthly_price` per zone. **Refresh:** none of the five caches it today; Task 2 adds that to the existing `fetchServerTypes` walk (R3).
  - `ROLE_CANDIDATES` names the eligible family members. The order is only the offline fallback, most reliably stocked first (R5).
  - This is why a stale hand list ("cpx32 first") can no longer pick an 8 GB server where a 4 GB one is in stock.
  - Cost if wrong: a type whose catalog entry lacks a price sorts after the priced ones, in declared order. A unit test pins that (Linode's dedicated plans carry `price.monthly: null` today).
- **P3, never move a persisted choice.** Precedence is unchanged: args, then `envConfig`, then the picker.
  - The picker affects only an environment's first deploy and a new standby.
  - `serverType`, `masterServerType`, `dbServerType`, `workerServerType` and `secondaryRegion` must be persisted in the skeleton env written before provisioning (`orchestrator.js:1133-1172` `saveSkeletonEnv`, through `updateProjectConfig`). `region` and `secondaryRegion` already are; the four types are not. Then a deploy that fails and is re-run after a catalog change cannot pick a different size and make Pulumi replace a live server.
  - Cost if wrong: none for existing envs. A user who wants the cheaper size runs `vibecarbon scale -type`.
- **P4, the region default for a NEW project follows price within the provider's default continent.**
  - When no region is persisted or passed, the region prompt's preselected value (and the `-y` headless choice) is the location on `DEFAULT_REGION`'s continent where the compose or cluster role set is cheapest to order now. Ties go to `DEFAULT_REGION`.
  - Every region option's label shows the from-price (`nbg1 - Nuremberg, Germany · from $23.59/mo`), so the user sees the trade and can pick a closer location.
  - The continent boundary keeps latency predictable: a European default never lands in the US.
  - On 2026-10-22 every provider ties inside its default continent, so this changes no default today. It moves new projects only when a cheaper type is stocked in one location (Hetzner `cx23` in hel1 on 2026-10-20).
  - Cost if wrong: a German user's default is Helsinki (about 20 ms more) unless they pick nbg1 at the prompt, where the price difference is visible.
- **P5, the standby default is the cheapest valid partner location.**
  - `getDefaultStandbyRegion(primary, roles)` keeps its contract (different location, same continent), but among the candidates it picks the one where the standby's role set is cheapest to order. Ties keep the conventional pair (`nbg1 -> fsn1`, `fr-par-1 -> nl-ams-1`, `ewr -> ord`, `us-iad -> us-ord`).
  - This fixes DigitalOcean's `sfo3` default, which cannot order any of today's default sizes, and the static `HA_REGIONS` partners on every provider.
  - Resolving the standby moves to after `fetchServerTypes` in `prompts.js`: today it runs at `:764-786`, before the catalog fetch at `:800`. That adds no network call, since the catalog fetch already happens.
  - Cost if wrong: a standby farther from the primary on the same continent, with a few ms more replication latency.
- **P6, no new serial latency.**
  - Availability and price come from the `fetchServerTypes` call the deploy already makes.
  - Scaleway needs a per-zone availability call. The per-zone walk (today a serial `for` over four zones, `scaleway.js:530`) becomes `Promise.all` over zones, each fetching `products/servers` and `products/servers/availability` together, and the result is cached on the class for the process, as `_locationTypes` already is. Net effect: Scaleway's catalog fetch gets faster, not slower.
  - `scripts/cost-grid.js` is the only new caller.
- **P7, fail closed when nothing fits.**
  - When no candidate is orderable in the target location for a role, the deploy stops before any provider write with one line: `no <role> server with <N> GB+ RAM is orderable in <loc> right now; orderable nearby: <loc> (<type> $<x>/mo), ...`. The price is the server plus its billed IPv4 (`IPV4_MONTHLY`), the same number the region labels show (R7).
  - A persisted `secondaryRegion` or region that can no longer order its persisted type gets the same one-line refusal naming alternatives. It is never moved silently (P3).
- **P8, the README cost grid is generated, committed and dated.**
  - `scripts/cost-grid.js` queries the provider APIs (tokens from the environment, never printed) and writes the section between `<!-- BEGIN:cost-grid -->` and `<!-- END:cost-grid -->` in `README.md` (R12: the perf table's marker convention).
  - The output is committed with its date. Running it in CI would need five providers' tokens and would flake on stock changes.
  - Refresh is `node scripts/cost-grid.js --write`.
  - Cost if wrong: the README goes stale between refreshes. The table carries its date, and the AGENTS.md release-gate line from Task 7 names the refresh (R11).
- **P9, ARM stays out of this plan** (see "Later: ARM"). The x86 guard `assertAmd64ServerType` is untouched.
- **P10, the k8s worker floor is 4 GB, the master's too.** P1 moves DO master and worker from `s-2vcpu-2gb` to `s-2vcpu-4gb`, and db from `s-2vcpu-4gb` to `s-1vcpu-2gb`. The cluster cost is the same, $61, with more headroom on the nodes that use it. **Refresh:** the original "DO's 2 GB master runs at about 75% RAM" has no lean-stack measurement behind it (DO's resource rows are from August); the move rests on P1 alone.
- **P11, the deploy wizard order becomes: API token, `fetchServerTypes`, region (priced), standby, S3 keys, then sizes.** See Task 5.

## Global Constraints

- x86-64 only. Every candidate list contains no ARM types, which the census asserts through `Provider.isArmServerType`. The picker filters through `filterAmd64Types` (`src/lib/server-types.js`) as every option builder does.
- `COMPOSE_MIN_RAM_GB = 4` (`src/lib/server-types.js:9`) stays the compose floor.
- Role floors: `ROLE_MIN_RAM_GB = { compose: 4, master: 4, db: 2, worker: 4 }`.
- Persisted values always win (P3). The picker never changes a deployed environment's type or region. Config writes go through `updateProjectConfig`.
- Region labels and refusal lines follow the CLI help voice: lowercase informational hints, no em dashes, exact numbers.
- README copy: no em dashes, the word "free" never next to servers, infrastructure or deploy (DigitalOcean's reserved IP is "no charge while assigned"), emoji-restrained, benefits before mechanism.
- Conventional commits, pathspec commits, never `--no-verify`, no `!:` footers. Root uses pnpm. Never print API tokens.
- **Run order relative to the other 2026-10-20 plans in this directory:**
  - after `2026-10-20-project-app-bucket.md` and `2026-10-20-env-app-bucket.md`, which edit `src/lib/deploy/prompts.js` (`resolveEnvStorage`, `:543`, a different region of the file). Both have landed in this stack;
  - after `2026-10-20-cold-deploy-speed.md` (#241, this branch's base), whose budgets were measured on 2 vCPU / 4 GB nodes. This plan keeps every role at 2 vCPU or more except the k8s db role (Hetzner `cpx12`, DigitalOcean `s-1vcpu-2gb`) and Scaleway compose (`DEV1-M`, 3 older vCPUs). Both can move cold-deploy times; see R10.
  - It shares no files with the add-ons, registry-copy or TLS plans.

## Review Focus

1. **A live environment deployed with today's defaults** (Hetzner compose on `cpx32`, or DO k8s master `s-2vcpu-2gb`): a redeploy after this change keeps the persisted types, and the Pulumi stack sees no server diff. A failed first deploy that is re-run also keeps the types written by the skeleton env. Test in Task 3.
2. **An offline catalog** (`fetchServerTypes` falls back): every provider's picker returns the first declared candidate that meets the floor and passes the provider's offline region rules, and it is amd64. Hetzner offline gives `cpx22` in the EU and `cpx21` in ash/hil for compose, never a retired SKU. Test in Task 2.
3. **A persisted `secondaryRegion` that can no longer order the standby type** fails closed with alternatives and is not moved. Test in Task 4.
4. **A standby priced in a different location** from the primary (flux fixture: `cx23` in hel1, `cpx22` in fsn1): compose-ha and k8s-ha get mixed types, and the existing `standbyServerType` logging shows it. Test in Task 4.
5. **Location-dependent prices** (Hetzner `sin`, `ash` and `hil` cost more): the picker uses the target location's price, not the first price in the list. Test in Task 1.

## File Map

- Create `src/lib/sizing.js`: `ROLE_MIN_RAM_GB`, `pickRoleType`, `cheapestRoleSet`, `rankLocationsByPrice`.
- Create `tests/unit/fixtures/catalogs/2026-10-22/{hetzner,digitalocean,vultr,linode,scaleway}.json` (trimmed live capture) and `tests/unit/fixtures/catalogs/flux-hetzner-cx23-hel1.json` (synthetic, the 2026-10-20 shape), plus a loader `tests/unit/helpers/catalog-fixtures.ts` that seeds a provider's `SERVER_TYPES`, `_locationTypes` and price cache.
- Modify `src/lib/providers/{hetzner,digitalocean,vultr,linode,scaleway}.js`:
  - `static ROLE_CANDIDATES` and `static IPV4_MONTHLY`;
  - price capture in `fetchServerTypes` (`_prices`) and `static priceFor(type, location)`;
  - `getRegionDefaults` delegates to the picker and gains `composeType`;
  - `getDefaultStandbyRegion` delegates to `rankLocationsByPrice`;
  - DigitalOcean's and Scaleway's `FALLBACK_SERVER_TYPES` gain the new candidates; Scaleway's `fetchServerTypes` runs zones in parallel and reads availability.
- Modify `src/lib/providers/base.js`: the abstract `ROLE_CANDIDATES`, `IPV4_MONTHLY` and `priceFor` contract (next to `fetchServerTypes` `:949`, `getRegionDefaults` `:976`).
- Modify `src/lib/deploy/prompts.js:749-847`:
  - compose uses `regionDefaults.composeType`, not `dbType` (`:810`);
  - the standby is resolved after the catalog fetch;
  - the region select moves after the token and carries from-prices;
  - P7 refusals.
- Modify `src/lib/deploy/orchestrator.js:1133-1172` `saveSkeletonEnv`: persist the four types (P3).
- Modify `src/lib/deploy/effects/compose-ha.js:152-193`, `src/lib/deploy/effects/k8s-ha.js:142-158` and `src/scale.js:326`: the picker replaces `resolveServerTypeForRegion` defaults where no type is persisted.
- Modify `tests/config.ts:183-301` (`capacityPreferences`), `tests/e2e/utils/region-resolver.ts`, `tests/e2e/utils/cli-runner.ts:429`, `tests/e2e/runner.ts:729-830`: the harness deploys the default sizes. `tests/e2e/utils/ssh.ts:295-340` `getServerIps` also returns the k8s-ha primary worker for resource metrics.
- Create `scripts/cost-grid.js`, the `README.md` section (after "## Performance", before "## License & Terms"), the AGENTS.md release-gate line, and `docs/superpowers/plans/2026-10-20-cost-grid-sources.md`.
- Tests are named per task. New census: `tests/unit/providers/role-candidates-census.test.ts`.

---

### Task 1: The picker, the role floors and the catalog fixtures

**Verdict (refresh): still needed, reshaped.** `src/lib/sizing.js` does not exist. Interface changes: `priceFor` takes the location (R2); the amd64 filter reuses `filterAmd64Types` plus `Provider.isArmServerType`, since only Hetzner stores `architecture` (R1); the offline path uses the offline catalog and an offline orderable set rather than "first candidate" (R5). Fixtures are created here (R4).

**Files:**
- Create: `src/lib/sizing.js`, `tests/unit/lib/sizing.test.ts`.
- Create: `tests/unit/fixtures/catalogs/2026-10-22/*.json`, `tests/unit/fixtures/catalogs/flux-hetzner-cx23-hel1.json`, `tests/unit/helpers/catalog-fixtures.ts`.
- Copy: the two cost-grid scratch files, updated to the "Prices verified 2026-10-22" table, into `docs/superpowers/plans/2026-10-20-cost-grid-sources.md`, one file with both sections.

**Interfaces:**
- Produces:
  - `ROLE_MIN_RAM_GB: Readonly<{ compose: 4, master: 4, db: 2, worker: 4 }>`;
  - `pickRoleType({ candidates: string[], catalog: Record<string,{ram:number, architecture?:string}>, orderable: Set<string>, location: string, priceFor: (type: string, location: string) => number|null, isArm: (type: string) => boolean, minRamGb: number }) -> string|null`:
    - It keeps candidates that are in `orderable`, have `catalog[t].ram >= minRamGb`, survive `filterAmd64Types` and are not `isArm(t)`.
    - It sorts the survivors ascending by `priceFor(t, location)`; unknown prices go after known ones, in declared order. Equal prices keep declared order.
    - It returns `null` when nothing survives.
    - The offline case is the caller's: it passes the offline catalog, an offline `orderable` set and a `priceFor` that returns `null`, so declared order decides.
  - `cheapestRoleSet(Provider, location, roles: string[]) -> { types: Record<role,string>, monthly: number|null } | null`. `monthly` is the sum of `priceFor` for each role's pick plus `Provider.IPV4_MONTHLY` per server; it is `null` when any price is unknown. It returns `null` when any role is unorderable.
  - `rankLocationsByPrice(Provider, locations: string[], roles: string[]) -> Array<{ location, monthly, types }>`, ascending by `monthly`, ties in the order of `locations`, omitting locations where any role is unorderable.
- Fixture loader: `seedCatalog(Provider, fixtureName)` sets `SERVER_TYPES`, `_locationTypes` and `_prices`, and returns a restore function for `afterEach`.

- [ ] **Step 1: Build the fixtures.** Trim each file in `/tmp/claude-1000/-home-brandon-repos-vibecarbon/0b7ee7cd-7067-44f6-a72a-5ce5d7505b2c/scratchpad/prices-2026-10-22/` to the fields `fetchServerTypes` reads (name, cores/vcpus, memory, architecture, locations with `available`/`deprecation`, prices; Scaleway servers plus availability per zone). If the capture is gone, re-capture with the operator's tokens and update every number this plan quotes, in the plan too. The flux fixture is the 2026-10-22 Hetzner one with `cx23` set `available: true` in hel1 only.
- [ ] **Step 2: Write the failing tests.**

```ts
// tests/unit/lib/sizing.test.ts
import { describe, expect, it } from 'vitest';
import { pickRoleType, rankLocationsByPrice, ROLE_MIN_RAM_GB } from '../../../src/lib/sizing.js';

const catalog = {
  cx23: { ram: 4, architecture: 'x86' }, cpx22: { ram: 4, architecture: 'x86' },
  cpx32: { ram: 8, architecture: 'x86' }, cpx12: { ram: 2, architecture: 'x86' },
  cax11: { ram: 4, architecture: 'arm' },
};
const flat = { cx23: 6.49, cpx22: 22.99, cpx32: 41.99, cpx12: 13.49, cax11: 6.99 };
const base = { catalog, location: 'nbg1', priceFor: (t) => flat[t] ?? null, isArm: (t) => t.startsWith('cax') };

describe('pickRoleType', () => {
  it('sorts by price, not declared order', () => {
    expect(pickRoleType({ ...base, candidates: ['cpx32', 'cpx22', 'cx23'], orderable: new Set(['cpx22', 'cpx32']), minRamGb: 4 })).toBe('cpx22');
    expect(pickRoleType({ ...base, candidates: ['cpx32', 'cpx22', 'cx23'], orderable: new Set(['cx23', 'cpx22']), minRamGb: 4 })).toBe('cx23');
  });
  it('takes more RAM than the floor when it is cheaper', () => {
    expect(pickRoleType({ ...base, candidates: ['cpx12', 'cx23'], orderable: new Set(['cpx12', 'cx23']), minRamGb: ROLE_MIN_RAM_GB.db })).toBe('cx23');
  });
  it('never returns ARM, even when it is cheapest', () => {
    expect(pickRoleType({ ...base, candidates: ['cax11', 'cpx22'], orderable: new Set(['cax11', 'cpx22']), minRamGb: 4 })).toBe('cpx22');
  });
  it('offline (no prices) keeps declared order', () => {
    expect(pickRoleType({ ...base, priceFor: () => null, candidates: ['cpx22', 'cx23'], orderable: new Set(['cpx22', 'cx23']), minRamGb: 4 })).toBe('cpx22');
  });
  it('unknown prices sort after known ones', () => {
    const priceFor = (t) => (t === 'cpx32' ? 41.99 : null);
    expect(pickRoleType({ ...base, priceFor, candidates: ['cpx22', 'cpx32'], orderable: new Set(['cpx22', 'cpx32']), minRamGb: 4 })).toBe('cpx32');
  });
  it('returns null when nothing fits', () => {
    expect(pickRoleType({ ...base, candidates: ['cpx22'], orderable: new Set(), minRamGb: 4 })).toBeNull();
  });
  it('Review Focus 5: prices by the target location', () => {
    const seen = [];
    const priceFor = (t, loc) => { seen.push(loc); return loc === 'ash' ? 20.49 : 5.99; };
    pickRoleType({ ...base, priceFor, location: 'ash', candidates: ['cpx22', 'cx23'], orderable: new Set(['cpx22', 'cx23']), minRamGb: 4 });
    expect(new Set(seen)).toEqual(new Set(['ash']));
  });
});

describe('rankLocationsByPrice', () => {
  it('flux fixture: cx23 stocked in hel1 only puts hel1 first at $7.09', async () => {
    // seedCatalog(HetznerProvider, 'flux-hetzner-cx23-hel1') in beforeEach
    const ranked = rankLocationsByPrice(HetznerProvider, ['nbg1', 'fsn1', 'hel1'], ['compose']);
    expect(ranked[0]).toMatchObject({ location: 'hel1', monthly: 7.09, types: { compose: 'cx23' } });
  });
  it('2026-10-22 fixture: the EU ties at $23.59 and keeps the given order', () => {
    const ranked = rankLocationsByPrice(HetznerProvider, ['nbg1', 'fsn1', 'hel1'], ['compose']);
    expect(ranked.map((r) => [r.location, r.monthly])).toEqual([['nbg1', 23.59], ['fsn1', 23.59], ['hel1', 23.59]]);
  });
});
```

  The two `rankLocationsByPrice` tests consume Task 2's `ROLE_CANDIDATES`, `priceFor` and `IPV4_MONTHLY`. In this task they run against a stub `HetznerProvider`-shaped object built from the fixture (candidates `['cpx22','cx23','cpx21']`, `IPV4_MONTHLY = 0.6`); Task 2 switches them to the real class.
- [ ] **Step 3: Run** `pnpm vitest run tests/unit/lib/sizing.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement** `src/lib/sizing.js` with the signatures above. Add a comment block above `ROLE_MIN_RAM_GB` citing the measured peaks from P1 and the sources doc. Round `monthly` to cents only at the end.
- [ ] **Step 5: Run the same command.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(sizing): pick the cheapest orderable server that fits each role`.

### Task 2: Provider candidates, prices and the census

**Verdict (refresh): still needed, reshaped.** Price capture is new work (R3). Candidate lists are re-derived from the 2026-10-22 catalogs: declared order is "most reliably stocked first" (R5); DigitalOcean gains `-amd`/`-intel` stock-out variants (R6); Scaleway gains `PLAY2-NANO` in its fallback catalog. `IPV4_MONTHLY` moves here from Task 5 (R7). More existing tests pin today's defaults than the plan listed.

**Files:**
- Modify: `src/lib/providers/base.js`, and the five provider modules (`fetchServerTypes`, `getRegionDefaults`, `FALLBACK_SERVER_TYPES` where noted).
- Create: `tests/unit/providers/role-candidates-census.test.ts`, `tests/unit/providers/price-for.test.ts`.
- Modify: `tests/unit/providers/hetzner-availability.test.ts` (`:120-190`), `hetzner.test.ts` (`:248`, `:405-452`), `fetch-server-types-pagination.test.ts` (`:255-265`), `digitalocean.test.ts` (`:192-200`), `scaleway.test.ts`, `provider-contract.test.ts`.

**Interfaces:**
- Consumes: Task 1.
- Produces, per provider:
  - `static ROLE_CANDIDATES: { compose: string[], master?: string[], db?: string[], worker?: string[] }` (x86 only). Providers whose `SUPPORTED_TIERS` are compose-only (Vultr, Linode, Scaleway) declare `compose` only;
  - `static IPV4_MONTHLY: number`, billed IPv4 per server per month, with a source comment and date: Hetzner 0.60 (`/v1/pricing` `primary_ips`), Scaleway 3.65 (Zonal flexible IPv4 €0.005/h × 730), DigitalOcean, Vultr and Linode 0 (included);
  - `static _prices`: filled by `fetchServerTypes` from the payload it already reads (no new request). Shape `{ [type]: { [location]: number } }` for Hetzner, Linode (base price for every region, overridden by `region_prices`) and Scaleway (per zone, `monthly_price`); `{ [type]: number }` for DigitalOcean (`price_monthly`) and Vultr (`monthly_cost`), whose prices are location-uniform;
  - `static priceFor(type: string, location: string) -> number|null`, monthly, in the account's billing currency, from `_prices`; `null` before a live fetch or for an unpriced type;
  - `getRegionDefaults(region)` returns `{ composeType, masterType, dbType, workerType }`, each from `pickRoleType` with `ROLE_MIN_RAM_GB`. `composeType` is new, and `dbType` keeps its meaning for k8s. On compose-only providers `masterType`, `dbType` and `workerType` equal `composeType` (interface parity; nothing reads them).
  - Offline (no live catalog): the catalog is `FALLBACK_SERVER_TYPES`, `orderable` is the provider's offline region rule (Hetzner: `REGION_TYPE_PREFIXES` minus the lines retired in that geography, the `RETIRED_IN_EU`/`RETIRED_EVERYWHERE` facts the availability test already pins; every other provider: the whole fallback catalog), and `priceFor` is `null`.
- Candidate lists (declared order = offline order; the picker decides by price live):
  - Hetzner: compose, master and worker `['cpx22', 'cx23', 'cpx21']`; db `['cpx12', 'cx23', 'cpx22', 'cpx11']`. EU offline gives `cpx22` / `cpx12`; ash/hil offline gives `cpx21` / `cpx11`. (`cpx11` is 2 GB, so it is a db-only candidate.)
  - DigitalOcean: compose, master and worker `['s-2vcpu-4gb', 's-2vcpu-4gb-amd', 's-2vcpu-4gb-intel']`; db `['s-1vcpu-2gb', 's-1vcpu-2gb-amd', 's-1vcpu-2gb-intel', 's-2vcpu-4gb']`. Add the four variant slugs to `FALLBACK_SERVER_TYPES` (specs from the fixture).
  - Vultr: compose `['vc2-2c-4gb', 'vhf-2c-4gb']`. Add `vhf-2c-4gb` to the fallback catalog.
  - Linode: compose `['g6-standard-2']`.
  - Scaleway: compose `['BASIC3-X2C-4G', 'DEV1-M', 'PLAY2-NANO']` (offline keeps today's audited default; live, `DEV1-M` wins at €14.74). Add `PLAY2-NANO` (2 vCPU, 4 GB) to the fallback catalog.
  - Each implementer confirms every name exists in that provider's 2026-10-22 fixture. If one doesn't, drop it and say so in the report.
- Scaleway `DEV1-M` with the program's 40 GB SBS root (`src/lib/iac/programs/scaleway-compose.js:233-241`, `volumeType: 'sbs_volume'`): verified during the refresh. The 2026-10-22 catalog gives `DEV1-M` `volumes_constraint.min_size: 0` (no local volume required) and a non-zero `block_bandwidth`, so an SBS-only root is accepted. `PLAY2-NANO` and `BASIC3-X2C-4G` have local max 0, as today.
- Scaleway availability (P6): `/instance/v1/zones/{zone}/products/servers/availability` per zone, fetched with the servers walk under one `Promise.all`. A type whose availability is `shortage` is dropped from that zone's orderable set; `scarce` stays orderable.

- [ ] **Step 1: Write the census** (a walk, not a hand list):

```ts
// tests/unit/providers/role-candidates-census.test.ts
import { describe, expect, it } from 'vitest';
import { listProviders, getProviderClass } from '../../../src/lib/providers/index.js';
import { ROLE_MIN_RAM_GB } from '../../../src/lib/sizing.js';
import { seedCatalog } from '../helpers/catalog-fixtures.js';

const ROLES_BY_MODE = { compose: ['compose'], 'compose-ha': ['compose'], k8s: ['master', 'db', 'worker'], 'k8s-ha': ['master', 'db', 'worker'] };

describe.each(listProviders().map((p) => p.id))('%s role candidates', (id) => {
  const P = getProviderClass(id);
  const roles = [...new Set(P.SUPPORTED_TIERS.flatMap((m) => ROLES_BY_MODE[m]))];
  it('(a) declares a non-empty own list for every role its modes use', () => {
    expect(Object.hasOwn(P, 'ROLE_CANDIDATES')).toBe(true);
    for (const r of roles) expect(P.ROLE_CANDIDATES[r]?.length).toBeGreaterThan(0);
  });
  it('(b) no candidate is ARM', () => {
    for (const list of Object.values(P.ROLE_CANDIDATES)) for (const t of list) expect(P.isArmServerType(t)).toBe(false);
  });
  it('(c) every candidate is in the offline catalog', () => {
    for (const list of Object.values(P.ROLE_CANDIDATES)) for (const t of list) expect(P.FALLBACK_SERVER_TYPES).toHaveProperty(t);
  });
  it('(d) live defaults in DEFAULT_REGION meet each role floor', () => {
    const restore = seedCatalog(P, `2026-10-22/${id}`);
    try {
      const d = P.getRegionDefaults(P.DEFAULT_REGION);
      const key = { compose: 'composeType', master: 'masterType', db: 'dbType', worker: 'workerType' };
      for (const r of roles) expect(P.SERVER_TYPES[d[key[r]]].ram).toBeGreaterThanOrEqual(ROLE_MIN_RAM_GB[r]);
    } finally { restore(); }
  });
});
```

  - (e) The compose branch of `prompts.js` never reads `regionDefaults.dbType`: read the source between `if (isComposeDeploy) {` and its `} else {` (today `:806-812`) and assert it contains `composeType` and not `dbType`.
  - Prove each arm bites: temporarily delete Hetzner's `db` list and add `'cax11'` to DO's compose list, see (a) and (b) fail, then restore. Record that in the report.
- [ ] **Step 2: Write the provider tests.**

```ts
// tests/unit/providers/price-for.test.ts (excerpt)
it('Hetzner, 2026-10-22: nbg1 defaults and location prices', () => {
  seedCatalog(HetznerProvider, '2026-10-22/hetzner');
  expect(HetznerProvider.getRegionDefaults('nbg1')).toEqual({ composeType: 'cpx22', masterType: 'cpx22', dbType: 'cpx12', workerType: 'cpx22' });
  expect(HetznerProvider.getRegionDefaults('ash')).toEqual({ composeType: 'cpx21', masterType: 'cpx21', dbType: 'cpx11', workerType: 'cpx21' });
  expect(HetznerProvider.priceFor('cpx22', 'sin')).toBe(30.99);
  expect(HetznerProvider.priceFor('cpx22', 'nbg1')).toBe(22.99);
});
it('Hetzner, flux fixture: cx23 in hel1 wins every role there', () => {
  seedCatalog(HetznerProvider, 'flux-hetzner-cx23-hel1');
  expect(HetznerProvider.getRegionDefaults('hel1')).toEqual({ composeType: 'cx23', masterType: 'cx23', dbType: 'cx23', workerType: 'cx23' });
});
it('DigitalOcean: 4 GB master and worker, 2 GB db; sfo3 falls to the $28 variants', () => {
  seedCatalog(DigitalOceanProvider, '2026-10-22/digitalocean');
  expect(DigitalOceanProvider.getRegionDefaults('nyc3')).toEqual({ composeType: 's-2vcpu-4gb', masterType: 's-2vcpu-4gb', dbType: 's-1vcpu-2gb', workerType: 's-2vcpu-4gb' });
  expect(DigitalOceanProvider.getRegionDefaults('sfo3').composeType).toMatch(/^s-2vcpu-4gb-(amd|intel)$/);
});
it('Scaleway fr-par-1: DEV1-M at €14.74', () => {
  seedCatalog(ScalewayProvider, '2026-10-22/scaleway');
  expect(ScalewayProvider.getRegionDefaults('fr-par-1').composeType).toBe('DEV1-M');
  expect(ScalewayProvider.priceFor('DEV1-M', 'fr-par-1')).toBeCloseTo(14.74, 2);
});
it('Linode: an unpriced type sorts after a priced one', () => { /* g8-dedicated-4-2 has price.monthly null */ });
it('Review Focus 2: offline Hetzner never names a retired SKU', () => {
  // no seedCatalog: _locationTypes null
  expect(HetznerProvider.getRegionDefaults('nbg1')).toEqual({ composeType: 'cpx22', masterType: 'cpx22', dbType: 'cpx12', workerType: 'cpx22' });
  expect(HetznerProvider.getRegionDefaults('hil')).toEqual({ composeType: 'cpx21', masterType: 'cpx21', dbType: 'cpx11', workerType: 'cpx21' });
});
```

  - `fetchServerTypes` capture: with each provider's existing fetch mock (`fetch-server-types-pagination.test.ts`), `_prices` holds the payload's prices and `priceFor` returns them.
  - Scaleway: the zone walk issues the four zones' requests before awaiting any (assert call order with a deferred mock), and a `shortage` type is absent from that zone's `_locationTypes`.
- [ ] **Step 3: Run** `pnpm vitest run tests/unit/providers`. Expected: FAIL.
- [ ] **Step 4: Implement.** Keep `fetchServerTypes` doing the only network work. Delete the `smallShared`/`mediumShared` lists and the hand `offline` triple in `HetznerProvider.getRegionDefaults` (`hetzner.js:604-646`), and the fixed triples in the other four. Keep `DEFAULT_TYPE`, `DEFAULT_COMPOSE_TYPE` and `DEFAULT_K8S_NODE_TYPE` (the generic-defaults drift guard pins them; Hetzner's `cpx22` already equals the new offline compose pick).
- [ ] **Step 5: Run** `pnpm vitest run tests/unit/providers tests/unit/deploy tests/unit/lib`. Expected: PASS. Update every test that pinned the old defaults (`hetzner.test.ts:405-452`, `fetch-server-types-pagination.test.ts:260`, `digitalocean.test.ts:192-200`, `hetzner.test.ts:248`), with the justification in the commit.
- [ ] **Step 6: Commit** `feat(providers): role candidates and live prices drive default sizes`.

### Task 3: Deploy prompts use the role defaults and persist what they picked

**Verdict (refresh): still needed.** Lines moved: compose sizes `prompts.js:806-812` (still `regionDefaults.dbType` at `:810`), k8s sizes `:813-826`; `saveSkeletonEnv` is `orchestrator.js:1133-1172` and already writes `region` and `secondaryRegion` through `updateProjectConfig`, but none of the four types. The four types are in scope there (destructured at `:882-885`). The P7 message now carries the IPv4-inclusive price (R7).

**Files:**
- Modify: `src/lib/deploy/prompts.js:800-847`, `src/lib/deploy/orchestrator.js:1133-1172`.
- Test: `tests/unit/deploy/compose-default-size.test.ts` (new), `tests/unit/deploy/skeleton-env-persists-types.test.ts` (new), `tests/unit/deploy/prompt-credential-order.test.ts` (unchanged here).

**Interfaces:**
- Consumes: `getRegionDefaults().composeType`, `IPV4_MONTHLY` (Task 2), `rankLocationsByPrice` (Task 1).

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/unit/deploy/compose-default-size.test.ts (excerpt; harness as in prompt-credential-order.test.ts)
it('compose with no args or envConfig sizes takes composeType', async () => {
  seedCatalog(HetznerProvider, '2026-10-22/hetzner');
  const out = await runPrompts({ args: { yes: true, region: 'nbg1' }, envConfig: {} });
  expect(out.serverType).toBe('cpx22');
});
it('Review Focus 1: persisted types win', async () => {
  expect((await runPrompts({ args: { yes: true }, envConfig: { region: 'nbg1', serverType: 'cpx32' } })).serverType).toBe('cpx32');
  seedCatalog(DigitalOceanProvider, '2026-10-22/digitalocean');
  const k8s = await runPrompts({ provider: 'digitalocean', mode: 'k8s', args: { yes: true }, envConfig: { region: 'nyc3', masterServerType: 's-2vcpu-2gb' } });
  expect(k8s.masterServerType).toBe('s-2vcpu-2gb');
});
it('P7: nothing orderable refuses before any provider write', async () => {
  seedCatalog(HetznerProvider, 'flux-hetzner-cx23-hel1', { drop: { nbg1: ['cpx22', 'cpx21'] } });
  await expect(runPrompts({ args: { yes: true, region: 'nbg1' }, envConfig: {} })).rejects.toThrow(/exit 1/);
  expect(clackMock.log.error).toHaveBeenCalledWith(
    expect.stringMatching(/^no compose server with 4 GB\+ RAM is orderable in nbg1 right now; orderable nearby: hel1 \(cx23 \$7\.09\/mo\)/),
  );
  expect(providerWrites).toEqual([]);
});
```

  - Review Focus 1, skeleton: with the existing orchestrator test harness, a fake IaC failure after `saveSkeletonEnv` leaves `serverType`, `masterServerType`, `dbServerType`, `workerServerType` (each when defined) and `secondaryRegion` in the persisted env, read back through `loadProjectConfig`.
  - A re-run of that failed deploy, with a catalog in which the persisted type is now more expensive than another candidate, keeps the persisted type.
  - `prompt-credential-order.test.ts` still passes unchanged in this task. Task 4 moves the standby, Task 5 the region (P11).
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/compose-default-size.test.ts tests/unit/deploy/skeleton-env-persists-types.test.ts tests/unit/deploy/prompt-credential-order.test.ts`. Expected: FAIL (the first two).
- [ ] **Step 3: Implement.** In the P7 message, "nearby" means same-continent locations from `rankLocationsByPrice`, at most 3. The skeleton fields go inside the existing `updateProjectConfig` updater, so a concurrent write is never clobbered.
- [ ] **Step 4: Run** `pnpm vitest run tests/unit/deploy`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(deploy): compose gets the cheapest 4 GB server, and a deploy remembers the sizes it picked`.

### Task 4: Standby location and standby size from the picker

**Verdict (refresh): still needed, more urgent.** On 2026-10-22 DigitalOcean's default standby for `nyc3` is `sfo3`, where neither `s-2vcpu-4gb` (compose, db) nor `s-2vcpu-2gb` (k8s master, worker) is sold, and `DigitalOceanProvider.resolveServerTypeForRegion` (`digitalocean.js:617-628`) returns the unsellable default anyway, so a headless DO compose-ha or k8s-ha deploy with default regions cannot place its standby. Lines: standby block `prompts.js:764-786`; compose-ha `compose-ha.js:152-154` (region) and `:186-193` (type); k8s-ha `k8s-ha.js:142-158` plus the `DEFAULT_K8S_NODE_TYPE` fallbacks at `:445-456`.

**Files:**
- Modify: each provider's `getDefaultStandbyRegion` (Hetzner `:193`, DO `:583`, Vultr `:401`, Linode `:541`, Scaleway `:627`), `src/lib/deploy/prompts.js` (move `:764-786` to after `:800`), `src/lib/deploy/effects/compose-ha.js:152-193`, `src/lib/deploy/effects/k8s-ha.js:142-158`.
- Test: `tests/unit/deploy/compose-ha-standby-region.test.ts`, `compose-ha-standby-server-type.test.ts`, `tests/unit/providers/standby-region-by-price.test.ts` (new), `tests/unit/providers/digitalocean.test.ts:112-126` (update), `tests/unit/deploy/prompt-credential-order.test.ts`.

**Interfaces:**
- Consumes: `rankLocationsByPrice`, `cheapestRoleSet`, `pickRoleType` (Task 1); `ROLE_CANDIDATES`, `priceFor` (Task 2).
- Produces: `getDefaultStandbyRegion(primaryRegion, roles = ['compose'])`. It returns the cheapest same-continent partner (not the primary) where every role is orderable; ties keep today's conventional pair. It falls back to today's static choice when the catalog is not loaded or no partner qualifies; the P7 refusal then fires at type resolution. k8s-ha passes `['master', 'db']` (the pilot-light standby has no worker).

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/unit/providers/standby-region-by-price.test.ts (excerpt)
it('Hetzner 2026-10-22: EU ties keep the conventional partner', () => {
  seedCatalog(HetznerProvider, '2026-10-22/hetzner');
  expect(HetznerProvider.getDefaultStandbyRegion('nbg1')).toBe('fsn1');
  expect(HetznerProvider.getDefaultStandbyRegion('hel1')).toBe('fsn1'); // deterministic: REGION_CONTINENT order
});
it('DigitalOcean 2026-10-22: nyc3 pairs with tor1, not the unstocked sfo3', () => {
  seedCatalog(DigitalOceanProvider, '2026-10-22/digitalocean');
  expect(DigitalOceanProvider.getDefaultStandbyRegion('nyc3')).toBe('tor1');
  expect(DigitalOceanProvider.getDefaultStandbyRegion('nyc3', ['master', 'db'])).toBe('tor1');
});
it('offline keeps the static pairs', () => {
  expect(DigitalOceanProvider.getDefaultStandbyRegion('nyc3')).toBe('sfo3');
});
```

  - The `prompts.js` standby block runs after the catalog fetch: a source-order assertion (`getDefaultStandbyRegion(` appears after `fetchServerTypes(` in the function body), plus a behavioral test that the DO default is `tor1` in a headless `-y` run.
  - This puts the standby prompt between the API token and the S3 keys, the first half of P11. Update `prompt-credential-order.test.ts` here to token, standby, S3 keys. Task 5 then inserts the region select before the standby.
  - Review Focus 3: a persisted `envConfig.secondaryRegion = 'sfo3'` on DO whose standby type is unorderable there exits 1 with the P7 line naming `tor1`, and `secondaryRegion` stays `'sfo3'` in config.
  - Review Focus 4 (flux fixture): compose-ha with primary `hel1` (`cx23`) and standby `fsn1` gives `ctx.standbyServerType === 'cpx22'`, and the info line `Standby server type adjusted for fsn1: cx23 -> cpx22` is logged. In k8s-ha, each standby role is re-picked for its location (`master: cpx22`, `db: cpx12` in fsn1).
  - A recorded standby type (`recordedType('standby')`, `compose-ha.js:177-182`) is still kept as is.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/compose-ha-standby-region.test.ts tests/unit/deploy/compose-ha-standby-server-type.test.ts tests/unit/providers/standby-region-by-price.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `pickRoleType` instead of the default branch of `resolveServerTypeForRegion` when no standby type is persisted. Keep `resolveServerTypeForRegion`'s ARM-rescue behaviour for persisted types, and make its "not stocked" branch return the picker's choice for the role rather than an unstocked default (the DO bug). The `DEFAULT_K8S_NODE_TYPE` fallbacks at `k8s-ha.js:445-456` stay as last-resort literals; they are reached only when no type was resolved at all.
- [ ] **Step 4: Run** `pnpm vitest run tests/unit/deploy tests/unit/providers`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ha): standbys default to the cheapest stocked partner location`.

### Task 5: New-project region default and priced region options

**Verdict (refresh): still needed, reshaped.** The region select is `prompts.js:749-761`, before `promptApiToken` at `:788`. `IPV4_MONTHLY` now comes from Task 2 (R7). With the 2026-10-22 catalogs every provider ties within its default continent, so the default does not move today; the flux fixture carries the "cheaper elsewhere" case.

**Files:**
- Modify: `src/lib/deploy/prompts.js` (the region select `:749-761` moves after `:800`).
- Test: `tests/unit/deploy/region-default-by-price.test.ts` (new), `tests/unit/deploy/prompt-credential-order.test.ts`.

**Interfaces:**
- Consumes: `rankLocationsByPrice` (Task 1), `IPV4_MONTHLY` (Task 2).
- The region select currently runs before `promptApiToken`, and a live price needs the token on Hetzner and DigitalOcean. The S3 keys need the region, because the object-storage endpoint follows the location, so the region cannot move after the keys.
- **Ruling P11:** the new order is API token, `fetchServerTypes`, region select (priced), standby (Task 4), then the S3 keys, then sizes.
  - This deliberately ends the "token and S3 keys back to back" contract (`prompts.js:849-853` comment, and `prompt-credential-order.test.ts`'s header): the region and standby prompts are one Enter each in the common case, while a priced region choice is the point of this task.
  - Update `prompt-credential-order.test.ts` to pin the new order, with the justification in the commit, and rewrite the two code comments that state the old contract (`:793-799`, `:849-853`).
  - A run with a persisted region and saved credentials has no new prompt at all.
  - Cost if wrong: a reviewer prefers the old order. Reverting is a block move, and the prices then show only after a second run.
- Label format: `<id> - <name> · from <currency><monthly>/mo` for the role set of the chosen mode (compose: `compose`; k8s: `master`, `db`, `worker`). A location where the set is unorderable shows `<id> - <name> · not orderable right now` and stays selectable (the P7 refusal explains). Currency symbol: `$` except Scaleway `€`.

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/unit/deploy/region-default-by-price.test.ts (excerpt)
it('flux fixture: a new Hetzner compose project preselects hel1 at $7.09', async () => {
  seedCatalog(HetznerProvider, 'flux-hetzner-cx23-hel1');
  const { region, selectCalls } = await runPrompts({ args: {}, envConfig: {} });
  const regionSelect = selectCalls.find((c) => c.message === 'Region:');
  expect(regionSelect.initialValue).toBe('hel1');
  expect(regionSelect.options.find((o) => o.value === 'hel1').label).toBe('hel1 - Helsinki, Finland · from $7.09/mo');
});
it('2026-10-22: the EU ties, so nbg1 stays the default at $23.59', async () => {
  seedCatalog(HetznerProvider, '2026-10-22/hetzner');
  expect((await runPrompts({ args: { yes: true }, envConfig: {} })).region).toBe('nbg1');
});
it('persisted and flag regions are never moved', async () => {
  seedCatalog(HetznerProvider, 'flux-hetzner-cx23-hel1');
  expect((await runPrompts({ args: { yes: true }, envConfig: { region: 'nbg1' } })).region).toBe('nbg1');
  expect((await runPrompts({ args: { yes: true, region: 'fsn1' }, envConfig: {} })).region).toBe('fsn1');
});
it('DigitalOcean keeps nyc3 on a $24 tie', async () => { /* 2026-10-22/digitalocean */ });
it('never preselects another continent', async () => { /* fixture where ash is cheapest: preselect stays in the EU */ });
```

- [ ] **Step 2: Run** `pnpm vitest run tests/unit/deploy/region-default-by-price.test.ts tests/unit/deploy/prompt-credential-order.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run tests/unit/deploy`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): new projects default to the cheapest region on the default continent, with prices shown`.

### Task 6: scale and the e2e harness use the same picker

**Verdict (refresh): reshaped.** The `K8S_PROFILES.starter` item is obsolete (no production caller; dropped). `scale.js:180-185` is now `scale.js:326` (`envConfig.serverType || Provider.getRegionDefaults(region).dbType`). The harness does not pin types per scenario: it pins them through `capacityPreferences.typePairs` (`tests/config.ts:183-301`), the resolver (`tests/e2e/utils/region-resolver.ts`), the runner (`tests/e2e/runner.ts:729-830`) and the env seed (`tests/e2e/utils/cli-runner.ts:429`). `tests/unit/e2e/hetzner-capacity-cost-guard.test.ts` pins the pairs (R9). The cold-deploy budgets then judge the new sizes (R10).

**Files:**
- Modify: `src/scale.js:326`.
- Modify: `tests/config.ts:183-301`: `typePairs` become a scale ladder keyed by the deployed type, `scaleTo: Record<string, string>` per provider (Hetzner `{ cx23: 'cx33', cpx22: 'cpx32', cpx12: 'cpx22', cpx21: 'cpx31' }`, DigitalOcean `{ 's-2vcpu-4gb': 's-4vcpu-8gb', 's-1vcpu-2gb': 's-2vcpu-4gb', 's-2vcpu-4gb-amd': 's-4vcpu-8gb', 's-2vcpu-4gb-intel': 's-4vcpu-8gb' }`, Vultr `{ 'vc2-2c-4gb': 'vc2-4c-8gb' }`, Linode `{ 'g6-standard-2': 'g6-standard-4' }`, Scaleway `{ 'DEV1-M': 'DEV1-L', 'BASIC3-X2C-4G': 'BASIC3-X4C-8G' }`). Each `scaleTo` value must exist in the fixture and, for the census, in the provider's fallback catalog: `DEV1-L` (Scaleway) and `cpx31` (Hetzner, already listed) are the checks; `s-4vcpu-8gb`, `vc2-4c-8gb`, `g6-standard-4` and `BASIC3-X4C-8G` are already in their fallback catalogs, `DEV1-L` must be added (4 vCPU, 8 GB, from the fixture).
- Modify: `tests/e2e/utils/region-resolver.ts`: `resolveCapacity` picks the first preferred region where `cheapestRoleSet` resolves for the scenario's roles and returns `serverType: undefined`; `resolveCapacityPair` picks two same-continent regions where it resolves in each (mixed types allowed, Review Focus 4). `scaleToType` comes from the ladder for the type the deploy persisted.
- Modify: `tests/e2e/utils/cli-runner.ts:429`: no `serverType` seed unless the scenario sets one explicitly.
- Modify: the scale step in `tests/e2e/scenarios/_run-lifecycle.ts` (`:3703`, `:3787`): read the deployed type from `.vibecarbon.json` (persisted by Task 3) and look up `scaleTo`; a type with no ladder entry fails the step with `no scale target for <type> in tests/config.ts scaleTo`.
- Modify: `tests/e2e/utils/ssh.ts:295-345` `getServerIps`: include the k8s-ha primary worker. **Refresh:** `getServerIps` already pushes every `servers[]` entry's `ip` (`:334-341`), yet the k8s-ha resource rows hold four servers (no worker), and the persisted `ha.primary` block (`orchestrator.js:2645-2665`) carries no worker IP. Step 0 of this item: find where (if anywhere) the k8s-ha primary worker's IP is persisted. If it is in `servers[]` under another shape, read it from there; if it is persisted nowhere, drop this item and say so in the report (the k8s worker peak, 1,050 MB, stands in, as cost-grid-sources says). Do not add a persisted field for a test.
- Test: `tests/unit/e2e/default-sizes-unpinned-census.test.ts` (new), `tests/unit/e2e/region-resolver.test.ts`, `tests/unit/e2e/hetzner-capacity-cost-guard.test.ts`, a `getServerIps` test (extend whichever file covers `ssh.ts` today, or create `tests/unit/e2e/server-ips.test.ts`), `tests/unit/scale/role-aware-sizing.test.ts` or a new `tests/unit/scale/default-type.test.ts`.

**Interfaces:**
- Consumes: `cheapestRoleSet` (Task 1), `getRegionDefaults().composeType` (Task 2), the skeleton-persisted types (Task 3).

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/unit/e2e/default-sizes-unpinned-census.test.ts (excerpt)
it('no scenario seeds a server type unless it is on the allow-list', () => {
  const ALLOW: Record<string, string> = {}; // scenario id -> reason; starts empty
  for (const s of allScenarios()) {
    const resolved = resolveCapacity(s, fixtureCatalogs);
    if (!(s.id in ALLOW)) expect(resolved.serverType).toBeUndefined();
  }
});
it('every scale ladder entry is amd64 and in the fallback catalog', () => { /* walk testConfig.e2e.capacityPreferences.*.scaleTo */ });
it('getServerIps includes the k8s-ha primary worker', () => {
  // envConfig shape: whatever Step 0 finds the k8s-ha deploy persists for the primary worker
  const ips = getServerIps(dirWith(k8sHaEnvWithPrimaryWorker('10.0.0.9')), 'e4');
  expect(ips).toContain('10.0.0.9');
});
it('scale with no persisted type shows composeType', async () => {
  // stub the backup-credential preflight (scale needs backup creds); provider hetzner, not scaleway
  seedCatalog(HetznerProvider, '2026-10-22/hetzner');
  expect(await currentTypeShown({ region: 'nbg1' })).toBe('cpx22');
});
```

  - `hetzner-capacity-cost-guard.test.ts`: keep the EU-only `regions` pin; replace the `typePairs` pin with "no ladder entry names the `cpx*1` generation as a target in the EU" plus "the resolver never returns a US location by default". Justify in the commit: the cost guard's intent (EU, current generation, cheapest first) is now carried by the picker.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/e2e tests/unit/scale`. Expected: FAIL.
- [ ] **Step 3: Implement.** The resolver imports the provider classes from `src/` (it already queries the same APIs at preflight); it calls `fetchServerTypes` once per provider and passes the cached classes to `cheapestRoleSet`.
- [ ] **Step 4: Run** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** `test(e2e): the matrix deploys the sizes customers get by default`.

### Task 7: README cost grid, generated

**Verdict (refresh): still needed, reshaped.** No "deploy-modes overview" heading exists: the section goes after "## Performance" (`README.md:290-317`) and before "## License & Terms". No release checklist file exists: the refresh line goes into AGENTS.md's release-gate bullets (`AGENTS.md:274`) (R11). Markers follow `<!-- BEGIN:perf-table -->` (R12). Expected values are the 2026-10-22 ones. Hetzner Object Storage is $7.99 for this USD account (the 2026-10-20 grid said €6.49, the EUR price).

**Files:**
- Create: `scripts/cost-grid.js`, `tests/unit/scripts/cost-grid.test.ts`.
- Modify: `README.md` (new "## What it costs to run" section between `<!-- BEGIN:cost-grid -->` and `<!-- END:cost-grid -->`), `AGENTS.md` (one line under the release gate: refresh the cost grid with `node scripts/cost-grid.js --write` before a release that changes default sizes).

**Interfaces:**
- `renderCostGrid({ providers: Array<{ id, label, currency, rows: Record<mode, { monthly: number, locations: string[] } | 'unsupported'> }>, date: string, storage: Record<id, string> }) -> string`. This is pure and tested with fixtures.
- `computeEnvMonthly(Provider, mode) -> { monthly, locations }`. It uses `rankLocationsByPrice` over the provider's `REGION_CONTINENT` keys on `DEFAULT_REGION`'s continent, the standby via `getDefaultStandbyRegion(primary, roles)`, and per-env extras: `IPV4_MONTHLY` per server (from the provider), Hetzner floating IP 3.50 per k8s cluster, the db volume at the provider's per-GB price × 11 GB on Hetzner and × 10 GiB on DigitalOcean per k8s cluster, and Scaleway's 40 GB SBS root.
  - Billing extras other than IPv4 are declared once, in a table in `scripts/cost-grid.js`, with source URLs and the date checked. They do not go into provider classes (IPv4 is the exception because the CLI's region labels need it, R7).
  - The script reads the Hetzner extras live from `/v1/pricing` when the token is present, and falls back to the declared table with a one-line note.
- CLI: `node scripts/cost-grid.js` prints the markdown; `--write` replaces the README section. It reads tokens from the environment, and skips a provider with a one-line note when its token is missing. Public APIs (Vultr plans, Linode types, Scaleway products) need none.

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/unit/scripts/cost-grid.test.ts (excerpt)
import { renderCostGrid, replaceSection } from '../../../scripts/cost-grid.js';

const fixture = {
  date: '22 October 2026',
  providers: [
    { id: 'hetzner', label: 'Hetzner (USD account)', currency: '$', rows: {
      compose: { monthly: 23.59, locations: ['nbg1'] }, 'compose-ha': { monthly: 47.18, locations: ['nbg1', 'fsn1'] },
      k8s: { monthly: 65.61, locations: ['nbg1'] }, 'k8s-ha': { monthly: 107.64, locations: ['nbg1', 'fsn1'] } } },
    { id: 'scaleway', label: 'Scaleway', currency: '€', rows: {
      compose: { monthly: 21.84, locations: ['fr-par-1'] }, 'compose-ha': { monthly: 43.68, locations: ['fr-par-1', 'nl-ams-1'] },
      k8s: 'unsupported', 'k8s-ha': 'unsupported' } },
  ],
  storage: { hetzner: '$7.99', scaleway: 'usage-based (cents at this size)' },
};

it('renders the Hetzner row', () => {
  expect(renderCostGrid(fixture)).toContain('| Hetzner (USD account) | $23.59 (nbg1) | $47.18 (nbg1 + fsn1) | $65.61 (nbg1) | $107.64 (nbg1 + fsn1) |');
  expect(renderCostGrid(fixture)).toContain('| Scaleway | €21.84 (fr-par-1) | €43.68 (fr-par-1 + nl-ams-1) | not yet | not yet |');
});
it('copy rules: no em dash, no "free" near servers, dated', () => {
  const md = renderCostGrid(fixture);
  expect(md).not.toMatch(/—/);
  expect(md).not.toMatch(/\bfree\b(\W+\w+){0,3}\W+(server|infrastructure|deploy)/i);
  expect(md).toMatch(/on 22 October 2026/);
});
it('--write replaces only the marked section', () => {
  const readme = 'before\n<!-- BEGIN:cost-grid -->\nold\n<!-- END:cost-grid -->\nafter\n';
  expect(replaceSection(readme, 'new')).toBe('before\n<!-- BEGIN:cost-grid -->\nnew\n<!-- END:cost-grid -->\nafter\n');
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/unit/scripts/cost-grid.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Then run `node scripts/cost-grid.js --write` with the tokens the operator has. Commit the README with whatever providers resolved, and name any skipped provider in the commit body.
  - The prose around the table comes from cost-grid.md: the "You pay your cloud provider directly" intro, the "What each mode runs" table and the footnote line, with the 2026-10-22 numbers. Expected grid on the 2026-10-22 catalogs:

    | Provider | compose | compose-ha | k8s | k8s-ha |
    |---|---|---|---|---|
    | Hetzner (USD account) | $23.59 (nbg1) | $47.18 (nbg1 + fsn1) | $65.61 (nbg1) | $107.64 (nbg1 + fsn1) |
    | DigitalOcean | $24 (nyc3) | $48 (nyc3 + tor1) | $61 (nyc3) | $98 (nyc3 + tor1) |
    | Vultr | $20 (ewr) | $40 (ewr + ord) | not yet | not yet |
    | Linode | $24 (us-iad) | $48 (us-iad + us-ord) | not yet | not yet |
    | Scaleway | €21.84 (fr-par-1) | €43.68 (fr-par-1 + nl-ams-1) | not yet | not yet |

    Object storage line: Hetzner $7.99 (this USD account; €6.49 on EUR accounts), DigitalOcean $5, Linode $5, Vultr $18, Scaleway usage-based.
  - The defaults-today collapsible from cost-grid.md is dropped, since after this plan the defaults are the best practical prices.
  - Where a cheaper type is listed but out of stock everywhere (Hetzner `cx23` on 2026-10-22), the footnote may say so in one sentence (decision B3).
  - The footnote names the ARM saving as "later" (decision B5).
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`. Expected: PASS.
- [ ] **Step 5: Commit** `docs(readme): monthly cost per environment for every provider and mode`.

---

## Later: ARM (not in this plan)

The win, on the 2026-10-22 catalog: Hetzner `cax11` costs $6.99 and is stocked in fsn1, nbg1 and hel1, which would take Hetzner compose to about $7.59, compose-ha to $15.18, k8s to $27.11 and k8s-ha to $46.64, against $23.59, $47.18, $65.61 and $107.64 on x86 today.

What arm64 end to end needs:
1. **Lift the guard.** `assertAmd64ServerType` (`src/lib/deploy/prompts.js:836-847`, `src/lib/scale-plan.js`, `src/failover.js`) and the catalog ARM filter (`hetzner.js:497`) become an arch property on the role pick. Mixed-arch HA pairs stay forbidden, because a streaming replica needs the same arch.
2. **Ship arm64 app images.** compose now delivers the app as a layer delta on top of the published `node-runtime` base (#240, #241). The runtime base must be published multi-arch, and the app layers built for the server's arch.
   - Building arm64 on an x86 laptop means QEMU, which the speed plan avoids. The practical routes are a native arm64 build on the server (`direct` mode, rejected as the default in 2026-05 for flakiness) or the GHA `push` mode with a multi-arch build.
   - compose-ha already builds on the servers, so on ARM it builds natively and needs only (1) and (3).
3. **Pin multi-arch images.** The db image `ghcr.io/hyperformant/postgres` is already multi-arch (release.yml requires it). The core-path images now come from our ghcr mirror (`MIRRORED_IMAGES`), and the cold-deploy plan turned some pins into amd64-child digests; each needs a multi-arch index pin instead. A census can walk the compose files and `MIRRORED_IMAGES` for that.
4. **k3s on arm64.** k3s itself supports arm64, but the in-cluster registry, cert-manager, the k3s system-image mirror and every k8s manifest image need the same index check.
5. **e2e:** one ARM scenario per mode that changes, starting with `hetzner/compose-ha`.

Order when picked up: compose-ha first, since it needs only items 1 and 3. Then compose. k8s and k8s-ha come last.

## Verification

- Per task: the commands listed, green, with red-then-green evidence in the implementer report.
- End of branch:
  - `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`;
  - CI `test.yml` green.
- Real infra, which needs Brandon's OK for the spend:
  - `pnpm test:e2e:batch -- --provider hetzner`, now on unpinned defaults. Expect compose on `cpx22` (or `cx23` where it is stocked that day), k8s with a `cpx12` db, and compose-ha with a same-continent standby. Every mode's peak RAM must stay under half its node RAM, the P1 rule, as recorded in `tests/results/e2e.db`, and every cold deploy must meet #241's budgets (R10).
  - `--provider digitalocean` to prove the `tor1` standby default and the `s-1vcpu-2gb` k8s db.
  - `--provider scaleway --scenario compose` once, to measure `DEV1-M` against the compose budget.
