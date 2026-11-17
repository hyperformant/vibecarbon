# Plan: remove duplicated code and the drift it caused

Status: proposed on 2026-11-17, not started. This is a working document: when
the work ships, its decisions go into `docs/history.md` and this file is
deleted.

## Goal

Remove code that is written more than once where one copy is simpler, without
changing behaviour, and fix the places where copies have already drifted apart.
Add checks so new duplication and unused code are caught on the pull request.

## How this was analysed

A line-window clone finder measured every area, then five read-only analysts
read the code behind the numbers, one area each. Twelve of their bug claims
were re-checked against the source by hand; those are marked "checked" below.
Everything else is as reported and gets re-verified by whoever picks up the
item. No test suite was run for the analysis.

| Area | Code lines | In repeated blocks (same shape) | Judged shareable |
|---|---|---|---|
| `src` per-provider code | part of 58,977 | part of 6,470 | 700 to 850 |
| `src` commands, deploy, helpers | part of 58,977 | part of 6,470 | 550 to 700 |
| `tests/e2e`, `scripts`, workflows | 18,826 | 1,716 | 1,500 to 1,700 |
| `carbon` template, `services` | 43,588 | 4,498 | about 2,000 |
| `tests/unit`, `tests/integration` | 176,406 | 21,065 | 4,200 to 4,700, plus up to 5,500 of mirror tests |

The "same shape" figure is an upper bound: it also matches tables, flag
declarations and instruction text. Most of what it flagged in `src` commands is
not duplication (`config-registry.js`, each command's `SPEC`, `configure.js`
setup notes).

## Rules for every change

- One cluster per pull request, behaviour unchanged, on a branch in the main
  checkout. A worktree only when two streams edit at the same time.
- Where copies differ, the difference is either kept through a parameter or
  fixed on purpose in its own commit that says so. Never silently unified.
- No new retry, wait or polling. A shared helper has to be simpler than the
  copies it replaces.
- A test that pins the old source text is repointed in the same pull request,
  and a census keeps seeing every call site it saw before.
- A refactor of code with no test gets a characterization test first, merged
  before the refactor.
- A structural guard is mutation-checked before merge: break the product line
  it guards and watch it fail.

## Order of work

### Phase 0: unblock and add the fast checks

1. Merge #522 to #525 once a patched `picomatch` exists (refresh
   `carbon/package-lock.json` first). #524 has to land before any sweep work.
2. Add the pull request gates to this repo, config checked in here:
   - **jscpd** (`pnpm dupes`): clone detection. Start with the threshold at
     today's measured level so it only fails on new duplication, and lower it
     as clusters are removed. Ignore list: the mirrored hooks, the mirrored
     secret-scan rules, vendored `components/ui`, protos, data tables.
   - **knip** (`pnpm unused`): unused files, exports and dependencies, for the
     CLI and for `carbon/`.
   - **shellcheck** on `.claude/hooks`, `carbon/.claude/hooks`,
     `carbon/cloud-init`, `carbon/backup`.
   - **actionlint** on `.github/workflows` and `carbon/.github/workflows`.
   - **hadolint** on the four Dockerfiles.
   Each first run will report existing findings. Fix or baseline them in the
   same pull request so the gate starts green.
3. Re-run the measurement with jscpd and replace the numbers above.

### Phase 1: fix the drift that is already a bug

Each is a behaviour change and gets its own pull request and test.

**Leak detection in the e2e harness (these cost money when wrong)**

| # | Bug | Where | State |
|---|---|---|---|
| 1 | A listing that hits the 20-page limit is reported as complete, so leftovers past it go unseen | `sweep-digitalocean.ts:256`, `sweep-linode.ts:280`, `sweep-vultr.ts:292`; also Linode bucket and reserved-IP loops, DO reserved-IP loop | checked (DO) |
| 2 | The Hetzner sweep ignores the result of every delete and counts the resource as swept | `sweep-hetzner.ts` volumes, placement groups, firewalls, ssh keys, floating IPs, networks | checked (volumes) |
| 3 | `scripts/sweep-hetzner.js` prints "clean" when its bucket listing or a bucket delete failed | bucket pass, `canSkipRecheck` | partly checked |
| 4 | An unreadable load-balancer list never marks a sweep incomplete; same for networks on three providers | all four non-Hetzner sweeps | reported |
| 5 | The Vultr banner leaves reserved IPs out of its total | `sweep-vultr.ts:488-505` | checked |
| 6 | CSI volume prefix is `pvc-` on two providers and `pvc` on three | sweeps | reported |
| 7 | Preflight "project clean" reads one page only on all five providers | `tests/e2e/utils/preflight.ts` | reported |
| 8 | The Hetzner sweep has no short-project-name guard; the other four refuse under 4 characters | `sweep-hetzner.ts` | reported |
| 9 | `e2e-us-perf.yml` installs Pulumi unpinned; `test.yml` pins it | workflows | reported |

