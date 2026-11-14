# Cleanup in the Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop test runs, destroys, tests and merged work from leaving things behind, and catch whatever still slips through, so a manual cleanup like the one on 2026-11-13 is never needed again.

**Architecture:** Four PRs, merged in order. (A) the e2e runner reaps what earlier runs left on this machine when it starts, and every sweep removes Pulumi stacks whose recorded resources all read 404. (B) two Claude Code hooks keep local main current and remove merged worktrees and branches; they ship in this repo and in the `carbon/` template, so every vibecarbon project gets them. (C) destroy deletes the `.json.bak` Pulumi leaves on stack removal, and the test suite stops writing into the real `~/.pulumi`. (D) a weekly read-only GitHub workflow reports any test residue on every provider.

**Tech Stack:** Node 24 / TypeScript (tsx, vitest), bash hooks (must run on macOS bash 3.2), Pulumi automation API, AWS SDK v3 S3 client, GitHub Actions.

**Spec:** this plan's Design section (agreed with Brandon in session, 2026-11-13: "yes, do all of them in that order. The claude hooks in particular should also be included in vibecarbon created projects so our users benefit from our workflow enhancements.")

## Design (the spec)

What the 2026-11-13 cleanup found, and where each fix belongs:

| Leftover | Why it stranded | Fix (PR) |
|---|---|---|
| e2e Docker images and volumes, `/tmp/vibecarbon-e2e-*` | `reapLocalBuildArtifacts` runs at the end of a run; killed runs and kept rigs never reach it | A: reap earlier runs' leftovers at runner start |
| 5 abandoned CI Pulumi stacks and 2 locks | sweeps delete cloud resources, never state | A: every sweep removes stacks whose recorded resources all read 404 by id |
| 653 orphan `.json.bak` files | Pulumi writes one on every stack removal; nothing deletes it (customers' buckets too) | C: destroy deletes it |
| 8,762 files in `~/.pulumi/workspaces` | iac integration tests run Pulumi with the real `PULUMI_HOME` | C: every test file gets its own temp `PULUMI_HOME` |
| 5 worktrees, 24 local branches | nothing removes them after a PR merges | B: hooks, shipped in the template |
| anything not thought of yet | a green sweep proves no servers, not no residue | D: weekly read-only audit |

Rules that hold across all four:
- A deletion needs proof, read just before it: a stack goes only when every resource it records reads 404 at its provider; a worktree goes only when its PR merged at the same commit (or its commit is in the default branch), it is clean, and nothing is working in it.
- Cleanup never fails the thing it cleans up after: warnings, not errors (except the audit, whose job is to fail).
- Things that are not ours are never listed or touched: the audit prints only test-shaped names and fixtures (the repo is public).

## Global Constraints

- Commit types: PR A `test(e2e)`, PR B `feat(template)` (plus `test`/`docs` for supporting commits), PR C `fix(destroy)` and `test(iac)`, PR D `test(e2e)` (use `ci` for the workflow only if commitlint accepts it). Never `!:` or a `BREAKING CHANGE` footer.
- Every commit message ends with the line `Claude-Session: https://claude.ai/code/session_01SK1vqQjFYbiqLQ8uja4LjQ`. Commit by pathspec after reading the staged diff. Never `--no-verify`.
- Never print a token, key or passphrase. Read credentials from `process.env` (CI) or `tests/.env.e2e` through the existing loaders (`parseDotenv`); check presence only.
- Every new tsx entry script that makes network calls calls `applyNetworkDefaults()` from `src/lib/net-defaults.js` first (Node's 250 ms connect budget gives false ETIMEDOUT without it). e2e utils already get it through `tests/e2e/utils/e2e-env.js`.
- Unit tests make no real network or cloud calls: inject `fetch`, `docker`, and store functions.
- Bash hooks: bash 3.2 compatible (no `mapfile`, no associative arrays, no `${var,,}`), only `git`, `sed`, `awk`, `grep` required; `gh` and `lsof` optional. Every exit path is `exit 0`. A hook never blocks a session.
- Hook scripts shared with the template are byte-identical in `.claude/hooks/` and `carbon/.claude/hooks/`, mode 100755 in git.
- User-facing text (hook messages, template docs, log lines): plain words, second person where it addresses the user, no em dashes.
- Verification commands: `pnpm exec vitest run <files>`, `pnpm exec biome check <files>`, `pnpm exec tsc -p tsconfig.e2e.json --noEmit` for anything under `tests/e2e`.

## Review Focus

1. A merged branch whose worktree another Claude session is working in (a process's cwd is inside it): it must be left alone, with the reason stated. Test in Task 4.
2. A generated project with no git remote, no `gh`, or a default branch called `master`: the hooks exit 0 and change nothing they cannot prove merged. Tests in Task 4.
3. A stale stack that records a resource type with no probe, or a probe that gets a 5xx, 429 or network error: the stack is kept. Tests in Task 2.
4. A concurrent e2e run younger than the age threshold: its images, volumes and temp dir survive another run's start. Test in Task 1.
5. The audit's run summary in a public repo: it never contains a resource or DNS name that is neither test-shaped nor a listed fixture. Test in Task 8.

---

## PR A: e2e cleans up after dead runs (branch `test/e2e-reap-dead-runs`)

### Task 1: Reap earlier runs' local leftovers at runner start

**Files:**
- Modify: `tests/e2e/utils/local-artifacts.ts` (add next to `reapLocalBuildArtifacts`)
- Modify: `tests/e2e/runner.ts` (call once after the preflight, before the first scenario)
- Test: `tests/unit/e2e/local-artifacts-stale.test.ts`

**Interfaces:**
- Produces:
  - `parseScratchProject(ref: string): { projectName: string; createdAtMs: number } | null` — finds `(testapp|citest)-<mode>-<13 digits>-<6 [a-z0-9]>` anywhere in an image repository or volume name; `createdAtMs` is the 13-digit number.
  - `reapStaleLocalArtifacts(tag: string, o?: { now?: number; maxAgeMs?: number; tempMaxAgeMs?: number; tmpRoot?: string; rigDir?: string; liveProjects?: Set<string>; docker?: (argv: readonly string[]) => string }): Promise<{ images: number; volumes: number; tempDirs: number }>`
  - Constants `STALE_RUN_MAX_AGE_MS = 43_200_000` (12 h) and `STALE_TEMP_MAX_AGE_MS = 604_800_000` (7 days).

- [ ] **Step 1: Write the failing tests** (fake `docker` that returns canned `images`/`volume ls` output and records `rmi`/`volume rm` argv; real temp dirs under the test's TMPDIR with `utimesSync` for age):
  - `parses the project and its start time from every tag scheme` (`10.0.1.2:5000/testapp-k8s-1794105178279-9trgtn`, `vibecarbon-local/testapp-k8s-…`, `testapp-compose-ha-1793951307008-0l9pc4-app`, volume `testapp-k8s-1794105178279-9trgtn_db_data`) and returns null for `vctest-postgres`, `vibecarbon-app`, `testapp1_grafana_data`.
  - `reaps a 13-hour-old run's images and volumes` (expects one `rmi -f` with every matching ref, one `volume rm -f`).
  - `keeps a run younger than 12 hours (a concurrent run)`.
  - `keeps a kept rig's images whatever their age` (`liveProjects` contains the name).
  - `reads live projects from tests/results/.rig-*.json when none are passed` (write a rig file `{ projectName }` in a temp `rigDir`).
  - `removes vibecarbon-e2e-* temp dirs and ca-bundle files older than 7 days and keeps newer ones`.
  - `never throws when docker fails or a temp dir cannot be removed` (resolves with counts).
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/e2e/local-artifacts-stale.test.ts` — expect FAIL (functions not exported).
- [ ] **Step 3: Implement** both functions. Default `docker` is the same best-effort `execFileSync` wrapper `reapLocalBuildArtifacts` uses (share it; do not copy it). Default `liveProjects` reads `projectName` from every `.rig-*.json` in `rigDir` (default `join(process.cwd(), 'tests', 'results')`; tests pass a temp dir, since vitest workers cannot `chdir`). Temp entries: `<tmpRoot>/vibecarbon-e2e-*` directories and `<tmpRoot>/vibecarbon-e2e-ca-bundle-*.pem` files by mtime. One log line when anything was removed: `${tag} [reap] Removed N image(s), M volume(s), K temp dir(s) left by earlier runs`.
- [ ] **Step 4: Wire into `runner.ts`**: one `await reapStaleLocalArtifacts('[runner]')` after the preflight block and before the scenario loop; it must not run before the token/selection checks fail fast.
- [ ] **Step 5: Run** the test file, then `pnpm exec tsc -p tsconfig.e2e.json --noEmit` and `pnpm exec biome check tests/e2e/utils/local-artifacts.ts tests/e2e/runner.ts tests/unit/e2e/local-artifacts-stale.test.ts` — expect PASS and clean.
- [ ] **Step 6: Commit** `test(e2e): the runner removes what dead runs left on this machine when it starts`.

### Task 2: Stale-stack sweep core and per-provider probes

**Files:**
- Create: `tests/e2e/utils/sweep-run-stacks.ts`, `tests/e2e/utils/stack-probes.ts`
- Test: `tests/unit/e2e/sweep-run-stacks.test.ts`, `tests/unit/e2e/stack-probes.test.ts`, `tests/unit/e2e/stack-probes-census.test.ts`

**Interfaces:**
- Produces (in `sweep-run-stacks.ts`, modeled on `sweep-run-tags.ts`):
  - `interface StateStoreApi { list(prefix: string): Promise<{ keys: string[]; complete: boolean }>; read(key: string): Promise<unknown | null>; remove(keys: string[]): Promise<string[]> }` (`remove` returns the keys now gone).
  - `interface RecordedResource { type: string; id: string; urn?: string; inputs?: Record<string, unknown>; outputs?: Record<string, unknown> }`
  - `type ProbeResult = 'gone' | 'present' | 'unknown'`; `type ResourceProbe = (r: RecordedResource) => Promise<ProbeResult>`
  - `recordedResources(stackFile: unknown): RecordedResource[]` — reads `checkpoint.latest.resources`, drops `pulumi:*` types and resources without an id.
  - `sweepRunStacks(tag: string, ownsProject: (pulumiProject: string) => boolean, store: StateStoreApi, probe: ResourceProbe): Promise<{ deleted: string[]; kept: string[] }>` — never throws.
- Produces (in `stack-probes.ts`):
  - `PROBED_TYPES: Record<string, readonly string[]>` — provider id (registry name: `hetzner`, `digitalocean`, `linode`, `vultr`, `scaleway`) to the Pulumi type tokens it can probe.
  - `probeFor(provider: string, o: { token: string; env: Record<string, string | undefined>; fetchImpl?: typeof fetch }): ResourceProbe`

Sweep rule: a stack is `.pulumi/stacks/<project>/<stack>.json`, plus `<stack>.json.bak`. Decide on the `.json` when it exists, else on an orphan `.bak`. Delete only when the decided file reads, and every recorded resource probes `gone` (zero resources counts as gone). Then delete the `.json`, the `.bak`, every key under `.pulumi/history/<project>/<stack>/` and under `.pulumi/locks/organization/<project>/<stack>/`. Anything else (unreadable file, a `present` or `unknown` probe, an incomplete listing) keeps the stack with one log line naming why. Probes run at most 4 at a time.

Probe rule: GET by id; 404 is `gone`, 2xx is `present`, anything else and any thrown error is `unknown`; an unlisted type is `unknown`. Type tokens come from the SDK classes themselves (`<Class>.__pulumiType`), not hand-typed strings. Children: Hetzner `NetworkSubnet` probes its network (id before the first `-`); `FloatingIpAssignment` probes the floating IP; Linode `VpcSubnet` probes `/v4/vpcs/{vpc}/subnets/{subnet}`; Vultr `FirewallRule` probes `/v2/firewalls/{group}/rules/{id}` with the group from its inputs, and is `gone` when the group 404s; Scaleway ids are `<zone>/<uuid>` and use the zoned endpoint. Confirm each id format against the provider package source in `node_modules` and pin it in a test.

- [ ] **Step 1: Write the failing tests** for `sweepRunStacks` (fake store and probe):
  - `deletes a stack, its backup, history and lock once every recorded resource reads 404`.
  - `keeps a stack while any recorded resource still answers`.
  - `keeps a stack whose resource type has no probe (unknown)`.
  - `keeps a stack whose file cannot be read`.
  - `decides on an orphan .bak when the stack file is gone`.
  - `touches only owned projects` (an unowned project with all-404 resources stays).
  - `reads each stack just before deciding, not from the listing` (call order: read, probes, remove).
  - `never throws: a failing list, read, probe or remove is a warning`.
- [ ] **Step 2: Write the failing tests** for `probeFor` (fake `fetchImpl` recording URLs): one test per provider asserting the exact URL per type and `404→gone`, `200→present`, `500→unknown`, `429→unknown`, thrown error→`unknown`, unlisted type→`unknown`; plus the child cases above, pinned with real id shapes.
- [ ] **Step 3: Write the census** `stack-probes-census.test.ts`: walk `src/lib` for `new <sdk>.<Path>(` constructions of the five provider SDKs, resolve each class from the installed package, read `__pulumiType`, and assert it is in `PROBED_TYPES` for that provider. Guard against an empty walk (expect at least `hcloud:index/server:Server`).
- [ ] **Step 4: Run** the three files — expect FAIL.
- [ ] **Step 5: Implement** both modules. Header comment in `sweep-run-stacks.ts` states the rule and why (the 2026-11-13 five stale CI stacks), like `sweep-run-tags.ts` does.
- [ ] **Step 6: Run** tests, `tsc -p tsconfig.e2e.json`, `biome check` — expect PASS and clean.
- [ ] **Step 7: Commit** `test(e2e): a stale-stack sweep that removes a stack only once everything it records reads 404`.

### Task 3: Wire the stack sweep into every sweep and CI

**Files:**
- Create: `tests/e2e/utils/state-store.ts`, `tests/e2e/sweep-stale-stacks-ci.ts`
- Modify: `tests/e2e/utils/sweep-provider.ts`, `.github/workflows/e2e-us-perf.yml` (new step after the provider sweeps)
- Test: `tests/unit/e2e/sweep-provider-stacks.test.ts`, `tests/unit/e2e/state-store.test.ts`

**Interfaces:**
- Consumes: Task 2's `sweepRunStacks`, `probeFor`, `StateStoreApi`.
- Produces:
  - `e2eStateStore(provider: string, env: Record<string, string | undefined>, opts?: { namespace?: 'local' | 'ci'; dryRun?: boolean; s3?: (cfg) => S3Like }): StateStoreApi | null` — `null` when that provider's storage credentials are missing. `namespace` defaults to the active one (`activeNamespace()`); Task 8 opens both. The bucket name, endpoint and region come from the same functions the runner and CLI use for the e2e state bucket (`sharedStateBucketName()` and whatever turns `vc-e2e-state-local` into `vc-e2e-state-local-6586f2` and picks the location; the Hetzner CI bucket is in fsn1, local in nbg1). Never hardcode the suffix or a location. `dryRun` makes `remove` log `would delete <key>` and return `[]`.
  - `sweepProjectOrphans` (existing) gains: after the provider sweep, when `enumFailed` is false and a store exists, `sweepRunStacks(tag, (p) => p === projectName, store, probeFor(provider, { token, env }))`. The result never changes `enumFailed` or `counts`.
  - `tests/e2e/sweep-stale-stacks-ci.ts [--dry-run]`: for every registry provider with credentials, `sweepRunStacks` with owner `(p) => p.startsWith(scratchNamePrefix())`. Exits 0 always; prints one summary line per provider, and `skipped (no credentials)` where applicable.

- [ ] **Step 1: Write the failing tests**:
  - `sweep-provider-stacks.test.ts`: `runs the stack sweep for exactly the project after a complete sweep`; `skips the stack sweep when the resource sweep could not enumerate`; `a stack sweep failure leaves counts and enumFailed unchanged` (mock the provider sweeps and the store factory).
  - `state-store.test.ts`: `names the bucket through the shared resolver` (local and ci namespaces, Hetzner fsn1 for ci); `returns null without storage credentials`; `dry run deletes nothing`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the store (S3 `ListObjectsV2`, `GetObject` + `JSON.parse`, `DeleteObject` per key; a 404 on delete counts as gone), the dispatch change, and the CI entry (import `applyNetworkDefaults` and call it first).
- [ ] **Step 4: Add the workflow step** `Stale state sweep (CI namespace only)` after the Scaleway sweep step, `if: always()`, running `npx tsx tests/e2e/sweep-stale-stacks-ci.ts` with the union of the storage and compute secrets the provider sweep steps already pass (copy their `env:` keys; no new secrets).
- [ ] **Step 5: Run** the tests, `tsc`, `biome`; then a live read-only check: `REAL_INFRA=true npx tsx tests/e2e/sweep-stale-stacks-ci.ts --dry-run` from the worktree. Expected: every provider lists its e2e state bucket (each holds only `.pulumi/meta.yaml` since 2026-11-13, so `0 stacks`); Scaleway may report a local DNS failure (known router fault, memory `scaleway-frpar-local-dns`), which must print as a warning, not a crash.
- [ ] **Step 6: Commit** `test(e2e): every sweep removes the stacks whose resources are all gone`.

---

## PR B: Claude Code hooks clean up merged work, in this repo and every vibecarbon project (branch `feat/claude-hooks-clean-merged`)

### Task 4: The `clean-merged.sh` hook and a default-branch-aware `ff-main.sh`

**Files:**
- Create: `.claude/hooks/clean-merged.sh` (mode 755)
- Modify: `.claude/hooks/ff-main.sh` (default branch instead of hardcoded `main`)
- Test: `tests/integration/hooks/clean-merged.test.ts`, `tests/integration/hooks/ff-main.test.ts`

**Interfaces:**
- Produces: two self-contained scripts (no sourced helper: `create.js` copies only top-level files of `.claude/hooks/`). Both read the hook JSON on stdin, take the repo from the cwd, and exit 0 on every path.

`clean-merged.sh` behavior, in order:
1. Not a git repo, or no `origin` remote: exit 0 silently.
2. `git fetch --quiet --prune origin`.
3. Default branch: `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` minus `origin/`; else `main` if `refs/remotes/origin/main` exists; else `master` if it exists; else exit 0.
4. Merged PR heads, only if `gh` is on PATH and `gh auth status` succeeds: `gh pr list --state merged --limit 200 --json headRefName,headRefOid --jq '.[] | "\(.headRefName) \(.headRefOid)"'` (no `jq` binary needed).
5. A local branch (never the default branch) is merged when its tip equals a merged PR head of the same branch name (its upstream's name, else its own), or its tip is an ancestor of `origin/<default>`. A detached worktree is merged when its HEAD is an ancestor of `origin/<default>`.
6. For each linked worktree (never the main one) that is merged: leave it, with a reason, when it is this session's worktree (contains `$CLAUDE_PROJECT_DIR` or the hook's cwd) → `this session is working in it`; when `git -C <path> status --porcelain` prints anything → `it has uncommitted changes`; when a process's cwd is inside it (Linux `/proc/*/cwd`, else `lsof -d cwd -Fn`) → `another process is working in it`; when neither check is available → `cannot tell whether something is working in it`. Otherwise `git worktree remove <path>` (never `--force`), then `git branch -D <branch>` if it had one.
7. Merged branches with no worktree and not checked out anywhere: `git branch -D`.
8. Output, only when something was removed or left: `{"hookSpecificOutput":{"hookEventName":"<event from stdin>","additionalContext":"<lines>"}}` with lines `Removed merged worktree <path> (<branch>)`, `Deleted merged branch <branch>`, `Left <path> (<branch>): <reason>`. JSON-escape the text.

`ff-main.sh`: same default-branch detection as step 3; every `main` reference becomes the detected branch; behavior otherwise unchanged.

- [ ] **Step 1: Write the failing tests** (integration tier: real `git` and `bash` in temp dirs; a bare `origin`, a clone, worktrees under it; a stub `gh` written to a temp bin dir prepended to PATH that prints canned merged PRs; a squash merge simulated by committing the branch's change onto origin's default branch as a new commit):
  - `removes a clean worktree and its branch once its PR merged, even when squashed`.
  - `deletes a merged branch that has no worktree`.
  - `leaves a worktree with uncommitted changes and says why`.
  - `leaves a worktree another process is working in` (spawn `sleep 30` with that cwd; Linux only, `it.skipIf(process.platform !== 'linux')`).
  - `leaves the session's own worktree` (`CLAUDE_PROJECT_DIR` set to it).
  - `leaves a branch whose tip moved past its merged PR head`.
  - `without gh, removes only branches already contained in the default branch`.
  - `works when the default branch is master`.
  - `exits 0 and changes nothing with no remote, or outside a repo`.
  - `prints additionalContext JSON naming what it did, and nothing when there was nothing to do`.
  - `ff-main.test.ts`: `fast-forwards the default branch when it is master`; `never moves a default branch with local changes`.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/integration/hooks` — expect FAIL.
- [ ] **Step 3: Implement** both scripts. Header comment in `clean-merged.sh`: what it removes, the proofs it needs, why (2026-11-13: 5 worktrees and 24 branches left after their PRs merged).
- [ ] **Step 4: Run** the tests again (expect PASS) and `bash -n` plus `shellcheck` if installed on both scripts.
- [ ] **Step 5: Commit** `feat(hooks): remove merged worktrees and branches, and follow the repo's default branch`.

### Task 5: Ship the hooks in the template and keep both copies in lockstep

**Files:**
- Create: `carbon/.claude/hooks/clean-merged.sh`, `carbon/.claude/hooks/ff-main.sh` (byte-identical to Task 4's, mode 755)
- Modify: `.claude/settings.json`, `carbon/.claude/settings.json`, `carbon/AGENTS.md`, `AGENTS.md`
- Test: `tests/unit/template/claude-hooks-lockstep.test.ts`; extend `tests/integration/template/create.test.ts` and the existing upgrade-policy unit test

**Interfaces:**
- Consumes: Task 4's scripts.
- Produces: settings entries, identical in both files for these two scripts:
  - `SessionStart`: `ff-main.sh` (timeout 30, existing) and `clean-merged.sh` (timeout 60, `statusMessage` `"Cleaning up merged worktrees"`).
  - `PostToolUse`, matcher `Bash`, `"if": "Bash(gh pr merge*)"`: `ff-main.sh` (async, existing) and `clean-merged.sh` (`"async": true`, timeout 120).
  - Keep `carbon/.claude/settings.json`'s existing `env` and gate hooks; keep the root file's permissions and plugins.

- [ ] **Step 1: Write the failing census** `claude-hooks-lockstep.test.ts`:
  - `every repo hook ships in the template byte for byte, or says why not`: each `.claude/hooks/*.sh` is identical in `carbon/.claude/hooks/`, or is in `TEMPLATE_VARIANTS` (`task-completed-gate.sh`, `teammate-idle-gate.sh`, with the reason they differ, read from their diff) or `REPO_ONLY` (with a reason).
  - `the shared hooks are wired the same way in both settings files` (compare the hook entries whose command names a shared script).
  - `every script either settings file runs exists and is executable in git` (mode `100755` from `git ls-files -s`).
- [ ] **Step 2: Extend** `create.test.ts`: a created project has both scripts, executable, and its settings run them; extend the upgrade-policy test: `.claude/hooks/clean-merged.sh` classifies as auto-updated (the `'.claude/hooks/**'` pattern).
- [ ] **Step 3: Run** the census and the two extended tests — expect FAIL.
- [ ] **Step 4: Copy** the scripts, `git update-index --chmod=+x` both template copies, edit both settings files, and add a short "Claude Code hooks" section to `carbon/AGENTS.md` and `AGENTS.md`: what each hook does, when it runs, what it never touches (uncommitted work, a worktree in use, anything not proven merged), and that it is a no-op without a remote.
- [ ] **Step 5: Run** the tests (expect PASS), `pnpm exec biome check` on changed TS, and validate both settings files: `jq -e '.hooks.SessionStart[].hooks[] | select(.command | test("clean-merged"))' <file>` prints the entry.
- [ ] **Step 6: Commit** `feat(template): new projects clean up merged worktrees and keep their default branch current`.

---

## PR C: destroy and tests leave nothing behind (branch `fix/destroy-stack-backup`)

### Task 6: Destroy deletes the stack's `.json.bak` (follow-up #18)

**Files:**
- Modify: `src/lib/iac/index.js` (near `destroyStack`'s `removeStack` at :1859 and `removeStackState`'s forced `removeStack` at :2045)
- Test: `tests/integration/iac/destroy-removes-stack-backup.test.ts`, `tests/unit/iac/remove-stack-backup.test.ts`

**Interfaces:**
- Produces: `removeStackBackup({ backendUrl: string, pulumiProject: string, stackName: string, s3?: S3Like }): Promise<boolean>` — deletes `.pulumi/stacks/<pulumiProject>/<stackName>.json.bak`. `s3://` backends use the same S3 client configuration the state backend already builds (find it through `openStateBackend`); `file://` backends `unlink` under the backend path. Returns true when the file is gone (deleted or absent). Never throws; logs at debug level on failure.

- [ ] **Step 1: Investigate and record** in the task report: the Pulumi project name each call site's stack uses, and whether each call site runs only after the stack's resources are destroyed or confirmed gone. If a path can remove a stack whose resources may still exist (a forced removal that skips verification), do not delete the backup on that path; it is the last record of what may have leaked.
- [ ] **Step 2: Write the failing tests**:
  - integration (file backend, the existing fakecloud or a stack with no cloud resources): `destroy leaves no .json.bak in the state backend`.
  - unit: `deletes the backup key from an s3 backend`; `deletes the backup file from a file backend`; `a missing backup counts as gone`; `a delete error is swallowed and reported as false`.
  - census in the unit file: `every removeStack call in src is followed by removeStackBackup or carries a comment saying why not` (slice the enclosing function body, per memory `source-census-passes-on-dead-code`).
- [ ] **Step 3: Run** — expect FAIL.
- [ ] **Step 4: Implement** and call it after each `removeStack` that Step 1 cleared.
- [ ] **Step 5: Run** the two files plus `pnpm exec vitest run tests/integration/iac` and `tests/unit/iac` — expect PASS.
- [ ] **Step 6: Commit** `fix(destroy): delete the state backup Pulumi leaves when an environment's stack is removed`.

### Task 7: Every test file gets its own `PULUMI_HOME` (follow-up #19)

**Files:**
- Modify: `tests/setup/global-setup.ts`
- Test: `tests/integration/iac/pulumi-home-isolated.test.ts`

**Interfaces:**
- Produces: in every test file, `process.env.PULUMI_HOME` is `<file temp root>/pulumi-home`, created on setup, with `plugins` (and `bin`, when present) symlinked from the real home (`$PULUMI_HOME` from the real env, else `~/.pulumi`) so nothing is downloaded again. It survives the per-test env reset the setup already does.

- [ ] **Step 1: Write the failing test** `pulumi-home-isolated.test.ts`: `a Pulumi workspace lands in the test's own PULUMI_HOME, not ~/.pulumi` — open a `file://` backend stack through the same helper the other iac tests use, then assert a workspace file exists under `process.env.PULUMI_HOME/workspaces` and no file with this test's unique project name exists under the real `~/.pulumi/workspaces`. Second case: `PULUMI_HOME is under the file's temp root` (holds for unit files too).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** in `global-setup.ts`.
- [ ] **Step 4: Run** the new test and the whole iac tier, `pnpm exec vitest run tests/integration/iac` — expect PASS, and `ls ~/.pulumi/workspaces | wc -l` unchanged before and after the tier run (record both numbers in the report).
- [ ] **Step 5: Commit** `test(iac): tests run Pulumi in their own home instead of the developer's`.

---

## PR D: a weekly residue audit (branch `test/e2e-residue-audit`)

### Task 8: Read-only residue audit script and weekly workflow

**Files:**
- Create: `tests/e2e/utils/residue-audit.ts` (inventories, classifier, summary), `tests/e2e/audit-residue.ts` (entry), `.github/workflows/e2e-residue-audit.yml`
- Test: `tests/unit/e2e/residue-audit.test.ts`

**Interfaces:**
- Produces:
  - `interface InventoryRow { provider: string; kind: string; name: string; region?: string; createdAt?: string; count?: number }`
  - `type Verdict = 'fixture' | 'residue' | 'expected' | 'in-flight' | 'other'`
  - `FIXTURES: readonly { provider: string; kind: string; name: string | RegExp; why: string }[]` — `vc-e2e-state-ci-6586f2` and `vc-e2e-state-local-6586f2` buckets (all five providers), DO Spaces `vc-local-e2e`, Vultr object storage `vc-e2e`, DO `hf-ops` droplet, firewall, SSH key and tag, provider default VPCs, the Scaleway project default security group, `.pulumi/meta.yaml`.
  - `RESIDUE_MIN_AGE_MS = 21_600_000` (6 h)
  - `classify(row: InventoryRow, now: number): Verdict` — fixture first; test-shaped names (`testapp-`, `citest-`, and run tags `project:`/`cluster:` with those names) are `in-flight` when younger than 6 h and `residue` otherwise, undated rows included; any `.pulumi/stacks/**`, `.pulumi/locks/**` or `.json.bak` object older than 6 h is `residue`; empty generic vibecarbon tags (`role:`, `environment:`, `node-pool:`, `managed-by:`, `os-flavor:`, `cluster-autoscaler-node:`) are `expected`; everything else is `other`.
  - `renderSummary(rows: Array<InventoryRow & { verdict: Verdict }>, incomplete: string[]): string` — markdown: residue rows in full; fixtures, expected, in-flight and other as counts only; incomplete providers named.
  - `inventory(provider: string, env, fetchImpl?): Promise<{ rows: InventoryRow[]; complete: boolean }>` per registry provider: servers, volumes, IPs, firewalls, SSH keys, load balancers, VPCs/networks, buckets, tags (DO, Linode), DNS records in the e2e zones only (the zones the e2e config names per provider; never list other zones), and the keys of both e2e state buckets (Task 3's `e2eStateStore(provider, env, { namespace })` for `'local'` and `'ci'`, `.list('.pulumi/')`). GET and List only.
  - Entry `tests/e2e/audit-residue.ts`: `applyNetworkDefaults()`, credentials from env or `tests/.env.e2e`, inventories in parallel, summary to stdout and appended to `$GITHUB_STEP_SUMMARY` when set. Exit 1 when any residue, else 2 when an inventory was incomplete, else 0. Never deletes.
- Reference for the API calls (already proven against the live accounts on 2026-11-13): `/tmp/claude-1000/-home-brandon-repos-vibecarbon/ea9270d8-33db-4e47-9b66-0e537d873b2e/scratchpad/audit-inventory.mjs`, `audit-dns.mjs`, `audit-tags-state.mjs` in the same folder.

- [ ] **Step 1: Write the failing tests**:
  - `flags a testapp droplet older than 6 hours`.
  - `calls a citest server 2 hours old in-flight, not residue`.
  - `keeps every fixture out of the residue list` (one row per FIXTURES entry).
  - `counts empty generic tags as expected and run tags as residue`.
  - `flags any stack, lock or backup in an e2e state bucket, but not meta.yaml`.
  - `the summary never names a row that is neither test-shaped nor a fixture` (feed a Cloudflare record `jellyfin.example.io` and a droplet `my-real-app`; assert neither string appears).
  - `exit code is 1 on residue, 2 on an incomplete inventory, 0 when clean`.
  - census: `every registry provider has an inventory` (walk `testConfig.e2e.providers`).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the module and entry.
- [ ] **Step 4: Write the workflow**: `on: schedule: - cron: '17 6 * * 1'` and `workflow_dispatch`; one job, `environment: e2e-infra`, `permissions: contents: read`, `concurrency: e2e-residue-audit`; checkout and toolchain setup copied from `e2e-us-perf.yml`; run `npx tsx tests/e2e/audit-residue.ts` with the provider and DNS secrets the e2e jobs already pass. A red run is the alert (GitHub mails the scheduled workflow's owner).
- [ ] **Step 5: Run** tests, `tsc`, `biome`, `actionlint` if installed; then a live read-only run from the worktree: `REAL_INFRA=true npx tsx tests/e2e/audit-residue.ts`. Expected after the 2026-11-13 cleanup: no residue (exit 0), or exit 2 naming Scaleway if the local router fault recurs.
- [ ] **Step 6: Commit** `test(e2e): a weekly read-only audit that reports test residue on every provider`.

---

## Delivery

Each PR: branch from fresh `origin/main` after the previous PR merged, push, open the PR (body ends with the session link), wait for CI green, squash-merge, delete the branch. The plan file rides along in PR A's first commit (`docs: plan for cleanup in the workflow`). No release is cut by this plan; PR B and PR C carry `feat`/`fix` commits for the next release.
