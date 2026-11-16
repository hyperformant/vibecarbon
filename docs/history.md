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

**Guard:** `tests/unit/docs/removed-license-surface-census.test.ts`.

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

**Unproven:** what triggered the prompts. Key login to GitHub worked without
one every time it was tried, and the key has no passphrase. Which session
start reason caused the repeats was not recorded either, and the Claude Code
hooks reference does not say whether a subagent start fires `SessionStart`.

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
| Deploy blocks until the certificate is issued | 2026-10-31 (#239) | A slow authority should not fail a deploy |
| Traefik CPU limit | 2026-11-06 (#364) | One client stalled all HTTPS |
| Docker version pin | 2026-11-05 (#343) | Security fixes must arrive without a release |
| A roadmap file in the repository | 2026-09-16 (#107) | Kept elsewhere |
| n8n and Metabase add-ons | Parked 2026-11-15 (#482) | Hidden; code remains |

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
   substring, locks cleared without proof. (#225, #384, #449, #451)
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
| Hetzner | An object written seconds ago can read as missing | Retention runs before the backup push |
| Hetzner | First boot can wait 120 s for the network | A slow network stage there is not project code |
| Linode | DNS has a 300 s minimum TTL | A failover can take up to five minutes to be seen |
| Linode | Released addresses are reissued within minutes | A logged address may belong to someone else |
| Linode | Labels are cut at 50 characters; every image boots as "localhost" | Find by label and id; hostnames are set at boot |
| Linode | Two VPCs may share a range | No range allocation is needed, unlike DigitalOcean |
| Vultr | Nameservers remember that a name did not exist | Same rule: never look up before create |
| All | A fresh server may inherit a spent Docker Hub quota | Core images come from the GHCR mirror |

## Dated bridges

Compatibility code that is meant to be deleted. When you add one, add it here
with a date.

| Bridge | Where | Remove after |
|---|---|---|
| Migration from the empty state passphrase | `src/lib/iac/index.js` | 2027-02-11 |
| AppArmor restriction off on k8s nodes | cloud-init for k3s | When k3s ships the upstream fix |
| DigitalOcean reserved IP migration | `src/lib/deploy/k8s/retired-reserved-ip.js` | No date set yet |
| Removal of provider tokens left in clusters and on servers | `src/lib/deploy/k8s/k3s.js`, `src/scale.js` | No date set yet |
