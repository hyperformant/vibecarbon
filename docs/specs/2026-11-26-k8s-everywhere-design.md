# Kubernetes everywhere: the three gaps, then k8s and k8s-ha on Vultr and Scaleway

Status: approved by Brandon, 2026-11-26.

## Intent

Every provider vibecarbon offers should run every offered tier: compose, k8s
and k8s-ha. Hetzner, DigitalOcean and Linode do. Vultr and Scaleway only run
compose, and the product says "soon" for the rest. The k8s tiers also carry
three known gaps that apply to every provider. Fix those first so the two new
providers inherit a sound base, then bring Vultr and Scaleway up to the same
bar the other three meet: the default e2e scenarios green on GitHub and the
perf table filled.

## Goals

1. The three k8s gaps are closed on every provider (Part A).
2. Vultr runs k8s and k8s-ha (Part B).
3. Scaleway runs k8s and k8s-ha (Part C).
4. `tests/config.ts` gives both providers `defaultSelection: ['compose', 'k8s', 'k8s-ha']`. The default matrix grows from 11 to 15 scenarios. All 15 are green in `e2e-us-perf.yml` runs on main, and the perf table carries rows for both providers' new tiers.
5. User docs, the vendor matrix and the provider guides say "yes" where they say "soon" today.

## Non-goals

- compose-ha anywhere: it is not offered (OFFERED_TIERS) and stays that way.
- Changing how Hetzner, DigitalOcean or Linode clusters work, beyond Part A.
- A release. Releases stay Brandon's call. Main may carry the new tiers before they are proven, because nothing reaches users without a release.
- Traefik 3.8, image bumps, Dependabot work.

## Anti-goals (would make this a failure even if it works)

- Managed Kubernetes (Vultr VKE, Scaleway Kapsule). Every provider runs the same thing: k3s on VMs, provisioned by Pulumi. One approach for all providers.
- `if (provider === 'vultr')` in shared deploy, HA, failover or destroy code. Every difference goes through provider class members, as Linode's did (the survey found no provider-id branch in shared code today).
- A provider token at GitHub, or 22 or 6443 opened wider than the operator CIDRs.
- Retry ladders for provider flakiness. A failure gets a root cause; see the no-retry-ladders rule in AGENTS.md and memory.
- E2E shortcuts a customer cannot use: pre-baked images, rig-scoped caches, pinned server types.

## Constraints

