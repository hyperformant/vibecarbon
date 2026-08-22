# Asserted-Attribution Burn-Down — proof debts for every unproven "external" claim

From the three-way attribution audit (48 commits, 13 RCA docs, 62
mitigation sites). Of 25 external attributions in commit history, 15 were **asserted** —
from error text, timing adjacency, or "recurrence stopped after retry" — and five asserted
claims have already flipped to *ours* once evidence arrived (5a82331d, 8e45726c, 3dd719ac,
0fbb296f, d592ec6f). This spec is the proof-debt ledger that
`docs/mitigations.yml` (enforced by `tests/unit/lib/mitigation-attribution-census.test.ts`)
requires for every `external-asserted` class: each section names the claim, why it is
currently only an assertion, and the discriminating experiment that would settle it.

Settling a debt means editing `docs/mitigations.yml`: flip the class to `external-proven`
with the evidence, or to `ours` with a root-fix spec. Either way the census enforces the
consequence.

## The standing rule this ledger serves (AGENTS.md "Mitigation policy")

One mitigation per root-cause class, with proof of RCA. A second mitigation for the same
class is prohibited until a root-cause change has landed and measurement shows the
residual. Classes below are frozen at their audited size by the census.

## Debts

### 1. `fresh-server-dns-settle` — highest priority (self-flagged)

**Claim:** fresh servers need ~30s for public DNS resolution to settle; the
`DNS_NOT_SETTLED_RETRY_DELAYS_MS` ladder (45s cumulative) rides it out.
**Why asserted:** the sizing commit (3dd719ac) itself retracts its citation — the ~30s
figure belongs to the private-NIC (enp7s0) dhcpcd race, a different interface and
subsystem than the public DNS failures it was sized against. "Pending a dedicated RCA"
that never ran.
**Experiment:** on the next kept rig, at first boot poll `resolvectl status` +
`getent hosts` against both interfaces every 2s and log timestamps; correlate with
cloud-init phase. One evening on a kept rig answers which subsystem, what window, and
whether the ladder shape is right — or whether our cloud-init ordering (ours) delays
resolver readiness.

### 2. `ssh-transport-blips`

**Claim:** scp/ssh "banner exchange" and connection-timeout blips are network transients.
**Why asserted:** evidence is error text plus same-environment adjacency (c0773fb0). Two
family members are already *proven ours* (MaxStartups penalty under our verify fan-out;
CPU-starved sshd under our concurrent reconcile, 7d045250) — the open uplink-semaphore
design (an earlier ledger) says the class-level answer may be our concurrency.
**Experiment:** stamp `sshd_config` `LogLevel VERBOSE` on one e2e rig and count
MaxStartups drops vs genuine timeouts across a matrix night; correlate blip timestamps
with our own fan-out phases from the perf markers.

### 3. `provider-api-network-transients`

**Claim:** generic fetch/HTTP 5xx/socket errors against provider APIs are provider-side
blips. **Why asserted:** the founding taxonomy (6afff1d7) was a-priori — no incident
corpus; the widest consumer (`fetchWithRetry`, 119 call sites) has never had its retry
outcomes measured; 8f7b4190's "Hetzner unreachable >50s" evidence was circular.
**Experiment:** log every retry fire with reason + outcome (the perf-sample-history
pipeline is the natural sink, the perf-sample-history design); after 10
matrix runs, rank reasons by fire-rate and success-rate. Reasons that never fire or never
succeed are dead weight; reasons that cluster on our fan-out phases are ours.

### 4. `walg-failover-terminal-guards`

**Claim:** wal-g audit blips absorbed by `WALG_AUDIT_RETRY_DELAYS_MS` are storage-side.
**Why asserted:** inferred from wordings; never isolated from the known staleness class
(now proven) or from our own restore-path bucket recreation (b924bac2 — ours).
**Experiment:** the state-op counter from the Pulumi serialization experiment (§3 of the
the state-backend consistency spec) covers this: if wal-g blips track our state-op volume, they are the same
class and ours to reduce.

### 5. `e2e-check-blips`

**Claim:** health/SSL/redis/app-functional check failures absorbed by e2e retry ladders
are network noise. **Why asserted:** ladders were sized from single incidents
(HEALTH_RETRY_DELAYS_MS from one 113s flake); the resolver-warmup member is
*partly ours* (our 0.0.0.0 placeholder record is what the pinned upstreams serve stale).
**Experiment:** record per-check retry counts in the e2e DB (schema already has the
category column); a check that retries on >20% of green runs is masking something
systematic.

### 6. `provider-provisioning-slowness` (flake-retry-only)

**Claim:** k3s install timeouts are provider/cloud-init slowness. **Why asserted:** never
separated from our own cloud-init content (we front-load ufw + unattended-upgrades) or
from Docker Hub quota (the known first-grep on heavy failures).
**Experiment:** on the next install-timeout flake, pull `/var/log/cloud-init.log` before
retrying (the kept-rig iteration flow) and attribute the stall to a phase we author vs
provider infrastructure.

### 7. `hetzner-quota-release-lag` → folded into `quota-churn-under-parallel-load` (ours)

The `RESOURCE_LIMIT_DELAYS_MS` ladder in hetzner.js rides out 30–90s Primary-IP release
lag **under our own parallel teardown** — the commit says so (iter-reliab).
Registered as `ours` from day one; the open question is only whether serial-matrix
discipline (already standing advice) makes the ladder dead code. Count its fires.

## Not debts (proven, for contrast)

`pulumi-state-backend-consistency` (request-id-bearing error bodies, upstream stack
frames), `hetzner-capacity` (4h sustained, two independent scenarios, b118f4b0),
`provider-api-outages` (a DigitalOcean platform incident), `provider-rate-limits`
(provider-issued bodies verbatim), `acme-issuance-pending` (cert-manager#8960 matched by
pinned-source read). These show what the evidence floor in the census means.

## Status

Open. Debts 1–2 are cheap and high-recurrence; 3 and 5 ride on the perf-sample-history
implementation; 4 rides on the Pulumi serialization experiment.
