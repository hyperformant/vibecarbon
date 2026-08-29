# Test Suite Documentation

Vibecarbon's test suite is organized into 4 tiers. Each tier has a one-sentence definition with no overlap.

## Tiers

| Tier | Definition | Real cloud? | Spawns CLI? | Command |
|---|---|---|---|---|
| **unit** | Pure, in-process. No child processes, no I/O outside tmp dirs. | No | No | `pnpm test:unit` |
| **integration** | Spawns the CLI against fixture projects with all cloud / SSH / exec stubbed; real Pulumi runs against file:// backend. | No | Yes | `pnpm test:integration` |
| **loadtest** | Performance benchmarks against a deployed instance. | No (target is) | No | `pnpm test:loadtest` |
| **e2e** | REAL_INFRA against a real cloud (any registered provider: Hetzner, DigitalOcean, Linode, Vultr, Scaleway). Real money, real DNS, full deploy / destroy / scale / restore matrix. | **Yes** | Yes | `pnpm test:e2e` |

`unit` + `integration` run on every push. `loadtest` is on-demand against a running target. `e2e` requires `REAL_INFRA=true` and credentials in `tests/.env.e2e` (gitignored; copy `tests/.env.e2e.example` and fill in the values you need; real shell/CI env vars still win over the file).

**What gates a release:** the `Test Suite` workflow (unit + integration + lint + the carbon template job); semantic-release fires on its success. **e2e is NOT a release gate**; it runs manually via `workflow_dispatch` (see below), so "e2e green on real infra" is a point-in-time result, not a property of every published version. Restore any "all green" claim only after a fresh full-matrix record run on the shipping commit.

## Integration sub-trees

`tests/integration/` is a single tier in vitest, but the directory is filterable for daily work:

| Subdir | Purpose | Filter |
|---|---|---|
| `cli/<cmd>/` | Per-command flag matrix using the harness | `pnpm test:cli` |
| `docker/` | Docker-compose service smoke (gated on `DOCKER_INTEGRATION=true`) | `pnpm test:docker` |
| `template/` | Generated-project lint/build + template script behavior (the artifact we ship to users) | `pnpm test:template` |
| `modules/` | Module-level integration that doesn't fit a single CLI command | `pnpm test:modules` |
| `_harness/` | Shared CLI test harness (fixtures, stubs, runCli, assertions); also has self-tests | n/a |

## Writing a CLI test (the harness)

```ts
import { afterEach, describe, it } from 'vitest';
import {
  assertSuccess,
  assertFileWritten,
  buildFixture,
  destroyFixture,
  installStubs,
  runCli,
  type TeardownFn,
} from '../../_harness/index.js';

describe('vibecarbon add observability', () => {
  let fix: string;
  let teardown: TeardownFn | undefined;
  afterEach(() => { teardown?.(); destroyFixture(fix); });

  it('writes manifest in a -no-git project', () => {
    fix = buildFixture({ mode: 'k8s', git: false });
    teardown = installStubs({ hetzner: 'success' });
    const r = runCli('add', ['observability'], { cwd: fix });
    assertSuccess(r);
    assertFileWritten(fix, 'k8s/overlays/observability/kustomization.yaml');
  });
});
```

### Harness primitives

- **`buildFixture({ mode, git, envs, withDeployedState, files })`**: synthesizes a vibecarbon project in a temp dir. Mode-specific scaffolding (compose vs k8s), `.gitignore` mirrors `carbon/.gitignore`, optional pre-populated `.vibecarbon/<env>.json` for post-deploy commands.
- **`installStubs({ hetzner, cloudflare })`**: overrides `globalThis.fetch` with HTTP fakes. Hetzner modes: `success` / `capacity-exhausted` / `rate-limited` / `not-found`. Cloudflare: `success` / `rate-limited`. Unmatched URLs throw: no silent prod hits. (In-process only; child-process exec stubbing is deferred.)
- **`runCli(verb, flags, opts)`**: spawns `node src/cli.js <verb> <flags...>` via `spawnSync`. ANSI is stripped from stdout/stderr. Sets `HOME` to a per-process tmp with a fake Fullerene license activated, so paid-tier commands reach their flag-parsing logic. Returns `{ exitCode, stdout, stderr }`.
- **`assertSuccess` / `assertExitWith` / `assertFileWritten` / `assertFileMissing`**: throw plain `Error` with the relevant slice of `RunResult` so failures are legible without digging through raw stdio.

