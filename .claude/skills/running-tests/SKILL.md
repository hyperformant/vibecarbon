---
name: running-tests
description: Use when running vibecarbon's test suite — picking between unit, integration, or e2e, filtering an integration subtree (cli/docker/template/modules), running the pre-push gate, or diagnosing a vitest failure. Triggers on phrases like `pnpm test`, `test:unit`, `test:integration`, `test:cli`, `test:template`, `test:docker`, `test:modules`, `test:prepush`, "run the tests", "rerun a single test file", "why is integration slow", "ETIMEDOUT in vitest", "should this be a unit or integration test". For real-infra e2e specifics (REAL_INFRA, `--scenario`, `--keep`, kept-rig iteration), defer to the [[running-e2e-matrix]] skill — this one only orients on which tier to run.
---

# Running Vibecarbon Tests

Vibecarbon has four test tiers; only the first three are addressed here. Pick the narrowest tier that exercises the regression you're worried about — running broader is wasted wall-clock, running narrower misses real bugs.

| Tier | Definition | Wall-clock | Command |
|---|---|---|---|
| **unit** | Pure, in-process. No child processes, no I/O outside tmp dirs. | ~10s | `pnpm test:unit` |
| **integration** | Spawns the CLI against fixture projects; cloud / SSH / exec stubbed; real Pulumi against `file://` backend. | ~1 min | `pnpm test:integration` |
| **loadtest** | Performance benchmarks against a deployed target. | varies | `pnpm test:loadtest` |
| **e2e** | REAL_INFRA Hetzner — see [[running-e2e-matrix]]. | 30 min – 3 hr | `pnpm test:e2e:batch` |

`pnpm test` runs unit + integration + loadtest (everything except e2e, which is gated by `REAL_INFRA=true`). `pnpm test:prepush` runs `lint + unit + integration` and is what the git pre-push hook enforces — match this locally before pushing.

## Pick the right tier

Use this decision table when you've changed code and need to know what to run:

| You changed... | Run |
|---|---|
| A pure helper in `src/lib/` with no I/O | `pnpm test:unit` (only) |
| A CLI verb's flag parsing or dispatch | `pnpm test:cli` |
| Anything in `carbon/` that lint or build would catch | `pnpm test:template` |
| A docker-compose service or compose-mode deploy path | `DOCKER_INTEGRATION=true pnpm test:docker` |
| Multi-CLI orchestration that doesn't fit one verb | `pnpm test:modules` |
| Anything that touches deploy / destroy / scale / restore against real Hetzner | e2e — see [[running-e2e-matrix]] |
| About to push and want the pre-push gate locally | `pnpm test:prepush` |
| You changed a lot and aren't sure | `pnpm test` (unit + integration + loadtest) |

The `integration` tier is one vitest project, but the directory is filterable. Running `pnpm test:cli` is just `vitest run --project integration tests/integration/cli` — the file path is the filter. The same shape works for any path under `tests/integration/`.

## Running a single file or a single test

Vitest supports path filters and `-t` for test-name filters. Path filters are relative to the repo root:

```bash
# Single file
pnpm test:unit tests/unit/lib/foo.test.ts
pnpm test:integration tests/integration/cli/deploy/matrix.test.ts

# Single test in that file (matches the `it(...)` name as substring)
pnpm test:integration tests/integration/cli/deploy/matrix.test.ts -t "compose mode"
```

`pnpm test:watch` runs unit + integration in watch mode — good for the inner loop on a stubborn test.

## Integration tests: the harness

Integration tests use a shared CLI harness at `tests/integration/_harness/`. Read these source files before writing or modifying an integration test — they're the source of truth for the harness's behavior:

