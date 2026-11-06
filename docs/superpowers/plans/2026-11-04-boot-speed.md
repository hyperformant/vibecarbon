# Boot Speed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove first-boot work no deploy needs, shrink the database image, and stop re-provisioning unchanged compose-ha infrastructure, so perf stats reflect the fastest honest path a customer gets.

**Architecture:** Compose servers refresh only Docker's apt source, with Ubuntu's post-update hooks silenced for that one refresh. k3s nodes stop using apt. The db image drops LLVM and is flattened. Warm compose-ha skips unchanged infrastructure the way k8s already does.

**Tech Stack:** cloud-init, POSIX sh, apt, Docker, Node ESM, Pulumi, vitest.

**Spec:** real-hardware results, 128 boots across five providers on 2026-11-04, seconds for Docker repo + refresh + install, full vs narrow without hooks: Hetzner 28 to 12, Linode 44 to 20, Vultr 44 to 27, DigitalOcean 63 to 43, Scaleway 26 to 18. 0 install failures in 44 narrow boots. Hook clearing alone took the narrow refresh from 9.0 to 0.1 s on Scaleway and 7.0 to 0.4 s on Vultr. `--force-unsafe-io` showed no gain and is out of scope. Slim db image measured locally: 126 to 50 MB gzip.

**Base:** branch `perf/boot-speed`, stacked on PR #340 (`fix/one-docker-everywhere`), because Task 1 changes #340's `src/lib/iac/docker-install.js`.

## Global Constraints

- Every compose server boots Ubuntu 24.04. Do not add Debian paths.
- Only the ready marker's meaning stays fixed: it is still written after `ufw enable`. Work is removed, never moved past the marker.
- Every `apt-get` carries the lock timeout (`APT_LOCK_OPT`; census in `tests/unit/deploy/apt-lock-timeout-census.test.ts`).
- User data stays pure ASCII, and Hetzner caps it at 32 KiB.
- No pre-baked server images, no snapshots, no e2e-only shortcuts: customers get exactly this path.
- No retry ladders. The single fallback in Task 1 is a different path (full refresh), not a retry of the same step.
- No `!:` or BREAKING footers. No attribution lines. No em dashes in user-facing text. Commit with pathspecs, never `--no-verify`.
- Never bare `git stash`. Do not push.

## Review Focus

1. A provider's image stops shipping a dependency of docker-ce, ufw or unattended-upgrades: the install falls back to a full refresh and the deploy still works.
2. Docker's repo is unreachable during the narrow refresh: the apt hook file is gone afterwards, and the failure is as loud as today.
3. compose-ha on Hetzner or Linode, whose images ship no package lists: `wireguard-tools` still installs.
4. The slim db image: `docker stop` is still a fast shutdown, and pg_basebackup, pg_dump, initdb locales, pg_cron, pg_stat_statements and wal-g all still work on both architectures.
5. Warm compose-ha with a changed server type, region, or operator CIDR must still run Pulumi. A skip when inputs differ is a silent drift bug.

---

### Task 1: Compose boot refreshes only what it installs

**Files:**
- Modify: `src/lib/deploy/apt.js`
- Modify: `src/lib/iac/docker-install.js`
- Modify: `carbon/cloud-init/docker-ce-setup.yaml:17` (remove `package_update`) and `:121`
- Modify: `src/lib/deploy/wireguard.js:262`
- Test: `tests/unit/deploy/apt-quiet-update.test.ts` (new), `tests/unit/iac/docker-install-census.test.ts`, `tests/unit/deploy/apt-lock-timeout-census.test.ts`

**Interfaces:**
- Produces, in `apt.js`:
  - `APT_QUIET_CONF = '/etc/apt/apt.conf.d/99zz-vibecarbon-boot'`
  - `APT_TRIMMED_INDEXES`: `-o Acquire::Languages=none` plus `DefaultEnabled=false` for `Acquire::IndexTargets::deb::` `CNF`, `DEP-11`, `DEP-11-icons-small`, `DEP-11-icons-hidpi`
  - `aptQuietUpdate(opts = '', confPath = APT_QUIET_CONF): string`, one line of POSIX sh that writes `#clear` lines for `APT::Update::Post-Invoke-Success`, `APT::Update::Post-Invoke`, `APT::Update::Post-Invoke-Stats` and `APT::Update::Pre-Invoke` to `confPath`, runs `apt-get <lock> update -qq <opts>`, always removes `confPath`, and exits with apt's status. It must behave under `set -e`, so: `apt-get ... && rc=0 || rc=$?; rm -f <conf>; [ "$rc" -eq 0 ]`. Double quotes only inside it, since it is embedded in a single-quoted YAML scalar.
  - `aptInstallOrRefresh(pkgs: string): string`: `<install -y pkgs> || { <update> && <install -y pkgs>; }`, where the update is plain, hooks left in place, for the rare fallback.

