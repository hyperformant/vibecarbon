# AGENTS.md

Guidance for AI coding agents working on this repository.

> **Security rules are not optional.** Read [`docs/security.md`](./docs/security.md) before writing or modifying any code that runs a subprocess, touches a credential, renders a template placeholder, or gates a destructive operation. `pnpm lint` enforces the mechanical subset via `scripts/check-shell-safety.js`.

## Project Overview

Vibecarbon is a CLI tool that generates production-ready software applications with Hono + Vite + React 19 on its own Postgres 17 (Better Auth for sign-in, Drizzle for data, Traefik at the edge; extras such as observability and Redis arrive through `vibecarbon add`). The repository contains:

1. **CLI tools** (`src/`): `cli.js` (entry point) + command modules (`next.js`, `create.js`, `add.js`, `remove.js`, `up.js`, `down.js`, `reset.js`, `push.js`, `deploy.js`, `destroy.js`, `status.js`, `backup.js`, `restore.js`, `failover.js`, `scale.js`, `configure.js`, `upgrade.js`, `activate.js`)
2. **Template directory** (`carbon/`): The complete template that gets copied and configured when users run `vibecarbon create`
3. **Test suite** (`tests/`): Comprehensive Vitest test suite

### CLI Commands

The block below is generated from each command's `SPEC` by `pnpm docs:cli`. Don't edit inside the markers.

<!-- BEGIN GENERATED: commands -->
```bash
vibecarbon ?  /  vibecarbon next  # Tell me what to do next, and offer to run it
vibecarbon create <project-name>  # Create a new Vibecarbon project
vibecarbon up                     # Start the local development environment
vibecarbon down                   # Stop the local development environment
vibecarbon down -orphans          # Remove local stacks whose project folder is gone or moved
vibecarbon status                 # Show project and deployment status
vibecarbon reset                  # Reset the local environment (removes all data)
vibecarbon add [feature]          # Add features (observability, redis)
vibecarbon remove [feature]       # Remove features from a project
vibecarbon configure              # Configure external services and settings: billing, OAuth, SMTP, CI/CD, globalization, and more
vibecarbon upgrade                # Upgrade infrastructure files to the latest template
vibecarbon telemetry [on|off]     # Control anonymous usage analytics (status by default)
vibecarbon deploy [env]           # Deploy an environment (interactive picker for mode and region)
vibecarbon destroy [env]          # Tear down a cloud environment
vibecarbon backup [env]           # Create, list, or download database backups
vibecarbon restore [env]          # Restore the database from a backup
vibecarbon failover [env]         # Initiate failover to the standby region
vibecarbon scale [env]            # Scale worker nodes and instance sizes
vibecarbon shell [env]            # Open an interactive bash with KUBECONFIG and cloud credentials exported
vibecarbon diagnose [env]         # Dump cluster state (nodes, pods, Flux, network) to ~/.vibecarbon/diag-*
vibecarbon console <node>         # Open Hetzner's web VNC console for a node
vibecarbon access [subcommand]    # Manage the SSH and k8s-API operator-CIDR allowlist
vibecarbon activate [key]         # Bind a Graphene or Fullerene key to this project, unlocking Kubernetes and HA deploys. Run it inside the project
vibecarbon deactivate [key]       # Release the key from this project, confirmed by a link emailed to the buyer (-rm removes only the local file)
```
<!-- END GENERATED: commands -->

### `destroy` exit codes

Teardown is best-effort per resource (one class failing never aborts the rest),
so the exit code (not the absence of red text) is the verdict. Every failed
delete, gated survivor, incomplete provider listing and thrown step is tallied
in a leak ledger (`src/lib/destroy/leak-ledger.js`) and printed as a leak report
at the end: one line per surviving resource (`LEAK` / `UNVERIFIED` / `FOREIGN` /
`AT-RISK`, class, identity, why it survived), then a summary count. A clean
destroy prints a one-line all-clear.