**CLI**

| # | Bug | Where | State |
|---|---|---|---|
| 10 | `diagnose` on k8s checks host keys against the operator's own `~/.ssh/known_hosts`, not the per-environment file | `src/diagnose.js:240-251`, `563-575` | checked |
| 11 | A non-JSON error body raises a SyntaxError instead of the intended message | `deleteServer`, `createSSHKey` in `hetzner.js` and `digitalocean.js`; `renameServer` in `digitalocean.js` | reported |
| 12 | `getServer` drops the HTTP status on Vultr and Scaleway (latent: read only on k8s paths) | `vultr.js:690`, `scaleway.js:1253` | reported |
| 13 | Hetzner `createSSHKey` pages by hand without checking the response | `hetzner.js:1261` | reported |
| 14 | `deleteFirewallByName` reports a refused delete with no error; `deleteNetworkByName` reports status and body | four providers | reported |
| 15 | `ha/index.js` builds remote kubectl commands as unescaped strings, against its own stated rule | five sites | reported |
| 16 | `destroy.js:1609` falls back to region `fsn1` for any provider | reachability unknown | reported |
| 17 | The compose HA replication read does not validate the state it reads, where the k8s reader does | `effects/compose-ha.js:1445` | reported |

**Template (ships to customers)**

| # | Bug | Where | State |
|---|---|---|---|
| 18 | Deleting an account cancels subscriptions through Stripe only; Paddle and Polar subscriptions keep billing | `routes/v1/index.ts`, `DELETE /api/v1/me` | checked |
| 19 | "Save Changes" on the organisation page only closes edit mode; the name is never saved | `pages/organizations/Details.tsx:127-133` | checked |
| 20 | Three admin pages show "none yet" when the request failed | `admin/Newsletter.tsx`, `Jobs.tsx`, `ContactSubmissions.tsx` | checked (Newsletter) |
| 21 | Malformed JSON to the theme route returns 500; every other route returns 400 | `routes/v1/theme.ts:101` | reported |
| 22 | The same request is cached under two keys, and two query keys are each shared by fetchers that fail differently | `Billing.tsx` and `useSubscription`; `['services-status']`; `['admin','stats']` | reported |
| 23 | Contact email: `escapeHtml` misses `'` and is applied to the Subject header | `routes/v1/contact.ts:65-73` | reported |
| 24 | `/admin/organizations` has no stable ordering, and none at all for `sortBy=email` | `routes/v1/index.ts:852-860` | reported |
| 25 | The billing page names Stripe variables whatever the provider | `Billing.tsx:172-181` | reported |
| 26 | `npm run k8s:apply` defaults to an overlay that does not exist | `scripts/k8s-apply.js`, `k8s-delete.js` | reported |
| 27 | Initials are blank for a whitespace-only name in two copies of `getUserInitials` | `admin/Users.tsx`, `organizations/Members.tsx` | reported |
| 28 | Two login error banners lack `role="alert"` | `Login.tsx:218`, `251` | reported |

**Test gaps found on the way**

| # | Gap | State |
|---|---|---|
| 29 | Ten files in `tests/unit/template` (5,498 lines) import no product code and test a copy written inside the test; one has drifted from the real code | checked (five files import only vitest or zod) |
| 30 | `update` is missing from the global "refuses outside a project" table | checked |
| 31 | 13 integration tests named "accepted by parser" pass on any crash that is not "unknown flag" | reported |
| 32 | `console.test.ts` passes on any non-zero exit | reported |
| 33 | No guided-setup credential tests for Linode or Scaleway; no IaC dispatch test for three providers | reported |

### Phase 2: characterization tests that the refactors need

Merged before the refactor they protect, and left unchanged by it.

- Sweeps: reserved-IP passes on DO, Linode and Vultr; load-balancer passes on
  Linode, Vultr and Scaleway; Scaleway private-network delete; every Hetzner
  compute pass (today only its buckets are tested).
- Preflight: the five project-clean checks with a stubbed `fetch` (match,
  non-match, HTTP 500, throw).
- `scripts/sweep-hetzner.js` bucket pass, with a fake store.
- Page walkers per dialect: multi-page, a failed middle page, guard exhaustion.

