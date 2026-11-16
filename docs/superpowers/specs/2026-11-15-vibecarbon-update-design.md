# `vibecarbon update`: system updates, reboots and the notice that one is due

Status: approved by Brandon, 2026-11-15.

## Why

Every server installs Ubuntu's security updates by itself every day (unattended-upgrades). Some of them, mostly kernel updates, only take effect after a reboot. Nothing in vibecarbon reboots a server or tells anyone a reboot is due, so a kernel fix can sit inactive for months. Nothing reads `/var/run/reboot-required` today, and no command reboots or drains anything.

The operator needs two things. First, to find out when their servers need attention. Second, one safe command that brings the servers up to date and says beforehand what it will do and whether users will notice.

## Goals

1. **One command, `vibecarbon update <env>`.** It installs the system updates waiting on that environment's servers (Ubuntu's security updates everywhere, and Docker on compose servers), then reboots the servers that need it, one at a time and in a safe order. Before it changes anything, it shows the plan: which servers, what will happen to each, and the downtime to expect. *(Brandon)*
2. **The operator hears that a reboot is due**, in three places *(Brandon)*:
   - `vibecarbon status` shows it, with the `vibecarbon update <env>` command to run.
   - The app's Super Admin area shows a notice that only super admins see.
   - When the app's email is set up (`SMTP_*` in `.env`), every super admin gets an email.
3. **No server reboots on its own.** The operator chooses the moment. *(Brandon, agreeing with the recommendation)*
4. **One approach in all four modes** (compose, compose-ha, k8s, k8s-ha) and on all five providers.

## Non-goals

