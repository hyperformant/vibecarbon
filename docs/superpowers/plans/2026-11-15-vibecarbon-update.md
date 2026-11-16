# `vibecarbon update` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command, `vibecarbon update <env>`, installs each server's system updates (Ubuntu security updates, and Docker on compose servers) and restarts the servers that need it one at a time, after a plan that shows the downtime to expect. `status`, a Super Admin notice and a daily-checked email say when a restart is due.

**Architecture:**
- **Reporter.** A host-side reporter (a POSIX sh script, a systemd path unit and a oneshot service) turns Ubuntu's `/var/run/reboot-required` into one JSON format:
  - on compose servers, a file the app reads through a read-only bind;
  - on k8s nodes, a Node annotation the node writes with its own kubelet credential.
- **CLI.** It reads the same format: status reads the raw files over SSH on compose and the annotation from the cluster snapshot on k8s. `update` adds inventory, inspect, plan, execute and text modules under `src/lib/update/`.
- **App.** It reads the format through a super-admin endpoint, shows an admin `Alert`, and runs a daily 09:00 UTC email check under an advisory lock.

**Tech Stack:** Node.js ESM CLI (`@clack/prompts`, vitest), POSIX sh and systemd on Ubuntu, k3s/kubectl, Docker Compose, the carbon template (Hono, Drizzle and Postgres, React 19 with react-query and react-i18next, nodemailer).

**Spec:** `docs/superpowers/specs/2026-11-15-vibecarbon-update-design.md` (approved 2026-11-15). Read it before any task.

## Decisions this plan makes beyond the spec (Claude's calls)

1. **How the reporter reaches servers.** Hetzner's master user data is 28,230 bytes against the 28 KiB tripwire in `tests/unit/deploy/private-net-guard.test.ts:121`, so it can't carry the reporter. So:
   - **Rides existing SSH sessions, no new step:**
     - k8s: `prePullImages` (`src/lib/deploy/k8s/k3s.js:1499`), which reaches master, db and workers on every deploy and on failover's standby pre-pull.
     - compose: `setupComposeBackupCron` (`src/lib/deploy/compose/index.js:1415`), which runs on every compose deploy, compose-ha deploy and compose scale.
   - **Cloud-init carries it only in the three k8s worker scripts.** That is the autoscaler's only path (`src/lib/deploy/k8s/k3s.js:1129`).
   - **`update` installs it on every server it reaches.**
   - The spec's goal, every server reports, holds.
2. **One annotation, not two.** `vibecarbon.dev/host-state` holds the JSON state. Its presence means "reporting"; its content says whether a restart is due.
3. **The email record lives in `app_settings`** under key `host_maintenance_notice`, not a new table.
   - That table is already used one key at a time with super-admin read (`carbon/src/server/db/schema.ts:564-596`).
   - A new table would mean regenerating the template's db baseline (`carbon/tests/structural/template-migrations-census.test.ts`).
