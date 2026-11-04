# HTTP-01 Everywhere Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every vibecarbon certificate, in all four modes and for every DNS provider, validates with HTTP-01 for an explicit list of names; DNS-01, wildcards, and DNS tokens on servers are gone.

**Architecture:** Compose keeps Traefik's built-in ACME client (lego), restricted to its HTTP-01 path, which already ships for manual DNS. k8s keeps cert-manager with one HTTP-01 ClusterIssuer pair through the Traefik ingress class. The CLI keeps writing A records from the operator's machine. Every DNS-01 piece is deleted rather than left disabled: the compose override, the issuers, the secrets, the webhook, the challenge-record reaping, the settle floors, and the stalled-challenge watchdog. Teardown and failover are reordered so DNS never changes under a running validation.

**Tech Stack:** Node 24 ESM CLI (pnpm), vitest, Traefik v3 with lego, cert-manager v1.20.2, k3s, Pulumi, bash.

**Spec:** `docs/superpowers/specs/2026-11-04-http01-everywhere.md`. A scratch inventory of every DNS-01 site with file:line lives at `/tmp/claude-1000/-home-brandon-repos-vibecarbon/0b7ee7cd-7067-44f6-a72a-5ce5d7505b2c/scratchpad/http01-inventory.md`. Read it first; line numbers are against `8ec6376`.

## Global Constraints

- **Commits:** conventional commits, committed with pathspecs (`git commit -- <files>`), never `--no-verify`, no `!:` or `BREAKING CHANGE` footers, and no attribution lines.
- **The PR body** carries a Compatibility note: existing environments get one certificate re-issue, because their names change, and a deploy removes the DNS token from the server.
- **No backward-compat shims, aliases or migration code.** There are no customers, and vibecarbon-web is pinned to `npx vibecarbon@0.49.0`.
- **Copy:** no em dashes in user-facing copy (CLI output, docs); second person; say why.
- **Files:** dotenv writes go only through `formatDotenvLine`, and `.vibecarbon.json` writes only through `updateProjectConfig`.
- **Fixes:** root fixes only, no retry ladders. `docs/mitigations.yml` entries that belonged to DNS-01 are deleted together with their census entries.
- **The family sweep is part of each fix:** every task that removes a mechanism adds or updates a census test asserting the mechanism is absent across `src/` and `carbon/`.
- **Tests:** focused vitest with `--maxWorkers=2`, because the machine is memory-constrained. The pre-commit gate runs the full unit suite with `VITEST_MAX_WORKERS=2`.
- **Issuer names:** k8s issuers are exactly `letsencrypt-prod` and `letsencrypt-staging`; the standby keeps `vibecarbon-standby-selfsigned`.
- **k8s names:** the k8s certificate's `dnsNames` is exactly `[domain]`.
- **Compose default certificate:** `main` is `traefik.<domain>`, and `sans` holds `grafana.<domain>` when observability is on, `n8n.<domain>` when n8n is on and `metabase.<domain>` when metabase is on, in that order. There is no `prometheus`. The apex keeps its own certificate through the app router's `tls.certresolver`.

## Review Focus

1. **The A record is the 0.0.0.0 warm-up placeholder or an old IP when the first HTTP-01 attempt runs.** Compose must wait for public DNS to show the server's IP before Traefik starts, for every DNS provider, not only manual. Task 3 adds the test.
2. **Cloudflare proxied record.** HTTP-01 through Cloudflare's proxy with "Always Use HTTPS" never reaches Traefik. The Cloudflare backend must keep creating records with `proxied: false`. Task 5 adds the test.
3. **An HA standby attempting ACME.** Under HTTP-01 it fails every challenge and uses up Let's Encrypt's 5 failed validations per hostname per hour. Only the side DNS points at may arm ACME. Task 4 adds the test.
4. **An existing environment's TLS snapshot carries the old wildcard names.** The restore must refuse the snapshot cleanly and cert-manager or Traefik must re-issue, with no crash. Task 1 adds the test.
5. **Failover with no usable snapshot.** The ACME issuer is armed or promoted only after the DNS flip, so the first HTTP-01 attempt reaches the new primary. Task 4 adds the test.