## Cross-tier shared helpers

`tests/_shared/` (HTTP fakes, temp-dir helpers, docker utils) is the home for cross-tier infrastructure. Anything specific to a single tier lives under that tier's `_harness/` (currently only `tests/integration/_harness/`).

## E2E tests

**`tests/e2e/scenarios/`**: full deploy/destroy/scale/restore matrix over the scenarios in the provider registry (`testConfig.e2e.providers` in `tests/config.ts`), which providers and scenarios come from; which deploy tiers each provider supports comes from that provider's `SUPPORTED_TIERS` in `src/lib/providers/<id>.js`. Run via `pnpm test:e2e` (the runner with metrics). Requires `REAL_INFRA=true` and burns real cloud credit on whichever provider you select.

**Scenario identity is `provider/mode`.** Selection is the grammar in `tests/e2e/selection.ts`: `--provider <name|all>` picks whole providers, `--scenario <provider>/<mode>` picks individual scenarios (optionally refined by DNS provider, e.g. `hetzner/k8s-ha-cloudflare`), and `--except` takes the same tokens. A bare mode is not a token. It throws a `SelectionError` naming the valid forms. Env prefixes (`e1`–`e4`, `d1`–`d3`) are internal namespacing for resource names and DNS subdomains, never selection vocabulary.

**Every provider is opt-in, equally.** There is no default provider: `pnpm test:e2e:batch` with no `--provider` throws, naming the known providers. Reach any of them with `--provider <id>` (its whole default selection), `--provider all`, or `--scenario <provider>/<mode>`. Each provider's required credentials are declared in its registry entry (`requiredEnv`) and listed in `tests/.env.e2e.example`.

Providers differ only in which deploy tiers they implement: Hetzner all four, DigitalOcean compose/compose-ha/k8s, Linode/Vultr/Scaleway compose/compose-ha. That is a capability difference, not a standing one: no provider is a default, and none gates a release.

### README performance table

Every published performance surface renders from one checked-in file, `docs/perf-data.json` (`providers.<id>.run{id,date,origin}` + `providers.<id>.scenarios.<mode>.<step> = ms`), via pure functions in `tests/e2e/metrics/perf-data.ts`: `renderUnifiedPerfTableMd` / `patchReadmeUnifiedPerfTable` render the single README table between `<!-- BEGIN:perf-table -->` / `<!-- END:perf-table -->` markers, one row per provider × scenario the registry declares, grouped by provider in registry order, scenarios in the provider's own order; a registered provider/mode with no measurement yet renders `_pending_` rather than being omitted, so "not supported" and "not measured" stay distinguishable. `patchInlinePerfMarkers` independently resolves `<!-- perf:<step>:<provider>/<mode> -->…<!-- /perf -->` spans elsewhere in README (e.g. headline numbers) from the same data. `syncCarbonPerfData` copies the file byte-identically to `carbon/src/client/components/sections/vendor-matrix-data.json`, which the marketing site's vendor-matrix component renders from.

**`docs/perf-data.json` is machine-owned; hand edits don't stick.** `updatePerfDataFromRun` merges a run's providers into it one at a time: a provider's entry updates only when every scenario in its registry list is green this run *and* the run covers the whole list. Partial coverage (e.g. a single `--scenario hetzner/k8s-ha` run) leaves that provider's existing entry untouched, independent of any sibling provider. Only green steps contribute numbers.

**Writers.** The batch runner (`pnpm test:e2e:batch`) calls `updatePerfDataFromRun` at the end of a run, but only under `GITHUB_ACTIONS`: a laptop-measured run never touches the file (the 2026-08-08 numbers policy). The **E2E US Perf Run** workflow (`.github/workflows/e2e-us-perf.yml`) runs one job per selected provider against its own checkout, uploads each leg's `e2e.db`, and a collector job, `tests/e2e/metrics/publish-perf-pr.ts`, merges every leg into the shared data file sequentially (safe without a db merge, since a leg's db only ever carries rows for the one provider it ran), then re-renders all three surfaces once and opens/updates a perf PR from `main`.

