# Project history

This is the record of how vibecarbon got to its current shape: the design and
architecture decisions, the features added along the way, and the incidents
that forced a decision. It exists so that nobody undoes a decision because the
reason for it was forgotten.

It is high level on purpose. The code and its tests say what the project does
today. Commit messages and pull requests hold the detail. This file says why,
and what not to change back.

## How to read it

- [Standing principles](#standing-principles) are the decisions that shape
  every other one. Read these first.
- [The timeline](#timeline) is chronological. Each entry says what changed, why,
  and, where there is a tempting way back, what not to undo.
- [Added and later removed](#added-and-later-removed) lists things the project
  tried and dropped. Check it before proposing something that sounds new.
- [Problems that keep coming back](#problems-that-keep-coming-back) groups
  incidents by cause. These are the decisions most likely to be undone by
  accident.
- [Provider facts that shaped the design](#provider-facts-that-shaped-the-design)
  lists platform behavior the code depends on.
- [Dated bridges](#dated-bridges) lists compatibility code that is meant to be
  deleted, and when.

## How to add to it

Add an entry when a change makes a design or architecture decision, adds or
removes a feature, or fixes an incident whose cause someone could reintroduce.
A routine fix does not need one.

Write the entry in the pull request that ships the change:

```markdown
#### YYYY-MM-DD: Short title (#PR)

What changed, in one to three sentences.

**Why:** the incident, measurement or requirement, with its numbers.

**Do not undo:** the tempting reversal, and what it would break.

**Guard:** the test that enforces it, if one does.
```

Leave out **Do not undo** and **Guard** when there is nothing to say. When a
later change replaces a decision, keep the old entry and add a line saying what
replaced it. Implementation plans are working documents: they are deleted once
their feature ships and its entry is here.

History before the first public commit (2026-08-22) is not in this repository.
Where an entry refers to it, it says so.

## Standing principles

**Fix the cause, never pad a retry.** A retry, backoff, watchdog or tolerance
branch is a mitigation. The rule since 2026-08-16 is one mitigation per
root-cause class, with proof of the cause, and none at all for a failure the
project's own code triggers. The history behind it: one failure class once
carried seven stacked recovery layers and was still red, and six clusters of
failures were mitigated for months while their triggers stayed. When a
dependency is flaky, the first question is whether the dependency can go
(2026-08-30: "remove the dependency, never pad the ladder"). The rule itself is
in `AGENTS.md` under Mitigation Policy; every site is registered in
`docs/mitigations.yml`.

**One core stack and one mechanism in all four modes.** Compose, compose-ha,
k8s and k8s-ha run the same database, the same app image and the same
certificate method. When a tradeoff comes up, the order is speed, reliability,
simplicity, and one approach across all modes (2026-11-02). A mode-specific
mechanism needs a reason a shared one cannot meet.

**No version pins unless something named breaks.** Security fixes must reach
servers without a CLI release (2026-11-05). "Drift" alone is never a reason to
pin. The [version channel](#2026-11-05-faster-deploys-the-version-channel-and-current-versions-343)
is how patches arrive.

**The template owes no backward compatibility; deployed data does.** Template
component APIs can break freely (2026-08-29). That is not licence to break a
running environment's database, backups or state.

**"Free" describes the licence, never the server.** Every mode bills to the
user's own cloud account (2026-09-01, #40).

**No 1.0 yet.** Breaking changes ship with a Compatibility note in the commit
body, not a breaking-change footer, which would cut a major release
(2026-09-01).

**Test what ships.** Verify the published package, not the checkout
(2026-09-12). Unit tests may not reach the network (2026-11-14). A check must
read real content, and a source-text guard must cover the code that runs
(2026-10-19, 2026-11-06). Real-server tests run on a fully merged main, never a
partial one (2026-11-05).

## Timeline

### Before the first public commit

The first commit (2026-08-22, version 0.39.15) is a complete tree. At that
point the project already had:

- Five providers (Hetzner, DigitalOcean, Linode, Vultr, Scaleway) and four
  deploy modes. Compose and compose-ha ran on all five. k8s ran on Hetzner and
  DigitalOcean, k8s-ha on Hetzner only.
- A template built on Supabase, with Stripe, Paddle and Polar billing and the
  add-ons observability, redis, n8n and Metabase.
- A Functional Source License with license keys.
- Certificates through DNS-01, with wildcards.
- The mitigation policy, `docs/mitigations.yml`, census tests, a mirror set
  for `registry.k8s.io` images, and a published performance table.

These decisions from before that commit still bind. Their dates come from
comments and docs that were already in the tree.

- **DNS records are never proxied, and failover is a human decision**
  (2026-03-26). Cloudflare load balancers were removed. With the proxy on,
  Cloudflare answers for the domain itself until it trusts the origin, and a
  deploy probe once got its 404 for 1,200 s. Failover is manual because a
  split-brain database is worse than a few minutes of downtime someone chose.
- **The e2e matrix runs one scenario at a time from one machine**
  (2026-06-01). Running four in parallel from one host produced failures no
  user sees: throttled state storage and a starved browser check.
- **A deploy that exits 0 has not proven it finished** (2026-07-07). A k8s-ha
  deploy ran 31 minutes, exited 0, and recorded no servers, because a promise
  never settled. A completion guard now fails any deploy whose plan did not
  reach its last step (`src/lib/deploy/completion-guard.js`).
- **Published performance numbers come only from GitHub-hosted runners**
  (2026-07-08). A slow home connection once inflated the table 20 to 40
  times. A local run never writes `docs/perf-data.json`.
- **Failover time is published only from a green run** (2026-07-18). The
  figures in `docs/technical.md` are written by the e2e renderer, never by
  hand, and are measurements, not promises.
- **Destroy reports what it left behind** (2026-07-22). A destroy once
  printed success and exited 0 with a server and two firewalls still running.
  Every failed delete now lands in a leak ledger, and exit code 2 means
  something may still be billing. `AGENTS.md` has the exit codes.
- **The session cookie is host-only** (2026-07-24). A separate short-lived
  token serves the admin proxy, so a flaw in a bundled admin tool cannot ride
  the user's session.
- **A bugfix must cover every sibling surface** (2026-07-30). About 20 real
  defects escaped in one day with every test tier green, in six classes.
  The test tiers had just been consolidated from seven to four.
  `docs/tests.md` holds the parity rule and the table of which guard a change
  needs.
- **amd64 only** (2026-07-30). Nothing enforced the architecture, so an Apple
  Silicon machine shipped an arm64 image to an amd64 server. ARM server types
  are refused everywhere. The one arm64 image is the database image, for
  local development.
- **Package managers differ by side** (2026-07-30). The CLI uses pnpm, the
  template and every generated project use npm, because running vibecarbon
  already requires `npx`. A `packageManager` pin in the template would bring
  the extra dependency back.
- **The Node floor is computed, and CI runs it** (2026-07-31). `engines.node`
  once claimed `>=20` while a runtime dependency needed `>=22.19` and threw
  on import. The floor now comes from the lockfile, and one CI job runs on
  exactly that version.
- **Never pull from `registry.k8s.io`.** It is a redirector whose Google leg
  returns 403 to datacenter ranges, and a retry lands on the same backend. It
  cost two deploys (cluster-autoscaler on 2026-07-31, the storage driver on
  2026-08-05, when one node of three lost storage). Every such image is
  mirrored to GHCR.
- **Storage volumes are tracked by id, and every listing is paginated**
  (2026-08-05). Cluster volumes are named by the platform and are not in
  infrastructure state. They were stranded three times, 14 volumes in all,
  once after a destroy that reported none left. An unpaginated listing made
  some of them invisible.
- **The state bucket is kept on destroy** (2026-08-07). Deleting it and
  recreating the same name lost writes the store had acknowledged. The
  earlier workaround, a new bucket name on every destroy, put every redeploy
  on a brand-new bucket, the least reliable kind. Only `-purge` of a
  project's last environment deletes it.
- **There is no default provider** (2026-08-08). Not for compute, DNS or the
  e2e matrix. An unknown or missing provider is an error.
- **A prompt with no terminal fails loudly** (2026-08-11). A prompt on a
  closed input neither answered nor cancelled, and a deploy exited 0 in 1.1 s
  having done nothing.
- **Our own bugs get root fixes, never retries** (2026-08-14 to 2026-08-16).
  An audit of 62 mitigation sites found that 15 of 25 failures blamed on a
  provider had no proof, and five turned out to be the project's own. See
  [Standing principles](#standing-principles).

### 2026-08: first public releases, DigitalOcean k8s-ha

#### 2026-08-22: CI credential names are the names the code reads

The workflow rename map was deleted. A secret's name is the environment
variable name.

**Why:** three naming styles and 32 renaming expressions in one workflow. A
wrong row authenticates as nobody and fails far from the cause.

**Do not undo:** do not add a translation layer between stored secrets and the
names `src/` reads.

#### 2026-08-22: Git hooks and the publish suite never run in CI

Both git hooks exit early when `CI` is set, and `prepublishOnly` skips the
suite there.

**Why:** a release died when semantic-release's own version commit ran the
pre-commit lint, and the next died in `prepublishOnly`. `release.yml` already
refuses to publish unless tests are green for the commit, so gates inside the
publish add only ways to fail.

#### 2026-08-23: An image pull is never silenced, and `up` never builds implicitly

The compose-ha pre-pull became one loud pull that leaves out the local-only app
image.

**Why:** the pull had been silenced four layers deep. Unsilenced, it failed in
11.5 s on "pull access denied" for the app image, and one hard failure aborts
every sibling pull. Green runs had been winning a bandwidth race.

**Do not undo:** this came back twice (#278, #282) when a new service used the
local image. Any service on the local-only image must be left out of pulls.

#### 2026-08-23: sshd accepts a deploy's connection fan-out

Every server raises `MaxStartups` and `MaxSessions` and reloads ssh.

**Why:** Ubuntu's default drops unauthenticated connections past ten. A deploy
opens more, and three subsystems died on connection resets.

**Do not undo:** reload ssh in cloud-init, never restart it. A restart cuts
cloud-init's own session.

#### 2026-08-25: Each migration file applies in one transaction

**Why:** a production deploy left a migration half applied
(`docs/rca/2026-08-25-migration-drift.md`).

**Do not undo:** no statement that refuses a transaction (such as
`CREATE INDEX CONCURRENTLY`) in a migration.

#### 2026-08-27: k8s-ha on DigitalOcean

The standby is the same k8s program in a second region, and failover is a DNS
change. k8s-ha became provider-generic: two k3s clusters, a WireGuard tunnel,
and a DNS flip.

**Why it needed new design:** DigitalOcean rejects a second VPC with a range
already used anywhere in the account, so each cluster's range is hashed from
its name. The database's first boot runs a temporary server that listens on
the Unix socket only, so a socket readiness check passed and the next query
failed.

**Do not undo:** do not give DigitalOcean a fixed VPC range. Database readiness
checks in the k8s path use TCP (`-h 127.0.0.1`), never the socket.

**Guard:** `tests/unit/deploy/k8s-readiness.test.ts`.

#### 2026-08-28: One certificate issuer per HA environment

Only the side DNS points at orders certificates. The k8s standby uses a
self-signed issuer, and failover re-points it. The compose standby's ACME
client is disarmed.

**Why:** both sides ordered certificates for the same names and overwrote each
other's challenge records.

**Do not undo:** this outlived the move to HTTP-01. A standby that tries to
validate burns Let's Encrypt's five failed validations per hostname per hour.

#### 2026-08-28: The health probe resolves through public DNS itself

**Why:** the system resolver cached a "no such name" answer for the zone's
minimum (3,600 s on Hetzner DNS), and a healthy deploy failed 118 probes.
`dns.setServers` does not affect `fetch`.

**Do not undo:** do not go back to `dns.setServers`. Each public resolver is
asked separately (#317, #337), because one "no such name" in a shared list is
treated as final.

#### 2026-08-28: Hetzner DNS records change atomically

**Why:** delete then create left a gap that served an empty answer, which a
resolver cached for an hour.

#### 2026-08-28: The state backend follows the state bucket's own region

**Why:** a region-scoped object store serves a bucket only at its region's
hostname. A scenario changed region and every state operation returned
NoSuchBucket.

#### 2026-08-29: A failed e2e run files an issue, and only infrastructure failures retry

**Why:** one provider's leg failed four runs in a row and left no trace for six
days.

**Do not undo:** a code failure or an unknown failure fails on the first
attempt. Every retry-eligible reason must own a root-cause class in
`docs/mitigations.yml`.

#### 2026-08-30: The in-cluster registry lives on the master's disk, not object storage (#30)

**Why:** Hetzner object storage returned NoSuchBucket to the registry while the
registry itself answered healthy, and every image push died. The registry is a
transport cache and needs no durability.

**Do not undo:** do not put any object storage in the image path.

### 2026-09: telemetry, licensing, configuration

#### 2026-09-01: PostgreSQL 17 and one static wal-g build (#38)

**Compatibility:** PostgreSQL 15 data and backups are not forward compatible.
Existing environments stayed on their image. This was deliberately not a major
version.

#### 2026-09-01: Anonymous CLI telemetry, opt-out (#41)

Every command sends an anonymous event, prints a cached update notice, and
sends a sanitized crash report on failure. `vibecarbon telemetry on|off|status`
controls it.

**Do not undo:** a telemetry failure must be unobservable: no throw, no changed
exit code, no extra output. Never send raw arguments, environment values,
hostnames or project names. `DO_NOT_TRACK`, `VIBECARBON_TELEMETRY_DISABLED=1`
and `CI` all switch it off.

#### 2026-09-01: An outer timeout must outlast the inner one (#46)

**Why:** a 120 s ssh timeout killed a package install that was inside apt's
300 s lock wait. This was the third case of an outer bound shorter than the
work inside it.

#### 2026-09-12: The template's `.gitignore` ships as `_gitignore` (#79)

**Why:** npm strips `.gitignore` from every tarball, so `vibecarbon create`
from npm had been broken since the first public release. Every test ran from
the checkout.

**Do not undo:** do not rename `carbon/_gitignore` back, and do not drop the
tests that run the real tarball.

#### 2026-09-12 to 2026-09-16: License keys and paid tiers (#96, #103)

Tiers became per-project subscriptions, and one key was bound to a project at
`activate`.

**Replaced by:** the [MIT relicense](#2026-11-07-mit-licence-no-keys-no-paid-tiers-382),
which removed all of it. One principle survives: a string that lives in a
repository may prove something, but must never be enough to do something.

#### 2026-09-15: Fixes from a production move (#98, #100)

Deploy now stops before provisioning when `.env` lacks keys compose requires.
A `-confirm` flag gates production. Restore runs `ANALYZE`.

**Why:** a deploy provisioned a server and moved DNS before compose refused to
start, five minutes into an outage. After a restore every table's live-row
count read zero until analyzed, which looked like data loss.

#### 2026-09-16: `upgrade` never undoes the CLI's own edits (#105, #107, #438)

**Why:** `upgrade` reverted edits `create` and `configure` had made, and once
left an old Flux file that applied an unfilled image placeholder.

**Do not undo:** any edit the CLI makes to a template file after create must
be registered in `src/lib/template-edits.js`.

#### 2026-09-16: The roadmap is not kept in this repository (#107)

#### 2026-09-19: `status` reports real container health (#110)

**Do not undo:** health comes from container state, never from the last
deploy's exit status.

#### 2026-09-20: Operator configuration is validated before anything is provisioned (#112)

One registry (`CONFIG_KEYS`) describes every operator value. Deploy checks the
shape before any provider call, and `status` shows the same check.

**Rejected:** verifying a credential by calling the provider (shape only), and
tight patterns for formats a vendor does not document.

**Do not undo:** never print a value in a problem message, only its name,
expected shape and length. Do not move keys between `.env` (goes to the
server) and `.env.local` (never leaves the machine).

#### 2026-09-21: One dotenv dialect (#132)

One module reads and writes every `.env` file, using only the grammar that
Node, Docker Compose and Vite all read the same way. A value none of them can
hold is refused at the prompt.

**Why:** the old quoting produced values every parser truncated.

**Do not undo:** never parse `.env` text by hand or build a `KEY=value` line
yourself.

**Guard:** `tests/unit/lib/dotenv-dialect-census.test.ts`.

#### 2026-09-21: `vibecarbon ?` tells you what to do next (#133)

### 2026-10: the lean stack and the October review

#### 2026-10-12: Local stacks survive a deleted or renamed project (#168)

Dev containers use `restart: on-failure:5`. `up` pins the compose project name
so a rename keeps its database. `down -orphans` removes leftovers.

**Why:** a deleted project's dev stack crash-looped for three weeks, with more
than 2,000 restarts.

**Accepted cost:** after a reboot you run `vibecarbon up` again. Production
keeps `unless-stopped`.

**Do not undo:** do not send the pinned project name to servers.

#### 2026-10-12: The CLI documents itself (#175)

Each command's `SPEC` is the only place its interface is written. Help, the
docs tables, the README tables and the `AGENTS.md` command block are generated
from it.

**Why:** a new flag shipped with correct help and no documentation.

**Guard:** `tests/unit/docs/cli-docs-generated.test.ts`.

#### 2026-10-16: Supabase replaced with Postgres and libraries (#194)

The template now runs its own Postgres 17 image, Better Auth in the app
process, Drizzle with per-request row-level security, and uploads through
signed object-storage URLs. The Supabase services are gone: Kong, GoTrue,
PostgREST, Realtime, Storage, Studio, the connection pooler and edge
functions. On k8s the database is its
own StatefulSet.

**Why:** local infrastructure idles at about 60 MiB, down from about 1.5 GB.

**Rejected:** compatibility code for old secrets, database builds on servers,
and public database ports.

**Compatibility:** deploy refuses to run over a database the old stack made.

**Do not undo:** cookie sessions need the origin check on every mutating
`/api/*` route. The admin proxy cookie must never carry the session token.
Do not give the modes different core stacks.

#### 2026-10-16: An authorization guard must agree with the handler it protects (#178, #224)

**Why:** a billing endpoint returned another organization's subscription. The
guard checked membership only for one value of a selector, and the handler
took the privileged path for every other value.

**Do not undo:** parse a selector once against an allowlist, and reach the
privileged branch by an explicit match, never by elimination. This rule ships
in every generated project's `AGENTS.md`.

#### 2026-10-19: Hetzner removed its datacenter fields (#225)

**Why:** the fields went away upstream on 2026-07-01 and 2026-10-01. Region
lookups had returned nothing since July, which silently dropped other
projects' servers from destroy's safety check.

**Do not undo:** the foreign-server scan fails closed when it cannot read a
region.

#### 2026-10-19: A check reads real content, never just a response (#226)

**Why:** every k8s Grafana "pass" had been the app's own page, and compose
passed on a 401.

#### 2026-10-20: Server creation is bounded at 15 minutes (#230)

**Why:** a provider left a create at zero progress for more than 70 minutes
with no output. Healthy creates take 30 to 68 s.

**Guard:** `tests/unit/iac/server-create-timeouts-census.test.ts`.

#### 2026-10-20: Storage bucket layout (#233, #421)

One uploads bucket per environment, created on first deploy and reused
forever. One state bucket per project. One backups bucket per project and
storage region (the region part came in #421). Destroy is scoped to its
environment.

**Why:** every redeploy and restore used to create a fresh bucket, and a new
Hetzner bucket is unreliable for minutes. The old layout also had data-loss
paths: destroying one environment deleted every environment's uploads.

**Rejected:** one bucket per project with a key prefix per environment (built
first, reworked before merge), and migration code for old bucket names (it
fails closed instead).

**Do not undo:** never create or rotate a bucket on a redeploy or restore. An
environment whose recorded bucket differs from the derived one stops; it never
re-points at an empty bucket.

#### 2026-10-25: The app holds only the credentials it needs (#234)

The app container gets one allowlisted environment file instead of the
server's whole `.env`. On k8s the Secret is split into app and infrastructure
secrets.

**Why:** the app held the cloud API token and the add-ons' database passwords.

**Known limit, stated on purpose:** where the provider cannot scope an
object-storage key (Hetzner by default, Scaleway, Vultr), a compromised app can
still read and delete uploads, backups and state. See
`docs/research/2026-10-object-storage-key-scoping.md`.

**Do not undo:** a key the app reads must be in `APP_RUNTIME_KEYS`. The app
process never holds the database owner password or runs migrations.

#### 2026-10-25: A published runtime base image and GHCR mirrors (#240)

**Why:** Docker Hub rate-limits anonymous pulls per address, and a fresh cloud
server often inherits a spent quota.

**Do not undo:** a third-party image on a deploy path goes through the mirror
set. A new GHCR package starts private and must be made public before code
uses it.

#### 2026-10-31: Failover acts only on proof (#235)

Promotion needs proof that the target is a caught-up replica. A journal
records each step. A planned failover fences writes first. A returning old
primary fences itself: read-only, no backups.

**Why:** a review found ten ways to promote stale or empty data, or to report
a half-finished failover as done.

**Do not undo:** do not infer "already promoted" from recovery state. Do not
report a failover done before the DNS record reads back. Once a promote is
issued, nothing un-fences on an unclear outcome.

#### 2026-10-31: Backups and restores prove themselves (#237)

Restore stages the backup beside the live data and keeps the original until
the restored database passes a write check. Each database lineage has its own
archive folder. Every promotion ends with a fresh base backup.

**Do not undo:** never delete data before the restore point is proven to
exist. A skipped backup is not a success. WAL archiving holds a segment when
the bucket fails; it does not drop it.

#### 2026-10-31: Add-ons declare how they behave on a standby (#236)

**Do not undo:** the compose file list must never depend on role, because a
role-dependent list would recreate the database on every promotion.

#### 2026-10-31: The k8s-ha standby copies the primary's image (#238)

A short-lived relay carries the image over the tunnel, and both sides check
the digest.

**Accepted risk:** the relay is unauthenticated for the length of the copy. It
admits one address and is deleted afterward either way.

#### 2026-10-31: Certificates are reused, and first issuance does not block (#239)

Issued certificates are saved to the backups bucket and restored on deploy,
failover and scale. A first deploy finishes with TLS pending and retries on a
timer.

**Why:** a slow certificate authority should not fail a deploy, and reissuing
spends rate limit.

**Do not undo:** a restore never overwrites a better live certificate. A
standby never writes a snapshot. On k8s the restored Secret needs
cert-manager's label, or cert-manager reissues at once (#305). Do not patch
cert-manager after applying it (#306).

**Guard:** `tests/unit/deploy/cert-manager-no-post-apply-patch-census.test.ts`.

#### 2026-10-31: The app image travels as a layer delta (#241)

The app builds from the published runtime base. The operator sends only the
layers the target lacks. Compose and k8s share that one path. On k8s the image
goes once to the master's registry and every node pulls from there.

**Why:** a first deploy sends 0.3 MB instead of 145 MB. A code-only change
sends about 10 KB.

**Do not undo:** no whole-image uploads, no per-node sideload, no build on a
server (except direct mode, when the operator has no Docker).

**Guard:** `tests/unit/deploy/image-delivery-census.test.ts`.

#### 2026-10-31: Default sizes are the cheapest in-stock servers that fit (#242)

Each provider declares candidate types per role. The deploy picks the cheapest
one the live catalog sells that meets a measured memory floor, and records it.

**Do not undo:** a redeploy never resizes, moves or refuses an environment
because prices or stock changed. Recorded choices always win.

### 2026-11: certificates, speed, MIT, Linode k8s

#### 2026-11-01: Cloud-init changes never replace a data-holding server (#281)

DNS, builds and pulls now overlap, and add-ons start off the critical path.

**Do not undo:** every server that holds data ignores user-data changes, so an
edit to a boot script can never replace a server and wipe its database.

#### 2026-11-02: compose-ha builds once, locally (#301)

**Why:** building on each server cost 117 s. The reason for remote builds was
ARM, which has been excluded since 2026-07-30.

#### 2026-11-03: Both sides of an HA pair run the same CPU class (#312)

The pair uses the best class both regions sell.

**Why:** a standby on a slower class took about twice as long to deploy.

**Do not undo:** do not hard-code a class for a region pair. The live catalog
decides.

#### 2026-11-03: Every object-storage client has real timeouts (#316)

**Why:** a restore hung nine minutes on one silent socket. The SDK's
`requestTimeout` only warns; `socketTimeout` is the bound.

**Do not undo:** prove a timeout against a silent server, never by checking
that an option is set.

#### 2026-11-04: The k8s-ha standby reseeds in place, and the wal-g role is a file (#309)

The standby reseeds inside its running database pod. The wal-g role is one
word in a file outside the data directory, changed with one write and no
restart.

**Why:** every reseed detached and re-attached the database volume four times,
and every failover recreated the database pod to change one variable. A cold
deploy timed out on that churn. Each recurrence of the volume-attach problem
was caused by the project's own detach.

**Do not undo:** do not bring back the helper pod or anything that detaches
the database volume. Only the literal word `primary` arms archiving; anything
else holds WAL and never drops a segment.

**Guard:** `tests/unit/deploy/db-in-pod-stop-census.test.ts`.

#### 2026-11-04: Certificates validate over HTTP-01, with explicit names (#325)

All four modes and every DNS provider. No DNS-01, no wildcard certificates, no
DNS provider tokens on servers or in clusters.

**Why:** DNS-01 defeats itself on DigitalOcean. ACME clients look up the
challenge name before creating its record, and DigitalOcean's nameservers then
hide that record for 64 s to more than 420 s on the edges that took the
lookup. A record nobody looked up first is served everywhere in under 0.3 s.
Vultr's nameservers do the same.

**Rejected:** longer waits before validation. They only improved the odds.

**Accepted cost:** no wildcard, so each subdomain is listed by name.

**Do not undo:** do not bring back DNS-01 or wildcards to save listing a
subdomain. On failover, arm ACME only after DNS has moved. Never delete a DNS
record while a validation may still be running. Never look up a name before
its record exists; tests use names no earlier run used.

**Guard:** `tests/unit/deploy/compose-http01-only-census.test.ts`,
`tests/unit/deploy/k8s-http01-only-census.test.ts`.

#### 2026-11-04: Uploads stay direct and presigned

The browser uploads straight to object storage with a signed URL and a bucket
CORS rule.

**Do not undo:** do not proxy uploads through the app for one provider. Any
other upload path must work the same in all modes.

#### 2026-11-05: Faster deploys, the version channel, and current versions (#343)

A daily job reads upstream versions, mirrors what is new, tests it without
cloud spend, and publishes one list. Deploys read it and fall back to the copy
bundled in the CLI. In the same change: Ubuntu 26.04 on all five providers,
Docker no longer pinned, narrower package indexes at boot, and readiness
driven by events where the platform can notify.

**Why:** a patch should reach servers without a CLI release.

**Later narrowed (#460, 2026-11-15):** an installed CLI takes a channel version
only on the major and minor it bundles. A newer minor arrives only with a CLI
release, because the CLI's templates were never tested with it.

**Rejected:** pre-baked server images, and running the full package refresh at
boot.

**Do not undo:** the channel's validator chooses what runs on customer
servers. Add to it, never loosen it. All five providers move Ubuntu versions
together. Existing clusters keep their Kubernetes version.

**Guard:** `tests/unit/deploy/version-channel-census.test.ts`.

#### 2026-11-05: Kubernetes manifests are applied on the master

**Why:** applying from the operator's machine made each provider look slow in
proportion to its distance. Most of the time was round trips.

**Do not undo:** do not move bulk applies back to the operator's side, and do
not patch a field after a client-side apply that names it (the next apply
resets it).

#### 2026-11-05: A new Hetzner bucket is written before it is read (#352, #360)

The bucket's CORS rule is written before anything reads the bucket.

**Why:** reading or listing a Hetzner bucket right after creating it starts a
window in which requests fail at random for about nine minutes. Writing the
rule first gave about 700 clean requests in a row.

**Do not undo:** do not probe a new bucket to prove it is ready. The probe
causes the fault.

#### 2026-11-06: Backup retention runs before the push (#357)

**Why:** Hetzner can return 404 for an object written seconds earlier, so
retention failed reading the backup it had just made. The read was removed,
not retried.

**Accepted cost:** a run whose push then fails has already pruned expired
backups.

#### 2026-11-06: Traefik has no CPU limit, and 512 MB of memory (#364, #372)

**Why:** at half a CPU, about 220 new TLS connections a second from one client
stalled all HTTPS. Measured on a real server, 512 MB with a Go memory limit
holds 11,900 connections; 256 MB held 4,600.

**Rejected:** a higher fixed CPU limit. Docker refuses a limit above the
host's CPU count, which would stop compose on a one-CPU server.

**Do not undo:** do not add a CPU limit to the TLS terminator.

#### 2026-11-06: Scale waits for kubelets to check in (#363, #427)

**Why:** after a resize the API shows dead nodes as Ready for about 40 s.

**Do not undo:** do not replace the Lease wait with a Ready wait.

#### 2026-11-06: A stale state lock is cleared only on proof (#366, #384)

**Why:** the first fix cancelled any lock, so a destroy during a live deploy
reported a clean teardown while the deploy kept creating resources.

**Do not undo:** clear a lock only when every holder is a dead process on this
machine, or the lock is more than two hours old.

#### 2026-11-07: MIT licence, no keys, no paid tiers (#382)

The licence is MIT. The licensing module, `activate`, `deactivate` and the
checkout routes are gone. A trademark policy replaces the terms file.

**Why:** adoption matters more than revenue at this stage. No licence had been
sold.

**Do not undo:** do not reintroduce keys, licence checks or tier gating.
Releases up to v0.52.0 stay under the terms they shipped with.

The two guards that watched for the old surface coming back (a census of
banned strings and a deploy test against a stand-in licence server) were
removed on 2026-11-17 with the last stored signing key. Nothing is left to
revive: this entry is the record.

#### 2026-11-07: Linode k8s and k8s-ha (#390)

Linode reaches all four modes. Vultr and Scaleway remain compose and
compose-ha.

**Design choices:** no Linode cloud controller (k3s's own is used). k8s is
refused in regions without private networks, before anything is created.

**Do not undo:** find servers and nodes by label or recorded id, never by a
substring of the name. Linode cuts labels at 50 characters, and a name match
missed the worker (#444).

#### 2026-11-09: A cut-off download gets a clear message, not a retry (#411)

#### 2026-11-09: Compose servers use Docker's classic image store (#415)

**Why:** Docker 29's default store makes one attempt per layer. Only the
classic store retries a failed layer download. Seven first pulls on fresh
servers had died mid-layer.

**Do not undo:** the cause of those resets was found later
([flow labels](#2026-11-14-a-stable-ipv6-flow-label-stops-pull-resets-442-459)),
but this is still the only retry on a compose pull. A server made before this
keeps its store, because switching hides every image it holds.

**Guard:** `tests/unit/iac/docker-daemon-config-census.test.ts`.

#### 2026-11-09: Compose HA does not promise automatic failover (#412)

Failover is one command the operator runs.

#### 2026-11-11: DigitalOcean k8s drops its reserved IP (#418)

DNS points at the master's own address. Existing clusters migrate by editing
state, and the old address is released only after the zone's nameservers show
DNS has left it.

**Why:** the address never moved (failover changes DNS), and assigning it
could fail. A released address a record still names is a takeover risk.

**Do not undo:** do not add the reserved IP back, and never let the
infrastructure tool delete an address on its own schedule.

#### 2026-11-12: State is encrypted per project, and tokens leave user data (#420, #422, #423)

Each project has its own state passphrase. Server user data and the cluster
join token are stored as secrets. The provider token reaches a cluster after
boot as a Secret, so rotating a token is a deploy.

**Why:** state used an empty passphrase. A provider keeps user data for a
server's life, so a token placed there outlived every rotation.

**Compatibility:** once a stack has moved, version 0.52 and earlier cannot
open it.

**Do not undo:** do not put a provider token in user data, and do not run
state with an empty passphrase.

#### 2026-11-12: k3s on Ubuntu 26.04 needs one AppArmor restriction off (#425)

**Why:** on the 7.0 kernel every signal inside a k3s container is denied, so
the database never becomes ready.

**Do not undo:** remove it only when the bundled k3s carries the upstream fix
(containerd/containerd#14485, k3s-io/k3s#13625). It is not leftover tuning.

#### 2026-11-14: A stable IPv6 flow label stops pull resets (#442, #459)

Every server sets `net.core.txrehash = 0` before any download.

**Why:** image pulls on fresh servers failed with connection resets. Linux
changes a socket's IPv6 flow label when it sees duplicate data, and something
on the path to the registry's CDN picks a server by that label, so replies
reach a server that does not hold the connection. With the setting: 0 resets
in 636 pulls. Without: 2 in 732, each right after a label change.

**Do not undo:** this is the root fix for a failure that killed deploys. It
has no removal date.

#### 2026-11-14: Deploy budgets fail a doubled deploy, not ordinary variance (#434)

**Why:** the old rule left about one cold deploy in ten over budget.

**Do not undo:** do not tighten it without rerunning the leave-one-out check.
Published performance numbers come only from the GitHub e2e workflow, and
since 2026-11-15 only from stock deploys with no add-ons (#457).

#### 2026-11-14: Test leftovers are removed on proof, and audited weekly (#430 to #433)

**Do not undo:** delete a resource only on proof read just before the delete.
A substring is not an owner: a destroy once claimed another cluster's volume
because its generated name happened to contain `db` (#449, #451).

#### 2026-11-15: A child process we stopped is not the operator's Ctrl-C (#452)

**Why:** Docker exits 130 when terminated. The CLI read its own abort of a
build as Ctrl-C and exited mid-deploy, leaving the standby half created.

#### 2026-11-15: n8n and Metabase are parked (#482)

They are hidden from help, docs and suggestions, and `add` refuses them. The
code remains, and un-parking is a one-line change plus restoring their docs.

**Guard:** `tests/unit/docs/parked-addon-surface-census.test.ts`.

#### 2026-11-16: `vibecarbon update` installs system updates and restarts servers (#491)

It shows a plan with the expected downtime per role, then restarts servers one
at a time. `status` and the admin dashboard say when a restart is due.

**Rejected:** automatic reboots. The operator chooses the moment.

**Do not undo:** no server reboots on its own. When the app cannot tell
whether a restart is due, it says so; it never reports "none due".

#### 2026-11-16: `create` ships `drizzle.config.ts` (#495)

`create` now copies `drizzle.config.ts` into the project, and `upgrade` adds it
to a project that has none.

**Why:** the template gained the file with the lean stack (#194, 2026-10-16),
but `create` copies root files from an explicit list and the file was never
added to it. Every project made since then lacked it, so the documented schema
workflow, `npx drizzle-kit generate --name <slug>`, failed for want of a
config. No test saw it: the template's own drift test passes the dialect,
schema and output directory as flags.

**Do not undo:** a new root file in `carbon/` reaches no project until it is
in the copy list in `src/create.js`, classified in
`src/lib/upgrade-policy.js`, and in the git-add allowlist in
`src/lib/project.js`.

**Guard:** `tests/integration/template/create.test.ts` ("ships
drizzle.config.ts with every file and path it names").

#### 2026-11-16: One secret-scan rule set for the CLI and for projects (#498)

The rules that decide what a secret is now live in one file,
`src/lib/secret-scan-rules.js`, with a byte-identical copy in the template at
`scripts/lib/secret-scan-rules.js`. The deploy check and a project's
pre-commit scan both import it. `vibecarbon upgrade` brings the file and the
new scanner to existing projects.

**Why:** the project scanner carried a hand-copied rule list with a comment
asking to keep it in sync, and no test. It fell behind by five rules, so a
project's pre-commit scan passed DigitalOcean, Linode, Vultr and Scaleway
tokens. Only Hetzner's was caught. It also still flagged two things the CLI
had stopped flagging as false alarms: lowercase hyphenated names near the word
"cloudflare", and `$VAR` references.

**Do not undo:** do not add a rule to either scanner file, and do not edit the
template copy on its own. Change `src/lib/secret-scan-rules.js` and copy it
over.

**Guard:** `tests/unit/security/secret-scan-rules-census.test.ts`.

#### 2026-11-16: Session hooks never prompt, and fetch only at a real session start (#500)

`ff-main.sh` and `clean-merged.sh` now run every git network call with ssh in
batch mode and git's terminal and askpass prompts off, so a fetch that cannot
log in fails quietly. At session start they run only for a new or resumed
session (matcher `startup|resume`), no longer on `/clear`, compaction or a
fork.

**Why:** in one long session with subagents the hooks re-fired until a process
watcher logged six `git fetch` connections to GitHub in 12 seconds, three per
hook, and the maintainer reported recurring SSH password prompts on the laptop
while it happened. Nothing stopped a background fetch from asking a person for
a password.

**Unproven:** which session start reason caused the repeats, and whether a
subagent start fires `SessionStart` (the Claude Code hooks reference does not
say). The hooks were later cleared of the prompts themselves: see
[2026-11-17](#2026-11-17-agent-sessions-cannot-open-an-ssh-password-dialog).

**Do not undo:** an empty `SessionStart` matcher brings back a fetch per hook
on every compaction. Removing `BatchMode=yes` lets a hook nobody is watching
ask for a password.

**Guard:** `tests/integration/hooks/never-prompt.test.ts` and the matcher test
in `tests/unit/template/claude-hooks-lockstep.test.ts`.

#### 2026-11-16: The staging allowlist covers every file create ships (#501)

`.nvmrc`, `tests/`, `vitest.config.ts`, `tsconfig.test.json`, `TESTING.md`,
`pnpm-workspace.yaml`, `.cursor/rules/` and `.windsurfrules` joined the list of
paths the CLI stages in a project. Because the list names whole directories,
staging now also leaves out any `.env*` file inside them, at any depth.

**Why:** when a project has no commit, `configure` makes the first one from
this list and pushes it to a new GitHub repository. The files had been added
to the template without being added to the list, so that push left them out.
The project's build workflow runs the tests, so it would fail on its first run
with no tests to find. On pnpm the push also left out the file that holds the
dependency security floors.

**Do not undo:** the list stays explicit. No `.env` name goes on it, the two
example files included, and `.vibecarbon.json` stays the operator's to commit.
Keep the `.env*` exclusion: the project's `.gitignore` does not cover every
env file name, and a project created without git has no `.gitignore`.
(Since the entry "A project created without git still gets its `.gitignore`"
below it has one. The exclusion stays for the names it does not cover.)

**Guard:** `tests/integration/template/create.test.ts` compares the list with
what a created project tracks, on npm and pnpm.
`tests/unit/security/git-add-census.test.ts` allows `git add -A` only in
`create`'s initial commit.

#### 2026-11-16: The e2e harness has its own CLI home (#503)

Real-infrastructure e2e runs now keep their CLI state in `~/.vibecarbon-e2e`
instead of the developer's `~/.vibecarbon`. `tests/e2e/utils/e2e-home.js` sets
`VIBECARBON_HOME` when it is imported, and the runner, `scripts/iter-step.js`
and `scripts/sweep-hetzner.js` import it before anything else. A
`VIBECARBON_HOME` already in the environment wins. Nothing in the real
`~/.vibecarbon` is moved or deleted.

**Why:** the unit and integration tiers got their own home earlier, but the
e2e runner did not. Every e2e `create` and `deploy` wrote the developer's real
project registry and log folder, and the log folder held hundreds of test
deploy logs.

**Do not undo:** it is one fixed directory for all runs, not one per run or
per scenario. Runs in parallel must share the uplink lock in it, or their
image pushes fight over the laptop's uplink. A kept rig must find the same
fingerprint key, volume ledger and logs on its next invocation. Keep the
import first in each entry point: a few `src` modules build their path when
they load, so setting the variable any later leaves the SSH mux directory,
local Pulumi state and the uplink lock in the real home, with nothing failing.
The module imports Node builtins only, for the same reason.

**Guard:** `tests/unit/e2e/e2e-home.test.ts` checks the import comes first in
all three entry points, and runs a real Node process to prove load-time paths
land in the e2e home and a preset home is respected.

#### 2026-11-16: A project created without git still gets its `.gitignore` (#504)

`create` now writes `.gitignore` and checks it for the required patterns on
every run. Only `git init`, the hooks and the first commit depend on git being
installed.

**Why:** the file was written inside the branch that runs when git is on the
PATH. On a machine without git the project had its generated secrets in `.env`
and `.env.local` and no `.gitignore`. The message `create` prints there tells
the operator to install git and run `git init`, and the first `git add .`
after that would have staged both files.

**Do not undo:** do not move the write back under the git check to group it
with `git init`. The file belongs to the project, not to the repository step.

**Guard:** `tests/integration/template/create.test.ts` runs `create` with a
PATH that holds only node, then runs a real `git init` and `git add .` and
checks that neither env file is staged.

#### 2026-11-16: Deploy stages the lockfile it generated and nothing else (#504)

When a project has no lockfile, `deploy` generates one and stages it. It now
stages that one file, through `buildGitAddNamedArgv`. `buildGitAddArgv`, which
stages the whole allowlist, is left for the first commit `configure` makes.

**Why:** the call passed the lockfile to `buildGitAddArgv` as an extra path.
That function stages every allowlisted path, so a deploy also staged whatever
the operator had changed under `src/`, `k8s/`, `package.json` and the rest,
and their next commit carried work they had not chosen to stage. It had been
that way since the first public commit.

**Do not undo:** do not reach for `buildGitAddArgv` to stage one file. Keep
the `.env*` exclusion and the empty-list check in the new helper: an exclusion
with no path before it tells git to stage everything else.

**Guard:** `tests/unit/security/gitignore-invariants.test.ts` runs real git on
a project with modified allowlisted files and a new lockfile.
`tests/unit/security/git-add-census.test.ts` allows `buildGitAddArgv` only in
`configure`.

#### 2026-11-16: `destroy` finishes a stack its own cleanup unblocked (#506)

On the k8s tiers, when a stack's `pulumi destroy` runs and leaves resources
behind, and the cleanup that runs after it (the orphaned-server sweep and the
per-stack backstop) removes something of that stack, `destroy` runs `pulumi
destroy` for that stack one more time. When that pass succeeds the stack's state is removed as on any
clean destroy, and nothing is reported for it. When it fails, the report, exit
code 2 and the kept environment entry are as before.

**Why:** a DigitalOcean k8s-ha deploy on 2026-11-15 was interrupted while a
droplet was being created. The droplet existed, but the Pulumi stack held only
the unfinished create. `pulumi destroy` then failed on the VPC ("409 Can not
delete VPC with members"), the sweep deleted the droplet, the backstop deleted
the VPC, and the provider was clean. The stack still listed the VPC, so
`destroy` reported it UNVERIFIED, exited 2 and told the user to run it again.
The stack file stayed in the state bucket, and the e2e sweep rightly never
deletes a stack with an unfinished create, so it was removed by hand.

**Do not undo:** this is one pass, not a retry. It runs only for a stack the
cleanup removed something of, because that is the only case where the second
destroy is a different operation from the first. Do not turn it into a loop,
add a wait, or run it when nothing changed: a repeat of the same destroy
against the same cloud hides whatever made it fail. A stack another run holds
gets no second pass either, since no destroy ran against it. A failure is written to
the leak report only after this pass, so the report never has to take a line
back; keep it that way instead of teaching the ledger to delete lines. The
orphan-stack cleanup (`destroy -orphans`) and the compose tiers get no second
pass: nothing runs between their Pulumi step and their report that could
change the outcome. The e2e sweep's rule about unfinished creates stays.

**Guard:** `tests/integration/iac/destroy-finishes-stack-after-sweeps.test.ts`
replays the incident on the real Pulumi engine: a VPC whose delete is refused,
an unfinished create in the state, then the stack file, its `.json.bak` and
its history gone and nothing reported.
`tests/unit/destroy/failed-stack-second-pass.test.ts` runs the real k8s
teardown and fails on a second pass for a stack nothing was removed of, and on
a third pass for any stack.

#### 2026-11-16: Cloudflare zone lookup reads every page (#514)

`getZones` in the Cloudflare DNS backend now asks for 50 zones a page and
follows the pages to the end, with a cap of 20 pages.

**Why:** it sent one request with no paging, and Cloudflare answers that with
the first 20 zones. On an account with more, a domain whose zone was past the
first page had no zone as far as `deploy` and `destroy` could tell. Every other
DNS backend already walked its pages. Found while sharing code between the
backends.

**Do not undo:** a list call to a provider is never a single request unless
the provider's own filter makes the answer one row.

**Guard:** `tests/unit/dns/cloudflare-zones-all-pages.test.ts`.

#### 2026-11-16: A Linode VPC membership listing cut short is a failed read (#515)

`_attachVpcMembership` in the Linode provider now returns its "membership read
failed" error when the `/vpcs/ips` walk stops at its 50-page limit, and attaches
no `vpc_ids` to any instance. `listServers` rejects on it, as it does for a
failed request.

**Why:** the page walk reports a limit it ran into as `complete: false` with no
`status`, and the membership read looked only at `status`. On an account with
more than 5,000 VPC addresses, every instance whose row came after the limit
read as being in no VPC, and the cluster sweeps in `destroy` skip an instance
that is in no VPC. Found in review; no account has hit it.

**Do not undo:** a listing that was not read to the end is unknown, not empty.
Do not go back to checking `status` alone, and do not attach the rows that were
read.

**Guard:** `tests/unit/providers/linode-vpc-methods.test.ts` serves a listing
that never ends and expects the error and a rejected `listServers`.

#### 2026-11-16: Scaleway checks the terminal before its storage guide (#515)

Scaleway's `getS3Credentials` now calls `assertInteractiveStdin` before it
prints the Object Storage guide, as the other four providers do. Off a
terminal it fails with `SCALEWAY_ACCESS_KEY/SCALEWAY_SECRET_KEY` and prints no
guide.

**Why:** Scaleway's storage keys are its compute keys, so `getS3Credentials`
opens no prompt of its own and hands off to `getApiToken`. The only terminal
check was the one in `getApiToken`, which runs after the guide, so a script or
CI run got setup steps for a prompt that could not open, and then the error.
The prompt census only looks at functions that open a prompt, so it never
looked at this one.

**Do not undo:** in a guided setup the terminal check comes before anything is
printed for the prompt, in the function that prints it. A check further down
the call does not count.

**Guard:** `tests/unit/lib/cli/interactive-prompt-guard.test.ts` walks every
guided setup for a guide call with no check before it, and runs each
provider's `getS3Credentials` off a terminal expecting a rejection and no guide.

#### 2026-11-16: A bucket that never becomes readable says what was failing (#516)

When a new bucket does not pass its readiness check in two minutes, the
warning now ends with the last problem seen: the error name and HTTP status of
the failing call, or that the bucket did not answer HEAD.

**Why:** a Hetzner compose e2e run created its app bucket and the deploy then
refused it as not readable. The check swallowed every error, so nothing said
which call was failing or how. The same code created a bucket in five seconds
minutes later, and the rerun passed. The refused bucket was readable twenty
minutes on, which matches Hetzner serving "no such bucket" for a while after
an early read.

**Still open:** that bucket was left behind. `destroy` reported it not found
in any region and the e2e sweep called it already gone, because both asked
while Hetzner was still answering "no such bucket" for a bucket it listed.
Closed on 2026-11-17 by the entry "A bucket the provider still lists is never
reported as gone".

**Do not undo:** keep the reason on the warning. Without it this failure
cannot be told apart from an outage.

**Guard:** `tests/unit/providers/bucket-sustained-visibility.test.ts`.

#### 2026-11-17: A bucket the provider still lists is never reported as gone

When a bucket's delete answers "no such bucket" and a HeadBucket in every
region the keys reach finds nothing, `destroy` and the e2e sweeps now read the
provider's bucket listing once more before they say anything. Only a listing
that was read and no longer shows the bucket makes it gone. A bucket still
listed, or a listing that cannot be read, is "cannot tell": `destroy -purge`
records the app or backups bucket as UNVERIFIED and exits 2, with a hint to
look in the console in about 15 minutes, and the sweep fails for that bucket.
The same check guards the "state bucket does not exist" verdict that lets a
destroy skip a Pulumi stack, and the age-based bucket reaper now fails a
bucket it listed, skipped as "not at this endpoint" and then deleted nowhere.

**Why:** on 2026-11-16 a Hetzner compose e2e deploy stopped on a new bucket
that would not answer. For the next 20 minutes that bucket answered
NoSuchBucket to the delete and 404 to every HeadBucket while ListBuckets on
the same endpoint still showed it. `destroy` printed "not found in any region
(already deleted or never created)", the sweep printed "already gone (stale
listing)", and a billable bucket stayed until it was deleted by hand. This is
the known Hetzner behaviour after an early read (2026-11-05, longest seen
894 s), so "no such bucket, and no HeadBucket finds it" is not proof there.
The listing was the one answer that told the truth.

The check reads once and decides what to say. It does not wait and does not
try the delete again. Listings lag real deletes too, so it can be wrong the
other way: measured on 2026-11-17, Hetzner dropped 14 of 15 deleted buckets
from ListBuckets by the first read after the delete was acknowledged, and the
last by the next read, under half a second, in all three locations.
DigitalOcean keeps a deleted bucket listed for 1 to 3 s. The second read comes
after the failed delete and the whole HeadBucket search, so a sweep that runs
right behind a clean destroy fails only when a provider's listing lags longer
than those round trips. Linode, Vultr and Scaleway are not measured.

**Do not undo:** do not go back to treating "no region holds it" as gone, and
do not add a wait or a second delete to ride out the 15 minutes or the listing
lag. If a provider's listing lag starts failing clean sweeps, measure it and
remove the early read. The hint names the console and not a destroy rerun on
purpose: a bucket line does not keep the environment's entry, so a rerun would
find nothing to run against.

**Guard:** `tests/unit/destroy/purge-locate-key-scope.test.ts` (the incident
on all five providers, through each real store class),
`tests/unit/e2e/bucket-already-gone.test.ts`, the five
`tests/unit/e2e/sweep-*.test.ts`, `tests/unit/iac/remove-stack-state.test.ts`
and `tests/unit/e2e/bucket-gone-census.test.ts`.

#### 2026-11-18: Unused code, duplication, shell, workflow, Dockerfile and secret checks gate every PR

The Lint job now also runs `pnpm unused` (knip), `pnpm dupes` (jscpd, budget in
`.jscpd.json`) and `pnpm lint:infra`. The last one is `scripts/lint-infra.sh`:
shellcheck over every tracked `.sh`, actionlint over the workflows, hadolint
over the Dockerfiles, and gitleaks over the commits a branch adds to `main`.
Each linter runs from the image pinned in `.github/lint-tools/Dockerfile`, so
a laptop needs only Docker and Dependabot proposes the bumps.

**Why:** the first sizing run found the checks mostly quiet, which is the cheap
moment to turn them into gates. Warnings and errors fail; style notes do not.
The cloud-init files are linted as the templates they are (placeholders and
spliced snippets are not shell errors). Unpinned `apk` packages stay allowed,
because a distribution's security fix must reach a rebuilt image without a
release of ours. The secret scan lets the generic rule pass in tests and docs,
where made-up keys are everywhere; provider-specific rules apply everywhere.
The last 54 exports nothing imported were removed so knip starts from zero.
The full-history secret scan, semgrep and mutation testing run from the
devagents repo, not here.

#### 2026-11-18: Copies shared across the CLI, the template and the e2e harness

One pass removed code that was written more than once: per-provider methods
moved to `BaseProvider` (catalog reads, `deleteServer`, `waitForServer`,
`getServerSummary`, `listServers`, a bare authenticated request and a
delete-if-gone); the DNS backends share their setup flows and record helpers
(`src/lib/dns-backend-helpers.js`); every database-pod command is built by
`dbExecArgv`; the five e2e sweeps share their context, bucket pass and banner
(`tests/e2e/utils/sweep-core.ts`) and one page walker; the template shares its
sidebar items, list controls, request validation and auth page shell. `pnpm
dupes` (jscpd) went from 121 clones to 51, and `pnpm unused` (knip) reports
unused exports.

**Why:** copies had drifted into bugs. Each entry below dated 2026-11-18 is a
bug that existed in one copy and not in its siblings.

**Do not undo:**
- The bare requests stay bare. `bareRequest` sends no JSON `Content-Type`,
  which `apiRequest` adds; folding them together changes what every provider
  receives.
- The compose and k8s failover flows, the two SSH runners (one returns false,
  one throws) and each DNS backend's `HA_TTL` and `deleteApexAndWildcard` stay
  separate on purpose.
- A k3s database node boots from the worker script with the `db` role
  (`loadCloudInit(script, { role: 'db' })`). It does not include the host
  reporter: the deploy installs that over SSH.

**Guard:** `.jscpd.json` threshold; the censuses each refactor repointed
(`pod-exec-bound-census`, `list-endpoint-pagination-sweep`,
`bucket-gone-census`, `shared-helper-consumers`).

#### 2026-11-18: Second pass: one sweep outline, one ssh helper for the checks, shared test scaffolding

The DigitalOcean, Linode, Vultr and Scaleway sweeps run each resource class
through `sweepClass` and one volume rule (`sweepOwnsVolume`) in
`tests/e2e/utils/sweep-core.ts`. Five e2e checks run their ssh command through
`sshOutput` and `sshExecOnce` (`tests/e2e/utils/ssh.ts`). The four CI sweep
entry points share their skip and exit code (`tests/e2e/utils/sweep-ci.ts`).
Tests read the repository through `REPO_ROOT` and `readRepoFile`, make temp
directories with `createTempDir`, and fake `@clack/prompts` with `clackFake`
or `quietClack` (`tests/_shared/`). `pnpm dupes` went from 51 clones to 42.

**Why:** the same reasons as the first pass, and about 60 tests depended on
the directory they were run from.

**Do not undo:**
- A delete that throws stops at one resource for some classes (`thrown`
  given) and ends the pass for others (`thrown` left out). Each sweep had it
  that way and it is kept per class.
- The CSI volume prefix is `pvc-` on DigitalOcean and `pvc` on the other
  three. The difference is carried, not decided.
- The retry loops in `replication.ts` and `pilot-light.ts` stay in their
  files; only the single attempt under them is shared.
- A prompt fake lists its own functions. Do not give `clackFake` defaults: a
  prompt the test did not name has to throw.
- 14 tests keep a `new URL(..., import.meta.url)` read. knip counts that read
  as the use of four DNS backends, `orchestrator.js` and
  `feature-observability.ts`; converting them fails `pnpm unused`.

**Not proven on real servers:** the sweep outline, the ssh helper and the CI
entry points were proven with fakes only.

**Guard:** `tests/unit/e2e/sweep-pass-transcript.test.ts` (every printed line
and provider call of every pass), `checks-ssh-exec.test.ts`,
`sweep-ci.test.ts`, and the rows in `shared-helper-consumers.test.ts`.

#### 2026-11-18: Leak detection in the e2e sweeps no longer reads "could not look" as clean

- A listing that runs out of its 20-page budget is incomplete, not complete.
- The Hetzner sweep counts a delete only when the API accepted it; a refused
  delete or a pass that throws fails the sweep and names the resource.
- `scripts/sweep-hetzner.js` exits 1 when it has no keys, cannot list buckets
  or a bucket delete fails.
- The sweeps list load balancers and networks themselves, because the
  provider methods answer `[]` on a failed call; a `false` from
  `deleteLoadBalancer` is a failed delete.
- The Vultr banner counts reserved IPs, the Hetzner sweep refuses a project
  name under 4 characters, and preflight reads every page. (Replaced for Vultr
  on 2026-11-27: its clusters make no reserved IP, so its sweep has no
  reserved-IP pass, and the residue audit still lists every one.)

**Why:** each of these let a sweep report success without having looked, and a
leaked resource bills until someone finds it.

**Do not undo:** `complete: true` means the provider said there is no next
page. Do not route a sweep listing back through a provider method that
swallows a failed call.

**Guard:** `tests/unit/e2e/sweep-page-guard.test.ts`,
`sweep-hetzner-compute.test.ts`, `sweep-load-balancers-networks.test.ts`,
`sweep-reserved-ips.test.ts`, `preflight-project-clean.test.ts`,
`tests/unit/scripts/sweep-hetzner-buckets.test.ts`.

#### 2026-11-18: CLI fixes found where copies disagreed

- `diagnose` on k8s checks host keys against the environment's own
  `.vibecarbon/known_hosts_<env>`, not the operator's `~/.ssh/known_hosts`.
- The compose-HA streaming check rejects a replication state it cannot
  recognise, as the k8s check did, so an ssh banner is never recorded as a
  state.
- A provider refusal whose body is not JSON still names what failed (it used
  to raise a SyntaxError), Hetzner's `renameServer` throws on a refusal, and
  `getServer` on Vultr and Scaleway keeps the HTTP status.
- Hetzner's failover upsert writes its own `HA_TTL`, not a literal 60.

**Guard:** the test added with each fix.

#### 2026-11-18: Template fixes

- Deleting an account cancels the user's active subscriptions with whichever
  billing provider the app uses. Before, only Stripe was cancelled, so a
  Paddle or Polar customer kept being billed. The Paddle and Polar calls were
  written from the providers' API references and not sent to a live API.
- The contact notification sends its subject as plain text on one line: an
  `&` no longer arrives as `&amp;`, and a line break cannot start a header.
- The admin theme route answers malformed JSON with 400, not 500. The admin
  organizations list pages in a stable order.
- Admin lists show a failed load, not the empty state. The Billing notice
  names the active provider's variables, sent by the server as `envVars`.
- Stripe: the billing period is read from the subscription item and a failed
  invoice's subscription from `parent.subscription_details`, where Stripe has
  reported them since API version 2025-03-31. Before, the period end was
  stored empty and a failed payment never marked the subscription past due.
  The older locations are still read, since a webhook endpoint keeps the API
  version it was created with. Proven against the SDK's types and signed test
  events, not a live Stripe account.
- An endpoint read by more than one component goes through one hook in
  `src/client/hooks/api/` (`useSubscription`, `useServicesStatus`,
  `useAdminStats`).
- "Save Changes" on the organization page saves the name, through the new
  `PATCH /api/v1/organizations/:orgId` (owner or admin; the name alone is
  written). Before, it only closed edit mode and the typed name was dropped.
  A member who is not an admin no longer gets the edit button.

**Do not undo:** a page-local `useQuery` for an endpoint that already has a
hook fetches twice. A provider-to-variable table in the client trips the
no-session-token invariant, which is unbounded on purpose.

**Guard:** `carbon/tests/integration/server/routes/` (`v1-me-delete-billing`,
`contact`, `theme-validation`, `admin-list-order`, `billing-status`,
`v1-routes`) and `carbon/tests/component/` (`billing-page`,
`organization-rename`).

#### 2026-11-18: Template tests test the template

Twelve files under `tests/unit/template/` re-implemented template logic inside
the test and tested that copy. Their cases now run against the real modules
under `carbon/tests/`, and the copies are deleted. Several copies asserted
behaviour the template does not have (plan names and prices, trust in a
forwarded-IP header the real code refuses).

**Do not undo:** a template test imports the module it tests.

#### 2026-11-17: Agent sessions cannot open an SSH password dialog

`.claude/settings.json` sets `SSH_ASKPASS_REQUIRE=never` for every Claude Code
session in this repository, so no `ssh` an agent runs can ask a person for a
password.

**Why:** the maintainer kept getting SSH password dialogs on the laptop. The
cause is how OpenSSH asks when it has no terminal: a command run by an agent
has none, the desktop sets `DISPLAY`, and `/usr/bin/ssh-askpass` exists, so
ssh opens a password window on the desktop whenever a server refuses the key
and still offers password login. Reproduced against a local sshd: without the
variable the askpass program was called with `root@127.0.0.1's password:`;
with it, or with `BatchMode=yes`, it was not.

The CLI, the e2e harness and the session hooks were already safe (batch mode
on every call, and the CLI sets the same variable). GitHub offers key login
only, so a fetch can never ask for a password. The unit and integration tiers
were run with a logging `ssh` on the path and made no ssh call at all. What
was not covered is `ssh` typed by an agent while debugging a kept rig: session
transcripts from 2026-11-02 to 2026-11-15 hold 27 such commands with no batch
mode. Any of them opens the window if the address now belongs to a server
that refuses the key and offers password login, such as a recycled IP.

**Unproven:** which of those commands opened a dialog. None of their recorded
output shows a refused key, and many discarded stderr.

**Do not undo:** removing the variable lets any agent's `ssh` to a server
that has lost its key stop and wait on a window nobody asked for. It is not in
the template's settings: there it would stop ssh asking for a key passphrase
in a project whose owner relies on that.

**Guard:** the session environment test in
`tests/unit/template/claude-hooks-lockstep.test.ts`.

#### 2026-11-18: The lockfile audit reports an advisory nobody can fix yet

The template job's audit step is now `scripts/audit-shipped-lockfile.mjs`. It
fails on every high or critical advisory, as before, except one listed in its
`NO_FIX_YET` table, which it prints and passes.

**Why:** on 2026-11-17 an advisory against every published picomatch
(GHSA-fc5q-39xc-vjpf, no patched version) reached the audit database. picomatch
comes in through vite and vitest, so every pull request failed a required
check with no lockfile to refresh to. The maintainer chose to set it aside
until upstream ships a fix.

**Do not undo:** do not turn the table into a general ignore list. An entry is
only for an advisory with no fixed release, it names the newest release of the
package when it was written, and the gate fails again the day a newer one is
published or the advisory stops being reported.

**Guard:** `tests/unit/scripts/audit-shipped-lockfile.test.ts`.

#### 2026-11-18: Third pass: per-provider tests as tables, shared test harnesses, three fixes found under load

Per-provider test copies became tables over the provider registry, so a new
provider gets each case without an edit: guided-setup credentials
(`tests/unit/providers/guided-setup-credentials.test.ts`, Linode and Scaleway
had none), IaC dispatch and its laziness (`iac-dispatch.test.ts`; DigitalOcean
compose, Linode, Vultr and Scaleway had none), and the cases every orphan
sweep shares (`tests/unit/e2e/sweep-shared-cases.test.ts`). Repeated test
harnesses moved to `tests/_shared/` (`ast-walk.ts`, `e2e-db-seed.ts`,
`teardown-provider.ts`, `state-passphrase-stub.ts`) and
`tests/unit/helpers/deploy-to-plan.ts`. `scale.js` and the k8s-ha deploy use
`Promise.withResolvers()`; `vibecarbon status` builds its container rows in
one place (`src/lib/status/container-rows.js`).

Fixes:
- `destroy -purge` and the pasted-key fence no longer fall back to the Hetzner
  location `fsn1` for a record with no storage region: they use the
  provider's own storage region. `scale` refuses such a record and names the
  missing field. Only hand-edited records reach either.
- `redactCredentials` is linear. Its three patterns rescanned a long run from
  every position inside it (a 200,000-character word took about 14 s); output
  is unchanged (300,000-case differential fuzz).
- Both restore scripts keep their scratch files under `${TMPDIR:-/tmp}`. A
  fixed `/tmp` path let concurrent test runs on one host overwrite each
  other's recovery settings. Servers are unaffected: TMPDIR is unset in the
  db container.
- The role-file preflight test copies the four files the preflight reads,
  not the whole template (12.9 s to 0.65 s).
- DNS dispatch loads backends through literal `import()`s, so `pnpm unused`
  sees them, and tests read source through `readRepoFile`.

Template: creating an organization trims the name before validating; billing
return URLs follow `SITE_URL` in every environment; a Stripe subscription
fetch that fails after checkout is logged and answered 500 so Stripe
redelivers (a subscription Stripe says does not exist is logged and
acknowledged); the organization settings page renders every string through
`t()`.

**Do not undo:**
- A test that runs a shipped script on the host gives it its own TMPDIR (or
  lock file). A fixed `/tmp` path is shared by every test run on the machine.
- A provider table reads `PROVIDERS` from the registry; do not hand-list
  providers in it.
- `test.yml` pins the Pulumi CLI to the lockfile's SDK for its real-engine
  tests; `e2e-us-perf.yml` installs the latest CLI, as users do. Both are on
  purpose.

**Guard:** `tests/unit/lib/redact-credentials.test.ts` (four 200,000-character
inputs), the TMPDIR case in `tests/unit/walg/restore-script-states.test.ts`,
`dns-registration-census.test.ts`, and the rows in
`shared-helper-consumers.test.ts`.

#### 2026-11-19: `update` installs in one apt transaction and plans a Kubernetes restart honestly

The first all-provider GitHub run since `update` started installing system
updates (#491) failed five of sixteen scenarios. Two were `update` running
past the e2e's 45 minutes: fresh Hetzner and DigitalOcean servers carried 121
and 41 pending security updates, and each server took 5 to 20 minutes to
install them. unattended-upgrade's default, minimal steps, commits each small
package set on its own and reloads apt's cache after each, which lets the
daily job stop cleanly at shutdown and costs a dpkg run, its triggers and a
cache reload per set. In a 2-CPU Ubuntu 26.04 container, 79 downloaded
updates took 453 s that way and 58 s in one transaction, and the dry run
`update` reads for its plan took 577 s and 64 s. `update` now passes
`--no-minimal-upgrade-steps` to its dry run and its install
(`UNATTENDED_UPGRADE` in `src/lib/deploy/apt.js`); the daily job keeps the
default. On the rerun (44496082723) a Hetzner cx23 installed its 121 updates
in about 2m20s, and the whole step took 894 s on Hetzner k8s (a timeout at 45
minutes the night before) and 1,383 s on Hetzner k8s-ha (2,541 s before).

A third, Linode k8s, measured 425 s of downtime for a master and a database
restart against a plan of 360. Across the run that pair cost 210 to 425 s: k3s
and the node's pods have to start again after the reboot, and Linode boots
slowest. The plan now gives a Kubernetes master or database node 60 to 240 s;
one compose server keeps 60 to 180 s (measured 20 to 130 s).

The other two were not `update`. A Linode compose-ha failover promoted the
standby, wrote the new A record through Linode's API, and read the old
address straight back, so it reported DNS as not flipped. That is open: the
next step is a probe that writes a record in the e2e zone and reads it back
by list and by id, to tell a stale read from a lost write. A DigitalOcean
compose-ha standby droplet in tor1 took 558 s to create, against 33 s in
sfo3, during DigitalOcean's "Increased Error Rates in SFO3" incident.

The rerun passed DigitalOcean and Linode, the Linode failover included, and
failed two Hetzner checks while Hetzner's API was slow (server creates of 100
to 238 s against 24 to 37 s the night before, nothing on its status page): a
k8s-ha deploy went 36 s over its budget, and hetzner/k8s verify-scale got one
503 for its post-scale type snapshot. The scale had resized all three servers,
but the fallback grepped the scale's output for the compose success line,
which a k8s scale never prints. verify-scale now reads each server's vCPUs
and memory over ssh before and after the scale
(`tests/e2e/utils/server-hardware.ts`) and, when the provider gives no types,
requires every server to be bigger afterwards than every server was before.
The exact-type check through the API stays the first proof.

The deploy budget no longer counts the provider's server create. Three budget
misses were the cloud's time, not the deploy's: the DigitalOcean compose-ha
above (742 s owned against 285, with its 558 s droplet), the rerun's Hetzner
k8s-ha (411 s against 375, server creates of 100 to 238 s) and a later Hetzner
k8s (44515679264: 374 s against 320, server creates of 173 to 192 s, 29 to 52 s
on other runs). The check and the calibrator now take the single longest
server-create timing out of both the owned and the end-to-end time, through
one function (`tests/e2e/utils/deploy-time.js`), and each provider declares
its server type once (`SERVER_RESOURCE_TYPE`). Only the longest, because
creates run in parallel: creates our code serialized would still count. The
three deploys then measure 184, 173 and 182 s. Recalibrated from the 49 stock
cold deploys since 2026-11-15, leave-one-out misses fell from 3 of 44 (exactly
those three) to none, and the check replayed on all 48 GitHub cold deploys
passes each one. A cold deploy log with no server create fails, and the
verdict names the provider's wait. The cost: the rule's +60 pads a smaller
number, so 8 of the 20 calibrated rows (all compose) would let a deploy that
doubles still pass, against 3 before.

**Do not undo:**
- `update` runs unattended-upgrade in one transaction. Minimal steps exist
  for a job that may be stopped by a shutdown; `update` restarts the server
  itself afterwards.
- A Kubernetes master and database restart are planned at up to 240 s each.

- verify-scale's fallback asks the servers, not the provider and not the
  scale's own output.
- The deploy budget takes out the longest server create, never the sum, and
  fails a cold deploy that recorded none.

**Guard:** the one-transaction pins in `tests/unit/update/inspect.test.ts` and
`execute.test.ts`; the ranges in `plan.test.ts` and `text.test.ts`;
`tests/unit/e2e/server-hardware.test.ts`; the server-create cases in
`tests/unit/e2e/deploy-budget.test.ts`, `calibrate-deploy-budgets.test.ts` and
`hollow-pass-census.test.ts`; the provider server-type census in
`tests/unit/iac/server-create-timeouts-census.test.ts`.

#### 2026-11-19: The failover DNS flip trusts the provider's answer to its write

At 05:45:33 UTC (run 44463077640, linode/compose-ha) a failover promoted the
standby, wrote the apex and wildcard A records, and exited 1 with "FAILOVER
COMPLETED, DNS DID NOT ... cil2-df3bd3.linode.appcarbon.dev reads back as
172.234.39.68, not only 172.238.167.61". The write, the read and the failure
fell in one second. Linode's account event log shows the write landed:
`domain_record_update` for both records with target 172.238.167.61 at
05:45:33, and the destroy at 05:45:45 deleted both records still holding it.
`GET /domains/{id}/records` had served a stale copy right after the PUT, so
this was a stale read, not a lost write: the Linode failover the entry above
left open. It is rare: a probe that wrote a record and read it back ran 100
rounds with no mismatch. But a false "DNS DID NOT" during a real incident
tells the user the site is down and sends them to redeploy.

`flipAndVerifyDns` now judges each record it wrote by the provider's response
to the write. Every backend's `upsertApexAndWildcard` returns, by name, the
records that response holds as `{id, value}`: the record in the PUT, PATCH or
POST body on Cloudflare, DigitalOcean, Linode and Scaleway; on Vultr's PATCH
(204, no body) and Hetzner's `set_records` (an Action), the record it addressed
with the value sent, which the 2xx or the Action's `success` confirms.
Hetzner's rrsets give each value the set's key, `<name>/<type>`, as its id, so
the set a write returns is all that is at the name. The record list
(`readARecords`, which replaced `readARecord` and returns ids) still runs, for
one thing: an A record at the name that the write did not name, at an address
other than the promoted one. A missing or different answer, another record, or
a write or list that throws still fails the flip, which never throws.

The class, "a read of a provider's DNS record list right after our own write,
treated as fresher than the write", had these members (lines as of this
change):
- `flipAndVerifyDns` (`src/lib/deploy/failover-guard.js:674`), behind
  `failoverHA`'s DNS step (`src/failover.js:3021`), the k8s-ha failover
  abort's repoint (`src/failover.js:2070`), the compose-ha failover
  (`src/lib/deploy/compose/ha.js:1841`) and the compose-ha reconverge deploy
  (`src/lib/deploy/orchestrator.js:1269`), the last two through
  `flipComposeDnsWith`: fixed as above.
- scale's `readDnsMove` after a failed `updateDNS` (`src/scale.js:1716`): an
  apex write that landed before the wildcard write failed could read as
  `old` in a lagging list, and the rollback would delete the new server with
  the apex pointing at it. A write that throws now carries the answers of the
  writes before it (`error.written`, from `writeARecords`), and `readDnsMove`
  judges those records by them. Fixed.
- The scale resume's re-read after pointing DNS back at the old server
  (`src/scale.js:956`): list only on purpose, 15 s after the write
  (`DNS_RESETTLE_MS`, `src/scale.js:688`). It looks for a late write by the
  stopped run, which only the list can show.
- Every backend's create-or-update lists the zone before it writes
  (`putRecord` in `src/lib/linode-dns.js:210`, `createDNSRecord` in the
  others). A list that missed a record created moments earlier would POST a
  duplicate (Hetzner refuses one instead). Not changed: the only create
  followed by a write to the same name is the deploy's 0.0.0.0 warm-up
  (`src/lib/deploy/orchestrator.js:2118`) and then the real-IP write, which
  awaits it after the servers are provisioned (`effects/index.js:422`,
  `k8s/dns-record.js:68`, `effects/compose-ha.js:947`,
  `effects/k8s-ha.js:849` under `src/lib/deploy/`): tens of seconds against
  a lag seen inside one second. A duplicate at another address now fails the
  next failover's flip, by name.
- `findARecordsAt` before a retired reserved IP is released
  (`src/lib/deploy/orchestrator.js:2775`), destroy's `deleteApexAndWildcard`
  (`src/destroy.js:2847`, `src/lib/deploy/compose/ha.js:1229`), and the e2e
  `dns_flip_verified` check (`tests/e2e/checks/ha-integrity.ts:1233`) read
  minutes after any write of ours, and a stale answer errs safe: the address
  is kept, a record is kept and reported, a check fails. Not changed.

**Do not undo:**
- The flip is judged by the write's response; the list only finds other
  records. Never re-read the list until it agrees: that is a retry ladder
  around a read the check does not need.
- Every backend's `upsertApexAndWildcard` returns `{id, value}[]` by name from
  its write's response, with the ids its `readARecords` lists.

**Guard:** `tests/unit/failover/flip-and-verify-dns.test.ts` (a lagging list,
another record named, and the 2026-11-19 replay through the Linode backend);
`tests/unit/dns/write-response-shape.test.ts`, which walks `DNS_PROVIDERS`
(each backend's answer, its ids against its list, and what a failed wildcard
write carries); the lagging-list case in `failover-state-matrix.test.ts` and
the partial-write case in `compose-scale-fence.test.ts`.

#### 2026-11-19: CSI pods start on the mirrors, so the deploy's re-pin rolls nothing

A Linode k8s-ha standby waited 109 s for its database
(`deploy.k3s.standby.awaitDb`, run 44623637422), against the e2e's 60 s
ceiling for a standby (`STANDBY_AWAIT_DB_MAX_MS`). Linode's database waits
across runs were 15 to 69 s on the primary and 35 to 109 s on the standby;
Hetzner's were 15 to 20 s. db-0 was created on the db node at 23:18:53. At
23:19:23 the CSI node pod on that node was torn down by the deploy's own
re-pin: step 0a of `applyK3sManifests` (`deploy.<prefix>.csiSidecars`) runs
`kubectl set image` to move the CSI sidecars from registry.k8s.io onto our
ghcr mirrors, which rolled the node DaemonSet and the controller. The new node
pod registered the driver at 23:19:34, the controller (provisioner and
attacher) was up at 23:20:06, the volume was provisioned at 23:20:07 to 14 and
attached at 23:20:21 to 40 (Linode takes 19 s), and db-0 was Ready at
23:20:44. The re-pin has a reason (registry.k8s.io 403s by node IP, so one
node's CSI pod never came up, RCA 2026-08-05), and its comment hoped the
rollout would overlap other work. On Linode it did not.

Each master's cloud-init now downloads its pinned CSI manifest and rewrites
the `image:` values before applying it (`csi_fetch_mirrored`,
`carbon/cloud-init/k3s/_csi-image-mirror.sh`, included by all three master
scripts). The pairs come from `csiInstallImageRewrites` in
`src/lib/images.js`, rendered as `${csi_image_rewrites}` by each provider's
`getK8sMasterUserData`, so no caller passes them. That function and
`csiSidecarSetImagePlan` read one per-container list (`CSI_SIDECAR_MIRRORS`,
and `csiUpstreamImagePins`, which now records DigitalOcean's `alpine:3` as
upstream spells it), so the pods start on exactly the refs, digests included,
that step 0a sets. There, kubectl computes an empty patch and sends nothing
(its `set_image.go` skips a `{}` patch): the pod template and its generation
stay, and nothing rolls. Step 0a stays as it was, to move a cluster built
before this change, and one whose alpine the version channel has moved since
its master booted. The rewrite matches whole `image:` values only, and it
stops the install (FATAL) when the manifest lacks a ref it rewrites or still
names an image on registry.k8s.io, so an upstream change cannot quietly put a
node back on registry.k8s.io. A failed download goes back to each install's
retry loop, which keeps its behaviour: Hetzner and DigitalOcean fall through
after three attempts, Linode stops. The standby wait this should shorten is
unmeasured as this is written; only an e2e run on real servers can show it.

It costs user data, and Hetzner rejects more than 32 KiB of it at server
create. The Hetzner master went from 28,284 to 30,924 bytes: the digest-pinned
refs alone are 862, and the snippet is cut to its code and four comment lines
(the reasons live on `csiInstallImageRewrites`). That tripped the 28 KiB
tripwire in `tests/unit/deploy/private-net-guard.test.ts`, now 31 KiB. About
half of every Hetzner render is comment lines, so the next addition makes its
room there.

Pulumi reads a server's user data only at create, so an existing cluster keeps
the manifest it installed, and its next deploy's re-pin moves it onto the
mirrors once, as before.

**Do not undo:**
- CSI workloads start on the mirrors; the deploy re-pin is a no-op on new
  clusters.
- The install rewrite and the re-pin read one list in `src/lib/images.js`.
  Never copy a ref into a cloud-init script by hand.

**Guard:** the install-rewrite census in
`tests/unit/deploy/k8s-image-mirrors.test.ts`, which runs each rendered
master's rewrite over its provider's upstream images (`UPSTREAM_CSI_MANIFESTS`,
`tests/_shared/csi-install-rewrite.ts`), requires the plan's refs on the plan's
containers and upstream's on every other, and requires the install to go
through it; `tests/unit/deploy/csi-install-rewrite.test.ts` (the two FATALs,
whole-value matching, a failed download); and
`tests/integration/docker/csi-repin-noop.test.ts`, which runs step 0a's
command on a real k3s: no patch and no new generation on the rewritten
workloads, a change on upstream's (also in the version channel's k3s smoke, so
the next k3s release proves it too). The Hetzner user-data size stays under
the 31 KiB tripwire in `private-net-guard.test.ts`.

#### 2026-11-20: A k8s destroy deletes CSI volumes after the servers (#562)

A k8s destroy no longer releases, detaches or deletes any CSI volume before
`pulumi destroy`. The servers' own deletes detach the volumes, and
`cleanupOrphanedVolumes` deletes the volume ids captured from the cluster's
PersistentVolumes afterwards, inside its existing 90 s wait for the cloud to
clear each attachment. The namespace release (`cleanupClusterPVCs`), the
pre-destroy detach step (`src/lib/destroy/csi-detach.js`) and the DigitalOcean
provider methods only it used are gone. A captured volume whose first delete
fails now joins that re-sweep and is reported if it never goes, where before it
printed one refused line and the destroy reported clean.

**Why:** e2e run 44653733007, DigitalOcean k8s, destroy exited 2 (LEAKED). The
release deleted the db volume at 01:37:19 to 01:37:51. At 01:37:53 the detach
step read every cluster droplet and found the volume gone. About 3 s later the
DigitalOcean Pulumi provider's own read of the db droplet listed it again
(terraform-provider-digitalocean re-reads `volume_ids` before a droplet
delete, detaches each one, and fails the delete on any error), and the detach
got a 404. The orphan sweep then deleted the droplet by API. csi-detach.js
waited for DigitalOcean to agree, and that cannot hold when one endpoint's
answer flips back.

**Do not undo:** do not delete or release a volume before the servers that
list it are destroyed. Any provider whose server delete walks its volumes
meets a volume that no longer exists.

**Guard:** `tests/unit/destroy/csi-volumes-after-servers.test.ts` runs the real
k8s destroy effect against fakes for DigitalOcean, Hetzner and Linode, k8s and
k8s-ha, with one ordered event log. The fake keeps DigitalOcean's stale read.
It requires that nothing touches a volume before every `pulumi destroy` ends,
and that every captured id is deleted after.

#### 2026-11-20: E2E opens SSH only to the runner's own address (#561)

E2E deploys now admit SSH (22) and the Kubernetes API (6443) only from the
address of the machine running the test, as a customer's firewall admits only
theirs. The runner and `scripts/iter-step.js` detect it once with the
product's `detectOperatorIp` and pass it as `ALLOWED_SSH_IPS`, and
`e2eCliEnv` refuses to build a CLI environment without one host address.
Before, e2e opened both ports to `0.0.0.0/0,::/0`.

**Why:** e2e run 44653733007, Linode k8s-ha. `update`'s final recheck got
`kex_exchange_identification: read: Connection reset by peer` from the standby
db server, which Linode's account events show was up the whole time. Linode
had handed that address (172.238.166.230) to our servers before: in run
44623637422 it belonged to a compose-ha standby and then a k8s-ha standby db,
and it reset key exchanges at 23:26:55 and 00:00:52, outside any restart.
Across both runs every other reset came 5 to 30 s after that server's
"restarting" line, while its sshd shut down. Something on the internet keeps
hitting that address, and it reached sshd only because e2e opened port 22 to
everyone. A customer never meets it.

**Do not undo:** do not widen `ALLOWED_SSH_IPS` in e2e to make a run pass. A
world-open port lets failures in that customers never see, and hides any
traffic that needs a wider firewall than a customer has.

**Guard:** `tests/unit/e2e/runner-cidr.test.ts` requires one detected host
address, never `0.0.0.0/0` or `::/0`, even from an inherited environment.

#### 2026-11-25: Compose HA is not offered to new environments (#582)

The deploy picker, `-mode` help and its error, the failover hints, the cost
grid and the user docs leave `compose-ha` out, and e2e runs it only when named
(#581). It still works on every provider: `-mode compose-ha` deploys one, and
an existing compose-ha environment keeps deploying, scaling, failing over and
restoring. On Vultr and Scaleway, where compose is then the one mode offered,
the picker says so instead of asking.

**Why:** we ship compose, k8s and k8s-ha right now, and leaving compose-ha out
of the default e2e runs takes them from 16 scenarios to 11.

**Do not undo:** offering it again is adding it to `OFFERED_TIERS`
(`src/lib/deploy/tier-registry.js`) and restoring its docs. Deleting its code
would strand the existing compose-ha environments.

**Guard:** `tests/unit/docs/unoffered-tier-surface-census.test.ts`.

#### 2026-11-25: Status lets your address through before its remote reads (#590)

`vibecarbon status`, run in a terminal outside CI, lets the operator's address
through every deployed environment's firewall before its first remote read.
Each environment records the list its firewall was last pushed
(`operatorCidrsPushed`), and status and every command that needs SSH push the
saved list to one whose record lacks the operator's own CIDR.
`vibecarbon access` pushes each environment with its own provider's token,
where it used Hetzner's for all of them, and carries on past a failing
environment.

**Why:** from a new address every SSH read timed out, and remote health showed
as unavailable with no reason. A command saves an address for the whole
project but pushes only its own environment, so "already listed" was not
enough: after `deploy prod` saved an address, `backup staging` from it stayed
locked out. And an `access remove` that stopped at its first failing
environment left the CIDR open on every environment after it.

**Do not undo:** making status read-only again brings the unexplained
"unavailable" back. Pushing only when the address is new leaves every
environment but the one that saved it closed. Pushing whenever the record
differs from the saved list turns a routine command into a sync of the local
list to every firewall: a stale checkout would re-open a CIDR someone removed
with `access remove`, or drop a teammate's newer one. Refreshing `lastUsedAt`
on every run, not at most once a day, rewrites the committed
`.vibecarbon.json` on every status. A status from cron, a CI job or a pipe
must stay a pure read.

**Guard:** `tests/unit/status/operator-ip-access.test.ts`,
`tests/unit/status/operator-ip-detect-budget.test.ts` and
`tests/unit/access/operator-ip-everywhere.test.ts`.

#### 2026-11-26: CI/CD on k8s is pull only (#591)

`vibecarbon configure cicd <env>` hands each k8s cluster to Flux from the
operator's machine: it installs Flux, gives each cluster its own read-only
deploy key (`vibecarbon flux <cluster>`, rotated on every run), writes the app
image's pull Secret when the package is private, applies the cluster file and
waits for the first sync. Nothing at GitHub connects to a cluster any more. The
`deploy.yml` workflow and the GitHub Environment copies it was seeded with
(`KUBECONFIG_B64` among them) are retired: `vibecarbon deploy <env>` applies
the secrets, the certificate and the backup settings from `.env.local` and
`.vibecarbon.json`, and `configure cicd` names an earlier version's copies at
GitHub without deleting them.

**Why:** the workflow could not work. The runner could not reach the k8s API
on 6443, which the firewall opens only to the operator's addresses; the
`GITHUB_TOKEN` Flux cloned with died when the job ended; and no pull Secret
existed, so a private app image could not be pulled.

**Do not undo:** a workflow that reaches the cluster needs a provider token at
GitHub, to open the firewall for the runner, or a 6443 open wider than the
operator's addresses. `destroy` leaves GitHub alone, because vibecarbon creates
no Environment: deleting one would delete an Environment it never made,
possibly the operator's own.

**Guard:** `tests/unit/deploy/gitops-retired-copies.test.ts`,
`tests/unit/deploy/flux-deploy-key.test.ts` and
`tests/unit/deploy/ghcr-pull-secret.test.ts`.

#### 2026-11-26: A compose server holds only a read:packages token (#592)

Compose deploys, compose-ha deploys and compose scale resolve the ghcr pull
credential once, before any server is created or provisioned. A public image
stores nothing and removes any ghcr.io login on the server, leaving every other
registry's login alone. A private image uses a `read:packages`-only token
already on one of the environment's servers, then `GHCR_PULL_TOKEN`, then one
ask on a terminal. A headless run with nothing usable refuses before any server
is created or provisioned. The server's docker login file holds only that token
for ghcr.io, and `ensureGhcrLoginOn` is its only writer. Commands that read a
secret run with `secret: true`, so the output never reaches a CI or DEBUG log or
an error.

**Why:** the server held the operator's whole GitHub. Compose logged every
server into ghcr.io with `gh auth token`, which usually carries `repo`,
`workflow` and `read:org`, and docker keeps it in `/root/.docker/config.json`.
Whoever got root on a server got every repo the operator can push to.

**Do not undo:** a server never gets `gh auth token`; `getGHCRToken()` is for
local probes only. A broad stored token is never reused, and the first deploy
after upgrading rewrites the login it left. Anyone who may have had root on a
compose server under an earlier version should revoke GitHub CLI's token at
https://github.com/settings/applications.

**Guard:** `tests/unit/deploy/ghcr-server-login-census.test.ts` for the login
path, and `tests/unit/lib/secret-read-census.test.ts` with its behaviour test
`tests/unit/lib/command-secret-output.test.ts` for secret reads.

#### 2026-11-27: Vultr k8s clusters point DNS at the master, with no reserved IP

A Vultr k8s cluster makes no reserved IP, as on DigitalOcean
(`VultrProvider.K8S_FLOATING_IP = false`): its domain points at the master's
own public IPv4, the program exports no `floatingIp`, and the master is
replaced create-first. The reserved-IP release, label and sweep code that only
Vultr k8s used is gone. No release made the reserved IP, so nothing migrates.

**Why:** every Vultr k8s destroy failed on it. It was the master's main IP, and
Vultr refuses to detach a main IP until its server is gone (400 "The server
must be closed to detach this IP because it is being used as the main IP").
The provider's instance delete returns before the server is gone, so
`pulumi destroy` deleted the instances in 7 s and then failed on the IP, on
both k8s and both k8s-ha stacks (e2e run 45922250720). It also bought nothing:
failover flips DNS between the clusters, and a resize keeps the master's
address.

**Do not undo:** a Vultr reserved IP given at create as an instance's main IP
can never be deleted in the same `pulumi destroy` as that instance. Bringing
one back needs its own assignment step and a delete that waits for the
instance to be gone, a reaping pass in the e2e sweep, and an entry in
`BILLING_EXTRAS`.

**Guard:** `tests/unit/iac/vultr-k8s.test.ts`,
`tests/unit/iac/floating-ip-backstop-census.test.ts` (a k8s program makes an IP
exactly when `K8S_FLOATING_IP` says) and
`tests/unit/e2e/sweep-reserved-ip-coverage.test.ts` (Vultr's sweep may skip
reserved IPs only while both of its flags are false).

#### 2026-11-27: Vultr stacks drop what Vultr has already deleted before each refresh

Before every `pulumi refresh` (pre-up, pre-destroy, and the one that clears
unfinished creates), a Vultr stack's instances, VPCs, reserved IPs and firewall
rules are read by id. A resource is taken out of the state only when Vultr
answers with its own 404 for that id, and each one taken out is logged. Any
other answer leaves the state alone. The refresh warning now names each failing
resource and its provider's error line, not `error: update failed`.

**Why:** in e2e run 45922250720 (vultr k8s, stack civ3) the backstop released
a reserved IP the destroy could not delete. The destroy then ran once more:
its refresh failed with `error: update failed`, its delete got a 404, and the
environment was kept and reported UNVERIFIED. terraform-provider-vultr 2.27.1
drops a missing resource only when the error contains its own phrase, and
Vultr's 404 says something else for four types. Measured 2026-11-27:

| Type | The provider looks for | Vultr's 404 says |
|---|---|---|
| Instance | `invalid instance ID` | `instance not found` |
| Vpc | `Invalid VPC ID` | `VPC not found.` |
| ReservedIp | `Invalid reserved-ip ID` | `reserved ip not found` |
| FirewallRule | `Firewall rule ID not found` | `Firewall Rule Not Found` |
| FirewallGroup | `"status":404` | matches, so its refresh drops it |
| SSHKey | `Invalid ssh key` | matches, so its refresh drops it |

**Do not undo:** do not widen the check to any 404, or to any non-2xx. A
404 for the wrong path, a 403 from an IP allowlist or an outage would take a
live resource out of the state, and the next up would make it again. Do not
retry the refresh instead: it fails the same way every time.

**Guard:** `tests/unit/iac/vultr-gone-resources-census.test.ts` (every Vultr
type the programs declare is classified, with the measured bodies as fixtures),
`tests/unit/iac/vultr-gone-refresh-sites-census.test.ts` (every refresh in
`src` runs after the check), `tests/unit/iac/vultr-gone-prune-wiring.test.ts`
and `tests/integration/iac/vultr-refresh-prune.test.ts`.

#### 2026-11-27: A cluster node that never joins fails the deploy, with the provider's view (#600)

Every node a k8s provisioning made, the k3s server, the database node and
every worker, has 600 s from the moment the k3s server serves to register and
be Ready. The deploy checks that before the first wait that needs one of them
(`awaitNodesJoined`, run by `applyK3sManifests`' db wait and by the
skipped-apply db pod wait). At the deadline the deploy stops on a server that
never registered, or on a k3s server or database node that is registered but
NotReady. It names each one, with what the provider says about it: its status,
when and where it was made, and its recent actions
(`describeServerForDiagnosis`, implemented for all five providers). A worker
that is registered but NotReady gets one warning line with the same view, and
the deploy goes on. The failover's worker wait is the same check, with no
tolerance: it scales onto those workers. Nothing is retried, rebooted or
replaced.

**Why:** twice a Hetzner database node was lost with nothing recorded. On
2026-11-06 one died after its volume attached. On 2026-11-27 (perf run
45922250720) one was created and never came up. Nothing waited for it to
join, so db-0 sat Pending on its node selector for the db wait's whole 900 s,
the failure named only the pod, and the rig was destroyed before anyone read
the provider's view of the server.

**Do not undo:** do not add a retry or an automatic replacement for a node
that never joins (no retry ladders). Do not fail a deploy on a NotReady worker:
it joined once, so it is a server that still exists, and a deploy from scratch
would not replace it, while an app change must still ship. A NotReady k3s
server or database node blocks the deploy's own waits, so it fails with the
clear message. The provider reads are GETs, one attempt
each under a 5 s abort and 30 s in all, because they run on a failure path
and must never replace the failure they describe.

**Guard:** `tests/unit/deploy/node-join-census.test.ts`, with
`tests/unit/deploy/node-join.test.ts` and
`tests/unit/providers/describe-server-for-diagnosis.test.ts`.

#### 2026-11-27: A node that never joins is probed from its own k3s server (#606)

At the join deadline, each server that never registered is probed from the
k3s server it should have joined, in one ssh bounded at 20 s: two pings and a
3 s connect to port 22 on its private and its public address, and the k3s
server's ARP entry for the private one. Each address gets a `[node-join] from
the k3s server:` log line with those facts, and the node's failure line ends
with one sentence reading them. The provider's view now carries the server's
public and private addresses as the provider lists them, prints both, and the
failure says when the public one is not the address the command waited on.
Linode reads its VPC address with one more bounded GET
(`/linode/instances/{id}/ips`); Scaleway's server read has none (IPAM holds
it), so the database node's recorded private address stands in.

**Why:** three servers never became reachable while their provider said they
were running: Hetzner fsn1 (2026-11-06), Hetzner nbg1 (2026-11-27) and, in
Vultr run 45956890734, the k8s-ha standby's database node, whose every ssh
timed out for nine minutes beside a healthy master in the same firewall group
and VPC. The provider's view could not tell a server that never booted from
one whose public network was broken, or from a wait on the wrong address, and
the rig is destroyed at teardown.

**Do not undo:** do not word a silent private address as anything but the
server not being up there unless the cluster firewall changes with it: the
sentence relies on every provider's firewall admitting ping and port 22 from
the private network (DigitalOcean, Linode and Vultr by rule; Hetzner's
firewall and Scaleway's security group never filter it), and on none
admitting ping, or port 22 from anyone but the operator, from outside. Do
not add a retry, a reboot or a replacement here: it is diagnosis, and it never
throws into the failure it describes.

**Guard:** `tests/unit/deploy/node-join-probe-firewall-census.test.ts` (runs
every k8s program and checks its firewall says what the probe says it does),
`tests/unit/deploy/node-join-census.test.ts` (every node wait passes the
probe, every provider view carries both addresses from its real response
shape) and `tests/unit/deploy/node-join-probe.test.ts` (the script, run only
under stub `ping`, `ip` and `timeout`).

#### 2026-11-27: `update`'s check waits for Ubuntu's daily apt job

`update` reads each server's pending updates only after Ubuntu's daily apt
units are done (`aptWaitForDailyUnits()`, at most 300 s). When the dry run
still fails, the reason names the last line it printed. Every ssh call that
runs apt now has a timeout of at least the waits in its own script (300 s for
the daily units, 300 s for each apt-get's lock wait) plus 120 s: 1,020 s for
the check and the WireGuard install, 1,200 s for the Docker upgrade.

**Why:** perf run 45940611622 (vultr/k8s-ha) checked both database nodes about
4 minutes after they booted, while Ubuntu's apt-daily-upgrade was installing
there. unattended-upgrade exits 1 at once when another one holds its lock, so
both nodes were skipped with "unattended-upgrade exited 1" and nothing more.
`update`'s install and Docker upgrade, and the WireGuard install, already
waited; the check was the one post-boot apt script that did not. Two of those
that waited had bounds shorter than their waits: the WireGuard install had
420 s for up to 900 s, the Docker upgrade 900 s for 900 s with no time to
work. This is the outer-timeout rule of 2026-09-01 (#46) again.

**Do not undo:** do not drop the wait for a retry of the check. Every apt
refresh or unattended-upgrade we run over ssh waits first; only cloud-init,
which runs before apt-daily, and a command we print for a person go without.
Do not shorten a bound below the waits its script holds.

**Guard:** `tests/unit/deploy/apt-daily-wait-census.test.ts`, with the wait and
reason cases in `tests/unit/update/inspect.test.ts`.

## Added and later removed

| What | Removed | Why |
|---|---|---|
| License keys, paid tiers, `activate` and `deactivate` | 2026-11-07 (#382) | Adoption over revenue |
| Supabase services and its Helm chart | 2026-10-16 (#194) | About 1.5 GB idle down to about 60 MiB |
| DNS-01, wildcard certificates, DNS tokens on servers | 2026-11-04 (#325) | DNS-01 hides its own challenge record |
| Registry backed by object storage | 2026-08-30 (#30) | Object-storage errors killed every push |
| Whole-image upload, per-node sideload, per-server registry | 2026-10-31 (#241) | The layer delta sends 0.3 MB, not 145 MB |
| Building the app on each compose-ha server | 2026-11-02 (#301) | Existed for ARM, which is excluded |
| Reseed helper pod and volume-attach repair | 2026-11-04 (#309) | The volume no longer detaches |
| Bucket rotation and shared uploads bucket | 2026-10-20 (#233) | New buckets are unreliable; data-loss paths |
| DigitalOcean k8s reserved IP | 2026-11-11 (#418) | Never moved; could fail; takeover risk |
| Vultr k8s reserved IP | 2026-11-27, before any release | Never moved; every destroy failed on it |
| Deploy blocks until the certificate is issued | 2026-10-31 (#239) | A slow authority should not fail a deploy |
| Traefik CPU limit | 2026-11-06 (#364) | One client stalled all HTTPS |
| Docker version pin | 2026-11-05 (#343) | Security fixes must arrive without a release |
| A roadmap file in the repository | 2026-09-16 (#107) | Kept elsewhere |
| n8n and Metabase add-ons | Parked 2026-11-15 (#482) | Hidden; code remains |
| Retirement guards for the hcloud autoscaler wiring, the credentials profiles and an e2e Grafana probe line | 2026-11-16 (#505) | The code they named is gone, so they could fail only on a name |
| The e2e scratch GitHub repository (`setup-repo`, `teardown-repo`, the stale-repo sweep) | 2026-11-16 (#505) | No scenario deploys in push mode, so nothing read it. Bring it back with a scenario that does |
| The template's Stripe-only webhook route, `/api/webhooks/stripe` | 2026-11-16 (#510) | `/api/webhooks/billing` handles the same Stripe events, and `configure billing` has named only that URL since the first public commit. `npm run stripe:listen` now forwards there |
| `backup -action download` and its `-source` flag | 2026-11-16 (#510) | It copied a dump file out of the database pod, and no released version wrote one: backups have been wal-g base backups since before the first public commit. `backup -l` lists them and `restore` reads them |
| Template `k8s:apply` and `k8s:delete` scripts | 2026-11-18 | Defaulted to an overlay the template does not ship |
| `carbon/src/shared/types.ts` | 2026-11-18 | Unused hand copy of the schema that had drifted |
| Per-provider k3s `*db-init.sh` scripts | 2026-11-18 | The worker script with three flags; now rendered from it |
| The GitOps deploy workflow (`deploy.yml`) and its GitHub Environment copies | 2026-11-26 | Its runner could not reach the cluster; Flux pulls instead |

## Problems that keep coming back

1. **Reading object storage too soon.** A new bucket, or an object written
   seconds ago, can read as missing. Every fix removed the read. None added a
   retry. (#30, #138, #233, #352, #357, #360)
2. **Image pulls on a fresh server.** Silenced pulls, the local-only app
   image, registry quotas, single-attempt downloads, flow-label resets.
   (#240, #278, #282, #415, #442)
3. **DNS caches, including "no such name".** Never look up a name before its
   record exists, and never leave a gap between delete and create.
   (#317, #325, #337)
4. **Volume attach and detach on DigitalOcean.** Every recurrence came from
   the project's own detach. The fix was to stop detaching. (#299, #309)
5. **"Ready" that means nothing.** A socket that accepts before the real
   server starts, nodes shown Ready after they died, a container marked ready
   before it listens. (#363, #427, #448)
6. **Timeouts that do not bound.** An option that only warns, an outer limit
   shorter than the inner one, a timer that keeps the process alive.
   (#46, #230, #316)
7. **Destroy claiming or leaking the wrong thing.** Ownership by name
   substring, locks cleared without proof, a bucket called gone while the
   provider still listed it. (#225, #384, #449, #451, 2026-11-17)
8. **Checks that pass on nothing.** A check satisfied by an error page, a
   guard matching dead code, unit tests reaching real hosts, checks that were
   always skipped. (#226, #352, #439, #457)

## Provider facts that shaped the design

| Provider | Fact | Consequence |
|---|---|---|
| DigitalOcean | A VPC range must be unique across the whole account | Each cluster's range is derived from its name |
| DigitalOcean | Nameservers hide a record that was looked up before it existed | HTTP-01 for certificates |
| DigitalOcean | The API can disagree with itself for a while after a write | A 404 on a just-listed resource is not proof it is gone |
| DigitalOcean | Its resolver stalls SRV lookups for about 31 s | Package downloads turn SRV lookups off |
| Hetzner | Reading a new bucket at once starts minutes of random failures | Write first, read later |
| Hetzner | A bucket can answer "no such bucket" for 15 minutes while its listing shows it | A listed bucket is never reported as gone |
| Hetzner | An object written seconds ago can read as missing | Retention runs before the backup push |
| Hetzner | First boot can wait 120 s for the network | A slow network stage there is not project code |
| Linode | DNS has a 300 s minimum TTL | A failover can take up to five minutes to be seen |
| Linode | Released addresses are reissued within minutes | A logged address may belong to someone else |
| Linode | Labels are cut at 50 characters; every image boots as "localhost" | Find by label and id; hostnames are set at boot |
| Linode | Two VPCs may share a range | No range allocation is needed, unlike DigitalOcean |
| Vultr | Nameservers remember that a name did not exist | Same rule: never look up before create |
| Vultr | A main IP cannot be detached until its server is gone, and the provider's instance delete returns first | k8s clusters have no reserved IP; the domain points at the master |
| Vultr | Its 404 wording differs from what the provider's Read looks for, for instances, VPCs, reserved IPs and firewall rules | Those are read by id and dropped from the state before each refresh |
| All | A fresh server may inherit a spent Docker Hub quota | Core images come from the GHCR mirror |

## Dated bridges

Compatibility code that is meant to be deleted. When you add one, add it here
with a date: three months after the release that made it unnecessary. The last
column says what happens, once the bridge is gone, to a project that never ran
it. Weigh the removal against that.

| Bridge | Where | Remove after | After removal, a project that never ran it |
|---|---|---|---|
| Migration from the empty state passphrase (#420, released in 0.53.0 on 2026-11-13) | `src/lib/iac/index.js`, `StateMigrationError` in `src/lib/iac/state-error.js` | 2027-02-11 | Its state does not open with the project's passphrase, and every command that reads state stops with the passphrase error. Opening it once with a version that still has the migration fixes it |
| AppArmor restriction off on k8s nodes | cloud-init for k3s | When k3s ships the upstream fix | Not a migration. It is a workaround for new nodes, and nothing old depends on it |
| Repair of `.env` lines in the old shell quoting (#132, released in 0.46.0 on 2026-09-21) | `src/lib/dotenv-heal.js`, `repairLegacyEnvQuoting` in `src/lib/project.js`, the legacy quoting line in `src/status.js` | 2026-12-21 | A value that holds a single quote and was written by 0.45.0 or earlier reads cut short at the quote in Node, Compose and Vite, and a deploy ships the short value. Enter it again with `vibecarbon configure` |
| DigitalOcean reserved IP migration (#418, released in 0.53.0 on 2026-11-13) | `src/lib/deploy/k8s/retired-reserved-ip.js`, `src/lib/iac/retired-resources.js` | 2027-02-13 | A DigitalOcean k8s cluster last deployed by 0.52.0 or earlier still lists the address in its state. The next deploy, scale or failover would delete it while DNS still points at it: an outage, then a takeover risk. Remove the bridge only together with a refusal for a stack that still lists the address |
| Removal of provider tokens left in clusters (#423, released in 0.53.0 on 2026-11-13) | `removeRetired` in `src/lib/deploy/k8s/k3s.js`, `K8S_RETIRED_CLOUD_SECRETS` on the provider classes | 2027-02-13 | A cluster last deployed by 0.52.0 or earlier keeps a second copy of the provider token in `kube-system` that nothing reads. Deploys still work. Delete the copy with kubectl |
| Removal of DNS tokens left on compose servers (#325, released in 0.51.0 on 2026-11-06) | `dropDnsTokenEnv` in `src/scale.js` | 2027-02-06 | A compose server last deployed by 0.50.1 or earlier can have the DNS provider's token in its `.env`, and a scale copies it to the replacement server. Deploys and scales still work. Delete the lines by hand |