---

### Task 1: One HTTP-01 issuer pair and apex-only names on k8s

**Files:**
- Modify: `carbon/k8s/infra/cert-manager-resources/cluster-issuers-manual.yaml`. Rename it to `cluster-issuers.yaml` with `git mv`. The issuers are renamed `letsencrypt-prod` and `letsencrypt-staging`, with account keys `letsencrypt-prod-account-key` and `letsencrypt-staging-account-key`.
- Delete: `cluster-issuers-cloudflare.yaml`, `cluster-issuers-hetzner.yaml` and `cluster-issuers-digitalocean.yaml` in the same directory. Update its `kustomization.yaml` resources list.
- Modify: `src/lib/deploy/k8s/k3s.js` (`pickIssuerName`, `certificateDnsNames`, `k8sIssuerName`, `k8sTlsIdentity`, ~1018-1107, and the call site ~4022-4046).
- Modify: `carbon/scripts/render-tls-certificate.mjs` (issuer regex and name regex, ~41-43) and `carbon/k8s/base/traefik/certificate.yaml` (default issuer and comments).
- Modify: `src/failover.js` `promoteAcmeIssuer` (~493-600). The promote annotation and target issuer use the new names.
- Modify: `src/lib/deploy/k8s/acme-issuer-policy.js` (header rationale only: the mechanism stays because an HTTP-01 standby cannot validate).
- Test: `tests/unit/deploy/cert-manager-issuer-selection.test.ts`, `certificate-dns-names.test.ts`, `k8s-tls-restore` tests, and a new `tests/unit/deploy/k8s-http01-only-census.test.ts`.

**Interfaces:**
- Produces: `pickIssuerName({ acmeServer }): 'letsencrypt-prod' | 'letsencrypt-staging'`. `dnsProvider` is no longer a parameter; delete it from every caller.
- Produces: `certificateDnsNames(domain): string[]` returning `[domain]`.
- Produces: `k8sTlsIdentity({ projectDir, domain }): { issuerName, dnsNames, ca }`.

- [ ] **Step 1: Write the failing tests.**
  - `pickIssuerName({ acmeServer: 'https://acme-staging-v02.api.letsencrypt.org/directory' })` returns `'letsencrypt-staging'`.
  - `pickIssuerName({})` returns `'letsencrypt-prod'`.
  - `certificateDnsNames('a.example.com')` equals `['a.example.com']`.
  - A census reads every YAML under `carbon/k8s` and asserts:
    - no ClusterIssuer has a `dns01` solver;
    - the only ACME ClusterIssuers are `letsencrypt-prod` and `letsencrypt-staging`, each with `http01.ingress.class: traefik`;
    - no `dnsNames` entry starts with `*.`.
  - A TLS snapshot whose names are `['d.example.com', '*.d.example.com']`, judged against `{ dnsNames: ['d.example.com'], issuerName: 'letsencrypt-prod' }`, is refused with a reason naming the names mismatch, so the deploy falls through to cert-manager issuing (Review Focus 4).
- [ ] **Step 2: Run them and see them fail.** `npx vitest run --project unit --maxWorkers=2 tests/unit/deploy/cert-manager-issuer-selection.test.ts tests/unit/deploy/certificate-dns-names.test.ts tests/unit/deploy/k8s-http01-only-census.test.ts` fails on the names.
- [ ] **Step 3: Implement.** Rename the issuer file and its issuers, delete the three DNS-01 issuer files, and change the four k3s.js functions and every caller. Update the renderer regexes so they accept exactly the two issuer names plus `vibecarbon-standby-selfsigned`, and reject `*`. Repoint the failover promote. Leave the snapshot judging logic (tls-snapshot.js, k8s/tls-restore.js) unchanged: Step 1's test proves it already refuses on a names mismatch.
- [ ] **Step 4: Run the k8s TLS tests.** `npx vitest run --project unit --maxWorkers=2 tests/unit/deploy/ tests/unit/failover/` passes.
- [ ] **Step 5: Commit** `feat(k8s): one HTTP-01 issuer pair and apex-only certificate names`.