- Follow `docs/adding-a-provider.md`. The Linode lift (#390, commit a0631083, 70 files) is the template; its plan is at `git show a0631083:docs/superpowers/plans/2026-11-07-linode-k8s.md`.
- Boot scripts stay under the census size caps (28 KiB and 31 KiB rendered). Scaleway user data must be ASCII (`assertAsciiCloudInit`).
- CSI and other system images come from our ghcr mirrors (`src/lib/images.js`, `_csi-image-mirror.sh`), never straight from upstream registries on a node. New ghcr packages must be made public by hand; that is a step for Brandon or a token with package admin, and the plan must say when it is needed.
- x86-64 only (`src/lib/deploy/platform.js`).
- Merge first, then real-server tests: the local suite and CI gate each PR; e2e runs on GitHub from main.
- Every census the survey listed (section "Touchpoints") gains entries. A census that would pass vacuously for a new provider is a defect.
- Repo conventions: Conventional Commits, no `!:` or BREAKING CHANGE footers (use a "Compatibility note"), no em dashes in user-facing copy, CLI voice lowercase and friendly.

## Part A: the three gaps (every provider)

### A1. Stale comments about the apiserver address

`src/lib/deploy/k8s/k3s.js:4937-4941` and `carbon/scripts/render-cert-manager.mjs:73` say the in-cluster `kubernetes` Endpoints advertises the master's public IP. It does not: every master installs k3s with `--advertise-address` on its private IP (Hetzner 10.0.1.1 in `carbon/cloud-init/k3s/master-init.sh`; the VPC IP in `do-master-init.sh` and `linode-master-init.sh`), and the private range is open in every cluster firewall.

Decided: rewrite both comments to say what is true now. Keep the cert-manager control-plane pin. Its original reason is history (RCA 2026-07-17, fixed by the private advertise address). Removing it changes scheduling on every cluster for no gain, and would need a real-server run. The comment should say exactly that. The comment at `k3s.js:5447` (Hetzner's `--node-ip` is public) is correct and stays.

### A2. `status` from a new address

`status` reads remote health over SSH, but it is the one SSH-using command that never lets the operator's current IP through the firewall. `shell` and `diagnose` call `ensureOperatorIpAccessWarn` near the top, and `src/lib/operator-ip.js:7` says every command that needs SSH or the k8s API should. From a new address, `status` reports remote health as unavailable with no reason.

Decided: `status` calls `ensureOperatorIpAccessWarn` the same way `diagnose` does, before its remote reads, and only when at least one environment has servers to read. The helper stops early once the IP is saved, so `status` must push the IP to every environment's firewall in one pass, not only the first. With `-json`, stdout stays clean JSON (the helper writes to stderr). Update the comment at `src/status.js:1912-1915` that explains why it did not. A unit test proves the call happens before the first remote read and does not happen when nothing is deployed.

### A3. CI/CD on k8s cannot reach the cluster

`vibecarbon configure cicd <env>` (Stage 2, k8s only) seeds GitHub Environment secrets, uploads the cluster's kubeconfig as `KUBECONFIG_B64`, and dispatches `carbon/.github/workflows/deploy.yml`. Three things stop it from working end to end (none seen live yet; the code makes each certain):
1. The workflow runs kubectl on GitHub-hosted runners against the master's public 6443, which admits only the operator CIDRs, so it cannot connect.
2. Flux's Git credential is the workflow's own `GITHUB_TOKEN` (`deploy.yml`, step "Create flux-system Secret"). GitHub revokes that token when the job ends, so on a private repo Flux stops pulling right after the run that set it up.
3. `carbon/k8s/base/app/rbac.yaml` names a `ghcr-pull-secret` for the app image, and nothing creates it, so a private package's image cannot be pulled.

Options weighed:
- The workflow opens the firewall for its runner: needs a provider token at GitHub. Rejected (anti-goal, and `gitops-deploy.js` deliberately keeps that token off GitHub).
- Allow GitHub's published runner ranges, or open 6443 to everyone: rejected (thousands of ranges, and it undoes the H-2 closeout).
- Pull only. Decided.

The pull model:
- Everything `deploy.yml` applies today moves into the CLI and runs from the operator's machine, which `ensureOperatorIpAccess` already lets in: the `vibecarbon` namespace, the backup CronJob and its settings, `vibecarbon-app-secrets` and `vibecarbon-infra-secrets`, the Flux install, the `flux-system` Git auth Secret, and the root GitRepository and Kustomization.
- After that the cluster pulls: Flux watches the repo's main branch, so `git push` stays the deploy verb for anything under `k8s/`. Nothing at GitHub ever connects to the cluster.
- Flux reads the repo with a read-only deploy key, one per cluster (a k8s-ha primary and standby each get their own, so either can be revoked alone), created by the CLI with `gh` and named after the environment and side. The private half goes straight into the cluster's `flux-system` Secret and is not kept on disk; rerunning `configure cicd` rotates it. The GitRepository URL becomes `ssh://git@github.com/...` with GitHub's published host keys as known_hosts.
- The app image pull credential (Brandon's call, 2026-11-26): `configure cicd <env>` asks once for a GitHub token with only the `read:packages` scope (a classic token; the prompt links to GitHub's new-token page with that scope preselected). The CLI checks the token's scopes from GitHub's response header and refuses one with more than `read:packages`, saying why: it will live in the cluster. It is stored only as the `ghcr-pull-secret` (dockerconfigjson) in the `vibecarbon` namespace of each cluster (both sides of k8s-ha), never on disk or at GitHub. A rerun does not ask again while that Secret exists; it asks when the Secret is missing or the registry rejects it. When the app package can be pulled anonymously (a public package), the step is skipped. A headless run reads the token from an operator variable registered in `src/lib/config-registry.js` like the others.
- The values already come from the operator's local `.env` (the CLI seeds the GitHub copies from it today), so applying them directly loses nothing. A secret change is applied by `vibecarbon deploy <env>`, as it is on a local-first cluster. The builder confirms `deploy` re-applies both Secrets on a GitOps environment, and makes it so if not.
- `KUBECONFIG_B64` (cluster-admin credentials) is no longer uploaded. That is a security improvement. A copy an earlier CLI put there, and the app secrets copied into GitHub Environments, are named once for the operator to delete, following `noteUnreadTokenSecrets` in `gitops-deploy.js`. The CLI does not delete them by itself.
- `carbon/.github/workflows/deploy.yml` leaves the template, along with whatever only it reads (the GitHub Environment secrets and vars the CLI seeds for it). `refreshGitopsTlsVars` (it updates TLS vars at GitHub after a failover) goes with them. The build workflow is unchanged.
- The help text and docs for `configure cicd` describe the new flow in one or two plain sentences.

This is a user-facing change in how CI/CD works on k8s: secrets are no longer edited at GitHub. My call, flagged for Brandon to check while reading.

Proof: unit and integration tests for the CLI path, plus one real-server run of `configure cicd <env>` on a kept k8s rig against a throwaway GitHub repo, then a push that Flux picks up. Brandon approved it on 2026-11-26; it runs after all three parts are merged, then the repo and servers are deleted.

## Parts B and C: k8s and k8s-ha on Vultr and Scaleway

### Shared decisions

- **Same shape as Linode.** k3s on VMs; a private network for all node-to-node traffic; `--advertise-address` and `--node-ip` on the private address; flannel pinned to the private interface; WireGuard-native flannel as on the others; no cloud controller (k3s's embedded one, as Linode), with the kubelet's `--provider-id` set from instance metadata by the boot script.
- **Firewall.** 22 and 6443 from operator CIDRs only, using the exact port strings `applyOperatorCidrs` rewrites; 80 and 443 from everyone; all TCP, UDP and ICMP inside the private network. k8s-ha adds UDP 51821 from the peer database node's public IP (`effects/k8s-ha.js:578-620`).
- **Storage.** The cloud's own block-storage CSI driver, images mirrored to ghcr, our own StorageClass named per `K8S_STORAGE_CLASS`, volumes named and tagged (or labelled) so destroy can attribute them (`csi-volumes.js` `CSI_DRIVERS` and name regex).
- **Ingress IP.** An address that survives replacing the master, so DNS does not move on scale: Vultr ReservedIp (as Linode); Scaleway the master's flexible IP, which is already its own resource in the compose program. Both `K8S_FLOATING_IP = true`. If a probe shows either cannot be attached at create the way Linode's is, fall back to DigitalOcean's approach (`K8S_FLOATING_IP = false`, records at the master) and say so in the PR.
- **Every node gets a public IPv4** for egress (image pulls, the S3 backups). On Scaleway that is a flexible IP per node (`IPV4_MONTHLY` 3.65, already in the price display). A Scaleway Public Gateway would save the IPs but adds a billed resource and a second egress path that no other provider has. Rejected for simplicity.
- **Autoscaled workers join the private network.** The carbon-autoscaler sidecar creates workers through `createServer({networks, firewalls, userData})`. Both providers' `createServer` ignore `networks` today, and `serverNetworkIds` returns []. Fix both, and bump `CARBON_AUTOSCALER_TAG`, or autoscaled workers never join the cluster.
- **HA pairs** use the existing `HA_REGIONS` and the standby picker (Vultr ewr and ord; Scaleway fr-par-1 and nl-ams-1). Failover is the existing DNS flip; nothing provider-specific.
- **E2E.** New scenarios in `tests/config.ts`: Vultr v3 (k8s) and v4 (k8s-ha), Scaleway s3 and s4, using the existing DNS zones (threvidence.com, yachtbunker.com). `scaleTo` entries for every type the picker can default to on a master. Deploy budgets in `tests/e2e/checks/deploy-budgets.json` are calibrated from the first green runs, per the existing rule.

### Vultr specifics

- Pulumi `@ediri/vultr` has what is needed: `Vpc` (or `Vpc2`, whichever Vultr currently recommends; probe first), `ReservedIp`, `BlockStorage`, `Instance.vpcIds`, `reservedIpId`, `internalIp`.
- No fixed private IPs, so the db and workers wait on the master's assigned private IP, as DigitalOcean's program does.
- Firewall rules are separate Pulumi resources that the REST side rewrites (operator CIDRs, 51821). Compose already reconciles that drift with `repairVultrFirewallRuleInputs`; k8s uses the same mechanism.
- BlockStorage and ReservedIp take a label but no tags. Destroy attributes them by captured ids and by name, never by a region-wide guess.

### Scaleway specifics

- Pulumi `@pulumiverse/scaleway` has `vpc.PrivateNetwork` (regional), `ipam.Ip` for static private addresses, `Server.privateNetworks[].ipamIpIds`, `block.Volume`, `instance.PrivateNic`. Fixed private addresses through IPAM are preferred, because they remove the wait on the master (Hetzner and Linode do this).
- Servers are zonal, private networks regional: the network lives in the zone's region.
- `k8sCloudSecrets` returns the access key, secret key, project id and zone that the CSI driver needs.
- Provider id format `scaleway://instance/<zone>/<uuid>` (`tests/_shared/provider-expected.ts:141`).
- All new scripts are ASCII.

### Verify before coding (task 1 of each provider's plan)

Read-only API calls and docs. No probe servers: the first real e2e run is the probe, and anything a doc cannot settle is found at boot instead of pinned.
1. The private interface: the boot script finds it at boot as the interface that holds the private IP from metadata, so no name is pinned.
2. Whether the Vultr firewall and Scaleway security groups filter private-network traffic at all, and whether the private network is reachable from anything outside the project.
3. How each CSI driver ships. A release manifest with the version in the URL works with `scripts/version-channel.mjs` `DRIVER_URL`. If scaleway-csi ships only as a Helm chart, render it once at a pinned version and commit the rendered manifest; nodes never run helm.
4. The CSI `volumeHandle` format (Scaleway's is probably `<zone>/<uuid>`), which `CSI_DRIVERS.volumeId` must parse.
5. The metadata endpoints for the public IP, private IP and instance id.
6. The user-data size limit on each cloud.
7. Whether a reserved or flexible IP can be attached at server create.

A finding that breaks one of the shared decisions above stops that part and comes back to Brandon with a recommendation.

## Order of work and delivery

1. Part A, one PR per gap (A1 and A2 are small; A3 is medium and needs its kept-rig run).
2. Part B (Vultr), one plan, PRs in Linode's task order: provider class and boot scripts, IaC program, CSI and images, destroy and sweeps, autoscaler, e2e config, docs.
3. Part C (Scaleway), same shape. Vultr goes first because it is closest to Linode and DigitalOcean (VPC, reserved IP, no fixed addresses).
4. When A, B and C are all merged (and not before): the A3 proof run, then `e2e-us-perf.yml` for all 15 default scenarios. RCA every failure, fix on a branch, merge, rerun. Done when each provider's whole default selection is green in one run and the bot perf PRs are merged.

Each part gets its own implementation plan (`docs/plans/`), executed subagent-driven, with a whole-branch review before the PR. Shipped plans fold into `docs/history.md` as usual.

## Decisions Brandon made

Answered 2026-11-26 (Brandon approved the design the same day):
- App image pull credential: a `read:packages` token, asked once (A3 above).
- Merges: every PR is squash-merged as soon as its required checks are green, without asking.
- Real-server runs: none until all of Parts A, B and C are merged. Then the A3 proof run (approved), then the e2e runs.
- Account limits: not checked; run and see. A quota error is a quota, not a code failure. Peak is one k8s-ha scenario at a time: about 8 servers, the same number of public IPs on Scaleway, a private network in each of two regions, a few block volumes.

## Touchpoints (from the survey)

Provider class statics and methods (`SUPPORTED_TIERS`, `ROLE_CANDIDATES`, `DEFAULT_K8S_NODE_TYPE`, `K8S_IMAGE`, `DEFAULT_VPC_CIDR`, `K8S_STORAGE_CLASS`, `K8S_ASSETS`, `K8S_FLOATING_IP`, `K8S_DESTROY_BACKSTOP`, `k8sRegionProblem`, `K8S_RETIRED_CLOUD_SECRETS`, `getK8s{Master,Worker,Db}UserData`, `getK8sProgram`, `k8sCloudSecrets`, `createServer` with networks, `listNetworks` with name, `serverNetworkIds`, `deleteNetworkByName`, `deleteReservedIpByAddress`, `volumeName`, `labelValue`, `buildReplicationFirewallRules`); `src/lib/iac/programs/<id>-k8s.js`; `carbon/cloud-init/k3s/<id>-{master,worker}-init.sh`; `src/lib/images.js` (CSI version, `CSI_SIDECAR_MIRRORS`, `csiUpstreamImagePins`, `CARBON_AUTOSCALER_TAG`); `src/lib/csi-volumes.js`; destroy backstop and orphan-volume code; e2e sweeps; `tests/config.ts`; `deploy-budgets.json`; every census the survey named (provider-expected, csi-install-rewrite, k3s-server-flags, pulumi-recorder, server-create-timeouts, k8s-image-mirrors, version-channel-plan, k8s-floating-ip-output, floating-ip-backstop, iac-dispatch, supported-tiers, provider-contract, destroy-field-accessors, role-candidates, k8s-storage-class-literal-guard, supported-tiers-scenario-coverage, reference-scenarios, selection-grammar, calibrate-deploy-budgets, sweep-reserved-ip-coverage, k8s-backstop, orphaned-volumes-cleanup, prompt-provider-select, region-for-tier, standby-region-by-price, sizing-k8s-region-guard, readme-provider-coverage, terminology-census); README, FEATURES.md, `vendor-matrix.tsx`, carbon docs, `en.json`, `scripts/cost-grid.js`, `docs/tests.md`, the running-e2e-matrix skill.

## Left to the builder

- Program structure, resource naming within the shared templates, test file layout.
- The exact wording of comments, help text and docs, within the voice rules.
- Which existing helper each piece reuses.
- Splitting a plan task when it turns out larger than expected.
