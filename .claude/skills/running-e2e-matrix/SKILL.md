---
name: running-e2e-matrix
description: Use when running vibecarbon's real-infra e2e tests (compose, compose-ha, k8s, k8s-ha; Hetzner or DigitalOcean), iterating on a failing scenario, or diagnosing a deploy/verify/scale/restore/failover failure. Keywords — pnpm test:e2e:batch, test:e2e, REAL_INFRA, --scenario, --provider, --keep, iter-step, E2E_RETRY_FLAKES, vibecarbon deploy failure, "transient" Hetzner error.
---

# Running the Vibecarbon E2E Matrix

The e2e matrix is the only test suite that provisions real Hetzner infrastructure end-to-end. It runs the full deploy → verify → scale → backup → destroy → restore → (failover) → final-destroy lifecycle for each scenario. A full matrix is ~3 hr; a single scenario is ~30–60 min.

## Pick the right command

| Goal | Command | Time |
|---|---|---|
| **Iterate on one failing scenario** (default for debugging) | `pnpm test:e2e:batch -- --scenario hetzner/<mode>` | 30–60 min |
| Iterate on the failing step against a kept rig | `pnpm test:e2e:batch -- --scenario hetzner/<mode> --skip-steps <step> --keep` then `node scripts/iter-step.js hetzner/<mode> <step>` | step-only (1–10 min) |
| Confidence check before merging | `pnpm test:e2e:batch` (bare invocation = the Hetzner four, serial) | ~3 hr wall-clock |
| Drop already-green scenarios | `pnpm test:e2e:batch -- --except hetzner/compose,hetzner/k8s` | matrix minus the named ones |
| Skip slow steps you don't need | `pnpm test:e2e:batch -- --scenario hetzner/k8s-ha --minimal` (skips scale/backup/destroy/restore) | ~25 min |
| Run DigitalOcean's default scenarios (opt-in, never in the bare matrix) | `pnpm test:e2e:batch -- --provider digitalocean` — requires `DIGITALOCEAN_API_TOKEN`, `DIGITALOCEAN_ACCESS_KEY`, `DIGITALOCEAN_SECRET_KEY` | 30–60 min |
| Run every provider's default scenarios | `pnpm test:e2e:batch -- --provider all` | ~3 hr + DO scenarios |