### Task 2: Remove DNS-01 machinery from clusters and GitOps

**Files:**
- **k3s.js:**
  - Delete `buildDnsProviderSecret` (~1109-1158), its call (~3408) and its apply (~3857-3862).
  - Delete the Hetzner webhook helm install block (~3864-3975) and the helm preflight that exists only for it (~4963-4964).
- **render-cert-manager.mjs** (~85-111): drop `--dns01-recursive-nameservers=1.1.1.1:53,8.8.8.8:53` and `--dns01-recursive-nameservers-only`, and keep the minimum-backoff flag.
- **acme-order-recovery.js:** delete `findStalledAcmeChallenges`, `CHALLENGE_STALL_MS` (~163-236) and the watchdog's stalled-challenge bounce (~414-442). Terminal-order recovery stays, with its wording made challenge-neutral.
- **Delete:** `carbon/k8s/gitops/cert-manager-webhook-hetzner/` and its Flux entries in `carbon/k8s/flux/clusters/primary/vibecarbon.yaml` (~13, ~133-156) and `standby/vibecarbon.yaml` (~116-133).
- **carbon/.github/workflows/deploy.yml:** delete the DNS-secret arms (~180-233), the token keys at ~150-155, and the webhook references at ~410 and ~431.
- **src/lib/github-environments.js:** stop seeding DNS tokens as GitHub secrets (~1-24, ~136-143). The caller is configure.js ~1605.
- **create.js:** remove the template copy of the webhook files (~770).
- **Tests:**
  - Delete `tests/unit/deploy/cert-manager-secrets.test.ts`, `gitops-cert-webhook-wiring.test.ts` and `k3s-helm-webhook-retry.test.ts`.
  - Update `k3s-apply-manifests-ordering.test.ts` (~86, ~1342, ~1388, ~1641-1700), `cert-manager-manifest.test.ts` and `acme-order-recovery.test.ts`.
  - Extend Task 1's census.

**Interfaces:**
- Consumes: Task 1's issuer names.
- Produces: none new.

- [ ] **Step 1: Extend the census.** Add assertions, failing for now, that no file under `src/`, `carbon/k8s`, `carbon/.github` or `carbon/scripts` contains:
  - `dns01-recursive-nameservers`;
  - `cert-manager-webhook-hetzner`;
  - a Secret named `digitalocean-dns`, `cloudflare-api-token` or `hetzner`;
  - `findStalledAcmeChallenges`.
- [ ] **Step 2: Run the census and see it fail.**
- [ ] **Step 3: Delete and update** everything listed under Files. The rendered cert-manager kustomization changes once, so the controller rolls once on the next deploy; say so in the commit body.
- [ ] **Step 4: Run** `npx vitest run --project unit --maxWorkers=2 tests/unit/deploy/ tests/unit/configure/ tests/unit/template/`, then `pnpm lint`. Both pass.
- [ ] **Step 5: Commit** `refactor(k8s): drop DNS-01 secrets, the Hetzner webhook and the stalled-challenge watchdog`.

### Task 3: Compose and compose-ha solve HTTP-01 only