`DOCKER_INSTALL_RUNCMD` keeps the keyring and source lines. Its last two lines become `aptQuietUpdate(<docker source only>)` and `aptInstallOrRefresh(PINNED_PACKAGES)`. Docker source only: `-o Dir::Etc::sourcelist=/etc/apt/sources.list.d/docker.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0`.

`docker-ce-setup.yaml:121` uses the same fallback shape, spelled out, because shell templates cannot import. wireguard.js replaces its plain update with `aptQuietUpdate(APT_TRIMMED_INDEXES)`, because boot no longer refreshes the lists and a full refresh there would hand the saving back.

- [ ] **Step 1: Write the failing tests.** In `apt-quiet-update.test.ts`, run the returned string with real `sh -c` and a fake `apt-get` first on PATH, with `confPath` in a temp dir:
  - apt succeeds: exit 0, conf file gone, and the fake saw the conf file present with all four `#clear` lines.
  - apt fails: exit non-zero, conf file gone (Review Focus 2).
  - Same two cases under `set -e`.
  - `aptInstallOrRefresh`: install fails once then succeeds: fake saw install, update, install, exit 0 (Review Focus 1). Install succeeds: no update call. Update fails: exit non-zero.
  - In the census: every provider's rendered user data has no `package_update: true`, holds the Docker-only refresh, and is ASCII and under 32 KiB. wireguard's command uses the quiet trimmed refresh (Review Focus 3).
- [ ] **Step 2: Run them.** `pnpm exec vitest run tests/unit/deploy/apt-quiet-update.test.ts tests/unit/iac/docker-install-census.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Update the header comments in `docker-install.js` and `docker-ce-setup.yaml`, which still describe the old flow. Update any test that pinned `package_update: true`.
- [ ] **Step 4: Run `pnpm lint && pnpm test:unit`.** Expected: PASS.
- [ ] **Step 5: Commit.** `perf(compose): boot refreshes only Docker's source, without Ubuntu's post-update hooks`

### Task 2: k3s nodes boot without apt

**Files:**
- Modify: `carbon/cloud-init/k3s/{master,worker,db,do-master,do-worker,do-db}-init.sh`
- Test: `tests/unit/deploy/k3s-no-apt.test.ts` (new), plus `tests/unit/deploy/apt-lock-timeout-census.test.ts`, `k3s-hetzner-byte-identical.test.ts`, `do-cloud-init-k3s-shape`, `tests/unit/providers/hetzner-k8s-user-data.test.ts`

**Interfaces:** consumes nothing from Task 1.

These six scripts run `apt-get update` then install `curl jq`, and the masters add `docker.io docker-buildx`. Nothing consumes them: `curl` ships on the images, `jq` has no user, and k3s image delivery goes through `ctr` (`src/lib/deploy/layer-delta-remote.sh`). Delete the `_m a` mark, both apt lines and the stale apt comments. Keep `_m n`.

In `master-init.sh`, `worker-init.sh` and `db-init.sh`, the private NIC wait triggers `dhcpcd` at `RETRY_COUNT -ge 6`, costing about 43 s on Hetzner. Change the threshold to `-ge 1`, and update the comment that says 30 s. `dhcpcd -1` is idempotent and `DHCP_TRIGGERED` still limits it to one run.

- [ ] **Step 1: Write the failing test.** `k3s-no-apt.test.ts`: walk every file in `carbon/cloud-init/k3s/`. None contains `apt-get`, or `_m a`, or a bare `jq ` or `docker ` command. The Hetzner scripts holding a dhcpcd trigger all use `-ge 1`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** Before deleting, grep `carbon/cloud-init/k3s/` for each tool again and check `src/lib/deploy/boot-timing.js` tolerates an absent `a` mark on k3s nodes. If it does not, report BLOCKED. Regenerate the rendered fixture.
- [ ] **Step 4: Run `pnpm lint && pnpm test:unit`.** Expected: PASS.
- [ ] **Step 5: Commit.** `perf(k8s): nodes boot without apt, and Hetzner asks for its private lease at once`

### Task 3: A database image without LLVM

**Files:**
- Modify: `docker/postgres-walg/Dockerfile`, `docker/postgres-walg/postgresql.conf`, `docker/postgres-walg/README.md`
- Modify: `src/lib/images.js` (`DB_IMAGE_TAG` to `-r4`, `DB_IMAGE_INPUTS_SHA256`)
- Test: `tests/unit/deploy/walg-dockerfile-arch.test.ts` and anything pinning the tag

**Interfaces:** consumes nothing from Tasks 1-2.

After the existing verification `RUN`, in the same stage, delete `/usr/lib/libLLVM*`, `/usr/local/lib/postgresql/llvmjit*`, `/usr/local/lib/postgresql/bitcode` and `/usr/local/include`. Name that stage. Then `FROM scratch`, `COPY --from=<stage> / /`, and restate everything `FROM scratch` loses: `ENV PATH LANG PG_MAJOR PG_VERSION PGDATA GOSU_VERSION`, `VOLUME /var/lib/postgresql/data`, `STOPSIGNAL SIGINT`, `EXPOSE 5432`, `ENTRYPOINT`, `CMD`, then the existing `LABEL`. Read the base image's real config with `docker image inspect` rather than trusting this list. Keep ICU data: non-English collations need it. Add `jit = off` to `postgresql.conf`, with a comment saying the image carries no LLVM. Keep gzip layers.

- [ ] **Step 1: Write the failing tests.** In `walg-dockerfile-arch.test.ts`: the final stage is `FROM scratch`, the Dockerfile removes `libLLVM`, `llvmjit` and `bitcode`, it restates `STOPSIGNAL SIGINT`, `VOLUME`, `ENTRYPOINT` and `PGDATA`, and `postgresql.conf` sets `jit = off`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement, then build and prove it locally.** `docker build -t vctest-pgslim:task3 docker/postgres-walg`, run it as `vctest-pgslim-task3` with no published ports, and verify Review Focus 4 on amd64: `pg_isready` within 2 s, `create extension pg_cron` and `pg_stat_statements`, an ICU collation query, `wal-g --version`, `pg_basebackup --version`, `pg_dump --version`, `show jit`, and `docker stop` returning in under 2 s with no SIGKILL. Record the numbers in your report. Remove your container with `docker rm -f -v` and your image afterwards. Never touch any other container, network or volume on this machine.
- [ ] **Step 4: Bump the tag and inputs hash.** Update the README and any doc that names the old image. Run `pnpm lint && pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit.** `perf(db): the image drops LLVM and flattens, 126 MB to 50 MB`