- **Automatic reboots on a schedule** (kured, Ubuntu's `Automatic-Reboot`). Possibly an opt-in later. Not now.
- **A general "your servers need attention" channel** (failed backups, disk space, certificates). The notice covers pending reboots only. *(Brandon)*
- **Kernel live patching** (Ubuntu Livepatch needs an Ubuntu Pro subscription per server).
- **App and platform images.** `update` covers the operating system only. `deploy` keeps owning container images and the version channel, including the k3s version. *(Claude's reading of "system updates".)*
- **Moving traffic to the standby to avoid the primary's restart outage on HA.** `failover` is a region move with its own write outage, DNS change time and a rebuild afterwards, which costs more than a 1 to 3 minute restart. The plan doesn't suggest it. *(Claude)*

## Anti-goals (a failure even if it works)

- A reboot the operator didn't expect, or downtime the plan didn't predict.
- A notice that won't go away after the reboot, or one that keeps emailing.
- A new path that widens what the app container can see of its host (the compose app runs read-only with no host mounts, and its Docker access is two GETs).
- Text a principled builder can't act on: every message says what's happening, why it matters and what to run.

## Constraints from the codebase

- **CLI conventions** (AGENTS.md "CLI conventions"):
  - single-dash flags, a `SPEC`, interactive by default, `requireTTYOrFlags` off a TTY;
  - `introCommand('update')` and `resolveEnvContext`;
  - context-sensitive messages in the existing voice (lowercase `p.log.info` hints, no em dashes);
  - every wait bounded;
  - the new-command checklist (`src/cli.js` case, `command-registry.js` entry in the `deploy` category, `## update` in `carbon/content/docs/cli.mdx`, then `pnpm docs:cli`).
- **`upgrade` already exists** ("Upgrade infrastructure files to the latest template", dev category). `update` sits next to it. The summaries must make the difference obvious, and each command's help should point to the other when someone likely meant it. Suggested `update` summary: "Install your servers' system updates and restart them when needed".
- **Updates today:**
  - Compose servers turn on unattended-upgrades in `carbon/cloud-init/docker-ce-setup.yaml:71-75`, with Ubuntu's default origins (security) and no automatic reboot.
  - k8s nodes run whatever the Ubuntu cloud image ships, which also runs unattended-upgrades (`src/lib/deploy/apt.js:6`, `wireguard.js:302-309`).
- **The app can't see its host today:**
  - The compose app has no volumes, is `read_only`, and its Docker proxy allows only the container list, logs and `_ping` (`carbon/docker-compose.prod.yml:300-328`).
  - On k8s the app's ServiceAccount can only list pods and read pod logs in its namespace (`carbon/k8s/base/app/rbac.yaml`). It can't read Node objects.
- **Super admins:**
  - `user.role = 'super_admin'` (`carbon/src/server/lib/auth.ts:7`).
  - The `notifications` table can't target super admins (visibility is `all | authenticated | public`). It holds operator-written broadcasts, so it is the wrong home for this.
- **Email:** `sendEmail` in `carbon/src/server/lib/email.ts` no-ops when SMTP isn't set. Nothing lists super admins yet.
- **No scheduler in the app.** pg_cron jobs are pure SQL. Several app replicas run on k8s (2 to 10), and the "run once" pattern is a Postgres advisory lock (`bootstrap-admin.ts:32-80`).
- **compose-ha:** both nodes run the app, but the standby's database is read-only, so only the primary's app can write. k8s-ha's standby runs no app.
- **The CLI already reaches servers:**
  - `status` SSHes every compose server (`src/lib/status/remote-containers.js:61-86`).
  - On k8s it reads Node objects through the master (`cluster-snapshot.js:31`).
  - Deploy-created nodes all carry the deploy SSH key (e.g. `hetzner-k8s.js:294,334,369`).

## How it works

### 1. Each server reports "reboot due" (decided: Claude)

Ubuntu marks a pending reboot by creating `/var/run/reboot-required`, and lists the packages that asked for it in `/var/run/reboot-required.pkgs`. Both live on tmpfs, so a reboot clears them.

Every server gets a small host-side reporter: a systemd `.path` unit watching that file, plus a oneshot service that also runs at boot.
- **Who installs it, idempotently** *(Claude)*:
  - cloud-init, on every new server and node, including autoscaler-created workers;
  - `update`, which SSHes every server and node anyway;
  - the compose `deploy`, which already SSHes every compose server.
- **The k8s `deploy` does not install it**, so it adds no per-node SSH step and costs nothing against the deploy time budgets. The reporter writes the state where each mode's app can read it, without widening the app's view of the host:

- **Compose and compose-ha:** it copies the two files into `/run/vibecarbon-host/` (tmpfs, so a reboot clears it too). The app container gets that one directory bind-mounted read-only (`/run/vibecarbon-host:/host-status:ro` in `docker-compose.prod.yml`). The app reads the file's presence, its mtime as "since", and the package list.
- **k8s and k8s-ha:** it annotates its own Node, e.g. `vibecarbon.dev/reboot-required: <since ISO>;<packages, truncated>`, and removes the annotation at boot when the file is gone. It authenticates with the node's own kubelet credential, so no new Secret or pod is needed: k3s enables NodeRestriction, which lets a node patch only its own Node object. The app's ServiceAccount gains one read-only ClusterRole: `nodes` with `get` and `list`.

Builder must verify on a real k3s server and agent:
- the kubelet kubeconfig path;
- that the kubelet identity may annotate its own Node.

If it can't, fall back to a ServiceAccount scoped to patching Nodes, held by the host unit. Never use a hostPath of `/var/run` in a pod, which would expose the container runtime's socket.

### 2. `vibecarbon status`

`status` adds one line per environment when any server has a reboot due.
- **Compose:** it reads the file over SSH, as it already reaches every compose server.
- **k8s:** it reads the annotation from the Node snapshot it already takes through the master. It does NOT SSH every node; that would undo the one-snapshot design. Alongside the reboot annotation, the reporter stamps a second annotation saying it is installed (e.g. `vibecarbon.dev/host-reporter: 1`). A node without it is listed as "not reporting yet", with `run vibecarbon update <env> once to set it up`. `status` never says a node is current when it can't tell. *(Claude)*

The line names the servers and the main package (e.g. `linux-image-…`) and ends with the command, `run vibecarbon update production to install it`. When no reboot is due, `status` shows nothing.

### 3. Super Admin notice

- **Endpoint:** a super-admin-only endpoint (`GET /api/v1/admin/host-maintenance`, behind `checkSuperAdmin`) returns `{ rebootRequired, since, servers: [{ name, packages }] }`. It reads the host-status directory on compose, or the Node annotations on k8s.
- **Where it shows:** admin pages show it as an `Alert`, following the Crawlers page pattern (`pages/admin/Crawlers.tsx:232-243`), in a shared spot so every `/admin` page shows it.
- **Text:** plain words. Security updates are installed and take effect after a restart. To restart safely, run `vibecarbon update <env>` from your project. It also lists the servers, and the packages behind an expander.
- Strings go through `t()` (carbon/AGENTS.md Localization).
- Nothing is stored. The notice is live, so it disappears once the reboots are done.

### 4. Email (decided: Claude)

An in-process check runs in the app server once a day *(Brandon: daily, not hourly)*.
- **When:** a fixed time of day (09:00 UTC), after Ubuntu's daily automatic-update run (apt-daily-upgrade, 06:00 plus up to an hour of random delay).
- **Why a fixed time:** an app restart (every deploy) doesn't push the check back the way a 24-hour interval timer would.
- **No check at startup.**
- The table below records `last_checked_at`, so a replica that restarts after 09:00 doesn't run the check twice that day.
- It takes `pg_try_advisory_lock`, so one replica does the work.
- It skips when the database is in recovery (the compose-ha standby) or when email isn't configured.
- When a reboot is due, it emails every super admin with a verified email address:
  - when the condition is first seen (keyed on the earliest "since");
  - then a reminder every 7 days while it stays due.
- It records checks and sends in a new small table, e.g. `host_maintenance_notices(key, first_seen_at, last_emailed_at, last_checked_at)`, with a migration and RLS for super-admin read only. The record stops repeats across restarts and replicas.
- The email names the servers and the command, and says nothing will reboot on its own.

### 5. `vibecarbon update <env>`

**Interface:** `vibecarbon update [<env>] [-y]`. With no env it prompts, like the other env-scoped commands. Off a TTY, `-y` is required. Without it, the command prints the plan and exits without changing anything.

**Step 1, look (no changes).** The command checks every server in the environment over SSH and, where it applies, through the master's kubectl:
- updates waiting, counted the same way unattended-upgrades counts them;
- whether a reboot is already due, and from which packages;
- the server's role: app server, standby, k8s master, worker, or database node.

**Step 2, show the plan, then confirm.** For each server, in the order it will go, the plan shows:
- what happens: install N updates, or nothing to do;
- whether it restarts, one of three *(Claude)*:
  - **restart: due.** The file is already there.
  - **restart: likely.** A package that asks for a restart is waiting: a kernel image, `libc6`, `systemd`, `dbus` or `linux-firmware`. The builder takes the exact list from Ubuntu's own reboot triggers.
  - **no restart expected.**
- what users will notice: the expected downtime, worked out from the mode and role:

| Mode | Server | Expected effect |
|---|---|---|
| compose | the server | Ubuntu updates: none expected. Docker update: the app is offline for about 30 to 60 seconds. Restart: the app is offline for about 1 to 3 minutes. Both on one server: one outage. |
| compose-ha | standby | None (no traffic). |
| compose-ha | primary | Same as compose: 30 to 60 seconds for a Docker update, 1 to 3 minutes for a restart, one outage when both. |
| k8s / k8s-ha | worker | None expected: the node is drained first and the app keeps 2 or more replicas (PDB `minAvailable: 1`). |
| k8s / k8s-ha | master | The app is offline for about 1 to 3 minutes. Traefik runs only on the master, on hostPorts 80 and 443 (`carbon/k8s/base/traefik/deployment.yaml`), and the cluster API pauses too. |
| k8s / k8s-ha | database node | Database restarts. Requests that need it fail for about 1 to 3 minutes. |
| k8s-ha | standby cluster | None (no traffic). |

It ends with a one-line total, e.g. `expected downtime: about 3 minutes, while web-1 restarts`, or `no downtime expected`, and asks to continue (default No; `-y` skips the prompt).

**Step 3, run, one server at a time:**

1. **Order:**
   - Standby side first (compose-ha standby node; k8s-ha standby cluster).
   - Then the primary side, workers before the master, the database node last.
   - The builder may adjust the order within a cluster with a stated reason.
2. **Install updates** the way the daily job does (`unattended-upgrade`, same origins), bounded and with output kept for the log. On compose servers, Docker's packages follow (see "Docker Engine is a system update").
3. **An install can create a restart the plan didn't predict.** The plan said "no restart expected", yet the reboot-required file now exists. *(Claude)*
   - Interactive: ask about that one server, naming the package and the downtime.
   - With `-y`: don't restart it. Finish the run, then end with `a restart became due on <server> (<package>): run vibecarbon update <env> again to restart it`. The second run plans it as "due".
   - `-y` therefore never causes downtime the plan didn't show.
4. **If a reboot is due or likely, and is now needed:**
   - On k8s, cordon and drain first, bounded, respecting PDBs.
   - Reboot (`systemctl reboot` over SSH).
   - Wait for the server to come back with a new boot id.
   - Then wait for it to be healthy:
     - compose: the stack's health, `/api/health/ready`;
     - k8s: the node Ready with its kubelet Lease renewing (`kubelet-liveness.js`), its pods Ready, then uncordon.
   - Every wait is bounded. A server that doesn't come back stops the run with a message naming the server, what was seen, and what to do.
5. **Measure, don't guess:** while it runs, poll the app's public health and record any real outage.

**Step 4, summary.** For each server it shows what was installed, whether it restarted, and how long the app was really unavailable. It ends with `no reboot due on any server` once the files are gone. If anything was skipped or failed, it names the next command.

## Docker Engine is a system update (Brandon, 2026-11-15)

Compose servers install Docker (docker-ce, containerd.io, runc and their companion packages) from Docker's own apt repository (`src/lib/iac/docker-install.js`). The daily unattended-upgrades job installs only from Ubuntu's security sources, so on an existing server Docker never updates, and neither do runc's container-escape fixes. `update` closes that gap.

- **Step 1** counts Docker's waiting packages separately from Ubuntu's.
- **Step 2** shows a Docker line per compose server: "update Docker 28.x to 29.y: every container restarts, the app is offline for about 30 to 60 seconds".
  - When the same server also restarts, the two share one outage: Docker is updated, then the server restarts. The plan shows one combined line and one downtime.
  - On compose-ha the standby goes first, as with restarts.
- **Step 3** upgrades exactly the packages `docker-install.js` installs, from the same repository, bounded. It then waits for the stack to be healthy (`/api/health/ready`) before moving on.
- **The daily automatic job still never touches Docker.** A dockerd restart is downtime, so it only happens when the operator runs `update`.
- **k8s nodes are unaffected.** They run k3s's own containerd, which `deploy` and the version channel manage.

## Docs *(Brandon: document it in the help, the markdown files and the user docs)*

`update` is a deploy command. It belongs in the **DEPLOY COMMANDS** section of `vibecarbon -h` (`src/lib/cli/help.js:219` renders that heading from the registry's `deploy` category), listed after `scale`. Each place it must appear:

- **CLI help:**
  - the `deploy`-category entry in `src/lib/cli/command-registry.js` (usage `[env]`) and the command's own `SPEC`;
  - `vibecarbon update -h`, which renders from that `SPEC`;
  - `vibecarbon upgrade -h`, which gets a line pointing to `update` for server updates. `update -h` gets the reverse.
- **Generated markdown**, all by `pnpm docs:cli`, with `tests/unit/docs/cli-docs-generated.test.ts` failing on drift:
  - the README's "Deploy: take an environment to the cloud (and back)" table (`README.md:144`);
  - AGENTS.md's command block;
  - the flag table in `cli.mdx`.
- **User docs:**
  - `carbon/content/docs/cli.mdx` gets a `## update` section with the `flags update` marker pair, plus hand-written prose: what it updates (Ubuntu security updates, and Docker on compose), the plan and the downtime per mode and role, the `-y` rule, and what to do when a server doesn't come back.
  - Any CLI overview page under `carbon/content/docs/` that lists the deploy commands gets the new row.
- **Repo docs:**
  - `docs/security.md` gets a section, "Security updates and restarts". It covers what updates by itself daily, what waits for `update`, why nothing restarts on its own, and the three places a due restart shows up.
  - `carbon/PRODUCTION.md` gets a short paragraph pointing to it.
  - `docs/technical.md` describes the host reporter in its architecture section.
- **The email and the Super Admin notice** link to the `update` section of the user docs.

## Testing (decided: Claude)

- **Unit tests:**
  - plan ordering and the downtime table per mode and role, with the key strings asserted;
  - the Docker line and the one-outage rule when a server needs both;
  - a census that `update`'s Docker package list matches `docker-install.js`;
  - parsing of the reporter's output and annotations;
  - the email check (first send, weekly reminder, no send on a standby or without SMTP, one replica via the lock, once per day even across a restart after 09:00 UTC);
  - the status line;
  - a census that every host-provisioning path (compose cloud-init, every k3s `*-init.sh` role, the deploy-time SSH install) installs the reporter.
- **Template tests:** the admin endpoint and RLS on the new table.
- **Real e2e:** a new lifecycle step, `update`, in every stock scenario after verify-deploy:
  - mark one server as needing a reboot (write the two files);
  - check that `status`, the admin endpoint and the Node annotation all show it;
  - run `vibecarbon update <env> -y`;
  - then check the notice is gone, the app is healthy, and the measured downtime is within the plan's prediction.
  - It reboots one server per scenario, so it adds about 3 to 5 minutes. Perf tables keep counting deploys only.

## Left to the builder

- Names of files, units and the annotation key.
- The exact unattended-upgrade invocation.
- The drain timeouts.
- The admin page placement.
- The email template layout.
- Flag spellings beyond `-y`.

The builder must verify:
- the kubelet-credential annotation on real k3s.
- that the autoscaler's worker cloud-init also gets the reporter. Autoscaler-created nodes already carry the deploy SSH key (`src/autoscaler/groups.js:287`).

## Risks

- **A node the CLI can't reach over SSH** (a firewall change, say). Its state can't be read and it can't be updated. The plan lists it as skipped and says why, and never claims it is current.
- **Existing k8s clusters** show "not reporting yet" in `status` and the app until one `update` run installs the reporter. That is honest, and the first `update` fixes it.
- **compose-ha:** each node's app sees only its own host. The primary's app is the one that notifies. A standby-only reboot due shows in `status` but not in the app notice. That is acceptable: both nodes get the same updates on the same schedule, and `update` handles both.