**Files:**
- **Delete** `src/lib/deploy/acme.js`: `useDnsChallenge`, `dnsChallengeEnv` and `DNS01_OVERRIDE_FILE`. Then remove every import and call. The inventory section 1 lists them: orchestrator.js ~1851, 1873, 2017; scale.js ~299, 468, 506, 722, 1150, 1288, 1763-1773; effects/compose-ha.js ~837; effects/index.js ~428-500.
- **Delete** `carbon/docker-compose.dns01.prod.yml` and its wiring: bundle.js ~100, 381 and 451-456 (`COMPOSE_OPTIONAL_FILES`); create.js ~834-837; upgrade-policy.js ~18; config-registry.js ~794; acme-role.js ~93.
- **Modify `renderTraefikDefaultCert`** in bundle.js (~270-352). Its signature becomes `({ domain, features })`. Main is `traefik.<domain>`; sans are grafana, n8n and metabase, as Global Constraints fix; delete the DNS-01 branch and its comments.
- **Modify effects/index.js** (~428-500): `waitForDNSPropagation` runs for every provider with automated DNS before Traefik starts, and the `waitForZoneServed` branch is deleted. compose-ha.js ~834-844 runs it too.
- **Modify scale.js** (~1282-1301): the replayed server `.env` drops every DNS-01 token variable (`DO_AUTH_TOKEN`, `CF_DNS_API_TOKEN`, `HETZNER_API_TOKEN`, `LINODE_TOKEN`, `VULTR_API_KEY`, `SCW_SECRET_KEY`, `ACME_DNS_PROVIDER`, `ACME_DNS_DELAY_BEFORE_CHECKS` and the `*_PROPAGATION_TIMEOUT` vars) before writing.
  - The upload's `tar -x` must remove a stale `docker-compose.dns01.prod.yml` left on an existing server. Add an `rm -f` of that one path in the same remote step.
- **Modify tls-ready.js:** `TLS_FIRST_LOOK_BUDGET_MS` becomes `120_000`, justified by HTTP-01. Delete the `ACME_DNS_DELAY_BEFORE_CHECKS` comments (~5-7, 30-36).
- **Modify carbon/backup/tls-retry.sh:** `MIN_TRAEFIK_AGE_SECONDS` becomes `300`, and the comments at ~40-46 and ~59 drop DNS-01.
- **Tests:**
  - Delete `tests/unit/deploy/acme.test.ts`, `dns-challenge-gate-wiring.test.ts` and `wait-for-zone-served.test.ts`.
  - Update `traefik-default-cert.test.ts`, `bundle-env-overrides.test.ts` (~206-276), `bundle-operator-secret-strip.test.ts` (~96), `compose-ha-overlay-up-flags.test.ts` (~55), `dns-early-write.test.ts` (~117, 262), `app-runtime-env-census.test.ts` (~62), `tls-ready.test.ts` (~133-158), `tests/unit/template/tls-retry-script.test.ts` (~13), `tests/unit/scale/compose-scale-*` (the `dnsChallenge` ctx), `services/addon-start.test.ts` (~51) and `config-registry.test.ts` (~264).
  - Integration: `tests/integration/docker/compose-secret-reach.test.ts` (~61, 94, 158) and `tests/integration/template/manifest-dry-run.test.ts` (~10, 90).

**Interfaces:**
- Produces: `renderTraefikDefaultCert({ domain: string, features?: { observability?: boolean, n8n?: boolean, metabase?: boolean } }): string`.

- [ ] **Step 1: Write the failing tests.**
  - `renderTraefikDefaultCert({ domain: 'a.dev', features: { observability: true, n8n: true, metabase: true } })` contains `main: "traefik.a.dev"` and the sans `grafana.a.dev`, `n8n.a.dev` and `metabase.a.dev` in that order. It contains no `*`, `dashboard.` or `prometheus`.
  - The compose deploy effect calls `waitForDNSPropagation` for a `digitalocean` DNS provider before the Traefik start, and calls no `waitForZoneServed` (Review Focus 1).
  - The bundle's server `.env` for a `digitalocean` deploy contains none of the token variables listed under Files.
  - The scale replay drops them from an old `.env` that has them.
  - A census confirms `docker-compose.dns01.prod.yml`, `useDnsChallenge`, `ACME_DNS_PROVIDER` and `dnschallenge` appear nowhere under `src/` or `carbon/`.
- [ ] **Step 2: Run them and see them fail.** Use the files above with `--maxWorkers=2`.
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `npx vitest run --project unit --maxWorkers=2 tests/unit/`, then `pnpm test:integration -- tests/integration/docker/compose-secret-reach.test.ts tests/integration/template/manifest-dry-run.test.ts`. Both pass.
- [ ] **Step 5: Commit** `feat(compose): every certificate validates over HTTP-01; no DNS token on the server`.