### Task 4: Warm compose-ha skips unchanged infrastructure

**Files:**
- Modify: `src/lib/deploy/effects/compose-ha.js:~270-330`
- Test: `tests/unit/deploy/compose-ha-infra-skip.test.ts` (new)

**Interfaces:** consumes `state.shouldSkip(id, inputs)`, `state.startStep`, `state.completeStep(id, result)`, `state.getStepResult(id)` from `src/lib/deploy/state.js`. Pattern to mirror: the `k3s-infra` step at `src/lib/deploy/k8s/k3s.js:4916-4993`.

Warm compose-ha spends 13-19 s of 56-95 s on two no-op `upStack` calls. k8s already skips this. Add a step `compose-ha-infra` with inputs covering everything the two programs receive: project, environment, both regions, both server types, the ssh public key, allowed CIDRs, provider. On a match, read the outputs from `state.getStepResult` and skip both `upStack` calls. Anything else, including a changed operator CIDR, runs Pulumi as today. Complete the step with the outputs both arms produced, after the existing required-output gates pass. Failed or partial runs must not complete it.

If single compose also runs `upStack` on warm deploys (check `src/lib/deploy/plan/`), report that rather than changing it. If the code after `upStack` needs something that is not an output of the stack, report BLOCKED rather than faking it.

- [ ] **Step 1: Write the failing tests.** Same inputs twice: `upStack` runs once and the second run gets identical outputs. Each input changed in turn, one test per input: `upStack` runs (Review Focus 5). A first run that throws in one arm: nothing completes, and the next run provisions. A ledger entry with missing outputs: provisions rather than continuing with undefined.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm lint && pnpm test:unit`.** Expected: PASS.
- [ ] **Step 5: Commit.** `perf(compose-ha): warm deploys skip unchanged infrastructure, as k8s does`

## Verification (controller)

- `pnpm lint && pnpm test:unit`, then `pnpm test:integration`.
- Real hardware, merged with `perf/event-driven-readiness` on a local test branch: one DigitalOcean run per mode and Hetzner compose, comparing `cloudInitReady`, `waitForK3sReady`, `boot.script.*` and `deploy.total` with the baselines in the budget evidence report.
- The slim image on real hardware needs a branch push to the dev channel, so it waits for a go-ahead.