### Phase 3: share the copies

Net lines are estimates. "Proof" is what has to pass beyond lint and unit.

**3a. Per-provider code in `src` (700 to 850 lines)**

| Cluster | Lines | Proof and notes |
|---|---|---|
| DNS `setupSimple` and `setupHA` in five backends | 230 | Each backend keeps a thin wrapper and its own `HA_TTL` (pinned per file). Keep Hetzner's missing `record` and Linode's start order |
| Catalog methods identical in four of five provider classes | 95 | Move to the base as #512 did; `base.test.ts` and the abstract-surface count change |
| Server delete and wait-until-gone, four providers | 80 | Keep both transports and each poll budget |
| Bare authenticated request and "delete, 404 is gone" | 70 | Widen the pagination sweep's regex in the same change. Do not fold into `apiRequest`: the direct calls omit a header on purpose |
| Tag label helpers, four copies | 60 | Re-export from each provider so importers do not change |
| Guided-setup `getApiToken` and `getS3Credentials` bodies | 95 | Reverses where #512 chose to stop; move the prompt-guard mutation probes |
| DNS record read and delete helpers | 85 | Leave `deleteApexAndWildcard` (Scaleway is sequential on purpose) |
| `waitForServer` loop | 55 | Linode keeps its override |
| IaC program preamble and output mapping, eight programs | 60 | Leave firewall rule text: it would replace live firewalls |
| Delete-by-name result shape, lazy-import statics, `getServerSummary`, key normalise, catalog tail, app-key revoke, ASCII map, `listServers` | 250 | Small, one pull request each or grouped by file |

**3b. Commands and deploy in `src` (550 to 700 lines)**

| Cluster | Lines | Proof and notes |
|---|---|---|
| Database-pod exec argv, about 30 copies | 150 | Export the existing private builder. Keep each site's psql flags and timeout; do not switch pod lookup to the constant |
| `diagnose.js` kubectl probes and ssh args | 130 | Emitted argv byte-identical |
| `scale.js` and `orchestrator.js` kubectl arrays | 90 | File-local helper |
| Lockfile generation in `create.js` versus `ensureLockfile` | 40 | Keep the spinner repaint |
| Readers in `replication.js` that re-implement its own psql runner | 35 | |
| State `s3Config` pick (5), tier psql runner (4), backup job diagnostics (2), `gh run list` (3), destroy server sweep (2) | 110 | |
| Small: Pulumi refresh wrapper, ACME arm and disarm, autoscaler Secret YAML, first-error-line, dev script runner, operator-IP wrappers, shell and diagnose preamble, `knownHostsPath`, entry-point guard | 110 | |

**3c. E2E harness and scripts (1,500 to 1,700 lines)**

| Cluster | Lines | Proof and notes |
|---|---|---|
| Sweep shared helpers: bucket loop, banner, preamble | 250 | After #524. No real-infra run |
| Sweep per-class skeleton for the four non-Hetzner providers | 250 | After Phase 2. One compose run per provider, or one seeded kept rig swept by hand. Each file keeps its name, pass order and protected set |
| Preflight per-provider checks as a table | 260 | After Phase 2 |
| Provider page walkers in sweeps, `server-types.ts`, `residue-audit.ts` | 170 | Keep the audit's "throw on a chain that does not end" |
| `scripts/sweep-hetzner.js` bucket emptier replaced by the product method | 100 | |
| SSH exec wrappers in checks | 80 | pilot-light keeps its retry without the latch |
| Local image build and remove scripts | 75 | Run the four pnpm scripts once |
| Lifecycle `runDeploy` calls and ANSI strip | 55 | Rewrite the test that pins six call sites |
| Sweep CI entry points and workflow steps | 75 | After the sweep work. One workflow dispatch per provider |
| `.env.e2e` merge, scratch prefix, repeated constants | 25 | |

**3d. Template (about 2,000 lines)**

| Cluster | Lines | Proof and notes |
|---|---|---|
| k3s cloud-init: the db-node script is the worker script plus three flags | 450 | Needs decision D2. Rendered output byte-equal apart from comments; 27 unit files name these scripts |
| `src/shared/types.ts`, 406 lines nothing imports | 350 to 400 | Needs decision D1 |
| Sidebar nav items and back button | 215 | Keep each label, tooltip and literal string |
| Server JSON body validation, 15 copies | 130 | Route tests assert the 400 bodies |
| `Blog.tsx` and `Changelog.tsx` | 115 | |
| Landing sections: visual frame, floating logo, glow tracker | 125 | |
| Admin Organizations and Users: sort header, pagination, list state | 90 | Leave the table bodies |
| Client fetch code that re-implements `apiJson`; services-status and stats hooks | 95 | Changes the non-JSON error edge; fixes bug 22 |
| `k8s-apply.js` and `k8s-delete.js` | 65 | Needs decision D4 |
| Settings toggles, auth page shell, SEO generators, `Billing.tsx`, billing provider helpers, redundant 401 check, `KpiCard`, list handlers, initials, `escapeHtml`, test setup | 430 | |

