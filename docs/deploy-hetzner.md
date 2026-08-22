# Vibecarbon: Hetzner Cloud Deployment

Deploying to Hetzner is fully automated by the CLI. You do not create servers,
configure firewalls, edit compose files, or set up replication by hand — one
command provisions the infrastructure, deploys the app, and wires DNS + TLS:

```bash
vibecarbon deploy
```

This guide covers what you need before that command, what it does, and how to
operate the result.

---

## Why Hetzner?

| Feature | Benefit |
|---------|---------|
| **Performance** | NVMe SSDs, AMD EPYC CPUs |
| **Simplicity** | Clean UI, straightforward pricing |
| **EU and US regions** | Falkenstein, Nuremberg, Helsinki, Ashburn, Hillsboro |
| **Integrated platform** | Compute, firewalls, DNS, and S3-compatible Object Storage behind one API token |
| **No egress fees** | Generous included traffic |

For exact, up-to-date figures, see
[Hetzner Cloud pricing](https://www.hetzner.com/cloud/).

## Prerequisites

1. **A Hetzner Cloud account** — [sign up](https://accounts.hetzner.com/signUp)
2. **A Hetzner Cloud API token** — Console → project → Security → API Tokens
   (read + write). The deploy prompt asks for it on first run and can save it
   to the project's `.env.local`; scripted runs can pass it via the
   `HETZNER_API_TOKEN` environment variable instead. The same token drives
   servers, firewalls, DNS, and TLS (DNS-01) — no separate DNS token exists.
3. **S3 credentials for Hetzner Object Storage** — used for deploy state and
   `wal-g` database backups. The guided setup walks you through creating them.
4. **A domain** you control, for the app URL and TLS certificates.
5. **Docker running locally** — images are built on your machine and pushed to
   the servers over SSH (local-first deploys; no registry or CI required).
6. **A Fullerene license, for advanced deploy modes** — single-server Docker
   Compose deploys are free forever on Graphite. Compose HA, Kubernetes, and
   Kubernetes HA require a Fullerene license ($149 one-time). Local
   development (`create`, `up`, `down`) is always free.

## Deployment modes

The mode is chosen at first deploy and locked for the environment (cross-mode
migration = `destroy` + fresh deploy with `-restore`).

| Mode | What it provisions |
|------|--------------------|
| `compose` | Single VPS running the full stack under Docker Compose |
| `compose-ha` | Primary + standby VPS in two regions, Postgres streaming replication, one-command manual failover |
| `k8s` | k3s cluster (master + workers + dedicated Supabase node) |
| `k8s-ha` | Primary + standby k3s clusters in two regions, pilot-light standby (2-node idle floor, cold app tier), Postgres streaming replication, manual failover with IaC provisioning |

Server types are picked automatically per region based on live availability
(small shared-vCPU types for masters/workers, a larger type for the database
node). You can override them in the deploy prompt or `.vibecarbon.json`.

## x86-64 only

Vibecarbon targets **x86-64 (amd64) servers only**. Every image it builds is
pinned to `linux/amd64`, and every image it pulls (the Supabase stack, Traefik,
Kong, cert-manager, the Hetzner CCM/CSI drivers, cluster-autoscaler) is
published for `linux/amd64`. Hetzner's ARM line (`cax11`/`cax21`/`cax31`/
`cax41`) is not offered in the deploy prompt and is **rejected** wherever a
server type can still arrive as raw text:

| Path | Behaviour on an ARM type |
|------|--------------------------|
| `deploy` (including types read from `.vibecarbon.json`) | exits 1 before provisioning |
| `scale -type cax…` | exits 1 |
| `failover -server-type cax…` | exits 1 |
| `failover` on a persisted ARM `ha.standbyWorkerSpec.serverType` | aborts before adding any capacity; the primary is untouched |
| `failover` on a persisted ARM `ha.standby.masterServerType` / `ha.standby.supabaseServerType` | same abort — all three persisted types are checked, so a partly-migrated standby is caught too |

### Migrating an environment created before this

**An environment whose `.vibecarbon.json` carries a `cax*` type can no longer
be redeployed.** This is deliberate: the amd64 app image cannot exec on arm64
nodes, so those deploys were already broken — the guard just makes the failure
immediate and legible instead of surfacing as `exec format error` after the
servers exist.

Hetzner cannot rescale a server across architectures, so there is no in-place
fix. The migration is a **replace + restore**:

```bash
vibecarbon backup <env>     # capture a fresh base backup
vibecarbon destroy <env>
vibecarbon deploy <env>     # choose x86 types at the server-type prompt, or
                            # edit the cax* values in .vibecarbon.json first
vibecarbon restore <env>
```

Pick the replacement by **spec, not by name**: Hetzner's `cax<N>` carries about
twice the RAM of `cpx<N>`, so the same-suffix swap silently downsizes (and
`cpx11` is below the 4 GB minimum). The equivalents below meet or exceed the
ARM SKU on both vCPU and RAM: `cax11 → cpx21`, `cax21 → cpx31`,
`cax31 → cpx41`, `cax41 → cpx51`. (RAM matches exactly on all four; `cax11`
gains a vCPU, 2 → 3.) The CLI names the right one for you in the rejection
message; sizing guidance is in
[technical.md](./technical.md#vps-recommendations).

### Mid-outage: what `-server-type` can and cannot do

`vibecarbon failover <env> -server-type <x86-type>` overrides **the standby
worker type, and nothing else**. Whether that is enough to get the app serving
depends on the rest of the standby's topology:

- **Standby master and database nodes are already x86** (the common case — only
  the worker spec is ARM): the flag is a complete workaround for that run. The
  workers come up on x86, the app schedules there, and the failover proceeds.
- **Standby master or database node is itself an ARM type**: the flag does not
  help and the failover aborts anyway — those two persisted types are guarded
  as well (see the table above), and there is no flag that overrides them. That
  node already exists as arm64 hardware, and Hetzner cannot rescale a server
  across architectures, so the only route is the replace + restore above.

Check `ha.standby.masterServerType` and `ha.standby.supabaseServerType` in
`.vibecarbon.json` to tell which case you are in before you rely on the flag.
Either way, complete the replace + restore afterwards so the persisted config
stops carrying an ARM type.

## Deploying

```bash
# Interactive — prompts for env, mode, region, DNS, server types
vibecarbon deploy

# Seeded — env and mode given, prompts for the rest
vibecarbon deploy prod -mode k8s-ha -region hel1

# Scripted — settings from .vibecarbon.json, no confirmations
vibecarbon deploy prod -y
```

A deploy:

1. Provisions servers, firewalls, and private networking via Pulumi (state
   lives in your Hetzner Object Storage bucket — no Pulumi account needed)
2. Creates DNS records for your domain (Hetzner DNS by default; Cloudflare
   opt-in; or manual if you manage DNS elsewhere)
3. Issues TLS certificates via ACME DNS-01 (wildcard-capable)
4. Builds your app image locally and pushes it to the servers over SSH
5. Starts the stack (Supabase, Kong, Traefik, your app), runs database
   migrations, creates the admin user, and verifies health
6. On HA modes: seeds the standby via `pg_basebackup` and verifies TLS
   streaming replication is live — the deploy **fails** if the standby is not
   confirmably streaming (use `-allow-degraded` to accept a warm standby)

Deploys are resumable: a failed run picks up where it left off. Use `-full` to
redo every step from scratch.

Run `vibecarbon deploy -h` for all flags (regions, disaster-recovery
`-restore`, etc.).

## Operating the deployment

| Task | Command |
|------|---------|
| Check health, servers, replication | `vibecarbon status <env>` |
| Scale workers / server sizes | `vibecarbon scale <env>` |
| On-demand backup (wal-g, to S3) | `vibecarbon backup <env>` |
| Restore / point-in-time recovery | `vibecarbon restore <env>` |
| Promote the standby region (HA) | `vibecarbon failover <env>` |
| Localize connectivity failures | `vibecarbon diagnose <env>` |
| Tear everything down | `vibecarbon destroy <env>` |

Scheduled backups are installed automatically at deploy time (wal-g archiving
to your Object Storage bucket).

## High availability

Both HA modes run two regions with Postgres streaming replication (TLS,
`verify-ca`, dedicated replication port) and deliberate, one-command manual
failover (never automatic — a split-brain database is worse than a few
minutes of operator-decided downtime). Their standby architectures are
different, and each mode keeps its own failover path:

- **`compose-ha`** keeps its existing always-warm architecture unchanged: two
  always-on VPSs, both running the full stack, standby continuously
  replicating. `vibecarbon failover` promotes the standby database and
  repoints DNS — there's no idle floor to provision and no `-server-type`
  step, because nothing is cold.
- **`k8s-ha`** uses the pilot-light standby described below: a 2-node idle
  floor with the app tier at zero, and failover provisions app-tier capacity
  before promoting.

The rest of this section (Standby Architecture, Failover ordering, Recovery &
Fail-back) describes **k8s-ha** specifically.

### Standby Architecture (Pilot-Light, k8s-ha only)

The k8s-ha standby region is deployed as a minimal, cost-optimized replica:
- **Idle floor: 2 nodes** — a master (control plane, ingress, replication gateway) and a dedicated supabase node (the streaming replica database)
- **Cold app tier:** All app-tier workloads are at `replicas: 0` (the app, auth, rest, realtime, storage, meta, kong, studio, imgproxy, cluster-autoscaler)
- **Seeded at deploy:** The database boots from a seed snapshot on first start, immediately becoming a live streaming replica — no separate reseed cycle
- **Workers provisioned at failover time** via the IaC layer, not idling in advance

**Deployment as role reconciler:** After any failover, re-running `vibecarbon deploy` converges each cluster to its current role — the new primary keeps its warm tier and workers, while the recovered ex-primary reconverges to pilot-light (cold app tier, workers removed).

### Failover (k8s-ha)

Failover is **deliberate, not automatic** — when the primary region is down, you run:

```bash
vibecarbon failover prod
```

This command follows the ordering principle **secure capacity first, cross
the point of no return last**:
1. Reads the persisted worker spec and scale-up list from the standby
2. **Provisions workers** via the IaC layer (0 → N workers; with `-server-type <id>` to retry on different hardware if needed) — capacity is secured before anything irreversible happens
3. **Quiesces the primary** (planned failover only): scales its app tier to 0, stopping writes
4. **Reseeds and promotes** the standby database (final catch-up against a quiesced primary)
5. **Scales up the app tier** (0 → target replicas) and verifies public API readiness
6. **Repoints DNS** to the new primary

**Clean abort on failure:** If provisioning fails, the command attempts to converge workers back to 0. If that also fails, it reports the exact state and the primary remains untouched. Re-run the command (optionally with `-server-type` for different hardware) to retry — every step is convergent, so reruns resume instead of duplicating.

Outage window: For a **planned** switchover, capacity is already secured by the time the outage opens — the customer-visible window starts at the quiesce step (step 3) and runs until the app tier is serving again (measured outage-side bound ≈ 1 min, plus DNS propagation bounded by the 60s record TTL). For an **unplanned** failover, the outage already began when the primary failed, before the command even runs; provisioning, promotion, and DNS are the recovery path, and the outage ends when the promoted cluster is serving (measured command wall-clock ≈ 3m 25s including provisioning, plus detection time and DNS propagation). **These are measured figures, not guaranteed SLOs** — the published breakdown with provenance lives in [docs/technical.md → Guarantees (k8s-ha)](./technical.md#guarantees-k8s-ha), methodology in [docs/rto-rpo.md](./rto-rpo.md).

### Recovery & Fail-back (k8s-ha)

After a failover completes:

- **Running `vibecarbon failover` again** performs a **planned switchover in the reverse direction** — the new primary becomes standby, and the recovered ex-standby becomes primary (quiesce-before-promote for zero data loss)
- **Running `vibecarbon deploy`** converges the recovered ex-primary back to a pilot-light standby — cold app tier, workers removed, streaming replication re-established from the new primary

**Replication lag visibility:** Use `vibecarbon status prod` to monitor replication lag at any time. The lag line **is** your unplanned-RPO exposure at that moment (seconds when healthy) — planned switchovers are RPO zero by quiesce-before-promote design.

**One-command-manual by design:** Automatic DNS-health-check failover is easy to trigger falsely, and a split-brain database is worse than a few minutes of operator-decided downtime. Manual failover gives you control and confidence.

## Troubleshooting

- `vibecarbon status <env>` — first stop: server, service, and replication
  state at a glance
- `vibecarbon diagnose <env>` — dumps full environment state to
  `~/.vibecarbon/diag-<env>-<ts>.txt`. On compose/compose-ha it gathers
  container states + health, recent service logs, Traefik/ACME cert state, and
  host disk usage over SSH; on k8s it runs the node/pod/network/Flux + egress
  battery and localizes the failing layer
- Deploy failures are resumable — rerun `vibecarbon deploy <env>`; add `-full`
  if you want a clean slate
- All servers are plain Ubuntu reachable over SSH with your key if you need to
  inspect anything directly
- `'cax…' is an ARM (aarch64) Hetzner Cloud server type` — the environment
  predates the x86-64 standardization; see [x86-64 only](#x86-64-only)
- A k8s node stuck `NotReady` with `node.kubernetes.io/unreachable` while its
  k3s service is still `active` usually means the private NIC lost its DHCP
  lease. Every node runs `vibecarbon-private-net.service`, which re-acquires
  the lease and, failing that, pins the address from Hetzner metadata —
  `journalctl -u vibecarbon-private-net` (or
  `/var/log/vibecarbon-private-net.log`) shows every repair it has made, and
  `ip -4 addr show enp7s0` shows the current state

## Security notes

- Firewalls are provisioned automatically and scoped to operator CIDRs for
  SSH/admin ports
- SSH host keys are pinned on first contact (TOFU)
- Secrets never appear in command argv; replication runs over TLS
- See [security.md](./security.md) for the full posture