**Anomaly guard.** `detectPerfAnomalies` (`tests/e2e/metrics/reporter.ts`) flags a green cell that is still anomalously slow: the current value against the **median of that same provider's last 5 green runs** (mode + dnsProvider + step, excluding this run); a cell over **1.3×** that median excludes its *whole* provider from the pass, keeping the previously recorded fast numbers (cells with fewer than 2 prior green runs are never flagged: no baseline yet; `--force-perf-table` records anyway). The batch runner wires this guard ahead of its own `updatePerfDataFromRun` call (`excludeProviders`); the CI US Perf collector does not re-run it and merges every leg's green coverage unconditionally.

### RTO/RPO figures (HA guarantees)

The published RTO/RPO guarantees in `docs/technical.md` → Guarantees (k8s-ha)
are rendered from the same SQLite metrics by a sibling of the perf-table
machinery: `pnpm test:e2e:rto-rpo` (`tests/e2e/metrics/rto-rpo.ts`) reads a
run's `failover` / `verify-failover` steps, the `failover.provisionWorkers` /
`failover.promoteStandby` perf substeps, and the
`replication_failover_continuity` verification, and re-renders the block
between the `<!-- BEGIN:rto-rpo-figures -->` / `<!-- END:rto-rpo-figures -->`
markers (print-only without `--write`). It fails closed (no green failover +
continuity evidence, no figures) and flags non-full-matrix sources per the
HA-claims-pinned-to-green-matrix rule. Full methodology and the metric-to-SQL
mapping: [docs/rto-rpo.md](./rto-rpo.md).

### CI US-region perf runs

The perf table can also be measured from CI, removing the operator's uplink
from the numbers: the **E2E US Perf Run** workflow (`workflow_dispatch`) runs
against Hetzner US regions (default `ash,hil`) and, opt-in, DigitalOcean.