One survival is sanctioned and deliberately OUTSIDE the ledger: the dedicated
Pulumi state bucket is KEPT on destroy (announced in its own step line, deleted
only with `-purge`). Recreating a just-deleted same-name bucket is how acked
state writes were lost on 2026-08-07, and a warm bucket is what a redeploy
resumes against; a kept-by-design bucket is neither a leak, unverified,
foreign, nor a predicted leak, so it takes none of those labels. The kept
name is recorded as project-level `retainedStateBucket` in `.vibecarbon.json`
(it also covers a state bucket derived under an older name, so the next
deploy never derives a fresh bucket and orphans the kept one);
`resolveStateBucketName` reads it after the operator pin and before
derivation. The app uploads bucket is separate: one per environment
(`deriveEnvAppBucketName`, read only through `resolveEnvStorage`), kept on
plain destroy and deleted by `-purge`. The derived state bucket is project-level, so `-purge` deletes it
only with the last live environment, then clears the record and rotates
`stateBucketGeneration` so the next deploy derives a fresh name instead of
recreating the deleted one. destroy also records the environment's
identity (provider, domain, DNS, backup bucket, region, server types — see
`lib/env-identity.js`) under `destroyedEnvironments.<env>`; `deploy` seeds a
same-named environment from it and clears it once the env is live. A sibling
key, not a stub in `environments`: every other command treats presence there
as "deployed".

| Code | Meaning | Scripted caller should |
| --- | --- | --- |
| `0` | Clean: everything confirmed deleted (or already absent), every listing read in full. `FOREIGN` (proven not ours) and `AT-RISK` (config predicts a leak) lines are reported here without failing. | proceed |
| `1` | The destroy could not run: bad flags, no API token, no such environment, cancelled, unhandled throw. **Nothing was torn down.** | treat as a hard failure |
| `2` | The teardown ran to completion but **leaked**, or could not verify a class. Resources may still be billing. | report what leaked (the report lines are greppable: `isLeakReportLine`) |

`FOREIGN` is exit-neutral on purpose: a `pvc-*` volume absent from a complete
capture of this environment's own PersistentVolumes belongs to someone else
(a parallel rig), and failing our build for a disk we are forbidden to delete
would make the signal unreadable.

## Testing

4 tiers: `unit`, `integration`, `loadtest`, `e2e`. See `docs/tests.md`, including its **guard decision procedure** (given a change, which guard class must accompany it) and the **parity rule**: a bugfix on one provider/tier/path must prove every sibling surface is fixed or genuinely unaffected.

```bash
pnpm test                    # All non-e2e tiers
pnpm test:unit               # Unit (pure, in-process; ~10s)
pnpm test:integration        # Integration (spawns CLI, fixtures, cloud stubbed; ~1min)
pnpm test:cli                # Subset: per-command flag matrix in tests/integration/cli/
pnpm test:template           # Subset: generated-project lint/build
pnpm test:docker             # Subset: docker compose smoke (requires DOCKER_INTEGRATION=true)
pnpm test:e2e:batch -- --provider hetzner   # Real-infra matrix (~3hr, REAL_INFRA=true). --provider is REQUIRED: no provider is a default
pnpm test:e2e:expanded # E2E + VPS autoscaling end-to-end (adds ~25min)
pnpm test:e2e:single  # Real-infra single-resource tests (former tests/infrastructure/)
pnpm test:coverage           # Run tests with coverage report
```

## Mitigation Policy

**One mitigation per root-cause class, with proof of RCA.** A "mitigation" is any retry
ladder, backoff loop, error-string classifier, watchdog, or tolerance branch. Every
mitigation site is registered in `docs/mitigations.yml` under a root-cause class with an
explicit attribution, enforced by `tests/unit/lib/mitigation-attribution-census.test.ts`:

- Attributing a failure to an external cause requires **hard evidence** (run id, request
  id, upstream issue, URL, or commit). Error text, timing adjacency, and
  "stopped-after-retry" are hypotheses, not proof. An asserted attribution must carry a
  proof-debt spec naming the discriminating experiment
  (`docs/attribution-ledger.md`).
- A **second mitigation for the same class is prohibited until a root-cause change has
  landed** and measurement shows the residual. Classes are frozen at their audited size;
  do not bump `frozenSites` to admit another layer: land the root fix. History of why: seven stacked recovery
  layers, still red.