**3e. Unit and integration tests (4,200 to 4,700 lines, plus up to 5,500)**

| Cluster | Lines | Proof and notes |
|---|---|---|
| Template mirror tests (bug 29): map each case to `carbon/tests`, port what is missing, delete the mirrors | up to 5,498 | Needs decision D3. Mutate the real template line and watch the ported test fail |
| Deploy wizard and `executeDeployment` harness, 16 files | 450 to 550 | One file at a time; small builders, bespoke mocks stay inline |
| Compose scale cutover harness, 16 files | 400 to 450 | Finish adopting the helper that already exists; diff recorded events before and after |
| `@clack/prompts` fakes, 88 files | 250 (rest counted above) | Keep fakes narrow so an unexpected prompt still fails |
| Provider API fetch harness, 49 files | 250 | |
| Repo root and source reader, 219 files | 300 | Mechanical; fixes 60 files that depend on the working directory |
| Temp directory setup, 166 files | 400 to 600 | |
| Pulumi workspace stubs, docker shell helpers, `hasPulumi`, AST walk, metrics seeding, destroy provider proxy | 740 | |
| Redundant tests proven by comparison: three snapshot files, 16 "refuses outside a project" copies, four DNS spinner literals | 325 | Fix gap 30 first |
| Per-provider merges into one table test: guided setup, IaC dispatch, sweep shared cases, plan purity, `prints help` | 660 | Adds the missing providers (gap 33) |

Every new shared test helper gets a row in the helper registry test.

## What stays as it is

- The compose and k8s failover flows: the disaster-recovery path, provable only
  on real servers.
- The two SSH runners: one returns false, one throws, on purpose.
- Direct `fetchWithRetry` calls versus `apiRequest`: the header difference is
  deliberate.
- Hooks and secret-scan rules mirrored into `carbon/`: held in step by tests.
- Hetzner's compute sweep, until it has tests.
- Per-backend `HA_TTL`, `deleteApexAndWildcard`, DNS page walks.
- Vendored `components/ui`, Launch UI sections, data tables, the OpenAPI
  literal, compose overlays, per-add-on twins under `services/`.
- Workflow setup steps and secret env blocks.
- DNS backend behaviour tests: sharing them needs one large configurable fake.

## Decisions needed before the affected items start

| # | Decision | Recommendation |
|---|---|---|
| D1 | `carbon/src/shared/types.ts`: delete, or replace with the API types the client and server really share | Delete, and update the line in `carbon/AGENTS.md` that points at it |
| D2 | Should database nodes get the host reporter that worker nodes get from cloud-init | Find out whether the CLI installs it over SSH first; share the script either way |
| D3 | Port the template mirror tests into `carbon/tests` and delete the mirrors | Yes |
| D4 | `k8s-apply.js` and `k8s-delete.js`: fix or remove | Remove; they cannot work today |
| D5 | Fix the template bugs (18 to 28) even though they change behaviour in generated projects | Yes, each in its own pull request with a changelog line |
| D6 | Budget for real-server proof: four compose runs for the sweep skeleton | Yes, after the unit proof |
| D7 | Unescaped kubectl strings in `ha/index.js` (bug 15, 50 lines): route through `sshKubectl` | Defer; it needs a k8s-ha run and touches a registered retry class |

## Size and sequencing

About 9,000 to 10,000 lines removed, plus up to 5,500 of mirror tests, across
roughly 60 to 70 small pull requests. Phases 0 to 2 are serial. In Phase 3 the
five areas touch different files and can run in parallel, one agent per area,
with these orderings inside an area: #524 before any sweep change; the sweep
helpers before the sweep skeleton before the CI entry points; the fetch and
clack test helpers before the per-provider test merges.

Not covered by the analysis and worth a second look once jscpd is in:
`carbon/k8s`, `src/status.js`, the compose and k8s paths inside `src/scale.js`,
`destroyK8sTier`, `tests/e2e/metrics`, and about 25 `tests/unit` directories
that were measured but not opened.