Topology: one `matrix` job instance per selected provider (`fail-fast:
false`, its own concurrency group per provider so re-dispatching one
provider never cancels or queues behind the other's in-flight leg), each
running the selection grammar's `--provider <x>` against its own checkout
and uploading its own `e2e.db`. A single `publish-perf` collector job then
downloads every leg's db and merges each into the shared `docs/perf-data.json`
in turn (see `tests/e2e/metrics/publish-perf-pr.ts`'s module doc for why
merging leg-by-leg is safe without merging the dbs first), then re-renders
the unified README table, the inline headline markers, and the carbon
component's data copy once from the merged result.

- `provider` input: `hetzner` (default), `digitalocean`, or `all`, selecting which
  provider(s)' legs run.
- `scenarios` input: qualified `provider/mode` tokens (e.g.
  `hetzner/k8s-ha,digitalocean/compose`, the same `--scenario` grammar the CLI
  and runner use everywhere else), or empty (default) for the selected
  provider(s)' registry default lists.
- `regions` input → `E2E_REGIONS` (comma-separated Hetzner locations). Only
  meaningful on the Hetzner leg; harmlessly ignored on the DigitalOcean leg.
- Environment variables on `e2e-infra`: `E2E_DNS_PROVIDER=hetzner` pins
  scenarios to Hetzner DNS (no provider variance in the numbers, no
  Cloudflare credential needed: preflight skips the Cloudflare check when
  nothing uses it); `E2E_DOMAIN` optionally overrides the base domain so
  every scenario shares one zone (e.g. `carbonstack.dev`).
- Runs under `E2E_NAMESPACE=ci`, scoped to the `matrix` job only (the
  collector never provisions anything): `citest-*` resource names, DNS
  prefixes, and prefix-scoped preflight/sweep, so CI and local matrices can
  run concurrently without seeing each other.
- Artifacts per leg (green or red), named `e2e-results-<provider>`:
  `e2e.db` (+ `-wal`/`-shm` sidecars), that leg's own batch log, and
  `cli-logs/` (per-env deploy logs + failure diagnostics), with the job's
  literal secret values scrubbed before upload.
- On a run from `main`, the collector merges every leg's db into
  `docs/perf-data.json` in turn, re-renders every surface once, and opens
  ONE PR **if that actually changed any of the three files' bytes**.
  Nothing else is the gate. So a leg that fell short of full coverage can
  still open the PR on the strength of its inline headline markers alone
  (those refresh per green scenario+step, independent of the
  full-registry-coverage gate on a provider's table rows), and a fully
  green run whose numbers came out byte-identical to what's already
  committed opens no PR at all. A provider that fails entirely leaves its
  entry in `docs/perf-data.json` (and its rows in the table) unchanged,
  while a clean sibling provider's entry and rows still update. **Branch
  dispatches never publish numbers from unmerged code**: legs run on
  whatever ref was dispatched, but the collector's publish step checks
  `GITHUB_REF_NAME == 'main'` before ever touching git, independent of the
  leg results.

Requires the `e2e-infra` GitHub Environment (Hetzner API + S3 + Docker Hub
secrets always; DigitalOcean API + Spaces secrets only for a
`provider: digitalocean` or `provider: all` dispatch: the DigitalOcean leg
hard-aborts with a clear message if they're absent; Cloudflare only for
cloudflare-DNS dispatches). Hetzner runs target the dedicated
`vibecarbon-e2e` Hetzner project, which owns the `carbonstack.dev` zone.
Cost per full Hetzner leg: ~3h runner time + ~$1–2 Hetzner spend.

CI passes `--skip-steps setup-repo`: the throwaway GitHub repo only feeds the
CI-image build path, which no perf scenario uses; skipping it means no
repo-create/delete PAT lives in CI (the runner waives its gh-auth requirement
when setup-repo is skipped, and teardown-repo self-skips when no repo exists).

Note: with `E2E_DNS_PROVIDER=hetzner` the Hetzner HA scenarios exercise the
HA-failover-over-Hetzner-DNS path, which the local matrix (Cloudflare for HA)
does not: a failover failure there is a real product signal, not CI noise.

## When to add a test where

| Symptom | Tier | File |
|---|---|---|
| Pure function returns wrong value | unit | `tests/unit/<module>/<x>.test.ts` |
| CLI verb fails to dispatch / parse a flag | integration cli | `tests/integration/cli/<cmd>/matrix.test.ts` |
| Generated project doesn't lint/build | integration template | `tests/integration/template/lint-build.test.ts` |
| Docker service won't come up locally | integration docker | `tests/integration/docker/<x>.test.ts` |
| Real cloud deploy regresses (Hetzner or DigitalOcean) | e2e | `tests/e2e/scenarios/<x>.ts` |

## Failure classes and the guard decision procedure (escape analysis, 2026-07-30)

On 2026-07-29/30, ~20 real defects escaped this suite in a single day, with all four
tiers green. None of them were exotic; they clustered into six classes, and each class
is invisible to a tier-based strategy for a *structural* reason. This section is the
standing countermeasure: given a change, it tells you which guard class must accompany
it. Adding one test per bug is the floor, not the goal: the goal is that the *class*
can't ship again.

### The six classes

**1. Sibling-surface drift.** The same logical operation exists in N places
(compose vs k8s deploy, Hetzner vs DigitalOcean vs Cloudflare, a live-data branch vs
its offline fallback, the e2e runner vs `iter-step`, provider code vs the audit
script that polices it) and a fix lands on one. (Escapes: compose `createAdminUser`
warned-and-continued months after k8s failed loud; Hetzner list calls un-paginated
after DO's were fixed; Cloudflare DNS destroy leaked the wildcard while the Hetzner
branch *in the same function* deleted the pair; `iter-step` silently ran production
Let's Encrypt.) Tiers are blind because each surface's tests assert that surface
only; nothing forces the fixer to enumerate siblings.
*Countermeasure:* **the parity rule** (below), convergence on shared helpers, and the
convergence registry `tests/unit/lib/shared-helper-consumers.test.ts`. For provider
methods, `provider-contract.test.ts` runs one invariant suite over every registered
provider. Prefer extending it over writing a per-provider test. (Adding a whole
provider? Follow `docs/adding-a-provider.md`: registration trips the censuses that
walk you through the rest.)
*Known limit: this class is reduced, not closed.* The registry is file-level and
listed-consumer-only: it catches a **listed** consumer dropping its reference to the
shared helper (de-convergence), but NOT a **new** call site that re-implements the
operation somewhere else and never touches the helper: a fresh file re-inlining the
apex-only Cloudflare delete sails past both the registry and the helper's behavioral
tests (empirically confirmed in PR #214 review with a probe file). It also can't see
a re-inline *inside* a listed file that keeps the helper's name in a comment or
wrapper. The only net for new bypassing call sites is the parity rule applied at
review time; plus, where the operation has a greppable wire signature, a repo-wide
sweep like `list-endpoint-pagination-sweep.test.ts` (which is call-site-level and
does catch new bypasses; write one of those when the signature allows it).

**2. Truncated listings.** An un-paginated collection GET plus client-side filtering
doesn't return "fewer rows": it makes the unserved rows unmatchable, and the caller
reports "nothing found" with confidence. This shipped twice in one day (provider list
methods leaking six CSI volumes past a *green* run; the audit sweep printing "recheck
clean" over unread pages) and four more latent instances fell out of writing the
guard (both providers' `fetchServerTypes`, the e2e cost collector, the e2e run-sweep).
*Countermeasure:* one shared walker per provider idiom
(`src/lib/providers/hetzner-pagination.js`; DO's `links.pages.next` walk) and the
repo-wide tripwire `tests/unit/providers/list-endpoint-pagination-sweep.test.ts`:
any new collection GET must paginate, filter server-side (`?name=`), or carry a
documented exception there.

**3. Silent success: the thing reports healthy while its function is dead.** A
wrong-arch wal-g builds fine and Postgres comes up green with backups dead; `destroy`
printed "(all via Pulumi)" while Pulumi destroyed nothing; a registry push failure
fell back to sideload so quietly that warm redeploys just "got slow"; and
`pg_stat_archiver` is *structurally* blind here because `wal-archive.sh` deliberately
exits 0. Health checks assert liveness; nobody asserted *effect*.
*Countermeasure (rule):* **success must cite evidence.** A step that can degrade must
(a) mark the run summary degraded (never `warn`-and-continue on a deploy-critical
path) and (b) carry a unit test asserting the loud path (pattern:
`compose-admin-user-retry.test.ts`, `destroy-stack-partial-detection.test.ts`).
Binaries installed into images are *executed* in the same build layer
(`walg-dockerfile-arch.test.ts`). The last gap in this class (asserting a backup
object actually *lands* in S3) is now closed by the backup-evidence e2e check
below, which forces a WAL boundary and then reads the named segment back out of
the bucket.

**4. Declared-but-unexercised claims.** `engines.node >=20` shipped broken against an
EOL runtime; both ghcr images published `linux/arm64` for months without the arm64
image being executed once; new tests crashed on the project's own minimum Node.
*Countermeasure (rule):* **every support claim maps to a leg that executes it, or the
claim is deleted.** arm64 was resolved by deleting the claim (amd64-only,
`workflow-platforms.test.ts` pins it *two-way*); the deploy-tier axis is pinned by
`tests/unit/e2e/supported-tiers-scenario-coverage.test.ts` (every
`Provider.SUPPORTED_TIERS` entry has a runnable e2e scenario, and vice versa).
The `engines.node` floor is executed by `test.yml`'s **`engines-min`** job, which runs
unit + integration on exactly that version. It is needed because `.nvmrc` holds a bare
*major*: every other leg floats on the newest release of the line, so the floor the
package advertises was itself unexercised. The escape above ("new tests crashed on the
project's own minimum Node") is what that gap looks like. The leg is pinned two-way to
`engines.node` by `node-version-pins.test.ts` (raise the floor without moving the leg,
or move the leg off the floor, and unit tests fail), `pnpm node:sync` writes the literal
so a Node bump stays one command, and the job asserts `process.version` at runtime:
`setup-node` does not fail on a version it cannot resolve, it just leaves the runner's
default Node in place, which would make the leg a class-3 silent success.

**5. Unexercised interactive surfaces.** `scale`'s pickers offered ARM types in EU
regions because e2e pins server types via `capacityPreferences`: the path a customer
takes interactively is the path CI never renders.
*Countermeasure (rule):* prompt options must come from an **exported pure builder**,
unit-tested over the *full catalog* (not a hand-picked fixture), the pattern that now
guards ARM (`provider-contract.test.ts` sweeps every region × type through
`getServerTypesForRegion`/`resolveServerTypeForRegion`). A true prompt-walkthrough
harness is specced below.

**6. Unexercised state spaces: warm/resumed paths and generated-artifact hygiene.**
E2E almost always cold-deploys, so the `k3s-apply` step gate could skip changed
manifests on a state-resumed redeploy for months, and the `k3s-build` gate, blind to
the app source entirely, skipped the build (and therefore the sideload and the
rollout) on every warm redeploy, silently serving a stale image; and nothing modeled
"customer runs `git add -A`", so `upgrade`'s un-ignored sidecars would have been
committed (and the secret scanner only gates *tracked* content).
*Countermeasure:* step-gate inputs are unit-pinned (`k3s-apply-gate-inputs.test.ts`,
`k3s-build-gate-inputs.test.ts`, `bundle-digest.test.ts`); artifact hygiene is a
behavioral invariant: after a mutating CLI command, every file left in the project
is template-sourced or gitignored (`tests/integration/cli/upgrade/upgrade.test.ts`,
"stays clean"). Those gate pins are static, though: they assert an input is *in* the
digest, not that a changed input actually reaches a cluster. The behavioral half
(change something, redeploy against existing state, prove it is live) is the
`warm-redeploy-change` e2e step below, and it is what executes both gate fixes
(`k3s-apply`'s manifest digests and `k3s-build`'s source digest) end-to-end.

### The parity rule (applies to every bugfix)

> **If you fix a bug in one provider / tier / mode / branch / harness path, the PR
> must prove each sibling is either fixed or genuinely unaffected.**

Concretely, before the fix merges:

1. **Enumerate the siblings.** The recurring axes: `hetzner ↔ digitalocean ↔
   cloudflare`; `compose ↔ compose-ha ↔ k8s ↔ k8s-ha`; live-data branch ↔ offline
   fallback in the same function; `src/` code ↔ the script or e2e-harness copy that
   audits it (`scripts/sweep-hetzner.js`, `tests/e2e/**`); runner ↔ `iter-step`.
   Grep for the function name, the endpoint, and the user-visible string.
2. **For each sibling:** either the fix reaches it through a shared helper (preferred:
   then add/extend a row in `shared-helper-consumers.test.ts`), or it gets its own
   test, or the PR states *why* it is structurally unaffected.
3. **Prefer convergence over parallel fixes.** Two fixed copies drift again; one
   helper with a consumer registry doesn't.

### Decision procedure: which guard must accompany a change

| You are... | Required guard |
|---|---|
| Fixing any bug | Parity rule above: siblings enumerated in the PR |
| Adding/altering a cloud-API list call | Route through the pagination walker or `?name=`; the sweep test enforces |
| Adding a provider method or static | Extend `provider-contract.test.ts` (+ `EXPECTED` table), not a one-provider test |
| Declaring support (engine, platform, tier, region) | Name the CI leg / e2e scenario that executes the claim, or don't declare it |
| Adding a fallback / degraded path | Summary marks the run degraded + unit test asserts the loud path |
| Writing a new file into a user project | Pattern in `carbon/.gitignore` + `REQUIRED_IGNORES` (gitignore-invariants), or intended-tracked; the upgrade "stays clean" test enforces behaviorally |
| Adding a prompt/picker | Options from an exported pure builder, unit-tested over the full catalog |
| Adding a step gate / resumable state | Unit test pins that the gate digest covers every behavior-changing input |
| Converging siblings on a shared helper | Add the registry row in `shared-helper-consumers.test.ts` |
| Duplicating logic across sibling surfaces | Don't: converge, or write the parity argument in the PR |

Every structural guard added under this section must be **mutation-tested** before it
merges: break the invariant, watch the guard fail, restore. A guard that passes
vacuously is worse than none: it launders confidence.

### Expensive guards (spec + implementation status)

- **Backup-evidence e2e check**: **implemented 2026-08-05**
  (`tests/e2e/checks/backup-evidence.ts`, unit-covered by
  `tests/unit/e2e/backup-evidence.test.ts`). Runs inside `verify-deploy` and again
  inside `verify-scale`, in **every mode and on both providers**. The spec said
  "assert an object exists with a fresh timestamp"; what shipped is stronger and
  has no clock in it. **Provoke, then observe**: inside the db container it forces
  `txid_current()` (so an idle cluster cannot no-op the switch) then
  `pg_walfile_name(pg_switch_wal())`, which *names* the segment Postgres just
  handed to `archive_command`; the runner then LISTs the backup bucket for that
  exact key under `backups/<project>/walg/wal_005/`. A second assertion pins that
  nothing lives under a role-namespaced prefix (`…/walg/primary|standby/`), the
  split that makes a promoted standby read an empty folder. Bucket/region/endpoint
  come from the project's own `.vibecarbon.json` `backupS3` block and the client is
  the product's `getObjectStorageProvider`, so Hetzner Object Storage and DO Spaces
  share one code path; credentials resolve through `Provider.OBJECT_STORAGE_ENV`.
  Missing credentials against an env that *records* a bucket are a **failure, not a
  skip**: otherwise the guard would go vacuous exactly when it matters. ~30–60 s
  per hook point, no extra infra.
- **Warm-redeploy e2e step**: **implemented 2026-08-05** as its own
  `warm-redeploy-change` step (k8s only; covers `e3` and the DO twin `d3`).
  Deliberately NOT folded into `warm-deploy`: that step is a curated perf-table
  column measuring the **no-op** convergence path, and making it mutating would
  silently redefine a published number and move the anomaly-guard baselines.
  The step edits a bundled manifest (an additive key on the `vibecarbon-config`
  ConfigMap) **and** an app source file (an additive Hono route on the health
  router), re-invokes `deploy` against the existing state, then asserts the
  manifest change via `kubectl … -o jsonpath` and the app change via one HTTPS GET
  of the new route. Both mutators live in
  `tests/e2e/utils/warm-redeploy-mutations.ts`, are pure, and **throw** when their
  anchor is missing: a mutation that silently no-opped would leave the step
  "proving" that an unchanged file is live. k8s-ha is excluded: `reconverge-deploy`
  already state-resumes a deploy there. ~5–10 min added to e3.
- **Prompt-surface walkthrough harness.** Integration-tier PTY driver that runs
  `scale`/`deploy` interactively against stubbed catalog data and asserts on the
  *rendered* option lists (region-appropriate, no retired SKUs, ARM never offered).
  ~1–2 days to build the driver; each walkthrough ~2–5 s, no infra. Highest-value
  first target: `scale`'s type pickers, the exact surface of escape #5.
- **Node-engines CI leg**: **implemented 2026-07-31**, and cheap rather than expensive
  in the end (one extra runner, no infra): `test.yml`'s `engines-min` job. Described
  under class 4 above; this entry stays only to record that the owed item is discharged.

### Consciously not guarded

- **A blanket warn-and-continue sweep.** ~100 legitimate `log.warn` sites exist; an
  inventory test over all of them would rot and desensitize. The rule (fallbacks mark
  the summary degraded + loud-path unit test) is enforced at review via the decision
  table instead.
- **arm64 execution coverage.** Resolved by retiring the claim, not by testing it:
  amd64-only publishing is pinned two-way in `workflow-platforms.test.ts`, and the
  Dockerfiles' arch-correctness (which still matters for arm64 *local dev*) is pinned
  in `walg-dockerfile-arch.test.ts`.
- **DigitalOcean scenario cadence.** The tier ↔ scenario guard proves a runnable
  scenario *exists* per declared tier; it cannot prove anyone runs it. Cadence is
  process: run `--provider digitalocean` before a release that touched DO-relevant
  code.

## History

This 4-tier layout was consolidated from a prior 7-tier layout (unit / integration / smoke / e2e / perf / infrastructure / e2e).