### Task 4: Failover arms ACME only where DNS points

**Files:**
- **Modify compose/ha.js:** in the failover flow, `armComposeAcme` (~2348-2380, called ~2351-2352) moves after the DNS flip (~2563-2574). Disarm (~2549-2556) still runs on the old primary before the flip.
- **Modify failover.js:** `promoteAcmeIssuer` (STEP 5b, ~2584) moves after the STEP 7 DNS flip (~2679). The TLS snapshot restore stays before the flip, so the new primary serves a valid certificate the moment DNS moves.
- **Modify acme-role.js** (header ~1-35 and recreate shell ~59-117): change the rationale to HTTP-01, and delete the dns01 file fallback.
- **Test:** `tests/unit/failover/` (the ordering tests) and `tests/unit/deploy/compose-ha-acme-role.test.ts` (~63, ~97).

**Interfaces:**
- Consumes: Task 1's `promoteAcmeIssuer` target names, and Task 3's removal of the dns01 file.

- [ ] **Step 1: Write the failing ordering tests.** Drive the failover effect with recorded fakes and assert the recorded order:
  - compose-ha: the disarm runs before the DNS flip, and the arm after it.
  - k8s-ha: the TLS restore runs before the flip, and the issuer promote after it.
  - A standby that is never flipped to is never armed (Review Focus 3 and 5).
- [ ] **Step 2: Run them and see them fail.** They fail on today's order.
- [ ] **Step 3: Reorder** both flows and update the acme-role rationale.
- [ ] **Step 4: Run** `npx vitest run --project unit --maxWorkers=2 tests/unit/failover/ tests/unit/deploy/`. It passes.
- [ ] **Step 5: Commit** `fix(ha): arm ACME on the new primary after DNS points at it`.

### Task 5: Delete the DNS-01 provider table and challenge-record reaping

**Files:**
- **src/lib/dns-provider.js:** delete `DNS01_PROVIDERS` and its header comments (~24-229). Keep `DNS_PROVIDERS`, `resolveDnsToken` and `hasAutomatedDns`. Remove the remaining consumers: k3s.js ~64 and ~1018; upgrade-policy.js ~30; secret-scan.js ~139 and ~152, keeping `LINODE_TOKEN` and `VULTR_API_KEY` because they are compute `CLI_TOKEN_ENV`.
- **Delete** `src/lib/acme-challenge.js`, and each backend's `challengeRecordNames` and `deleteChallengeRecords`: cloudflare-dns.js ~314, hetzner-dns.js ~445, digitalocean-dns.js ~327, linode-dns.js ~407, vultr-dns.js ~334, scaleway-dns.js ~464.
- **Delete their callers:** destroy.js ~28 and ~2041-2066, including the leak hint; compose/ha.js ~16 and ~1095-1115.
- **Update** `tests/unit/lib/dns-registration-census.test.ts` (~39-43, drop the method from the contract).
- **Delete** `tests/unit/lib/dns-challenge-cleanup.test.ts`, `tests/unit/lib/dns01-semantics-classifier.test.ts` and `scripts/probe-dns01-semantics.js`.

- [ ] **Step 1: Write the failing tests.**
  - Update the DNS registration census so no backend exports `deleteChallengeRecords`, and nothing under `src/` contains `_acme-challenge` or `DNS01_PROVIDERS`.
  - Pin `proxied: false` on the Cloudflare A-record writes (Review Focus 2): the create call's body for a fresh domain has `proxied: false`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Delete and update** everything listed under Files.
- [ ] **Step 4: Run** `npx vitest run --project unit --maxWorkers=2 tests/unit/lib/ tests/unit/destroy/ tests/unit/deploy/`, then `pnpm lint`. Both pass.
- [ ] **Step 5: Commit** `refactor(dns): providers manage A records only; no challenge records to reap`.

### Task 6: Teardown deletes DNS after compute in every mode

**Files:**
- **Modify destroy.js** k8s and k8s-ha (~2719-2721): run the Pulumi destroy of every stack first, then delete the apex and wildcard A records, the same order compose (~2233-2255, then ~2372) and compose-ha (ha.js ~974, then ~1030+) already use.
- **Test:** a new `tests/unit/destroy/dns-after-compute-census.test.ts`.