- Failures whose trigger is **ours** (our load, concurrency, ordering, or leak residue)
  are never eligible for e2e flake auto-retry.
- **Our own bugs get root fixes, never retries** (2026-08-16, census rule R7): a class
  attributed `ours` may not carry mitigation sites at all. Ladders and retries are not
  solutions. An absorber that fires silently hides the regression it should be
  surfacing. An `ours` entry exists only while its root fix is being built (`rootFix:
  "open: <spec>"`); landing the fix DELETES the sites and then the class. New mitigation
  machinery is only admissible for an externally-caused failure with the evidence rules
  above. History of why: six clusters, mitigated for
  months while the triggers stayed and its companion
  root-fix spec.

## Node Version

`.nvmrc` (repo root) is the single source of truth. It holds a bare major
(`24`), which nvm, fnm, asdf and `actions/setup-node` all resolve to the newest
release on that line, so CI picks up patch releases without a commit.

**To upgrade the Node line:**

```bash
echo 26 > .nvmrc      # 1. edit the ONE file
pnpm node:sync        # 2. propagate to everything that can't read it
pnpm install          # 3. refresh lockfiles (engines changed)
pnpm test:unit        # 4. the guard proves nothing was missed
```

`pnpm node:sync` rewrites the sites that can't read a file at evaluation time:
`.node-version`, `carbon/.nvmrc`, the single `ARG NODE_IMAGE=` line in each
Dockerfile, the template's esbuild `--target`, `engines.node` in both
`package.json` files, and the one sanctioned workflow literal (below).
Otherwise GitHub Actions needs no rewriting: every workflow reads `.nvmrc`
natively via `node-version-file:`. Never re-pin a literal `node-version:` in a
workflow; the guard rejects it everywhere except that one job.