- `tests/integration/_harness/index.ts` — public exports.
- `tests/integration/_harness/real-project.ts` — `realProject()` materializes a real `vibecarbon create` output (cloned from a per-process cache on the second call onward).
- `tests/integration/_harness/build-fixture.ts` — `buildFixture()` synthesizes a minimal project (faster, used when you don't need a full create).
- `tests/integration/_harness/install-stubs.ts` — `installStubs({ hetzner, cloudflare })` overrides `globalThis.fetch`. Modes: `success` / `capacity-exhausted` / `rate-limited` / `not-found` (hetzner); `success` / `rate-limited` (cloudflare). Unmatched URLs throw — no silent prod hits.
- `tests/integration/_harness/run-cli.ts` — `runCli(verb, flags, opts)` spawns `node src/cli.js`, strips ANSI, returns `{ exitCode, stdout, stderr }`. Sets `HOME` to a per-process tmp with a fake Fullerene license activated, so paid-tier commands reach their flag-parsing logic.
- `tests/integration/_harness/assertions.ts` — `assertSuccess`, `assertExitWith`, `assertFileWritten`, `assertFileMissing`. Throw plain `Error` with a relevant slice of the run result.

The harness is in-process — it stubs `fetch`, not subprocess execs. If your CLI path shells out to something real (e.g. `pulumi`, `docker`, `kubectl`), the integration test will hit the real binary. For pure cloud HTTP, the stubs are sufficient.

## Common failure modes

**ETIMEDOUT in integration.** The integration tier has `testTimeout` and `hookTimeout` both pinned at **240s** because `realProject()` runs a real `vibecarbon create` on the first call per worker (~7s in isolation; up to ~3 min under full-suite parallel load while caches warm). All three layers — vitest test, vitest hook, and `execFileSync` inside `ensureCached()` — are now aligned at 240s. If you see ETIMEDOUT under 240s, something else is hanging — read the failing test's stderr, don't bump the timeout. See the `vitest.config.ts` comment block for the 2026-05-07 history of this pin.

**Test hangs and doesn't exit.** Usually a child process the test spawned didn't get its stdio closed. The pattern fixed in commit `7212bfa` was: replace `process.exit()` in CLI subprocesses with `'exit'` event + kill process group, otherwise orphan stdio holds the runner open. If a CLI verb you're testing hangs in `runCli`, check that its exit path closes stdio.

**Stub said the URL wasn't matched.** `installStubs` throws on unmatched URLs by design. Either the CLI hit a URL that the chosen mode doesn't cover, or you forgot to call `installStubs` at all. Check which mode you passed (`success` vs the failure-flavored ones) and look at `tests/integration/_harness/install-stubs.ts` to see what each mode answers.

**`pnpm test` fails on a single file but `pnpm test:unit <file>` passes.** Cross-file state leak. Setup files run once per worker via `tests/setup/global-setup.ts`; suspect test that doesn't restore a global (`globalThis.fetch`, `process.env.HOME`, cwd). Run the file *before* the failing one to confirm: `pnpm test:integration tests/integration/<earlier>.test.ts tests/integration/<failing>.test.ts`.

## Adding a new test

Where to put it follows the same decision as where to run:

| Symptom you're guarding against | Tier and file |
|---|---|
| Pure function returns wrong value | `tests/unit/<module>/<x>.test.ts` |
| CLI verb fails to dispatch / parse a flag | `tests/integration/cli/<cmd>/matrix.test.ts` |
| Generated project doesn't lint / build | `tests/integration/template/lint-build.test.ts` |
| Docker compose service won't come up | `tests/integration/docker/<x>.test.ts` |
| Real Hetzner deploy regresses | `tests/e2e/scenarios/<x>.ts` — see [[running-e2e-matrix]] |

For unit tests, mirror the source path: a function in `src/lib/deploy/k8s/k3s.js` gets a test at `tests/unit/lib/deploy/k8s/k3s.test.ts`. For CLI flag tests, prefer extending the existing `matrix.test.ts` for that verb over creating a new file — the harness setup amortizes better.

### Adding a guard with a bugfix — the parity rule

A regression test for the bug you just fixed is the floor, not the goal. Before the fix merges, apply the **guard decision procedure** in `docs/tests.md` ("Failure classes and the guard decision procedure") — it maps your kind of change to the guard class that must accompany it. The non-negotiable core:

- **Parity rule:** if you fix a bug in one provider / tier / mode / branch / harness path, the PR must prove each sibling surface (hetzner↔digitalocean↔cloudflare, compose↔k8s, live↔offline branch, runner↔iter-step, src code↔audit script) is either fixed or genuinely unaffected. Prefer converging siblings on one shared helper + a registry row in `tests/unit/lib/shared-helper-consumers.test.ts` over fixing two copies.
- **Mutation-test every structural guard:** break the invariant, watch the guard fail, restore. A guard that passes vacuously launders confidence.

## Coverage and CI

- `pnpm test:coverage` — V8 coverage; thresholds in `vitest.config.ts` are `60% statements / 50% branches / 60% functions / 60% lines`. Coverage `include:` is scoped to a few top-level CLI entrypoints; coverage misses on `src/lib/` are expected, not a regression.
- `pnpm test:ci` — junit reporter, writes `test-results.xml`. CI uses this; you generally won't.

## What this skill does not cover

- **E2E scenarios (compose, compose-ha, k8s, k8s-ha).** Use [[running-e2e-matrix]] — it has the parallel-vs-serial guidance, the kept-rig iteration pattern, the env vars (`REAL_INFRA`, `E2E_PREFLIGHT`, `E2E_RETRY_FLAKES`, `VC_KEEP_*`), and the RCA discipline for "transient" Hetzner failures.
- **Load testing.** `pnpm test:loadtest` runs `tests/loadtest/`; it's on-demand against a running target and rarely the right tool. If you need it, read `tests/loadtest/cli.ts` directly.