4. **The app learns its environment name** through a new runtime key, `VIBECARBON_ENV`, so the notice and email print the exact `vibecarbon update <env>` command.
5. **Only k8s workers are drained.** The master (Traefik's hostPorts) and the db node (dedicated, tainted, local volume) are cordoned, not drained, because their pods can't move anyway.
6. **`update -json`** prints a machine-readable result: the plan, the outcomes, and the expected and measured downtime. The e2e step needs it, and it's useful for automation.
7. **Docker update followed by a restart on one server** is planned as one outage of about 1 to 4 minutes.
8. **A cancelled run can leave a node cordoned.** `update` marks the nodes it cordons (`vibecarbon.dev/cordoned-by-update`), and the next run uncordons any Ready node carrying that mark before planning.

## Global Constraints

- CLI copy follows AGENTS.md "CLI conventions":
  - single-dash flags;
  - lowercase `p.log.info` hints;
  - **no em or en dashes** anywhere in printed text, help, docs or emails;
  - every printed `vibecarbon <cmd> -flag` must exist (`tests/unit/cli/printed-command-flags-census.test.ts`);
  - summaries are one line, with no bare `< > { }` (`tests/unit/cli/command-registry.test.ts`).
- **Every wait is bounded.** Every remote command gets an explicit `timeout`.
- **Remote scripts:**
  - POSIX `sh`, never bash-only syntax in anything `sh -s` runs.
  - No `${name}` brace syntax in `carbon/cloud-init/k3s/_host-reporter.sh`, because `renderScript` substitutes it. Use `$name`.
- **Every `apt-get` uses `APT_LOCK_OPT`** (`src/lib/deploy/apt.js:80`; `tests/unit/deploy/apt-lock-timeout-census.test.ts`).
- **Paths and probes go through the shared helpers:**
  - SSH key path only via `sshKeyPathFor(env)` (`tests/unit/deploy/deploy-key-census.test.ts`);
  - public-domain requests only via `fetchPublicDomain` (`tests/unit/deploy/public-domain-probe-census.test.ts`);
  - k8s worker selection by label, `WORKER_NODE_SELECTOR` / `isWorkerNode` (`tests/unit/deploy/node-roles-census.test.ts`).
- **No version pins** (Docker is upgraded to the repository's candidate).
- **Template strings:**
  - every user-facing string goes through `t()`;
  - `carbon/src/client/locales/en.json` is the only locale, so English only (carbon/AGENTS.md "Localization").
- **Template server data access:**
  - `adminDb` and raw `pool` only in files added to `ADMIN_DB_ALLOWLIST` / `POOL_ALLOWLIST` (`carbon/tests/structural/db-access-census.test.ts:37,76`), each with a reason;
  - never inline `isSuperAdmin(` in routes.
- **Secrets:**
  - never print secret values;
  - any recursive grep over `tests/` or the repo root uses `--exclude='.env*'`.
- **Commits:**
  - `git add` new files, then `git commit -- <paths>`;
  - check `git config --show-origin user.email` names `~/.gitconfig`;
  - never `--no-verify`;
  - no `!:` and no BREAKING CHANGE footer;
  - conventional messages ending with `Claude-Session: https://claude.ai/code/session_01SK1vqQLM9B9SaK3Q9Hxjgo`.
- **Exact numbers:**

  | Constant | Value |
  |---|---|
  | Restart outage | 60 to 180 s |
  | Docker-only outage | 30 to 60 s |
  | Docker then restart | 60 to 240 s |
  | Email check | 09:00 UTC daily |
  | Email reminder | every 7 UTC calendar days |
  | Advisory lock key | `'7264519330021877'` |
  | Annotation | `vibecarbon.dev/host-state` |
  | Package list cap | 20 names |
  | Compose host dir | `/run/vibecarbon-host`, mounted at `/host-status` |

## Review Focus

These are the five cases most likely to bite someone that no feature test would otherwise exercise. Each is pinned by a test in the task named.

1. **A server that can't be reached over SSH during inspect** (timeout, refused, no ExternalIP). The plan lists it as skipped with the reason and still plans the others; the summary names the next command. Task 8 and Task 9.
2. **The daily unattended-upgrades run holds the apt lock while `update` installs.** `APT_LOCK_OPT` waits, bounded. A failed install stops the run naming the server and the last output lines, and changes no later server. Task 10.
3. **A server that never comes back after the reboot** (boot id unchanged past the budget). The run stops naming the server, what was seen and what to do. A k8s node left cordoned is named with the command that fixes it. Task 10.
4. **Ctrl-C or a crash mid-run with a node cordoned.** The next `update` uncordons nodes it marked and says so. Task 10.
5. **The app can't read Nodes**, for example a cluster deployed before the ClusterRole existed (API answers 403). The endpoint answers 503 and the admin page shows nothing. Never "no restart due". Task 5.

---

## File Structure

**CLI and host (repo root):**

| File | Responsibility |
|---|---|
| `carbon/cloud-init/k3s/_host-reporter.sh` (new) | Single source: installer snippet that writes the reporter script and two units, then enables and starts them |
| `src/lib/host-reporter.js` (new) | Reads the snippet: `hostReporterInstaller()`, `hostReporterScript()`, `withHostReporter(script)` |
| `src/lib/host-state.js` (new) | The JSON format: `HOST_STATE_ANNOTATION`, `parseHostState`, `hostStateFromNode`, `mainPackage`, `REBOOT_TRIGGER_PATTERNS` |
| `src/lib/update/inventory.js` (new) | Which servers an env has, and their role, side and SSH address |
| `src/lib/update/inspect.js` (new) | One remote probe per server, plus pure parsers |
| `src/lib/update/plan.js` (new) | Pure: order, restart prediction, downtime per step, totals |
| `src/lib/update/execute.js` (new) | Runs a plan: reporter install, apt, Docker, cordon, drain, reboot, waits, uncordon, outage monitor |
| `src/lib/update/text.js` (new) | Every string `update` prints: plan, prompts, summary, errors |
| `src/update.js` (new) | The command: SPEC, flow, `-y`, `-json` |
| `src/lib/status/host-states.js` (new) | status's fourth remote check and its row text |

**Template:**

| File | Responsibility |
|---|---|
| `carbon/src/server/lib/k8s-api.ts` (new, moved from `services-status.ts`) | k8s API credentials and requests, plus `k8sGetJson` that rejects non-2xx |
| `carbon/src/server/lib/host-maintenance.ts` (new) | `readHostMaintenance()` for compose, k8s and none |
| `carbon/src/server/routes/v1/admin/host-maintenance.ts` (new) | `GET /api/v1/admin/host-maintenance` |
| `carbon/src/server/jobs/host-maintenance-email.ts` (new) | Daily schedule plus `runHostMaintenanceCheck` |
| `carbon/src/client/components/admin/HostMaintenanceNotice.tsx` (new) | The admin `Alert` |
| `carbon/src/client/hooks/api/useHostMaintenance.ts` (new) | The query hook |

---

### Task 1: Host state format and the reporter

**Files:**
- Create: `carbon/cloud-init/k3s/_host-reporter.sh`, `src/lib/host-reporter.js`, `src/lib/host-state.js`
- Create fixtures: `carbon/tests/fixtures/host-state/{due.json,clear.json,many-packages.json,malformed.txt}`. They live in carbon so the template's own tests can read the same files (Task 5).
- Test: `tests/unit/host-reporter/host-state.test.ts`, `tests/unit/host-reporter/installer.test.ts`

**Interfaces:**
- Produces:
  - `HostState = { host: string, rebootRequired: boolean, since: string | null, packages: string[] }`
  - `HOST_STATE_ANNOTATION = 'vibecarbon.dev/host-state'`
  - `parseHostState(text: string): HostState | null`. Returns null for anything not version 1 or malformed. Packages are capped at 20.
  - `hostStateFromNode(node: object): { name: string, reporting: boolean, state: HostState | null }`
  - `mainPackage(packages: string[]): string | null`. Returns the first package matching a kernel pattern, else the first package.
  - `REBOOT_TRIGGER_PATTERNS: RegExp[]`
  - `HOST_REPORTER_SNIPPET: string` (path)
  - `hostReporterInstaller(): string`
  - `hostReporterScript(): string`, the reporter body between the heredoc markers
  - `withHostReporter(script: string): string`. The installer runs in a subshell that can't fail the carrier, then the script.

**The reporter's contract** (the script the installer writes to `/usr/local/lib/vibecarbon/host-reporter.sh`):
- **Output:** a single line, `{"v":1,"host":"<hostname>","rebootRequired":<bool>,"since":<"ISO-8601 Z" or null>,"packages":[...]}`.
  - `since` is the mtime of `/var/run/reboot-required` (`date -u -r`).
  - `packages` come from `/var/run/reboot-required.pkgs`, sorted, unique, at most 20.
- **`--print`:** prints the JSON and does nothing else.
- **With no argument:**
  - **k8s mode** (when `/var/lib/rancher/k3s/agent/kubelet.kubeconfig` exists):
    - learn the node name from `k3s kubectl --kubeconfig <that> auth whoami -o jsonpath='{.status.userInfo.username}'`, stripping `system:node:`;
    - then `k3s kubectl --kubeconfig <that> annotate --overwrite node <name> vibecarbon.dev/host-state=<json>`;
    - exit non-zero on failure.
  - **Otherwise:** write `/run/vibecarbon-host/state.json` atomically (write `state.json.tmp`, then `mv`), mode 0644, directory 0755. Never remove the directory: the app's bind pins its inode.
- **Units:**
  - `vibecarbon-host-reporter.service`: `Type=oneshot`, `ExecStart=/usr/local/lib/vibecarbon/host-reporter.sh`, `Restart=on-failure`, `RestartSec=30`, `WantedBy=multi-user.target`. It runs at every boot, which clears the state.
  - `vibecarbon-host-reporter.path`: `PathChanged=` on both files, `WantedBy=multi-user.target`.
  - The installer ends with:
    ```
    systemctl daemon-reload
    systemctl enable vibecarbon-host-reporter.service vibecarbon-host-reporter.path
    systemctl restart vibecarbon-host-reporter.path
    systemctl start --no-block vibecarbon-host-reporter.service
    ```
    This satisfies `tests/unit/deploy/cloud-init-units-started.test.ts`.

- [ ] **Step 1: Write the failing tests**

`host-state.test.ts`:
- `parseHostState(read('due.json'))` equals `{ host: 'web-1', rebootRequired: true, since: '2026-11-15T06:42:10Z', packages: ['linux-base', 'linux-image-6.8.0-90-generic'] }`.
- `clear.json` gives `rebootRequired: false, since: null, packages: []`.
- `many-packages.json` (25 names) gives `packages.length === 20`.
- `malformed.txt`, `'{"v":2}'` and `''` each give `null`.
- `hostStateFromNode({ metadata: { name: 'w1', annotations: { 'vibecarbon.dev/host-state': <due.json text> } } })` gives `{ name: 'w1', reporting: true, state: { rebootRequired: true, ... } }`.
- A node without the annotation gives `{ reporting: false, state: null }`.
- `mainPackage(['libc6', 'linux-image-6.8.0-90-generic'])` is `'linux-image-6.8.0-90-generic'`; `mainPackage([])` is `null`.
- `REBOOT_TRIGGER_PATTERNS` matches `linux-image-6.8.0-90-generic`, `linux-firmware`, `libc6`, `systemd`, `dbus`, and does not match `curl` or `openssl`.

`installer.test.ts`:
- `hostReporterInstaller()` contains both unit names, `systemctl start --no-block vibecarbon-host-reporter.service`, and no `/\$\{[a-zA-Z0-9_]+\}/`.
- `hostReporterScript()` starts with `#!/bin/sh` and contains `--print`, `auth whoami`, `vibecarbon.dev/host-state` and `/run/vibecarbon-host`.
- `withHostReporter('echo hi')` ends with `echo hi\n`. The installer part is wrapped so its failure can't stop the script: assert it matches `/^\(\n[\s\S]*\n\) >\/dev\/null 2>&1 \|\| true\n/`.
- Running `sh -n` on `hostReporterScript()` and on `hostReporterInstaller()` exits 0. Use `spawnSync('sh', ['-n'], { input })`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit tests/unit/host-reporter/`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the snippet and the two modules**

`REBOOT_TRIGGER_PATTERNS`:
- Comment the list with its evidence: packages whose maintainer scripts call `/usr/share/update-notifier/notify-reboot-required` on Ubuntu 24.04 and 26.04.
- Check that evidence with `grep -l notify-reboot-required /var/lib/dpkg/info/*.postinst` in `ubuntu:24.04`. Task 2's Docker test re-checks it.
- At minimum: `^linux-(image|modules|base|firmware)`, `^libc6$`, `^systemd$`, `^dbus$`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run --project unit tests/unit/host-reporter/`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add` the new files, then `git commit -- <them>`.
Message: `feat(update): host reporter and the host-state format`.

---

### Task 2: Prove the reporter on real k3s and Ubuntu (Docker)

This is the spec's "builder must verify". It runs before any delivery work. If the kubelet credential can't annotate its own Node, stop and report back: the spec's fallback (a ServiceAccount scoped to patching Nodes) changes Tasks 3 and 4.

**Files:**
- Test: `tests/integration/docker/host-reporter-k3s.test.ts`. Model it on `tests/integration/docker/k3s-agent-token.test.ts`: the same `rancher/k3s:<k3sVersion()>` image, a master plus an agent on a `vctest-*` network, skipped unless `DOCKER_INTEGRATION=true`.
- Test: `tests/integration/docker/host-reporter-ubuntu.test.ts`: an `ubuntu:24.04` container, `vctest-*` named.

**Interfaces:** consumes `hostReporterScript()` and `parseHostState()` from Task 1.

- [ ] **Step 1: Write the k3s test**

Copy the reporter into the agent container (`docker cp`), then:
1. Write `/var/run/reboot-required` and `/var/run/reboot-required.pkgs` (`linux-image-e2e-test`) in the agent, and run `sh /tmp/host-reporter.sh`.
   - Expect exit 0.
   - The master's `kubectl get node <agent> -o jsonpath='{.metadata.annotations.vibecarbon\.dev/host-state}'` parses to `{ rebootRequired: true, packages: ['linux-image-e2e-test'] }`.
2. Remove both files and run it again. Expect `rebootRequired: false`.
3. As the agent's kubelet credential, try to annotate the master's node. Expect a non-zero exit with stderr matching `/forbidden/i`; this proves NodeRestriction keeps the credential to its own Node.
4. `auth whoami` with the kubelet kubeconfig prints `system:node:<agent node name>`.

- [ ] **Step 2: Write the Ubuntu test**

1. Install `unattended-upgrades` in the container. Run the reporter with no k3s present: `/run/vibecarbon-host/state.json` parses to `rebootRequired: false`.
2. Create the two files and run again: `rebootRequired: true`, and `since` matches `/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/`.
3. `--print` prints the same JSON and writes nothing new. Check that the mtime of `state.json` is unchanged.
4. Every package that `grep -l notify-reboot-required /var/lib/dpkg/info/*.postinst` names matches `REBOOT_TRIGGER_PATTERNS`.
5. `INSPECT_SCRIPT('compose')` from Task 8 is added to this file in Task 8, not now.

- [ ] **Step 3: Run them**

Run: `DOCKER_INTEGRATION=true npx vitest run --project integration-docker tests/integration/docker/host-reporter-k3s.test.ts tests/integration/docker/host-reporter-ubuntu.test.ts`
Expected: PASS.
- If step 1.3 doesn't show `forbidden`, or 1.1 is refused, STOP and report the exact stderr. Don't work around it.
- If a reporter bug shows up, fix the snippet (Task 1 files) and rerun Task 1's tests too.

- [ ] **Step 4: Commit**

Message: `test(update): prove the host reporter on k3s and Ubuntu`.

---

### Task 3: Deliver the reporter to every server

**Files:**
- Modify the three k8s worker scripts:
  - `carbon/cloud-init/k3s/worker-init.sh`
  - `carbon/cloud-init/k3s/do-worker-init.sh`
  - `carbon/cloud-init/k3s/linode-worker-init.sh`

  In each, add `# @include _host-reporter.sh` after the k3s install block (the `if curl ... get.k3s.io ...` block and its `fi`), so the kubeconfig exists.
- Modify `src/lib/deploy/k8s/k3s.js:1509`: the pre-pull script becomes `withStableFlowLabel(withHostReporter(...))`.
- Modify `src/lib/deploy/compose/index.js:1415` (`setupComposeBackupCron`): its script becomes `withHostReporter(<cron script>)`.
- Re-capture `tests/fixtures/k3s-hetzner-worker-init-rendered.txt` the way `tests/unit/deploy/k3s-hetzner-byte-identical.test.ts` documents.
- Test: `tests/unit/deploy/host-reporter-census.test.ts`.

**Interfaces:** consumes `withHostReporter`, `HOST_REPORTER_SNIPPET` (Task 1) and `bootScriptFiles()` / `k8sBootScripts()` (`tests/_shared/k3s-boot-scripts.ts`).

- [ ] **Step 1: Write the failing census**

`host-reporter-census.test.ts` has four parts.
1. **Worker scripts.** Every k8s worker boot script (every `*worker-init.sh` from `bootScriptFiles()`, at least 3) contains `# @include _host-reporter.sh` after its `get.k3s.io` line. Its rendered form (`loadCloudInit`) contains `vibecarbon-host-reporter.path`.
2. **Autoscaler.** The autoscaler config (`renderCarbonAutoscalerConfig`, as `stable-flowlabel-census.test.ts` builds it) contains `vibecarbon-host-reporter.path` for every k8s provider.
3. **Carriers.** Pass recording fakes and check that both scripts contain the installer:
   - the `prePullImages` script (its `runCommandAsync` input);
   - the `setupComposeBackupCron` script (`runScript` seam).
4. **Size.** Every Hetzner worker and db render stays under `28 * 1024` bytes. Don't touch the master: it doesn't include the snippet.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run --project unit tests/unit/deploy/host-reporter-census.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the includes and both carriers**

Re-capture the worker fixture.

- [ ] **Step 4: Run the census and every test that pins these scripts**

Run:
```
npx vitest run --project unit tests/unit/deploy/host-reporter-census.test.ts tests/unit/deploy/k3s-hetzner-byte-identical.test.ts tests/unit/deploy/private-net-guard.test.ts tests/unit/deploy/cloud-init-units-started.test.ts tests/unit/deploy/stable-flowlabel-census.test.ts tests/unit/deploy/stable-flowlabel-deploy-census.test.ts tests/unit/iac/cloud-init-include.test.ts tests/unit/providers/hetzner-k8s-user-data.test.ts
```
Expected: PASS. A digest test of `CLOUD_INIT_DIR` may need its pinned digest updated. That's expected: say so in the commit body.

- [ ] **Step 5: Commit**

Message: `feat(update): install the host reporter on every server`.

---

### Task 4: Let the app see host state (compose bind, k8s RBAC, env name)

**Files:**
- Modify `carbon/docker-compose.prod.yml`: the `app:` service gets `volumes: ['/run/vibecarbon-host:/host-status:ro']`. Bind the directory (see `tests/unit/template/compose-role-bind.test.ts` for why a directory, not a file). No `Z`.
- Modify `carbon/k8s/base/app/rbac.yaml`: add ClusterRole `vibecarbon-app-nodes` (`""` `nodes`: `get`, `list`) and ClusterRoleBinding `vibecarbon-app-nodes` to ServiceAccount `vibecarbon-app`, namespace `vibecarbon`.
- Modify `tests/unit/deploy/k8s-app-rbac-census.test.ts`. The app's namespaced Role stays exactly `pods` get/list and `pods/log` get. The app is bound to exactly one ClusterRole, granting exactly `nodes` get/list: no other resource, no write verb, no `*`.
- Modify `src/lib/deploy/app-runtime-env.js:33`: add `'VIBECARBON_ENV'` to `CORE_APP_KEYS`. Deliver its value (the base env name, without `-primary`/`-standby`) wherever `PROJECT_NAME`'s value is delivered, for compose and k8s.
- Test: `tests/unit/template/host-status-bind.test.ts`, the updated RBAC census, and `tests/unit/deploy/app-runtime-env-census.test.ts` (existing; it must pass with the new key delivered).

- [ ] **Step 1: Write the failing tests**

`host-status-bind.test.ts`, reading the YAML:
- `services.app.volumes` in the prod overlay equals `['/run/vibecarbon-host:/host-status:ro']`.
- No service in any compose file binds `/run` or `/var/run` as a whole.
- The base `docker-compose.yml` app service has no `volumes` (dev unchanged).

RBAC census: the new rules above. Extend the runtime env test with `VIBECARBON_ENV` present in a compose and a k8s render for env `production`, value `production`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit tests/unit/template/host-status-bind.test.ts tests/unit/deploy/k8s-app-rbac-census.test.ts tests/unit/deploy/app-runtime-env-census.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them again, plus `tests/integration/docker/compose-secret-reach.test.ts` in its tier if Docker is available**

Expected: PASS.

- [ ] **Step 5: Security review**

Dispatch the `security-reviewer` agent on this task's diff: the ClusterRole, the bind and the new env key. Fix what it confirms.

- [ ] **Step 6: Commit**

Message: `feat(update): let the app read host restart state`.

---

### Task 5: App reader and the super-admin endpoint

**Files:**
- Create `carbon/src/server/lib/k8s-api.ts`:
  - move `k8sCredentials`, `getPodDefaultGateway`, `testTcpConnection`, `getK8sApiEndpoint` and `k8sRequest` from `carbon/src/server/routes/_internal/services-status.ts:689-847`, unchanged, and import them back there;
  - add `export class K8sApiError extends Error { status: number }`;
  - add `export async function k8sGetJson<T>(path: string): Promise<T>`, which rejects with `K8sApiError` on any non-2xx.
- Create `carbon/src/server/lib/host-maintenance.ts`:
  - `export type HostServer = { name: string; reporting: boolean; rebootRequired: boolean; since: string | null; packages: string[] }`
  - `export type HostMaintenance = { runtime: 'compose' | 'kubernetes' | 'none'; envName: string | null; rebootRequired: boolean; since: string | null; servers: HostServer[] }`
  - `export function parseHostState(text: string)`, a TS port of Task 1's parser;
  - `export async function readHostMaintenance(deps?: { isKubernetes?: boolean; isDocker?: boolean; readFile?: (p: string) => Promise<string>; getNodes?: () => Promise<{ items: unknown[] }> }): Promise<HostMaintenance>`. Rules:
    - compose reads `/host-status/state.json`.
      - No `/host-status` directory (no bind, as in local dev) gives `runtime: 'none'`.
      - The directory without the file gives one server `{ name: 'this server', reporting: false, ... }`.
    - k8s calls `k8sGetJson('/api/v1/nodes')`.
    - Neither gives `runtime: 'none', servers: []`.
    - `since` is the earliest due `since`.
    - `envName` is `process.env.VIBECARBON_ENV || null`.
- Create `carbon/src/server/routes/v1/admin/host-maintenance.ts` (`hostMaintenanceRoutes`, `use('*', requireSuperAdmin)`, `GET /`):
  - 200 returns the `HostMaintenance` JSON;
  - a `K8sApiError` or read failure returns 503 `{ error: sanitizeError(err, 'Could not read server restart state') }`.
- Mount it at `carbon/src/server/index.ts:196-203` as `app.route('/api/v1/admin/host-maintenance', hostMaintenanceRoutes)`, and add an OpenAPI entry next to `:406`.
- Test:
  - `carbon/tests/unit/host-maintenance.test.ts` (parser against `carbon/tests/fixtures/host-state/*`, and the reader with fake deps);
  - `carbon/tests/integration/server/routes/admin-host-maintenance.test.ts` (pattern: `admin-jobs.test.ts`).

- [ ] **Step 1: Write the failing tests**

Reader:
- compose with `due.json` gives `{ runtime: 'compose', rebootRequired: true, servers: [{ name: 'web-1', reporting: true, packages: [...] }] }`.
- compose with the directory present but no `state.json` gives `servers[0].reporting === false` and `rebootRequired: false`.
- compose with no `/host-status` directory gives `runtime: 'none'` and `servers: []`.
- k8s with two nodes, one annotated `due.json` and one without, gives `rebootRequired: true`, with `servers` naming both, the second `reporting: false`.
- `getNodes` rejecting with `new K8sApiError(403)` makes `readHostMaintenance` reject. It never resolves "not due" (Review Focus 5).
- `parseHostState` returns the same objects as Task 1's JS parser for every fixture: assert the literal expected objects in both test files.

Route:
- A non-super-admin gets 403.
- A super admin gets 200 with the reader's JSON (mock `@server/lib/host-maintenance`).
- The reader throwing gives 503 with an `error` string.

`k8sGetJson`: a fake server answering 403 rejects with `status === 403`.

- [ ] **Step 2: Run them and see them fail**

Run: `cd carbon && npx vitest run --project unit tests/unit/host-maintenance.test.ts && npx vitest run --project integration tests/integration/server/routes/admin-host-maintenance.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

The services-status tests must stay green after the move.

- [ ] **Step 4: Run them, plus the template structural censuses**

Run: `cd carbon && npx vitest run --project unit tests/unit/host-maintenance.test.ts tests/structural && npx vitest run --project integration tests/integration/server/routes/admin-host-maintenance.test.ts tests/integration/server/routes/`
Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(template): super-admin endpoint for server restart state`.

---

### Task 6: Admin notice

**Files:**
- Create `carbon/src/client/hooks/api/useHostMaintenance.ts`: `useQuery({ queryKey: ['admin', 'host-maintenance'], queryFn: () => apiJson<HostMaintenance>('/api/v1/admin/host-maintenance'), staleTime: 60_000, retry: false })`. Export it from `hooks/api/index.ts`.
- Create `carbon/src/client/components/admin/HostMaintenanceNotice.tsx`. It renders nothing when loading, on error, for `runtime: 'none'`, or when nothing is due and every server reports.
- Modify `carbon/src/client/components/layouts/SidebarLayout.tsx`: add an optional `banner?: ReactNode` prop, rendered above the `Outlet` inside `SidebarInset`.
- Modify `carbon/src/client/App.tsx:227-247`: the admin group's element passes `banner={<HostMaintenanceNotice />}`. User routes pass nothing.
- Modify `carbon/src/client/locales/en.json`: add `admin.hostMaintenance.*`.
- Test: `carbon/tests/component/host-maintenance-notice.test.tsx`.

**Copy** (exact English; `{{servers}}` is a comma-joined list, `{{command}}` is `vibecarbon update <envName>` or `vibecarbon update <your environment>` when `envName` is null):

| Key | Text |
|---|---|
| `title` | "Your servers need a restart to finish security updates" |
| `body` | "Security updates are installed on {{servers}} and take effect after a restart. Nothing restarts on its own. To restart safely, run {{command}} from your project." |
| `docsLink` | "How updates work" (links to `/docs/cli#update`) |
| `showPackages` | "Show packages" |
| `notReporting` | "{{servers}} not reporting yet. Run {{command}} once to set it up." |

- **Due:** `Alert` (default variant) with `IconAlertTriangle`, the title, the body, the docs link, and a `Collapsible` listing each due server's packages.
- **Not reporting:** the `notReporting` line, shown even when nothing is due.

- [ ] **Step 1: Write the failing component test**

- Mock `apiJson`. A due response renders the title, `web-1`, `vibecarbon update production`, and a link with `href="/docs/cli#update"`.
- `envName: null` renders `vibecarbon update <your environment>`.
- A not-reporting server renders its `notReporting` line.
- A rejected query renders nothing (`container` empty). So does `runtime: 'none'`.

- [ ] **Step 2: Run it and see it fail**

Run: `cd carbon && npx vitest run --project component tests/component/host-maintenance-notice.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run it, plus the i18n censuses**

Run: `cd carbon && npx vitest run --project component tests/component/host-maintenance-notice.test.tsx && npx vitest run --project unit tests/structural/i18n-key-resolution.test.ts tests/structural/i18n-parity.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(template): admin notice when servers need a restart`.

---

### Task 7: Daily restart email

**Files:**
- Create `carbon/src/server/jobs/host-maintenance-email.ts`:
  - `export const HOST_MAINTENANCE_LOCK_KEY = '7264519330021877'`
  - `export const NOTICE_KEY = 'host_maintenance_notice'`
  - `export function msUntilNextDailyRun(now: Date, hourUtc = 9): number`, always > 0, so a time exactly at 09:00:00.000 gives 24 h.
  - `export type NoticeRecord = { since: string | null; firstSeenAt: string | null; lastEmailedAt: string | null; lastCheckedAt: string | null }`
  - `export type CheckOutcome = 'skipped-no-email' | 'skipped-locked' | 'skipped-standby' | 'skipped-already-checked' | 'none-due' | 'sent-first' | 'sent-reminder' | 'not-due-yet' | 'error'`
  - `export async function runHostMaintenanceCheck(now: Date, deps: CheckDeps): Promise<CheckOutcome>`
  - `export function startHostMaintenanceEmails(): () => void`, which arms an unref'd `setTimeout` chain and returns `stop`.
- `CheckDeps = { emailConfigured(): boolean; withTryLock<T>(fn: () => Promise<T>): Promise<T | 'locked'>; inRecovery(): Promise<boolean>; readRecord(): Promise<NoticeRecord | null>; writeRecord(r: NoticeRecord): Promise<void>; readHosts(): Promise<HostMaintenance>; listRecipients(): Promise<string[]>; send(to: string[], email: { subject: string; html: string }): Promise<void> }`
- **Real deps:**
  - `withTryLock`: `pool.connect()`, `select pg_try_advisory_lock($1::bigint) as ok`, `pg_advisory_unlock` in `finally`, release.
  - `inRecovery`: `select pg_is_in_recovery()`.
  - Record: in `app_settings` via `adminDb` (`onConflictDoUpdate` on `key`).
  - `listRecipients`: `adminDb` select of `user.email` where `role = 'super_admin'`, `email_verified`, and `banned` is not true.
  - `send`: `sendEmail`.
  - `readHosts`: `readHostMaintenance`.
- Modify `carbon/src/server/emails/templates.ts`: `export function hostRestartDueEmail(o: { servers: HostServer[]; command: string; docsUrl: string; reminder: boolean }): { subject: string; html: string }`.
  - Subject: `Restart needed to finish security updates`, or with `Reminder: ` in front.
  - The body uses the same sentences as Task 6's `title`/`body`, a per-server package list, and the docs link. Use `escapeHtml` and `layout`.
- Modify `carbon/src/server/index.ts:607`: after `void startDatabase();`, `const stopHostMaintenanceEmails = startHostMaintenanceEmails();`. Call it in `shutdown` (`:613`).
- Modify `carbon/tests/structural/db-access-census.test.ts`: add the new file to `ADMIN_DB_ALLOWLIST` and `POOL_ALLOWLIST` with a reason ("server-only job: lists super admins and keeps its own record; takes a try-lock on a dedicated client").
- Test: `carbon/tests/unit/host-maintenance-email.test.ts`, `carbon/tests/db/host-maintenance-lock.test.ts`.

**The check, in order:**
1. `emailConfigured()` false: `skipped-no-email`.
2. Lock not taken: `skipped-locked`.
3. Inside the lock:
   1. In recovery: `skipped-standby`.
   2. The record's `lastCheckedAt` is on the same UTC date as `now`: `skipped-already-checked`.
   3. Read hosts. On a throw, log it and return `error` without writing.
   4. Not due: write `{ since: null, firstSeenAt: null, lastEmailedAt: null, lastCheckedAt: now }` and return `none-due`.
   5. Due and `record.since !== hosts.since`: send to all recipients (none means no send), write `{ since: hosts.since, firstSeenAt: now, lastEmailedAt: now, lastCheckedAt: now }`, and return `sent-first`.
   6. Due, same `since`, and the UTC calendar-day difference from `lastEmailedAt` to `now` is 7 or more: send with `reminder: true`, update `lastEmailedAt` and `lastCheckedAt`, and return `sent-reminder`.
   7. Otherwise write `lastCheckedAt` and return `not-due-yet`.
4. A send failure is logged, and `lastEmailedAt` stays unchanged (so it retries the next day).

- [ ] **Step 1: Write the failing tests**

Unit tests, with fake deps and fixed `now`:
- Each of the nine outcomes has its own case.
- `sent-first` sends once to `['a@x.test', 'b@x.test']` with subject `Restart needed to finish security updates`.
- 6 days later the outcome is `not-due-yet` with no send. 7 calendar days later at 09:00 it is `sent-reminder` with subject `Reminder: Restart needed to finish security updates`.
- After the restart clears (`none-due`), a new due condition gives `sent-first` again.
- A second call on the same UTC date gives `skipped-already-checked`, even when the first ran at 09:00 and the second at 14:00 (the restart-after-09:00 case).
- `msUntilNextDailyRun(new Date('2026-11-16T08:59:00Z'))` is `60_000`. `msUntilNextDailyRun(new Date('2026-11-16T09:00:00Z'))` is `86_400_000`.

Db test (`describe.skipIf(!dbTestsEnabled)`): two concurrent `withTryLock` calls on the real pool give exactly one `'locked'`.

- [ ] **Step 2: Run them and see them fail**

Run: `cd carbon && npx vitest run --project unit tests/unit/host-maintenance-email.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them, the structural censuses, and the db test if a test db is up**

Run: `cd carbon && npx vitest run --project unit tests/unit/host-maintenance-email.test.ts tests/structural && npm run typecheck`, and `npm run test:db` per the CI recipe in `.github/workflows/test.yml:320` when Postgres is available.
Expected: PASS.

- [ ] **Step 5: Security review**

Dispatch the `security-reviewer` agent on Tasks 5 to 7 together: the endpoint, the recipients query, the email HTML escaping and the lock. Fix what it confirms.

- [ ] **Step 6: Commit**

Message: `feat(template): daily email when servers need a restart`.

---

### Task 8: `update` inventory and inspect

**Files:**
- Create `src/lib/update/inventory.js`, `src/lib/update/inspect.js`
- Test: `tests/unit/update/inventory.test.ts`, `tests/unit/update/inspect.test.ts`. Add the probe case to `tests/integration/docker/host-reporter-ubuntu.test.ts`.

**Interfaces:**
- `UpdateTarget = { name: string, ip: string, side: 'primary' | 'standby', role: 'server' | 'master' | 'worker' | 'db', kind: 'compose' | 'k8s', masterIp?: string, nodeName?: string }`
- `Skipped = { name: string, ip: string | null, reason: string }`
- `listUpdateTargets(envName, envConfig, deps = { sshKubectl }): Promise<{ tier, targets: UpdateTarget[], skipped: Skipped[] }>`. Rules:
  - compose: the one server, `role: 'server'`, side primary.
  - compose-ha: the `servers[]` entries with `role` primary and standby.
  - k8s and k8s-ha:
    - For each cluster, the primary master from `resolvePrimary`, and on k8s-ha the other side's `masterIp`, run `sshKubectl(masterIp, key, ['get', 'nodes', '-o', 'json'], { timeout: 20_000 })`.
    - Role: the `node-role.kubernetes.io/control-plane` label gives `master`, `dedicated=db` gives `db`, otherwise `worker` via `isWorkerNode`.
    - `ip` is the node's `ExternalIP`. A node without one is skipped with `'no public address'`.
    - A cluster whose master can't be read is skipped as a whole: `'could not list nodes through <master ip>: <why>'`.
  - The tier comes from `resolveTier`.
- `TargetState = { host: HostState, bootId: string, ubuntu: string[], docker: { packages: Array<{ name: string, from: string, to: string }> } | null }`
- `INSPECT_SCRIPT(kind: 'compose' | 'k8s'): string`: POSIX sh, printing sections:
  1. `@@host` then `hostReporterScript()` run with `--print`;
  2. `@@boot-id` then `/proc/sys/kernel/random/boot_id`;
  3. `@@ubuntu` then the package names from `unattended-upgrade --dry-run --verbose`'s `Packages that will be upgraded:` line, after `apt-get APT_LOCK_OPT update -qq`;
  4. compose only: `@@docker` then `apt-cache policy` of `DOCKER_PACKAGES`, after the Docker-only update `docker-install.js` uses.
- `parseInspectOutput(stdout: string, kind): TargetState`, which throws `Error('inspect output missing @@<section>')`.
- `inspectTarget(target, deps = { sshRun }): Promise<TargetState>`: `sshRun(ip, key, ['sh', '-s'], { input, timeout: 180_000, transportRetry: false })`.
- `inspectAll(targets, deps): Promise<{ inspected: Array<{ target, state }>, skipped: Skipped[] }>`: parallel, and a target that throws becomes `Skipped` with `describeSshError(err)` (from `cluster-snapshot.js`).

- [ ] **Step 1: Write the failing tests**

Inventory:
- A compose config gives one target named `master`.
- compose-ha gives primary and standby.
- k8s with a fake `sshKubectl` returning three nodes (use `tests/_shared/fake-nodes.ts`) gives roles master, worker and db, with `ip` from `ExternalIP`.
- A node without `ExternalIP` lands in `skipped` with `no public address`.
- k8s-ha calls `sshKubectl` with both masters.
- A rejecting `sshKubectl` gives one `skipped` entry naming the master (Review Focus 1).

Inspect:
- `parseInspectOutput` on a captured fixture (`tests/fixtures/update/inspect-compose.txt`, holding real `apt-cache policy` and `unattended-upgrade` output from the Ubuntu container) gives `ubuntu` names, `bootId`, and `docker.packages` with `from !== to` only.
- A missing `@@boot-id` throws.
- `inspectAll` with one rejecting target gives that target in `skipped` and the others in `inspected` (Review Focus 1).

Docker: in the Ubuntu container, `INSPECT_SCRIPT('compose')` runs and parses (Docker's apt source may be absent there; the parser must then return `docker: null`).

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit tests/unit/update/`
Expected: FAIL.

- [ ] **Step 3: Implement**

Capture the fixture from the Ubuntu container run.

- [ ] **Step 4: Run them, and the Docker test**

Run: `npx vitest run --project unit tests/unit/update/ && DOCKER_INTEGRATION=true npx vitest run --project integration-docker tests/integration/docker/host-reporter-ubuntu.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(update): list and inspect an environment's servers`.

---

### Task 9: The plan and its text

**Files:**
- Create `src/lib/update/plan.js`, `src/lib/update/text.js`
- Test: `tests/unit/update/plan.test.ts`, `tests/unit/update/text.test.ts`

**Interfaces:**
- `DOWNTIME = { restart: [60, 180], docker: [30, 60], dockerThenRestart: [60, 240] }`
- `PlanStep = { target: UpdateTarget, state: TargetState, install: number, docker: TargetState['docker'], restart: 'due' | 'likely' | 'none', restartReason: string | null, effect: { kind: 'none' | 'no-traffic' | 'drained' | 'app-offline' | 'db-offline', seconds: [number, number] | null } }`
- `UpdatePlan = { envName, tier, steps: PlanStep[], skipped: Skipped[], total: [number, number] | null, outageServers: string[] }`
- `buildUpdatePlan({ envName, tier, inspected, skipped }): UpdatePlan`
- `formatPlan(plan): string[]`
- `formatTotal(plan): string`
- `formatDuration([min, max]): string`
- `isNothingToDo(plan): boolean`

**Order:**
- Standby side first, then primary.
- Within a side: `server`, then `worker` (by name), then `master`, then `db`.

**Restart:**
- `due` when `state.host.rebootRequired`, with the reason `mainPackage(state.host.packages)`.
- Else `likely` when a waiting Ubuntu package matches `REBOOT_TRIGGER_PATTERNS`, with that package as the reason.
- Else `none`.

**Effect:**

| Case | Effect |
|---|---|
| No install, no Docker, no restart | `none` (and the step is "nothing to do") |
| Standby side | `no-traffic` |
| `worker` | `drained` |
| compose or compose-ha primary | `app-offline` for `docker` when only Docker, `restart` when only a restart, `dockerThenRestart` when both |
| `master` restarting | `app-offline`, `restart` |
| `db` restarting | `db-offline`, `restart` |
| Ubuntu packages only, no restart | `none` |

`total` sums the `seconds` of every `app-offline` and `db-offline` step, or is `null` when there are none.

**Exact copy (`text.js`):**
- **Header:** `update plan for <env> (<tier>)`
- **Per step:** `<n>. <name> (<ip>)`, then indented lines from:
  - `install <N> security updates`
  - `update Docker: <pkg> <from> to <to>[, <pkg> <from> to <to>]`
  - `restart: due (<reason>)`, `restart: likely (<reason> is waiting to install)`, or `no restart expected`
  - `nothing to do`
- **Users-notice line,** by effect:

  | Effect | Text |
  |---|---|
  | `none` | `users notice: nothing` |
  | `no-traffic` | `users notice: nothing, this side takes no traffic` |
  | `drained` | `users notice: nothing, the node is drained first and the app keeps running elsewhere` |
  | `app-offline` (compose) | `users notice: the app is offline for <duration>` |
  | `app-offline` (master) | `users notice: the app is offline for <duration>, Traefik runs only on the master` |
  | `db-offline` | `users notice: requests that need the database fail for <duration>` |

- **Skipped:** `<name> (<ip or "no address">): skipped, <reason>. Check the server is running, then run vibecarbon update <env> again`
- **Total:** `expected downtime: <duration> in total, while <names joined with ", "> restart`, or `no downtime expected`.
- **`formatDuration`:**
  - `[30, 60]` gives `about 30 to 60 seconds`;
  - `[60, 180]` gives `about 1 to 3 minutes`;
  - `[120, 420]` gives `about 2 to 7 minutes`.
  - Minutes are rounded up; a range under 60 s on both ends stays in seconds.
- **Nothing to do:** `everything on <env> is up to date, nothing to do`
- **Confirm:** `Update <env> now?`
- **Unexpected restart prompt:** `<name> now needs a restart for <package>, which the plan did not show. The app is offline for <duration> while it restarts. Restart it now?`
- **Unexpected restart with `-y`:** `a restart became due on <name> (<package>): run vibecarbon update <env> again to restart it`
- **All clear:** `no reboot due on any server`
- **Summary line:** `<name>: installed <N> updates[, Docker <from> to <to>][, restarted][, app offline <m>m <s>s]`

- [ ] **Step 1: Write the failing tests**

Plan:
- A compose-ha plan has the standby step before the primary.
- A k8s plan with nodes `db`, `master`, `worker-2`, `worker-1` orders them `worker-1, worker-2, master, db`.
- `due`, `likely` and `none` come out as defined.
- A compose primary with Docker and a restart gets `seconds: [60, 240]` (one outage, not two).
- A k8s worker restart is `drained` with `seconds: null`.
- The total sums a master and a db restart to `[120, 360]`.
- `isNothingToDo` is true when every step installs nothing, has no Docker update and doesn't restart.
- Skipped targets pass through.

Text:
- Each line above appears exactly for a fixture plan.
- `formatTotal` for that plan is `expected downtime: about 2 to 6 minutes in total, while master, db restart`.
- No line contains `—` or `–`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit tests/unit/update/plan.test.ts tests/unit/update/text.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them and see them pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(update): plan the update and the downtime it costs`.

---

### Task 10: Execute the plan

**Files:**
- Create `src/lib/update/execute.js`
- Test: `tests/unit/update/execute.test.ts`

**Interfaces:**
- `executeUpdatePlan(plan, ctx, deps): Promise<{ outcomes: StepOutcome[], becameDue: Array<{ name, package }>, stoppedAt: StepOutcome | null }>`
  - `ctx = { envName, sshKeyPath, domain, projectName, yes: boolean, confirm: (message: string) => Promise<boolean>, log: { step(msg), info(msg), warn(msg) } }`
  - `deps = { sshRun, sshRunScript, sshKubectl, verifyAppHealth, fetchPublicDomain, now, sleep }`
- `StepOutcome = { name, installed: number, docker: Array<{ name, from, to }> | null, restarted: boolean, outageSeconds: number, error: string | null, hint: string | null }`
- `startOutageMonitor({ url, probe, intervalMs = 5000, now, sleep }): { stop(): { windows: Array<{ start: number, end: number }>, totalSeconds: number } }`. A failed probe or non-2xx opens a window; the next 2xx closes it.
- `releaseLeftoverCordons(masterIps, deps): Promise<string[]>`: uncordons Ready nodes carrying `vibecarbon.dev/cordoned-by-update` and removes the mark. Returns their names.
- k8s argv builders, all run with `sshKubectl` on the target's `masterIp`:
  - `cordonArgv(node)`
  - `markArgv(node)`, which adds the mark annotation
  - `drainArgv(node)`: `['drain', node, '--ignore-daemonsets', '--delete-emptydir-data', '--timeout=300s']`
  - `uncordonArgv(node)`
  - `unmarkArgv(node)`

**Per step, in order:**
1. **Install the reporter:** `sshRunScript(ip, key, hostReporterInstaller(), { timeout: 60_000 })`. A failure warns and the step goes on.
2. **Ubuntu updates** (if `install > 0`): `unattended-upgrade --verbose`, timeout 1,200,000 ms. On a non-zero exit or timeout, stop the run. The `error` holds the last 5 non-empty output lines, and `hint` is `run vibecarbon update <env> again once <name> is reachable and apt is free`.
3. **Docker** (if `docker`): Docker-only `apt-get update`, then `apt-get APT_LOCK_OPT install -y --only-upgrade -o Dpkg::Options::=--force-confold <DOCKER_PACKAGES>` with `DEBIAN_FRONTEND=noninteractive`, timeout 600,000 ms. If no restart follows, wait for `verifyAppHealth(ip, key, projectName, { domain, budgetMs: 300_000 })`.
4. **Re-read** `/var/run/reboot-required`. Restart now when the step's restart was `due`, or was `likely` and the file exists. Then:
   - **file exists but the plan said `none`:**
     - with `ctx.yes`: record it in `becameDue` and don't restart;
     - otherwise: `ctx.confirm(<unexpected restart prompt>)`, and restart on yes.
   - **`likely` but no file:** no restart.
5. **Restart:**
   1. On k8s: cordon and mark, then drain only when `role === 'worker'`.
   2. Read the boot id, then `systemd-run --on-active=2 --unit=vibecarbon-update-reboot systemctl reboot`.
   3. Poll the boot id every 5 s (`transportRetry: false`, `timeout: 10_000`) until it differs, with a 600,000 ms budget.
   4. **Then wait:**
      - compose: `verifyAppHealth` with a 300,000 ms budget.
      - k8s:
        - when the target is the master, `sshKubectl ... get --raw /readyz` answers `ok`;
        - the node is `Ready`;
        - `waitForKubeletsRenewing` (reading leases through the master) settles;
        - every pod with `spec.nodeName=<node>` is Ready or Succeeded within 300,000 ms;
        - then uncordon and unmark.
   5. **Timeout:** any wait that runs out stops the run with `error: '<name> did not <come back | become healthy> within <budget>: <last thing seen>'`.
      - k8s: `hint: 'it is still cordoned, run vibecarbon update <env> again once it is Ready, which uncordons it'`.
      - compose: `hint: 'check it in your provider console, then run vibecarbon status <env>'`.
6. **Outage:** `outageSeconds` is the overlap of the monitor's windows with the step's start and end.

`ctx.domain`'s outage monitor runs for the whole execution; the probe is `fetchPublicDomain('https://<domain>/api/health/ready', {}, { timeoutMs: 5000 })`.

- [ ] **Step 1: Write the failing tests**

Use fakes built with `withSshContract`, and a fake clock.
- **compose restart:** argv order is reporter install, `unattended-upgrade`, the reboot-required check, `systemd-run ... systemctl reboot`, boot-id polls until it changes, then `verifyAppHealth`. The outcome is `restarted: true`.
- **k8s worker:** `cordon`, the mark, then `drain` with `--timeout=300s` happen before reboot; `uncordon` and the unmark come after the pods are Ready.
- **master and db:** they get `cordon` but never `drain`.
- **Unexpected restart:** `-y` gives no reboot argv and `becameDue` naming the server and package. Without `-y`, `confirm` is called with the exact prompt text, and on `false` there's no reboot.
- **`likely` without the file:** no reboot.
- **Review Focus 2:** `unattended-upgrade` rejects with `status: 100` and `stdout` ending in `E: Could not get lock /var/lib/dpkg/lock-frontend`. The run stops at that step, the `error` contains that line, and no later target is touched.
- **Review Focus 3:** the boot id never changes. The run stops after a 600,000 ms fake budget with `error` matching `/did not come back within 10 minutes/`. On k8s the `hint` contains `still cordoned`.
- **Review Focus 4:** `releaseLeftoverCordons` with one marked Ready node and one marked NotReady node uncordons only the Ready one and returns its name.
- **Outage monitor:** probes `[ok, fail, fail, ok]` at 5 s intervals give one window of 10 s.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run --project unit tests/unit/update/execute.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Reuse `waitForKubeletsRenewing` (`src/lib/deploy/k8s/kubelet-liveness.js:33`), `verifyAppHealth` (`src/lib/deploy/compose/index.js:925`), `pollUntil` (`src/lib/retry.js:30`), and the Docker-only update options already in `src/lib/iac/docker-install.js:40` (export them if they're file-local; don't copy them).

- [ ] **Step 4: Run it and see it pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(update): run the plan one server at a time`.

---

### Task 11: The `update` command, help and CLI docs

**Files:**
- Create `src/update.js`:
  - `export const SPEC = { name: 'update', summary: "Install your servers' system updates and restart them when needed", description, positional: [{ name: 'env', optional: true, description: 'Environment to update' }], flags: [h, v, y ('Skip the confirmation prompt'), json ('Print the plan and the result as JSON'), env], examples }`
  - `export async function run(args)`
- Modify `src/cli.js` (`KNOWN_COMMANDS` at `:133`, a `case 'update'` next to `:335`) and `src/lib/cli/command-registry.js` (a `deploy` entry after `scale`, `usage: '[env]'`).
- Modify `src/upgrade.js:117` (its `description` gains the pointer line below), `tests/unit/cli/command-registry.test.ts` (the deploy order ends `..., 'scale', 'update'`), and `tests/integration/cli/routing.test.ts:79`.
- Modify `carbon/content/docs/cli.mdx`: a `## update` section after `## scale`'s flags region (`:764`), before `# Debug & Access`, with the `{/* BEGIN GENERATED: flags update */}` / `END` pair. Then run `pnpm docs:cli`, which regenerates README.md, AGENTS.md and `cli.mdx`.
- Test: `tests/unit/update/arg-parser.test.ts` (with `itParsesBooleanFlags`, `itParsesEnvSeed`, `itRejectsDoubleDash` from `tests/_shared/arg-parser-suite.ts`), `tests/unit/update/run.test.ts`, and `tests/integration/cli/update/update.test.ts`.

**`description`** (lines joined with `\n`):
1. `Installs the security updates waiting on each server of an environment, and Docker updates on compose servers, then restarts the servers that need it, one at a time.`
2. `Before it changes anything it shows the plan and the downtime to expect. Nothing restarts on its own: your servers install security updates daily and wait for you to run this.`
3. `Looking for vibecarbon upgrade? That one updates your project's infrastructure files from the template.`

`upgrade`'s description gains: `Looking for vibecarbon update? That one installs your servers' system updates and restarts them.`

**`run(args)` flow:**
1. `parseFlagsOrExit`
2. `assertInProjectDir`
3. `introCommand('update')`
4. `resolveEnvContext({ actionVerb: 'update', ... })`
5. the operator-IP firewall refresh, exactly as `src/backup.js:589`
6. check the SSH key exists
7. `listUpdateTargets`
8. On k8s, `releaseLeftoverCordons` with the targets' distinct `masterIp`s, logging `p.log.info('uncordoned <names>, left from an earlier update')`. Then `inspectAll`, then `buildUpdatePlan`.
9. **Nothing to do:** print the nothing-to-do line and exit 0, with no prompt (with `-json`, print the JSON).
10. Print `formatPlan` and `formatTotal` (skip both with `-json`).
11. **Off a TTY without `-y`:** `requireTTYOrFlags({ requirements: [{ flag: 'y', description: 'apply this plan without the confirmation prompt', satisfied: false }] })`, after the plan is printed.
12. **On a TTY without `-y`:** `p.confirm({ message, initialValue: false })`, then `exitCancelled` / `exitDeclined`.
13. `executeUpdatePlan`, then re-inspect the reached targets' `host` state.
14. Print the summary lines, then `becameDue` lines, then the all-clear line only when every reached target reports no restart due.
15. Exit 1 when `stoppedAt` is set, printing its `error` and `hint`.

**`-json` output:**
```
{ env, tier,
  plan: [{ name, role, side, install, docker, restart, restartReason, expectedSeconds }],
  skipped,
  expectedDowntime: { min, max } | null,
  outcomes,
  becameDue,
  measuredDowntimeSeconds }
```
- With `-json`, the human plan isn't printed.
- `-json` without `-y` off a TTY prints the JSON plan (with `outcomes: []`) and exits 0 without changing anything.

**`cli.mdx` `## update` prose** (hand-written, above the generated flags region):
- what it updates: Ubuntu security updates on every server, and Docker on compose servers;
- that nothing restarts on its own;
- the plan, with the downtime table from the spec in plain words;
- `-y`, and "a restart that becomes due during a `-y` run waits for the next run";
- what to do when a server doesn't come back;
- that it is not `upgrade`.

**Every other docs page** that lists deploy commands (`carbon/content/docs/deployment.mdx`, `carbon/content/docs/environments.mdx`) gets a one-line mention with a link to `/docs/cli#update`.

- [ ] **Step 1: Write the failing tests**

- **Arg parser:** the suite helpers, and `-json` and `-y` parse as booleans.
- **`run.test.ts`** (modules mocked):
  - nothing to do gives exit 0, no confirm, and the nothing-to-do line;
  - off a TTY without `-y`, the plan is printed, then `requireTTYOrFlags` is called with flag `y`, and `executeUpdatePlan` is never called;
  - `-json -y` prints a parseable document with `measuredDowntimeSeconds`;
  - a stopped run exits 1, printing `error` and `hint`.
- **Integration** (`runCli`, `realProject`):
  - `vibecarbon update -h` exits 0, shows the summary and `Looking for vibecarbon upgrade?`;
  - `vibecarbon upgrade -h` shows `Looking for vibecarbon update?`;
  - `vibecarbon -h`'s DEPLOY COMMANDS block lists `update [env]` after `scale [env]`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit tests/unit/update/arg-parser.test.ts tests/unit/update/run.test.ts tests/unit/cli/command-registry.test.ts && npx vitest run --project integration tests/integration/cli/update/update.test.ts tests/integration/cli/routing.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement, write the `cli.mdx` section, then run `pnpm docs:cli`**

- [ ] **Step 4: Run them, the docs tests and the help censuses**

Run: `npx vitest run --project unit tests/unit/update/ tests/unit/cli/ tests/unit/docs/cli-docs-generated.test.ts tests/unit/docs/cli-docs-census.test.ts && npx vitest run --project integration tests/integration/cli/update/ tests/integration/cli/routing.test.ts tests/integration/cli/`
Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(update): vibecarbon update command, help and docs`. Include the regenerated README.md and AGENTS.md.

---

### Task 12: `status` shows a due restart

**Files:**
- Create `src/lib/status/host-states.js`:
  - `checkHostStates(envName, envConfig, deps): Promise<Array<{ name: string, reporting: boolean, state: HostState | null, error?: string }>>`
  - `hostStateRows(envName, hosts): Array<{ label: string, text: string }>`
- Modify `src/status.js`:
  - `checkEnvironmentRemote` (`:804`) runs `checkHostStates` as a fourth `Promise.allSettled` member, sharing the snapshots;
  - `checks.hostState` goes into the JSON;
  - `renderEnvironment` adds the rows after the Write fence row (`:1570`), with `c.warning` text.
- Test: `tests/unit/status/host-states.test.ts`, and extend `tests/unit/status/render-environment.test.ts`.

**Behavior:**
- **Compose targets** (from `planContainerTargets`): `sshRun(ip, key, ['sh', '-s', '--', '--print'], { input: hostReporterScript(), timeout: 10_000, transportRetry: false })`, then `parseHostState`. This works without the reporter installed, so compose is always `reporting: true` when reachable.
- **k8s:**
  - Nodes come from `snapshots.get(masterIp)`, using `hostStateFromNode`.
  - On k8s-ha, also the other side's master. Its failure becomes a check error, `standby cluster: could not read nodes`, never "no restart due".
  - This module never lists nodes itself (`tests/unit/status/cluster-listing-census.test.ts`).

**Rows** (exact):
- Label `Restart due`. Text: `<names> need<s> a restart for <mainPackage> (since <Mon D>), run vibecarbon update <env> to install it`. Use `needs` for one server and `need` for several.
- Label `Restart check`. Text: `<names> not reporting yet, run vibecarbon update <env> once to set it up`.
- No rows when nothing is due and every server reports.

- [ ] **Step 1: Write the failing tests**

- `hostStateRows('production', [{ name: 'master', reporting: true, state: <due> }])` gives `[{ label: 'Restart due', text: 'master needs a restart for linux-image-6.8.0-90-generic (since Nov 15), run vibecarbon update production to install it' }]`.
- Two due servers give `master, worker-1 need a restart ...`.
- A not-reporting node gives the `Restart check` row.
- All clear gives `[]`.
- `checkHostStates` on k8s reads only the snapshot (no `sshRun` call). On compose it calls `sshRun` with `['sh', '-s', '--', '--print']` and `transportRetry: false`.
- `renderEnvironment` output contains the `Restart due` row when `checks.hostState` holds a due server.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project unit tests/unit/status/host-states.test.ts tests/unit/status/render-environment.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the status suite and the printed-command census**

Run: `npx vitest run --project unit tests/unit/status/ tests/unit/cli/printed-command-flags-census.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(status): show when servers need a restart`.

---

### Task 13: Repo docs

**Files:**
- Modify `docs/security.md`: a new section, "Security updates and restarts". It covers:
  - what installs by itself daily (Ubuntu security updates via unattended-upgrades on every server);
  - what waits for `vibecarbon update` (restarts, and Docker Engine on compose servers);
  - why nothing restarts on its own;
  - the three places a due restart shows up (`status`, the Super Admin notice, and the email when SMTP is set);
  - that the app reads host state through one read-only directory (compose) or Node annotations with read-only `nodes` access (k8s).
- Modify `carbon/PRODUCTION.md`: a short paragraph pointing to `vibecarbon update` and the security section.
- Modify `docs/technical.md`: the host reporter in the architecture section (files, units, the annotation, delivery paths), and why the master's user data doesn't carry it (Hetzner 28 KiB tripwire).
- Test: none new. Run the docs censuses.

- [ ] **Step 1: Write the three sections**

No em or en dashes, plain words, second person. Mode names appear only as proof.

- [ ] **Step 2: Run the docs and copy censuses**

Run: `npx vitest run --project unit tests/unit/docs/`
Expected: PASS.

- [ ] **Step 3: Commit**

Message: `docs(update): security updates and restarts`.

---

### Task 14: The e2e `update` step

**Files:**
- Modify:
  - `tests/e2e/scenarios/types.ts:72`: add `'update'` to `STEP_NAMES` right after `'verify-status'`.
  - `tests/e2e/scenarios/_run-lifecycle.ts`:
    - a `StepDef` after `verify-status` (`:2951`);
    - `TIMEOUTS.update = 25 * 60_000` (`:227`);
    - every mode runs it.
  - `tests/e2e/scenarios/step-dependencies.ts`: `update` depends on `deploy`.
  - `tests/e2e/metrics/reporter.ts:505`: add `'update'` to `NON_PERF_STEPS`.
  - `tests/e2e/utils/iter-step-args.js:12`: add `'update'` to `ITER_STEPS`.
  - `tests/e2e/utils/cli-runner.ts`: add `runUpdate(env, o)`, which runs `` `update ${env} -y -json` ``.
- Create `tests/e2e/checks/host-restart.ts`. Its check names are:
  - `restart_due_status`
  - `restart_due_admin`
  - `restart_due_annotation` (k8s only)
  - `update_ran`
  - `restart_cleared`
  - `downtime_within_plan`
- Test: `tests/unit/e2e/host-restart.test.ts`, plus the existing step-list and iter-step tests.

**Step behavior:**
1. **Target:**
   - compose and compose-ha: the primary server;
   - k8s and k8s-ha: the first worker of the primary cluster, found with `sshKubectl(master, key, ['get', 'nodes', '-l', WORKER_NODE_SELECTOR, '-o', 'json'])`, using its `ExternalIP`.
2. **Mark it** over SSH:
   ```
   printf '*** System restart required ***\n' > /var/run/reboot-required
   printf 'linux-image-e2e-test\n' > /var/run/reboot-required.pkgs
   ```
3. **Within 90 s,** each of these must show it:
   - `vibecarbon status <env> -json` has `checks.hostState` with the target due (`restart_due_status`);
   - with the super-admin session from `auth_admin_login` (`tests/e2e/checks/app-functional.ts:426`), `GET https://<domain>/api/v1/admin/host-maintenance` gives `rebootRequired: true` listing the target (`restart_due_admin`);
   - on k8s, the Node annotation parses to due (`restart_due_annotation`).
4. **Run** `runUpdate`: exit 0, and the JSON plan has the target with `restart: 'due'` (`update_ran`).
5. **Within 120 s after:** status, the endpoint and the annotation all show the target not due, and `https://<domain>/api/health/ready` answers 2xx (`restart_cleared`).
6. **`downtime_within_plan`:** `measuredDowntimeSeconds <= (expectedDowntime?.max ?? 0) + 30`. The 30 s is one poll interval of slack each side.

- [ ] **Step 1: Write the failing unit test**

Use a fake `runCli`, `fetch` and `sshRun`.
- The checks pass on a due-then-cleared sequence.
- `downtime_within_plan` fails with a message naming both numbers when measured is 400 and expected max is 180.
- Target selection picks the primary on compose-ha and a label-matched worker on k8s.
- `'update'` is in `STEP_NAMES` after `'verify-status'` and in `ITER_STEPS`.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run --project unit tests/unit/e2e/host-restart.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the e2e unit suite**

Run: `npx vitest run --project unit tests/unit/e2e/ tests/unit/metrics/step-matrix-after-failure.test.ts && pnpm lint`
Expected: PASS. Don't run real infrastructure in this task: the real run happens after merge, on GitHub (`.github/workflows/e2e-us-perf.yml`), when Brandon says go.

- [ ] **Step 5: Commit**

Message: `test(e2e): update step marks a restart due and checks it clears`.

---

## After the last task

1. **Whole-branch review:** `superpowers:requesting-code-review`, plus the `security-reviewer` agent on the full diff.
2. **Full local gate:**
   - `pnpm test:prepush` at the root;
   - `cd carbon && npm run typecheck && npm run test:prepush`;
   - `pnpm test:docker` for the two host-reporter files if Docker is available.
3. **Hand back to Brandon.** Pushing, opening the PR and the real e2e run each wait for his go.