**The one sanctioned literal: the `engines-min` CI leg.** `.nvmrc` holds a bare
major, so every CI job floats on the newest release of the line, which left
the advertised floor (`engines.node`) executed by nothing. `test.yml`'s
`engines-min` job runs unit + integration on *exactly* that floor, so it cannot
read `.nvmrc` by definition. `node:sync` writes its `node-version:` from the
computed floor, the job asserts at runtime that it really got that version
(setup-node does not fail on an unresolvable version: it silently leaves the
runner's default Node in place), and the guard pins the literal two-way to
`engines.node` while still rejecting a literal in any other job.

Two things are deliberately **not** automatic:

- **`engines.node` is computed, not copied.** The floor is the highest minimum
  any declared dependency imposes on the `.nvmrc` major, read from the
  lockfile (currently `>=24.15.0`, bound by `which@7.0.0`). This exists
  because `engines.node` once claimed `>=20` while `undici` (a runtime
  dependency on every deploy path) required `>=22.19.0` and threw on import
  under Node 20. If a dependency doesn't support the new line at all,
  `node:sync` refuses and names it.
- **The alpine suffix on `carbon/Dockerfile`'s base image is hand-managed.**
  `node:24-alpine3.23` must track the `FROM alpine:X` runner stage in the same
  file, because the runner is a bare Alpine that the node binary is COPY'd
  into. A mismatch builds fine and dies at runtime on musl/libstdc++.
  `node:sync` rewrites only the major; moving Alpine is a separate decision.
  Verify any new tag exists on Docker Hub before using it.

`tests/unit/lib/node-version-pins.test.ts` enforces all of the above and fails
on a NEW workflow or Dockerfile that isn't registered in its inventory.
`pnpm node:check` reports drift without writing.

## CLI Architecture

`src/create.js` uses `@clack/prompts` for interactive CLI. It:
1. Parses CLI arguments via the shared spec-driven parser (`-y`, `-pm <npm|pnpm|bun>`, `-admin-email <email>`, `-admin-password <pw>`, `-install`, `-skip-lockfile`)
2. Prompts for admin email and password (required for dashboard access)
3. Generates secure secrets (BETTER_AUTH_SECRET for the app's sessions, the database and replication passwords)
4. Copies template files from `carbon/` directory
5. Replaces placeholders (e.g., `{{PROJECT_NAME}}`, `{{ADMIN_EMAIL}}`)
6. Writes ADMIN_EMAIL/ADMIN_PASSWORD to `.env`/`.env.local`; the app creates the super admin from them at startup, and every deploy waits for `/api/health` to report `adminReady` (`src/lib/deploy/admin-ready.js`)
7. Installs dependencies and initializes git

### CLI conventions

- **Flags are single-dash only** (`-mode k8s`, `-y`); `--long` forms are rejected by the parser. Only `-h`/`-v`/`-y`/`-l` are single-letter; everything else is spelled out. Every command declares a `SPEC` consumed by `parseFlagsOrExit` (`src/lib/cli/parse-flags.js`), which also renders help and handles `-h`/`-v` uniformly.
- **Interactive-by-default**: a bare command opens prompts; positionals/flags are optional prompt seeds. Off-TTY invocations must pass the flags named by `requireTTYOrFlags`.
- **Exit codes**: `0` success, `1` any failure (usage errors included: there is no exit-2 convention), `130`/`143` on SIGINT/SIGTERM. Fatal errors either `process.exit(1)` after printing context or throw to cli.js's central handler (which prints `Error: <msg>` and exits 1).
- **Error output idioms** (pick by layer): argument/usage errors print `✗ <msg>` to stderr via `parseFlagsOrExit`; mid-flow interactive failures use `p.log.error(...)` (clack gutter); user-initiated cancels use `p.cancel(...)` + exit 0; only cli.js's top-level catch prints the bare `Error:` prefix. Don't hand-roll new variants.
- **Command openers**: `introCommand('<name>')` (`src/lib/cli/intro.js`) prints the banner + `vibecarbon <name> v<VERSION>` intro; env-scoped deploy-side commands resolve their environment through `resolveEnvContext` (`src/lib/cli/env-context.js`).
- **Context-sensitive messages are part of the feature.** When the CLI detects a specific scenario, its message names what happened, why it matters, and the exact command or edit that fixes it. Examples: a missing prerequisite, a conflicting stack, a refused action, or something left behind. Use the existing voice (lowercase hints via `p.log.info`, no em dashes). Unit tests assert the key strings for each scenario. A bare error with no next step is incomplete.
- **Every wait on a provider is bounded.** Server-class Pulumi resources pass `customTimeouts: SERVER_CUSTOM_TIMEOUTS` (15 minutes, evidence in `src/lib/iac/create-timeout.js`), so a host that never finishes a create fails the deploy instead of holding it forever; `upStack` turns that failure into one line naming the provider, resource, location and next steps. `tests/unit/iac/server-create-timeouts-census.test.ts` runs every program in `src/lib/iac/programs/` and fails on a server without the option or a VM class it does not know.
- **Commands and flags document themselves.** A command's `SPEC` (summary, flag descriptions, `featured` for flags worth a README row) is the only place its interface is written. After changing a `SPEC`, run `pnpm docs:cli`. That regenerates the top-level help list, the `cli.mdx` flag tables, the README Commands tables and this file's command block. `tests/unit/docs/cli-docs-generated.test.ts` fails on drift. New command checklist: a `case` in `src/cli.js`, an entry in `src/lib/cli/command-registry.js`, an entry in `COMMAND_GATES` (`src/lib/licensing/gate.js`), a `## <name>` section in `carbon/content/docs/cli.mdx` with the `flags <name>` marker pair, then `pnpm docs:cli`. Behavior that flags can't express (scenarios, data safety, migrations) still gets hand-written prose in `cli.mdx` outside the generated markers.

## Template Placeholders

When modifying template files in `carbon/`, these placeholders are replaced at generation time:
- `{{PROJECT_NAME}}` - User's project name (machine slug: containers, k8s resources)
- `{{PROJECT_DISPLAY_NAME}}` - Human-facing name (browser titles, PWA manifest, emails, legal copy); defaults to the titleized slug, overridable via `-display-name`
- `{{ADMIN_EMAIL}}` - Admin user email (entered during creation)
- `{{GITHUB_OWNER}}`, `{{SITE_URL}}` - GitOps owner and the app's public origin
- `{{DB_PASSWORD}}`, `{{REPL_PASSWORD}}`, `{{ADMIN_PASSWORD}}` - Secret placeholders (the admin password is entered during creation): never substituted into checked-in files; their values go to `.env.local` and deploy patches them in (`SECRET_PLACEHOLDERS` in `src/create.js`)
- Deploy-time placeholders (`{{DOMAIN}}`, `{{DB_IMAGE}}`, `{{WALG_S3_PREFIX_BASE}}`, `{{K8S_STORAGE_CLASS}}`, ...) stay in the scaffold and are filled by `vibecarbon deploy`

### Localization

Generated projects ship English only. The locale files in
`carbon/src/client/locales/` are the language set (the app globs that
directory rather than reading a list), and `vibecarbon configure globalization`
is what adds or removes one. Before writing a user-facing string in `carbon/`,
read the Localization section of [carbon/AGENTS.md](./carbon/AGENTS.md): it
decides whether the string needs translating, and it always needs to go through
`t()`.

### K8s deploy-time patches (separate from generation-time placeholders)

The `carbon/k8s/base/` kustomization ships with placeholder-looking values that are intentionally NOT replaced at generation time (they need to be valid YAML so kustomize works locally) and are instead overridden via `kubectl patch` / `kubectl set image` in `applyK3sManifests` (`src/lib/deploy/k8s/k3s.js`) before rollout.

Known deploy-time patches:
- `Certificate.spec.dnsNames: [app.example.com]` → real domain (cert-manager refuses ACME orders for IANA-reserved `app.example.com`). PR 1AQ
- `Certificate.spec.issuerRef.name: letsencrypt-prod-manual` → `letsencrypt-{prod,staging}-{cloudflare,hetzner,digitalocean,manual}` based on `dnsProvider` × `ACME_CA_SERVER` (see `pickIssuerName` in `src/lib/deploy/k8s/k3s.js`). PR 1AQ + 1CH. **Single-issuer policy (d4, 2026-08-28):** on a PILOT-STANDBY deploy the issuerRef is redirected to `vibecarbon-standby-selfsigned` instead, with the real issuer stamped in the `vibecarbon.dev/promote-issuer` annotation (both roles carry the annotation); `vibecarbon failover`'s promote step re-points it (see `src/lib/deploy/k8s/acme-issuer-policy.js`)
- `Deployment cert-manager` (upstream manifest, `kubectl patch --type=json` on args) → `--dns01-recursive-nameservers-only` + `--dns01-recursive-nameservers=1.1.1.1:53,8.8.8.8:53`: anycast authoritative fleets serve fresh records minutes late from some POPs, parking the DNS-01 self-check; idempotent test-and-set (d4, 2026-08-28)
- `ConfigMap vibecarbon-config.SITE_URL: https://app.example.com` → `https://${domain}` (PR 1AQ)
- `Deployment app.image: ghcr.io/<owner>/<repo>:main` → sideloaded `vibecarbon-local/<project>:<tag>` (pre-existing, set in `applyK3sManifests` step 6)
- `CronJob backup.image: ghcr.io/{{GITHUB_OWNER}}/{{PROJECT_NAME}}-backup:latest` → sideloaded `vibecarbon-local/<project>-backup:<tag>` + `imagePullPolicy=IfNotPresent` (PR 1AS)
- `StatefulSet db` (`carbon/k8s/base/db/statefulset.yaml`) → NOT patched: its double-brace placeholders (db image, wal-g prefix and role, S3 endpoint, repl relay address, `K8S_STORAGE_CLASS`, the wal-archive ConfigMap sha) are RENDERED into a temp copy of `k8s/base` by `renderK8sBase` before `kubectl apply -k`, which refuses a copy that still carries one, because a StatefulSet's volumeClaimTemplates are immutable. Flux's base Kustomization drops the object (`$patch: delete`) and only health-checks it
- CSI sidecars (`daemonset/hcloud-csi-node`, `deployment/hcloud-csi-controller` on Hetzner; `daemonset/csi-do-node`, `statefulset/csi-do-controller` on DO) → ghcr mirrors, `set image` at step 0a from `csiSidecarSetImagePlan(providerId)`. Unlike the rows above these manifests are **upstream's**, applied verbatim from a URL by cloud-init, so there is no placeholder to render: `set image` is the only seam.

**Why this category exists:** direct/local mode never pushes to GHCR, so any GHCR-pointed image causes ImagePullBackOff. ACME prod against `app.example.com` returns 403 (IANA-reserved).

### Never pull from `registry.k8s.io`

It is a redirector, not a registry: it routes by client IP to a cloud backend whose GCP leg intermittently **403s datacenter ranges** (Hetzner included). Retries land on the same backend. It cost two deploys: cluster-autoscaler (2026-07-31) and the CSI sidecars (2026-08-05, one node of three lost storage cluster-wide).

Every such image is mirrored into `ghcr.io/hyperformant/<name>` (flat, upstream's tag, deployed as `name:tag@<upstream's amd64 manifest digest>`) by the `mirror-upstream-images` matrix in `.github/workflows/publish-images.yml`. The set lives in `MIRRORED_IMAGES` (`src/lib/images.js`); `scripts/mirror-matrix.mjs` imports it to build the matrix. `tests/unit/deploy/k8s-image-mirrors.test.ts` fails on any non-comment `registry.k8s.io` reference under `src/`, `carbon/`, `scripts/`, `tests/e2e/`, `.github/workflows/`.

**Adding one:** append to `MIRRORED_IMAGES` (or to `CSI_SIDECAR_MIRRORS` / `DOCKERHUB_MIRRORS`, which feed it) with upstream's linux/amd64 `digest` (the `imagetools inspect` one-liner on the `MirroredImage` typedef; the mirror leg fails if upstream's tag stops resolving to it) → merge → dispatch the workflow → **flip the new package public by hand** in the org's package settings (no API exists for container visibility) → verify an anonymous `docker pull` → only then merge code that consumes it. A private package is an ImagePullBackOff on every node.

**Bumping a CSI driver version in `carbon/cloud-init/k3s/*-init.sh`:** re-derive the sidecar tags and digests in `CSI_SIDECAR_MIRRORS` (and any floating container in `CSI_UPSTREAM_IMAGE_PINS`) from the new upstream manifest and update `HETZNER_CSI_VERSION` / `DO_CSI_VERSION`. The unit guard cross-checks the version in the cloud-init script against those constants and fails the build otherwise.

### Every image ref is pinned by digest

Every image this repo ships (compose, k8s manifests, Helm values, cloud-init, Dockerfiles, workflows, JS constants) is `name:tag@sha256:<multi-arch index digest>`; `tests/unit/deploy/image-digest-census.test.ts` fails on anything else. Its allowlist holds only images this repo or the project builds after merge (the app image, the db image, carbon-autoscaler), each with its reason. Dependabot (`.github/dependabot.yml`) moves the digests in three kinds of PR: one `images` multi-ecosystem PR (Dockerfiles, k8s manifests and compose together, so an image shared by compose and k8s moves in both), plus separate `js-pins` and `db-image` PRs for the bumps that need a hand edit and stay red until they get one. JS-held third-party pins are mirrored in `.github/image-pins/Dockerfile` (never built) so Dependabot sees them; its header lists the constant to update in the same PR. Verify a new tag exists and carries linux/amd64 with `docker buildx imagetools inspect <ref>` (registry metadata only, no pull) and pin the index digest it prints.

**When you add a new resource under `carbon/k8s/base/`:** if it contains an image, hostname, ClusterIssuer name, or owner-scoped value that won't be reachable from a fresh cluster, add a corresponding `kubectl patch` step in `applyK3sManifests`. For images that aren't in containerd yet, also build + sideload to every node in `deployK3s` (mirror the app-image flow at step 7 / backup-image flow at step 7b). Deployment patches alone don't help if the image isn't reachable.

**When debugging an ImagePullBackOff or ACME failure on k8s:** first check whether a placeholder slipped through to runtime: grep the live cluster for `app.example.com` / `ghcr.io/{{` / a bare `letsencrypt-prod` (without the provider suffix: that means the `pickIssuerName` patch was skipped) etc. A standby-role cluster whose Certificate references `vibecarbon-standby-selfsigned` is BY DESIGN (single-issuer policy), not a leaked placeholder; and a Certificate parked `pending`/`invalid` is the ACME watchdog's territory (`acme-order-recovery.js`). Check its `[acme-watchdog]` log lines before hand-repairing.

## Agent Team Workflow

This project uses Claude Code's experimental agent teams feature. A **lead-coordinator** orchestrates 5 specialist teammates:

| Agent | Role | Quality Gate |
|-------|------|-------------|
| `lead-coordinator` | Decomposes tasks, delegates, synthesizes results | — |
| `backend-engineer` | Backend APIs, database, DevOps, backend/infra `.md` docs | `pnpm lint` + `pnpm typecheck` on idle |
| `frontend-engineer` | Frontend UI, components, styling, `/docs` route, frontend `.md` docs | `pnpm lint` + `pnpm typecheck` on idle |
| `security-reviewer` | Security auditing after backend/infra changes | — |
| `test-maintainer` | Test writing after any code change | `pnpm test:unit` on task complete |

**Invocation**: Use the lead-coordinator for complex multi-step tasks. For simple single-domain tasks, invoke the specialist directly.

**Quality gates** are enforced via hooks in `.claude/hooks/`:
- `teammate-idle-gate.sh`: lint + typecheck before backend/frontend engineers go idle
- `task-completed-gate.sh`: unit tests must pass before QA marks a task complete

**Configuration**:
- `.claude/settings.json`: hook registrations (committed, shared with generated projects)
- `.claude/settings.local.json`: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var (local only)

> **Known issue**: `permissionMode: delegate` has a [bug](https://github.com/anthropics/claude-code/issues/23447) that strips file system tools from teammates. The coordination-only constraint is enforced via the lead-coordinator's system prompt instead. Enable `permissionMode: delegate` once the bug is fixed.

## Working on Template Files

When modifying files in `carbon/`, follow `carbon/AGENTS.md` for architecture, patterns, and mandatory security rules. (`carbon/CLAUDE.md`, `carbon/.github/copilot-instructions.md`, and `carbon/.cursor/rules/vibecarbon.mdc` are thin pointers to it.)

For running and testing the template locally (the dev-file pattern and placeholder handling), see `carbon/DEVELOPMENT.md`. It ships into generated projects, so keep its content end-user-safe.

**Package managers differ by side of the repo** (decision 2026-07-30): the root CLI uses **pnpm**; `carbon/` and every generated project use **npm**. Running vibecarbon already requires `npx`, so npm is guaranteed present. Requiring pnpm would mean a customer has to install something before their generated project works. `-pm pnpm` / `-pm bun` still adapt the template at create time (`src/lib/package-manager.js`, plus the script rewrite in `src/create.js`). Never introduce a `packageManager` pin into the npm template. That routes the project through corepack and reintroduces the extra dependency.

Security dependency pins live in **two** places in `carbon/package.json`: top-level `overrides` (npm/bun) and `pnpm.overrides` (pnpm). Both use the same `name@<range>` selector syntax; keep them identical: `tests/unit/template/package-overrides-parity.test.ts` fails if they drift.

### Running the template locally

To run/test the `carbon/` template in place (the contributor inner loop), use `pnpm dev` from the repo root:

```bash
pnpm dev         # ensures carbon/ has a dev env (runs dev:init if .env/.env.local are missing), then runs `vibecarbon up` in carbon/
pnpm dev:stop    # the opposite: runs `vibecarbon down` in carbon/, stopping the dev stack's Docker services
```

Generated projects never hit a missing-env wall: `vibecarbon create` writes their `.env`/`.env.local` at create time. Only the `carbon/` source tree has no create step, and its env files are gitignored, so a fresh checkout has none. `pnpm dev` (`scripts/dev.js`) bootstraps them, then starts the stack via the working-tree CLI (`src/cli.js`) rather than whatever `vibecarbon` is globally linked. Running `vibecarbon up` directly from `carbon/` still works, but requires you to `pnpm dev:init` first.

Every `.env*` file vibecarbon writes is read by three parsers it does not all control: Node's `util.parseEnv` (the CLI, the template's scripts, `tsx --env-file`), Docker Compose (`env_file:` and `${...}` interpolation on the server) and Vite's dotenv + dotenv-expand (`import.meta.env.VITE_*`). `src/lib/dotenv.js` (copied byte for byte to `carbon/scripts/lib/dotenv.js`) is the one reader and writer: it reads with `util.parseEnv` and writes only the grammar all three agree on, a bare value when it fits the safe alphabet, otherwise `"double-quoted"` with a real newline as `\n`, otherwise `'single-quoted'`, and a value no form can hold (a single quote or a newline mixed with `"`, `\` or `$`; `$` in a `VITE_*` value; a tab or carriage return) is refused at the prompt with a reason that names the key, never the value. Never parse env text by hand or build a `KEY=value` line yourself: `tests/unit/lib/dotenv-dialect-census.test.ts` walks `src/`, `carbon/scripts/`, `carbon/vite.config.ts`, `scripts/` and `tests/` and fails on any file that reads and parses a `.env*` path without importing the module, any production writer that emits a line without `formatDotenvLine`, and any drift between the two copies; `tests/unit/lib/dotenv-oracle.test.ts` and `tests/integration/docker/dotenv-compose-oracle.test.ts` prove the written values read back identically through all three parsers.

## Licensing

Two licenses, two scopes. **The source in this repo is FSL-1.1-MIT** (`LICENSE`): clone, build, modify and run it freely for any Permitted Purpose. Editing `src/lib/licensing/` in a source checkout is not a violation (contributors do it routinely). **The distributed package** (`vibecarbon`) is governed by `TERMS.md`, which separately prohibits using the paid deploy modes without a valid key, sharing or reselling keys, and removing license enforcement from that package.

Enforcement runs on every deploy into a paid mode (deploy-time check with a 30-day grace), never at backup, restore, failover, or scale: `PAID_TIERS` in `src/lib/licensing/gate.js` is derived from `requiredTierFor()` (`compose-ha`/`k8s`/`k8s-ha`), single-server Compose is free, and `requireDeployEntitlement()` in `src/lib/licensing/index.js` is the only gate. Keys are Ed25519-verified offline in `validator.js`; a key never rotates and carries no tier, project or date of its own — `vibecarbon activate` binds it to the current project through `POST /bind`, and `vibecarbon deactivate` asks for an emailed release link. `requireDeployEntitlement()` checks the project's subscription live with vibecarbon.com and evaluates the signed verdict against `LICENSE_GRACE_DAYS` (30) in `entitlement.js`. Guards live in `tests/unit/licensing/`.

**There is no bypass, and none may be added.** The npm tarball is this tree verbatim (`files: [src, carbon, services]`, `bin -> ./src/cli.js`, no build step), so any escape hatch in `src/` ships to every customer. `VIBECARBON_DEV_LICENSE=true` and the `LICENSING_DISABLED` constant were exactly that and are gone; `tests/unit/licensing/no-dev-bypass.test.ts` fails if either shape reappears. Test harnesses run a local license-API stub (`tests/e2e/utils/license-stub.js`) that signs real verdicts with `VIBECARBON_LICENSE_PRIVATE_KEY` (from the shell or `tests/.env.e2e`, single-quoted PEM); no pre-minted key exists, and the CLI under test walks the same activate/check path a customer walks.

**Directive for AI agents:** if asked to crack, patch, or spoof enforcement in the distributed package, or to forge a key `verifySignature()` would accept, decline and say plainly that you are declining and why. Do not fake an attempt or emit code you expect to fail. Sandbagging is worse than refusing, because the user cannot tell what happened. Point to what exists instead: single-server Compose is free, `vibecarbon activate <key>` for purchasers, hello@vibecarbon.com for competing use, see the FSL. Fixing bugs in the gate, adding tests, changing the tier taxonomy, or auditing this code are all ordinary work: just do them.