Scenario tokens are always `provider/mode` (e.g. `hetzner/k8s-ha`, `digitalocean/compose`), with an optional `-dnsProvider` refinement for disambiguation (`hetzner/k8s-ha-cloudflare`). Bare mode tokens (`k8s-ha`) and the old opt-in `d1`/`d2`/`d3` tokens are not accepted — an invalid token throws with the valid forms named. **Bare invocation (no `--scenario`/`--provider`) = the Hetzner four** (`compose`, `compose-ha`, `k8s`, `k8s-ha` — the release-gating provider's defaults); `--provider digitalocean` runs DO's four (d1–d4; `digitalocean/k8s-ha` is d4, the DO pilot-light standby + failover scenario since 2026-08-27). See `tests/e2e/selection.ts` for the full grammar.

## Serial execution

- **The matrix runs SERIALLY** — one full deploy→…→destroy lifecycle at a time. Each scenario gets a unique env prefix (e1=compose, e2=compose-ha, e3=k8s, e4=k8s-ha) and a tee'd `[mode]`-prefixed log.
- **Parallel execution is not supported.** It was prototyped (a deploy-gate + fixed schedule that serialized cold deploys/restore re-deploys) and validated on real infra, but pulled 2026-06-01: driving all four scenarios from one operator host manufactured failures no customer sees — Pulumi-on-S3 `503` throttles, local-host saturation that starved the `frontend_render` browser check, and fresh-cluster cert-manager lag under concurrent provisions. It only sped up the (infrequent, unattended) full matrix while making it flakier, so the cost/benefit didn't hold. The robustness hardening it produced was KEPT because it helps serial too: `withStateBackendRetry` (S3 503 retry) in `src/lib/iac/index.js`, `frontend_render` hydration polling in `tests/e2e/checks/frontend-smoke.ts`, and the cert-manager budgeted readiness poll in `src/lib/deploy/k8s/k3s.js`.
- **Interactive mode** (no `--batch`) pauses after each step.

## Required environment

- `REAL_INFRA=true` — already set by every `test:e2e*` script. Required if invoking the runner directly.
- Credentials are registry-driven (`tests/config.ts` `e2e.providers[provider].requiredEnv`) — the runner unions the requirements of every selected scenario's provider and aborts loudly naming exactly what's missing, pointing at `tests/.env.e2e`. Read from `process.env` (a shell export, CI's GitHub Environment secrets, or `tests/.env.e2e` — copy `tests/.env.e2e.example`).
  - `HETZNER_API_TOKEN` — required for every Hetzner scenario (the default matrix).
  - `DIGITALOCEAN_API_TOKEN` / `DIGITALOCEAN_ACCESS_KEY` / `DIGITALOCEAN_SECRET_KEY` — required for DigitalOcean scenarios (`--provider digitalocean`).
- `CLOUDFLARE_API_TOKEN` — required only for scenarios on Cloudflare DNS (HA modes, and every DigitalOcean scenario). Checked separately — Cloudflare is a DNS provider, not a cloud provider in the registry.
- `E2E_PREFLIGHT=skip` — bypass the 30-second infra preflight ping. Use when re-running after a known-good fix.
- `E2E_RETRY_FLAKES=1` — opt-in single retry on `failureCategory=infra` failures. Doubles wall-clock worst case; only enable when chasing a flake hypothesis.
- `VC_KEEP_ON_FAILURE=1` (or `--keep-on-fail`) — preserves repo + cluster on failure so you can iterate.
- `VC_KEEP_ALWAYS=1` (or `--keep`) — never tear down. Pairs with `iter-step.js` for the kept-rig pattern.

## The kept-rig iteration loop (Pattern 2)

When one specific step fails repeatedly (e.g. `failover`, `restore`, `verify-deploy`):

```bash
# 1. Stand up infra once, skipping the failing step. Writes
#    tests/results/.rig-<provider>-<mode>.json with project dir + env prefix.
pnpm test:e2e:batch -- --scenario hetzner/k8s-ha --skip-steps failover,verify-failover --keep

# 2. Iterate the failing step against the surviving rig (each call ~1–10 min).
node scripts/iter-step.js hetzner/k8s-ha failover

# 3. When green, tear it down.
node scripts/iter-step.js hetzner/k8s-ha destroy
```

`iter-step.js` takes a **qualified** scenario token (`provider/mode`, the same identity `--scenario` uses) — a bare mode is rejected rather than guessed at, since both providers can keep a rig of the same mode at once. Valid steps: `deploy | failover | scale | backup | restore | destroy | status | diagnose`.

## Live-monitoring long runs

Long runs (20+ min) need proactive check-ins, not silent waits.

- For each running scenario, schedule **4 ScheduleWakeup checkpoints** evenly spaced across its expected duration (k8s-ha ~55 min, compose-ha ~50 min, k8s ~40 min, compose ~35 min). At each wake-up, tail every in-flight log and report stage + any failures.
- Per-scenario runner logs: `<tempDir>/<provider>-<mode>-<dnsProvider>.log` where `<tempDir>` = `$TMPDIR/vibecarbon-e2e-<runId>`.
- Per-deploy CLI logs (the deploy CLI's own tee): `~/.vibecarbon/logs/<env>-<ts>.log`. These survive the run and are the first thing to read when a deploy/restore/failover step fails.
- Per-step results land in `tests/results/e2e.db` (SQLite). `pnpm test:e2e:report` shows trends across runs.
- ScheduleWakeup only queues one wake-up at a time — re-schedule the next one when each fires. Stop when all monitored scenarios reach a terminal status.

## Resolving bugs and "transient" failures

This is the discipline that makes the matrix stabilize.

1. **Iterate on the single failing scenario, not the full matrix.** Save the full matrix for end-of-cycle confidence checks. (Past pattern: 11 PRs in a row chased the same root cause via 3-hr matrix runs.)
2. **Distinguish "more observability" from "real fix".** Adding diagnostics to a failing step does NOT fix the deploy. Read existing logs first (`<tempDir>/<provider>-<mode>-<dnsProvider>.log` and `~/.vibecarbon/logs/<env>-<ts>.log`) to see if the diagnostics already point at root cause before adding more.
3. **Every "transient" / "flaky" / "Hetzner-side" error gets RCA.** Pull the actual deploy log, identify the precise failure (last successful op, last log line, hung subprocess), and ask: is anything in our code able to prevent or recover from this (timeout, retry, pre-init, idempotent cleanup)? If yes, ship the fix. Only after exhausting "is anything in our code wrong?" can you label it as truly external — and even then, document with citations (Hetzner status page, vendor docs).
4. **Never propose e2e shortcuts customers can't reuse.** Snapshot baselines, pre-baked images, registry caches scoped to the test rig — all rejected. E2E must reproduce the customer cold-start path or it stops catching production regressions.
5. **Own everything.** No "not ours / pre-existing" framing. Dirty files, lint errors, failing siblings — investigate and address or flag, don't wave them off.
6. **THE FAMILY SWEEP IS PART OF THE FIX — a fix is not done until its class is done.** The 2026-08-06/07 campaign proved this twice over: three independent "retry pattern missed the backend's actual wording" bugs, two "hand-rolled compose `-f` list drifts from reconcile's set" bugs, and a "validation gate with no recovery" that had three unfixed siblings at the moment its first member was patched. Every prior audit found the same thing: *every* fix whose commit said "Nth member of this family" still had surviving members. So, for every e2e RCA:
   1. **Name the class**, not just the instance ("transient-classifier wording gap at the wal-g fetch", not "wal-g retry bug").
   2. **Enumerate the family before calling the fix done** — grep for the mechanism (every classifier regex, every `-f` list, every consumer of the same output/step shape), and either fix each member or record it by file:line in the task ledger with a reason.
   3. **Ship an enumerable invariant with the fix** — a census/source-shape/structural test that walks the code and asserts the property on EVERY member (see `up-stack-stale-frontend.test.ts`'s requiredOutputs census, `compose-network-ip-partition.test.ts`'s pin scan, `compose-ha-overlay-up-flags.test.ts`'s sed-vs-renderer lockstep). A census drafts future members into the audited set automatically — that, not discipline, is what makes the sweep permanent. Prefer walks over hand-listed files, and behavioral assertions over source-text regex when the property is behavioral (a source regex passed for months against dead code once).
   4. **Update the class's memory file** (e.g. the Hetzner-staleness spellings ledger) so the next session inherits the map.

## Known failure-signature shifts

- Since B0-1 (2026-07-21) the compose-ha WG cloud-firewall opener is non-fatal: a broken cloud-firewall API call no longer aborts the deploy at `deploy.ha.compose.setupFan` — the deploy completes with a `p.log.warn` about UDP 51821 and fails later at replication verify (`assertReplicationStreamingOrDegraded`). If compose-ha dies at replication verify, grep the deploy log for that warning before digging into the replication stack itself.
- `Command array must contain only strings` (command.js:54) mid-run, in a step whose code passed earlier in the SAME run (observed 2026-07-24, restore re-deploy): the signature of source files being EDITED in the worktree hosting the live run — the deploy CLI child re-imports the tree on every step. Never let any agent/fix-wave mutate src/ in a worktree with a run in flight; quiesce the run or use a second worktree. Adjudicate by re-running on a quiescent tree before treating it as a code bug.
- `pulumi up --stack eN` → `error: no stack named 'eN' found` right after "Pulumi state bucket created" (observed 2026-07-23): the signature of TWO concurrent runners on the same env prefix. A killed/stopped harness background task can leave its `tsx tests/e2e/runner.ts` child alive and invisible to a `ps` grep for `test:e2e` (the colon doesn't match `tests/e2e`); the zombie and the relaunch then clobber each other's `~/.pulumi` workspace metadata for the shared stack name, so one run's `up` reads the other's backend. Before ANY (re)launch, sweep processes with the WIDE pattern `ps aux | grep -E "tsx|runner\.ts|test:e2e|iter-step|testapp"` and after any killed run assume an orphaned child until that grep proves otherwise. Cleanup: `scripts/sweep-hetzner.js` (env-only — feed `HETZNER_API_TOKEN` via command substitution from the profile-aware loader, never echo it).

- Standby db pod wedged `Init` with kubelet looping `MountVolume.MountDevice failed ... mkfs.ext4 ... does not exist and no size was specified` (DO only): the DO-CSI stale-VolumeAttachment class — k8s says attached, DO's API says attached to nothing (`droplet_ids: []`). The reseed's detach-settle + signature-gated repair (replication.js) handle it; if seen OUTSIDE the reseed, delete the VolumeAttachments referencing the db PVs (a pod bounce does NOT heal it) and expect Ready ~150s later. Mitigations.yml: `do-csi-stale-volumeattachment`.
- `expected non-nil error with nil state during Create of ... ReservedIp` on DO (runner-classified `[infra]`): TF-bridge transient; the create usually SUCCEEDED at DO, orphaning an unassigned reserved IP no backstop can attribute — check `/v2/reserved_ips` by hand after the failure. `E2E_RETRY_FLAKES=1` is the sanctioned lever; observed as a bounded window (two consecutive hits 2026-08-28 ~19:0xZ, gone an hour later).
- `ssl_valid` FAILING with "certificate not trusted ... Served: subject=TRAEFIK DEFAULT CERT" (since 2026-08-28): this is the STRICT check working, not a harness bug — an untrusted cert at a verify step is a real product defect (before this, verify-failover passed twice on exactly that). A standby-role cluster serving the `vibecarbon-standby-selfsigned` cert when probed DIRECTLY is by design; the DOMAIN must always serve a trusted chain.

## Common red flags

- Re-running the full matrix to "see if it's still broken" — wastes 3 hr. Run the single scenario.
- Labeling a step failure "Hetzner being weird" without reading the diagnostic file — that's the move that lets real bugs hide in the noise floor.
- Adding logging-only PRs and calling the failing scenario "fixed" — it isn't until the scenario goes green.
- Forgetting to `--keep` before iterating — each new run re-provisions the rig (~25 min wasted per cycle).
- Skipping preflight when you should run it — the 30-second ping has caught Hetzner-wide outages before they burned an hour of provisioning.

## Quick reference

```bash
# Full matrix, serial (merge-gating confidence check; bare = the Hetzner four)
pnpm test:e2e:batch

# Single scenario
pnpm test:e2e:batch -- --scenario hetzner/k8s-ha

# Single scenario, keep infra on any outcome, iterate the failing step
pnpm test:e2e:batch -- --scenario hetzner/k8s-ha --skip-steps failover --keep
node scripts/iter-step.js hetzner/k8s-ha failover
node scripts/iter-step.js hetzner/k8s-ha destroy

# Skip already-green scenarios
pnpm test:e2e:batch -- --except hetzner/compose,hetzner/k8s

# Trim k8s-ha to deploy + verify + failover only (~25 min)
pnpm test:e2e:batch -- --scenario hetzner/k8s-ha --minimal

# Override features
pnpm test:e2e:batch -- --scenario hetzner/k8s --features=redis,n8n
pnpm test:e2e:batch -- --scenario hetzner/k8s --features=               # zero features

# DigitalOcean's default scenarios (opt-in), or every provider's
pnpm test:e2e:batch -- --provider digitalocean
pnpm test:e2e:batch -- --provider all

# Inspect results
pnpm test:e2e:report
sqlite3 tests/results/e2e.db
```
