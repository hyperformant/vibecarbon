# Compose ghcr pull credential (A4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A compose server never holds the operator's `gh auth token`. It pulls a private app image with a classic token that has only `read:packages`. It pulls a public image anonymously. When nothing comes from ghcr, it holds no ghcr login at all.

**Architecture:** A3's ghcr decision (Part A, spec `docs/specs/2026-11-26-k8s-everywhere-design.md`, "ghcr pull Secret") applied to compose. The resolver in `src/lib/deploy/k8s/ghcr-pull-secret.js` stops knowing about clusters. It reads stored pairs from any list of stores. Compose gets one store per server: the `ghcr.io` entry in the server's `/root/.docker/config.json`. Every compose deploy, compose-ha deploy and compose scale goes through a single function, `ensureGhcrLoginOn`, which writes, keeps or removes that entry.

**Tech Stack:** Node 24 ESM, vitest, ssh to the server through the existing compose helpers.

**Spec:** `docs/specs/2026-11-26-k8s-everywhere-design.md`, A3's ghcr decision, which Brandon approved: "Go with the read:packages token, design approved". The A3 spec does not cover compose. Where this plan goes beyond it, that is the controller's ruling R24 in `.superpowers/sdd/2026-11-26-k8s-gaps/progress.md`, and it is provisional.

## Why

Today three paths log every compose server into ghcr.io with the operator's full `gh auth token`. That token usually carries `repo`, `workflow` and `read:org`. docker writes it as base64 into `/root/.docker/config.json`. Whoever gets root on the server gets every repo the operator can push to.
- `src/lib/ci-setup.js` (`ensureCIImageReady`, `ghcrPullCreds` from `getGHCRToken()`), then `src/lib/deploy/effects/index.js` (`ghcrLogin`). This is a compose push-mode deploy, the default once the build workflow is installed (`resolveBuildMode`, `ciAvailable`). It logs in even for a public package.
- `src/lib/deploy/effects/compose-ha.js` (the `ghcrPullCreds` login fan-out to both sides).
- `src/scale.js` (`getGHCRCredentials()` from `src/lib/build.js`). This logs in on every compose scale, in every build mode, even when the image is delivered from the operator's machine.

## Global Constraints

- The token rules are A3's, unchanged: a classic token with exactly `read:packages`, checked through the `x-oauth-scopes` header; ghcr must accept it for this package; a stored token is checked again on every run.
- The token goes only into Authorization headers to api.github.com and ghcr.io, and into the server through the existing `dockerLoginOnServer` script environment. It never goes into argv, a URL, a local file, a log, state, or an error message.
- `getGHCRToken()` stays, for local probes only (`waitForGhcrManifest`, the tag check). No value it returns may reach a server.
- Other registries' entries in the server's docker config (Docker Hub) are never touched.
- Copy:
  - lowercase CLI hints that say why;
  - a command ends its line;
  - no U+2014 or U+2013 anywhere;
  - "free" never next to servers.
- Before every commit, run `pnpm lint`, `pnpm lint:infra`, `pnpm unused` and `pnpm dupes`. The pre-commit hook runs only lint and unit.
- No `!:` and no BREAKING CHANGE footers. Use a "Compatibility note" paragraph instead.
- Never `--no-verify`. Never read `tests/.env.e2e`. Every recursive grep uses `--exclude='.env*'`.
- No real-server runs. The e2e lifecycle uses local and direct builds and never `configure cicd` (`tests/e2e/scenarios/_run-lifecycle.ts:470`), so no e2e setting changes.

## Review Focus

1. **A server that already holds the broad token.** The next deploy reads that entry back as a stored pair. Its scopes are broader than `read:packages`, so it is never reused: in push mode it is replaced, and otherwise the entry is removed. Nothing prints the token.
2. **A public package.** Nothing is asked. The `ghcr.io` entry is removed, and the Docker Hub entry is still there afterwards.
3. **compose-ha.** One ask covers both sides. A good token stored on either side is reused for both.
4. **compose scale with an image delivered from the operator.** The new server gets no ghcr login and nothing is asked. A scale of a push-mode image reuses the old server's token, with no ask.
5. **A headless push deploy of a private package with no stored token and no `GHCR_PULL_TOKEN`.** It refuses, saying what to export, before any server is created or changed.