- [ ] **Step 1: Write the failing test.** For each tier destroy function (compose, compose-ha, k8s, k8s-ha), drive it with recorded fakes and assert the last compute deletion comes before the first DNS record deletion.
- [ ] **Step 2: Run it and see it fail.** It fails on k8s and k8s-ha.
- [ ] **Step 3: Reorder** the k8s tiers. A DNS deletion that fails after compute is gone still reports through the existing leak list; don't add a retry.
- [ ] **Step 4: Run** `npx vitest run --project unit --maxWorkers=2 tests/unit/destroy/`. It passes.
- [ ] **Step 5: Commit** `fix(destroy): delete DNS only after the servers that could still validate are gone`.

### Task 7: e2e runs on fresh names; DNS-01 harness pieces go

**Files:**
- **Modify `tests/e2e/runner.ts`** (~923): the scenario domain becomes `${envPrefix}-${runTag}.${baseDomain}`. `runTag` is the first 6 lowercase hex characters of the run id, computed once per run. The env name (`envPrefix`) is unchanged.
- **Make the orphan and DNS sweeps** (`tests/e2e/utils/sweep-*.ts`, `scripts/sweep-*.js`) match records named `<envPrefix>` or `<envPrefix>-<6 hex>` under the base domain, so a crashed run's names are swept.
- **Delete from `tests/e2e/utils/classify-failure.ts`** (~90-115) the TXT and Vultr NS patterns, and their cases in `tests/unit/e2e/classify-failure.test.ts`.
- **Delete from `docs/mitigations.yml`** the entries `acme-issuance-pending` (the DNS-01 extension), `dns-anycast-propagation-divergence` and `vultr-dns-negative-cache-poisoning`, plus their reason mappings (~445, ~447). Update `frozenSites` and the mitigations census.
- **Delete** `scripts/acme-iso/`.
- **Comments:** tests/config.ts (~137, 331, 371, 432), scenario-overrides.ts (~8), cluster-diagnostics.ts (~225) and tests/.env.e2e.example (~61, 84, 105).

- [ ] **Step 1: Write the failing tests.**
  - The resolved scenario domain for env `d4`, base `do.appcarbon.dev` and run id `0123abcd-...` is `d4-0123ab.do.appcarbon.dev`.
  - The sweep's name matcher accepts `d4` and `d4-0123ab`, and rejects `d40` and `d4-xyz`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement** the changes listed under Files.
- [ ] **Step 4: Run** `npx vitest run --project unit --maxWorkers=2 tests/unit/e2e/`, then `pnpm exec tsc -p tsconfig.e2e.json --noEmit`. Both pass.
- [ ] **Step 5: Commit** `test(e2e): each run gets fresh DNS names; drop the DNS-01 classifiers and mitigations`.

### Task 8: Docs and copy

**Files:** AGENTS.md (~236-238, 277), docs/deploy-hetzner.md (~36, 147), docs/deploy-digitalocean.md (~47), carbon/k8s/README.md (~184), carbon/k8s/flux/README.md, the CLI hint at effects/index.js ~680, and the code comments the inventory lists in section 6.

- [ ] **Step 1: Rewrite each passage.** Certificates use HTTP-01 for the listed names, port 80 must reach the server, the DNS provider token stays on your machine, and there is no wildcard certificate. Say how to add your own subdomain. On compose, give its Traefik router the label `traefik.http.routers.<name>.tls.certresolver=letsencrypt`, and Traefik issues it its own certificate over HTTP-01. On k8s, routes are paths on your domain, so a new path needs nothing.
- [ ] **Step 2: Check the copy.** `git grep -nE "DNS-01|dns01|wildcard cert|_acme-challenge" -- AGENTS.md docs carbon src` returns only intentional historical mentions in `docs/superpowers/`.
- [ ] **Step 3: Commit** `docs: certificates validate over HTTP-01 for each name`.