---

### Task 1: The resolver reads any store

**Files:**
- Create: `src/lib/deploy/ghcr-pull.js`. It takes the store-agnostic part of `src/lib/deploy/k8s/ghcr-pull-secret.js` (as merged in #591):
  - `newPullTokenUrl`, `githubTokenScopes`, `pullTokenProblem`, `ghcrPullsAnonymously`, `ghcrAcceptsToken` and `resolveGhcrPull`;
  - the `GhcrPull` typedef;
  - their private helpers (`ghcrEndpoints`, `MANIFEST_TYPES`, `TOKEN_CHARS`, `scopeShortfall`, `ghcrBearer`, `ghcrTagsStatus`, `unexpectedTags`, `storedTokenShortfall`, `newPullToken`).

  Export `ghcrEndpoints` and `ghcrBearer` only if the k8s file still needs them.
- Modify: `src/lib/deploy/k8s/ghcr-pull-secret.js`.
  - It keeps `GHCR_PULL_SECRET`, `FLUX_APP_TAG`, `assertAppImageBuilt` (which checks the tag Flux deploys, so it is k8s only), `ghcrPullSecretManifest`, `readGhcrPullSecret` and `ensureGhcrPullSecretOn`, whose public case deletes the stored Secret.
  - It imports what it needs from the new module and adds `clusterStores(clusters)`.
  - Do not re-export the moved names. Point the importers at the new module (`grep -rn --exclude='.env*' "ghcr-pull-secret.js" src tests`).
- Modify: `src/configure.js`. The `resolveGhcrPull` call in `runConfigureCicd` builds its clusters from the sides handed over (`handed`).
- Modify tests: `tests/unit/deploy/ghcr-pull-secret.test.ts`, whose imports and cluster cases move to stores, and any test that slices `runConfigureCicd` for `resolveGhcrPull(`.

**Interfaces:**
- Produces:
  - `type PullStore = { name: string, read: () => Promise<{ username: string, token: string } | null> }`. `name` completes "the token ___": `in prod's cluster`, `on prod's server`.
  - `resolveGhcrPull({ owner, repo, projectName, envName, stores, keptAs, isTTY?, prompt?, fetcher? }): Promise<GhcrPull>`. It replaces `clusters` with `stores`. `keptAs` completes the ask's third line: `it lives ${keptAs} and nowhere else, so give it nothing more.` For k8s, `keptAs` is `in the cluster as ghcr-pull-secret`. A stale line reads `the token ${store.name} ${shortfall}`.
  - `clusterStores(clusters: Array<{ envName, kubeconfigPath }>): PullStore[]`. It returns `{ name: \`in ${envName}'s cluster\`, read: () => readGhcrPullSecret({ env: { ...process.env, KUBECONFIG } }) }`.

- [ ] **Step 1: Move the existing tests to stores.** k8s behaviour must not change. Every existing `resolveGhcrPull` case passes with `stores: clusterStores([...])` and the same expectations. The copy assertions on the stale lines and the ask keep their current k8s text.
- [ ] **Step 2: Add the new cases.**
  - `a store of any kind is read in order, and the first good pair wins with no ask`: two fake stores, the first returning null.
  - `keptAs names where the token lives in the ask`.
  - `a stored token with more than read:packages is never reused`: a fake store holds a pair whose scope header is `repo, read:packages, workflow`. The prompt is asked, and the stale warning says the token in that store can also repo.
- [ ] **Step 3: Run them and confirm the new cases fail.** Run `pnpm vitest run --project unit tests/unit/deploy/ghcr-pull-secret.test.ts`.
- [ ] **Step 4: Implement.** Move the code, add `stores`, `keptAs` and `clusterStores`, and update the configure call.
- [ ] **Step 5: Run the gate.** Run `pnpm test:unit` plus the four lint gates. Expected: PASS.
- [ ] **Step 6: Commit.** Subject: `refactor(ghcr): the pull resolver reads any store`.

### Task 2: Compose servers log in with the pull credential, or not at all

**Files:**
- Create: `src/lib/deploy/compose/ghcr-login.js`, and `tests/unit/deploy/compose-ghcr-login.test.ts` (ssh mocked the way `dockerLoginOnServer`'s existing tests mock it).
- Modify:
  - `src/lib/ci-setup.js`: `ensureCIImageReady` no longer returns `ghcrPullCreds`. Its doc and return type change too.
  - `src/lib/deploy/orchestrator.js`: the push branch resolves the credential once before provisioning, and the compose and compose-HA contexts carry `ghcrPull`.
  - `src/lib/deploy/plan/steps.js`: `ghcrLoginStep` runs for every compose deploy, not only when creds exist.
  - `src/lib/deploy/effects/index.js` (`ghcrLogin`) and `src/lib/deploy/effects/compose-ha.js` (the fan-out).
  - `src/scale.js`: the ghcr block in step 4b.
  - `src/lib/build.js`: delete `getGHCRCredentials` if knip then finds it unused.
- Modify tests:
  - every test that builds a `ciReady` with `ghcrPullCreds` (find them with `grep -rln --exclude='.env*' ghcrPullCreds tests`);
  - the destroy and deploy plan step tests that pin `ghcr-login`'s `when`;
  - scale's tests for step 4b.
- Create: `tests/unit/deploy/ghcr-server-login-census.test.ts`.

**Interfaces:**
- Consumes: `resolveGhcrPull` and `PullStore` from Task 1, and `dockerLoginOnServer(ip, sshKeyPath, { username, token, registry: 'ghcr.io' })`.
- Produces (`ghcr-login.js`):
  - `readGhcrLoginOnServer(ip, sshKeyPath): Promise<{ username, token } | null>`.
    - It reads the `auths['ghcr.io'].auth` of `/root/.docker/config.json` over ssh, with the output captured and never printed, and base64-decodes `user:token`.
    - A missing file, a missing entry or a malformed body returns null. A server ssh cannot reach throws.
  - `serverStores(servers: Array<{ name: string, ip: string }>, sshKeyPath): PullStore[]`. The store name is `on ${name}'s server`.
  - `COMPOSE_KEPT_AS = "on the server in docker's login file"`.
  - `ensureGhcrLoginOn(ip, sshKeyPath, pull: GhcrPull | null): Promise<'removed' | 'absent' | 'kept' | 'stored'>`.
    - With `null` (nothing pulls from ghcr: local or direct build) or `{ mode: 'public' }`, it removes the `ghcr.io` entry. The removal uses the same python merge shape as `dockerLoginOnServer` and leaves every other key as it was. It returns `'removed'`, or `'absent'` when there was no entry.
    - With `{ mode: 'token' }`, it returns `'kept'` when the read-back pair is equal; otherwise it calls `dockerLoginOnServer` and returns `'stored'`.

Wiring:
- **Compose and compose-HA push deploys.**
  - The orchestrator calls `resolveGhcrPull` once, before `iac.upStack`, with:
    - `owner` and `repo` from `getGitHubRepo(cwd)` in ci-setup.js, the lookup `ensureCIImageReady` uses. Do not use the k8s `resolveOwnerAndRepo`. If there is no GitHub remote, fail with `ensureCIImageReady`'s own message;
    - `stores: serverStores(<the environment's recorded servers, both sides for compose-HA>, sshKeyPath)`, which is `[]` on a first deploy;
    - `keptAs: COMPOSE_KEPT_AS`.
  - A refusal there stops the deploy before any provisioning.
  - Local and direct deploys set `ghcrPull: null`.
- **The `ghcrLogin` effect.** It calls `ensureGhcrLoginOn(serverIp, sshKeyPath, ctx.ghcrPull)` on every compose deploy, state-gated as today. The gate's inputs are the mode and a token fingerprint, never the token. The compose-HA fan-out does the same on both sides.
- **compose scale.**
  - When the image is delivered from the operator (`imageDelivery`), the new server gets `ensureGhcrLoginOn(newIp, sshKeyPath, null)`, which is a no-op on a fresh server.
  - Otherwise scale resolves with `stores: serverStores([<the server being replaced>])`, so a good token is reused with no ask, then calls `ensureGhcrLoginOn(newIp, ...)`.
  - The `catch {}` that hid a failure goes. A refusal says what to export.

- [ ] **Step 1: Write the failing tests.**
  - `compose-ghcr-login.test.ts`:
    - `reads the ghcr.io pair back, and nothing else`: a config with Docker Hub and ghcr.io entries returns the ghcr.io pair.
    - `missing file, missing entry, malformed json: null`.
    - `public and null remove only the ghcr.io entry`: the script sent over ssh drops `auths['ghcr.io']` and keeps `auths['https://index.docker.io/v1/']`. Run the script's python against a temp config with `python3 -I` in the test, if the existing login tests do so; otherwise assert on the script text.
    - `the same pair is kept with no write`.
    - `a different pair is written through dockerLoginOnServer and never appears in argv`.
  - The orchestrator and plan tests:
    - `a push deploy resolves the pull credential once, before provisioning`, with spies on `resolveGhcrPull` and `upStack`, checking the order.
    - `a local deploy passes ghcrPull null and the step still runs`.
    - `a refusal provisions nothing` (Review Focus 5).
  - compose-HA: `both sides get the same credential from one resolve` (Review Focus 3).
  - Scale (Review Focus 4):
    - `a delivered image logs the new server into nothing`;
    - `a push image reuses the replaced server's token without asking`.
  - `ghcr-server-login-census.test.ts`, a walk over `src/**/*.js`:
    - The only call of `dockerLoginOnServer` whose argument names `'ghcr.io'` is inside `ensureGhcrLoginOn`.
    - `getGHCRToken(` is called only inside `waitForGhcrManifest` and the tag check, and those return no token.
    - No `src` file calls `getGHCRCredentials`.
    - Slice each function body, not the file: a guard over the whole file passes on dead code.
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run --project unit tests/unit/deploy/compose-ghcr-login.test.ts tests/unit/deploy/ghcr-server-login-census.test.ts`.
- [ ] **Step 3: Implement the wiring above.**
- [ ] **Step 4: Run the gate.** Run `pnpm test:unit && pnpm test:integration`, then the four lint gates. Expected: PASS.
- [ ] **Step 5: Commit.** Subject: `fix(security): compose servers pull with a read:packages token, never the gh token`.
  - The commit body gives the three paths above.
  - It ends with this Compatibility note: an earlier vibecarbon logged compose servers into ghcr.io with your `gh auth token`; your next `vibecarbon deploy <env>` replaces that login (private image) or removes it (public image, or a local build); a headless push deploy of a private image now needs `GHCR_PULL_TOKEN`; if anyone else may have had root on one of those servers, revoke GitHub CLI's token at https://github.com/settings/applications and run `gh auth login`.

### Task 3: Docs

**Files:**
- Modify:
  - `docs/security.md`: the GHCR row covers compose servers (where the token lives, rotation), and a line says that earlier versions put the `gh` token there and what to do about it;
  - `carbon/content/docs/cli.mdx`, the deploy section on push mode: the one-time ask, `GHCR_PULL_TOKEN` for headless runs, and a public image needing nothing;
  - `src/lib/config-registry.js` and `carbon/.env.local.example`: the `GHCR_PULL_TOKEN` text names `vibecarbon deploy` as well as `configure cicd`;
  - `docs/history.md`: a new entry. **Why:** the server held the operator's whole GitHub. **Do not undo:** a server never gets `gh auth token`. **Guard:** `ghcr-server-login-census.test.ts`.
- [ ] **Step 1: Edit.** Follow the copy rules in Global Constraints.
- [ ] **Step 2: Check.** Run `pnpm docs:cli`, `pnpm vitest run --project unit tests/unit/docs tests/unit/lib/env-docs-census.test.ts tests/unit/config-registry.test.ts`, then `pnpm lint`. Grep the changed lines for U+2014 and U+2013. Expected: PASS, no dashes.
- [ ] **Step 3: Commit.** Subject: `docs(security): compose servers hold only a read:packages token`.

## Out of scope

- Real servers. The first push-mode compose deploy after Parts A, B and C merge is the proof.
- k8s. Its non-GitOps deploys build locally (`resolveBuildMode` returns `'local'` for k8s), and its GitOps path is A3.
