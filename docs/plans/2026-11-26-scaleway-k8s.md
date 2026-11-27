# Scaleway k8s and k8s-ha Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaleway runs `k8s` and `k8s-ha` with the same lifecycle as Vultr and Linode (deploy, scale, backup, destroy, restore, failover), and `--provider scaleway` runs `compose`, `k8s` and `k8s-ha`. The default e2e selection grows from 13 to 15 scenarios.

**Architecture:** A new Pulumi program `scaleway-k8s.js`, shaped like `vultr-k8s.js`: one VPC and one Private Network per cluster, dynamic private addresses (the db and workers wait on the master's), the master's flexible IP as the ingress address, no CCM (k3s's embedded cloud controller, a provider id from metadata). The boot scripts read Scaleway's metadata in one include and find the Private Network NIC by its MAC prefix, at boot and again at every k3s start. Storage is scaleway-csi v0.3.6, rendered once from its Helm chart, committed, and embedded compressed in the master's user data, with Hetzner's mirrored sidecars, our own StorageClass and a 5 GiB volume floor. Every difference reaches shared code through provider class members or data tables.

**Tech Stack:** Node ESM CLI, `@pulumiverse/scaleway` 1.62.1, k3s v1.37.2+k3s1, bash cloud-init (no apt, jq or docker; `python3 -I` for JSON, as Vultr's), vitest.

**Spec:** `docs/specs/2026-11-26-k8s-everywhere-design.md`, Part C and the Shared decisions of Parts B and C. Model: `docs/plans/2026-11-26-vultr-k8s.md` and its rulings RV1 to RV11 (that plan's "Rulings made during execution" section). Facts: `.superpowers/sdd/2026-11-26-scaleway-k8s/scaleway-facts.md`. Line numbers were read on main e7b09398 (Part B merged as #593); re-find a seam by its name if it moved.

**Depends on RC10, which lands first.** The k8s-ha replication rule is its own PR (`docs/plans/2026-11-26-ha-replication-rule.md`). It adds `replicationPeerIpFor(envConfig, stackName)` to `src/lib/iac/program-inputs.js`, the `replicationPeerIp` program-config field, a 51821 rule equal to `buildPeerRule` in every inline-rule k8s program, and `tests/unit/iac/k8s-firewall-round-trip-census.test.ts`, which walks `PROVIDERS`. Part C rebases on main after that PR merges, and Task 1 starts on that base.

**Departures from the spec** (each is a decision below, with its reason): dynamic private addresses instead of IPAM fixed ones; provider id `scaleway://<uuid>` instead of `scaleway://instance/<zone>/<uuid>`; flannel on vxlan, as Part B decided for Vultr; no private-network rules on the security group; a VPC per cluster; the CSI manifest embedded, not fetched; `k8sCloudSecrets({ token, region })`; the flannel drop-in; the CSI driver image left on its upstream registry (Docker Hub); untagged CSI volumes, attributed by captured id; `findFirewallByName` throwing on a partial listing.

## Global Constraints

### Repo rules (every task)

- Conventional Commits. Commit with `git commit -F <msgfile> -- <paths>`, pathspecs only; `git add` new files first. Check the staged diff before committing (shared checkout).
- Never `--no-verify`. The pre-commit hook runs the unit suite, so every task ends green.
- Before every commit, run `pnpm lint`, `pnpm lint:infra`, `pnpm unused` and `pnpm dupes`, fix what they find, and paste their output in the report (RV2).
- No `!:` and no `BREAKING CHANGE` footer. A breaking change gets a "Compatibility note" paragraph in the body instead.
- Every commit message ends with the line `Claude-Session: https://claude.ai/code/session_01SK1vqQLM9B9SaK3Q9Hxjgo`.
- No em or en dashes in user-facing copy (CLI output, errors, docs, README, site). No emoji. "Free" never next to servers or deploys. CLI hints are lowercase and friendly, say why, and a command on its own line ends the hint.
- One dotenv dialect: parse with `util.parseEnv`, write with `formatDotenvLine`.
- A command whose captured output holds a secret passes `secret: true` to its runner (#592); `tests/unit/lib/secret-read-census.test.ts` walks every such read. This plan adds no such read; that census passes unchanged.
- The cloud credential reaches a cluster only through `applyCloudSecrets` over stdin. No boot script and no user data carries a credential (`tests/unit/deploy/k8s-user-data-secret-census.test.ts`).
- Every delete lists first and matches exactly. A partial listing throws, so destroy reports the resource unverified, and it is never read as "gone" (RV6, and the `deleteVpcByName` contract at `src/lib/providers/base.js:42-60`). `deleteFirewallByName` already turns a throw into `apiError`, and that stays.
- Never read or print `tests/.env.e2e`. Every recursive grep passes `--exclude='.env*'`.
- No provider-id branches in shared deploy, HA, failover or destroy code. A difference goes through a provider class member or a data table keyed by provider (as `CSI_SIDECAR_MIRRORS`).
- No retry ladders. A bounded wait for a boot condition (metadata, an interface, the API server) is fine.
- x86-64 only. All new scripts and the rendered manifest are pure ASCII.
- Boot scripts stay under the repo caps: 28 KiB rendered for worker and db, 31 KiB for the master.
- No real servers, no cloud resources, no state-changing cloud API calls, no workflow dispatch in any task. Real e2e runs wait until Parts A, B and C have all merged.
- After a local template build, `rm -rf carbon/dist` before committing.
- The e2e default selection for Scaleway becomes `compose`, `k8s` (s3) and `k8s-ha` (s4), so `--provider all` gives 15 scenarios.

### Scaleway facts (settled 2026-11-26 from read-only sources)

1. **Private interface.** Metadata (`GET http://169.254.42.42/conf?format=json`) gives `id`, `hostname`, `location.zone_id`, `public_ip.address` and `public_ips_v4[].address`, but nothing about the Private Network NIC (scaleway-facts section 4). That NIC's MAC "always begins with `02:00:00`", its name is "not guaranteed to be stable" across reboots, and DHCP on it is automatic through `/lib/udev/rules.d/72-scw-vpc-iface.rules` (docs-content `pages/instances/reference-content/manual-configuration-private-ips.mdx`, step 3 and lines 8-9).
2. **The NIC arrives after power-on.** The Pulumi provider creates the server, powers it on, then adds each private NIC and waits for it. Source: terraform-provider-scaleway v2.92.1, the version `@pulumiverse/scaleway` 1.62.1 bridges (its release notes, PR #662). In `internal/services/instance/server.go`, `ResourceInstanceServerCreate` (L425) calls `reachState(ctx, api, zone, res.Server.ID, targetState)` at L592, and an unset `state` means running (`helpers_instance.go` L152-155). Only after that, L625-657 call `CreatePrivateNetworkInterface`, `waitForPrivateNIC` and `waitForMACAddress` (https://github.com/scaleway/terraform-provider-scaleway/blob/v2.92.1/internal/services/instance/server.go#L592, read 2026-11-26 with `gh api`). The boot script waits for the NIC.
3. **Server private addresses.** `instance.Server.privateIps` (`{ id, address }`, IPv4 and IPv6; the PN always has an IPv6 block) is read through IPAM, and a 403 there is only a warning that leaves it empty (`server.go` `setServerState`; `internal/services/ipam/helpers.go:100-107` gives the bare address). `ServerPrivateNetwork` takes only `pnId`; `ipamIpIds` exists on `instance.PrivateNic`, not on servers (`types/input.d.ts:4650-4665`).
4. **Security groups and the PN.** A security group filters a PN interface only when applied to that interface (`pages/instances/reference-content/understanding-security-groups-private-network-interfaces.mdx`, validated 2026-10-19). NACLs between PNs default to allow-all (`pages/vpc/faq.mdx`). "Routing is activated by default whenever you create a new VPC" (`pages/vpc/concepts.mdx:131`). Quotas: 256 VPCs, 100 PNs per VPC, 255 PNs per Organization (`organization-quotas.mdx:507-513`); 500 security group rules per Organization (scaleway-facts section 2).
5. **PN subnets.** 10.0.0.0/8, 172.16.0.0/12 and 192.168.0.0/16 are allowed; reserved are 127/8, 0/8, 100.64/10, 169.254/16, 224/4 (`pages/vpc/reference-content/private-networks-reserved-prefixes.mdx`, 2026-04-09). Sizes run /20 to /28 (`pages/vpc/how-to/create-private-network.mdx:95`).
6. **CSI distribution.** scaleway-csi v0.3.6 ships only as Helm chart 0.2.2: `https://github.com/scaleway/helm-charts/releases/download/scaleway-csi-0.2.2/scaleway-csi-0.2.2.tgz`, sha256 `aeddcbec4f832a79b3c0888c79c8660af933b18ae3f5fb912dadb93418563661`. The render below is 17,060 bytes, 2,608 as gzip -9 plus base64.
7. **CSI behaviour.** Driver `csi.scaleway.com`, topology key `topology.csi.scaleway.com/zone`, volumeHandle `<zone>/<uuid>` (`pkg/driver/helpers.go:38-61`). Its node id is `<zone>/<server id>` from metadata (`pkg/driver/node.go:438-448`; `pkg/scaleway/metadata.go` tries `/run/cloud-init/instance-data.json`, then `169.254.42.42`), not from the kubelet's provider id. Volumes are named `pvc-<uuid>` and carry no tags. Minimum 1 GB in the driver (`pkg/scaleway/scaleway.go:24`) and the SDK (`api/block/v1/block_sdk.go:449`), 5 GB in the console and docs. PVC bytes go to the API unrounded (`helpers.go:176-212`); the driver's own examples request 3Gi and 10Gi (`examples/kubernetes/*/pvc.yaml`). `go.mod`: `k8s.io/mount-utils v0.36.2`, minor 36.
8. **CSI credential.** Only the controller reads it, as `envFrom` Secret `scaleway-csi-secret`, keys `SCW_DEFAULT_ZONE`, `SCW_DEFAULT_PROJECT_ID`, `SCW_ACCESS_KEY`, `SCW_SECRET_KEY` (scaleway-facts section 3).
9. **Flexible and dynamic IPs.** A flexible IP attaches at create (`ipIds`) and stays with its resource across a server replacement (scaleway-facts section 6). A dynamic IP is "released back into the general public pool ... whenever you stop your Instance" (`pages/instances/concepts.mdx:46-48`). IP object: `id`, `address`, `server { id, name }`, `tags`, `zone` (scaleway-sdk-go `api/instance/v1/instance_sdk.go:1832-1857`).
10. **Private NIC over REST.** `POST /instance/v1/zones/{zone}/servers/{server_id}/private_nics` with `{ private_network_id }` returns `{ private_nic }`; a server carries `private_nics[]` with `private_network_id` (`instance_sdk.go:2455-2477`, `:6825`, `:1468-1496`, `:1790`).
11. **IAM.** A policy rule can carry a `request.ip` condition, public addresses only (`pages/iam/policies-permissions/understanding-request-level-conditions.mdx`, 2026-07-13). The k8s tier needs `PrivateNetworksFullAccess`, `VPCFullAccess` and `IPAMReadOnly` beyond the compose list (`pages/iam/policies-permissions/permission-sets.mdx:191`, `:193`, `:201`, 2026-03-20).
12. **k3s.** Without `flannel-iface`, flannel takes the default-gateway interface (k3s `pkg/agent/flannel/flannel.go` `LookupExtInterface`), the public one here. k3s loads `/etc/rancher/k3s/config.yaml.d/*.yaml` at every start (k3s-io/docs `docs/installation/configuration.md:88`).
13. **Regions.** `REGIONS` are zones fr-par-1, fr-par-2, nl-ams-1, nl-ams-2; Private Networks and VPCs are regional (`fr-par`, `nl-ams`). No zone is known to lack block storage (scaleway-facts section 9).
14. **Unconfirmed until the first run:** the user-data size limit; whether the Block API rounds an unrounded byte size or refuses it; the `ubuntu_resolute` UFW state (the include is a no-op without ufw).

### Decisions this plan makes

- **RC1, dynamic private addressing.** Every server gets `privateNetworks: [{ pnId: network.id }]`; the master's address is the first IPv4 in `master.privateIps` inside the cluster's subnet, and the db and workers wait on it. Why: the NIC is DHCP-configured at boot (fact 1), the SDK's IPAM docs say "Static IPs should be avoided unless necessary" (`node_modules/@pulumiverse/scaleway/ipam/ip.d.ts:129`), and it is DigitalOcean's and Vultr's approach. Cost if wrong: about a minute of serial creates. The spec's `Server.privateNetworks[].ipamIpIds` does not exist on instances (fact 3).
- **Subnet.** `vpcCidrForCluster(clusterName, 24)` unchanged: a /24 inside 10.128.0.0/10, allowed and within /20 to /28 (fact 5), clear of k3s's 10.42/16 and 10.43/16 and the 10.99 WireGuard transport. `DEFAULT_VPC_CIDR` stays `''`.
- **A VPC per cluster.** `network.Vpc` plus `network.PrivateNetwork`, both named `${clusterName}-network`, in the zone's region. Why: routing is on in every new VPC (fact 4) and no security group or UFW filters PN traffic, so two environments sharing the default VPC would reach each other's kubelet, flannel and database ports. A VPC per cluster gives the isolation a VPC per cluster gives on the other four. Cost: one more resource and one more destroy target.
- **RC4, no security group on the PN NIC, and no private-network rules.** PN traffic never meets the instance security group (fact 4), so the spec's "all TCP, UDP and ICMP inside the private network" needs no rules here. Isolation is the VPC.
- **RC3, operator rules declared from config.** The security group is the inline `instance.SecurityGroup`, as compose's. The REST methods (`setFirewallRules`, `applyOperatorCidrs`, `buildReplicationFirewallRules`) own 22, 6443 and 51821 between ups. The mechanism Hetzner, DigitalOcean and Linode use, which Scaleway takes: their programs declare 22 and 6443 from `config.allowedSshIps` and `config.allowedK8sApiIps` (`hetzner-k8s.js:180-207`, `digitalocean-k8s.js:239-243`, `linode-k8s.js:188`, `:197`), built from the saved `projectConfig.operatorCidrs` (`src/lib/deploy/k8s/k3s.js:6360`, `src/lib/iac/converge-cluster.js:316`), and `vibecarbon access` saves the list (`updateOperatorCidrs`, `src/lib/operator-ip.js:208`) before it pushes (`pushOperatorCidrs`, `:365`). So the next up declares the set REST wrote. No `ignoreChanges` is involved, and `K8S_OPERATOR_RULES_AFTER_UP` stays false. The 51821 rule works the same way (RC10). The program declares it from `config.replicationPeerIp`, as a rule equal to Scaleway's `buildPeerRule` (`scaleway.js:1432-1439`), and declares none when the field is unset. The REST step (`haK8sOpenReplicationFirewallStep`, `src/lib/deploy/plan/deploy-plan.js:160`) stays as the bootstrap.
- **Rule order.** The provider compares the rule list in order, so the program declares the rules in the order `applyOperatorCidrs` writes them. That write is `[...kept, ...rebuilt]` (`scaleway.js:1485`): the non-operator rules as they were, 51821 among them, then 22 per CIDR, then 6443 per CIDR. So 51821 goes after the four 80 and 443 rules and before 22. RC10 says "last" because Linode's `rewriteOperatorRules` rewrites in place (`linode.js:222`); on Scaleway, last would make every access push reorder the list. The REST replication write must land in the same order. The shared `replaceWireguardPeerRules` appends the peer's rule at the end (`base.js:1981`), so Scaleway's `buildReplicationFirewallRules` (`:1426`) moves the operator-locked rules (inbound TCP 22 and 6443, the `isLocked` test of `applyOperatorCidrs`) after the others, each group in its order. Otherwise a first deploy's REST bootstrap would leave `[..., 22, 6443, 51821]`, and the first scale after it would rewrite the group. Every k8s writer then produces one order: the non-operator rules, then 22, then 6443. (Scaleway compose's program declares 22 first, `scaleway-compose.js:76-86`, and the shared reorder would change compose-ha's order; compose-ha is not shipping, so this plan leaves compose as it is.)
- **Atomic rule writes.** `setFirewallRules` stays one `PUT .../rules`, a set-style write like Hetzner's and DigitalOcean's (base doc at `src/lib/providers/base.js:1047`). Vultr's basis-scoped minimal diff exists because Vultr has no such write.
- **Partial listings refuse.** `findFirewallByName` returns null today when a zone's group walk is incomplete, and ignores an incomplete rules walk (`scaleway.js:1340-1358`), so `deleteFirewallByName` reads a short listing as "never existed" and `applyOperatorCidrs` can PUT a rule list missing 80 and 443. It throws on either incomplete walk instead.
- **RC7, ingress and node IPs.** The master's flexible IP `ingress` is the cluster's public address (`K8S_FLOATING_IP = true`, base). Every node gets its own `instance.Ip` attached at create, each tagged with separate `project:<P>` and `environment:<E>` tags (`encodeLabels`), never a joined name (RV9). Flexible, not dynamic, because a dynamic IP moves on every stop (fact 9) and the db's public address is its WireGuard endpoint. Since one IP holds one server, every node is `deleteBeforeReplace: true`.
- **IP ownership.** An attached IP is "labelled project P, environment E" only when its tags carry both and the server holding it carries the same two tags. Destroy never deletes an attached IP; it reports it held.
- **Provider id `scaleway://$NODE_ID`** (the server UUID). Why: no Scaleway CCM runs, the CSI driver finds its node from metadata (fact 7), and the shared parsers take `PROVIDER_ID_PREFIX + <server id>` (`src/autoscaler/groups.js:147`, `:174`, `:404`; `k3s.js:2673`). The CCM's `instance/<zone>/<uuid>` form would need zone-aware parsing in shared code.
- **Flannel on vxlan**, as Part B decided for Vultr and Linode run (the spec's WireGuard-native line is Hetzner's).
- **Reboot-safe flannel interface.** The boot writes `/usr/local/sbin/vc-flannel-iface`, which finds the `02:00:00` NIC and writes `flannel-iface: <name>` to `/etc/rancher/k3s/config.yaml.d/50-flannel-iface.yaml`, and runs it as `ExecStartPre` of the k3s unit, so a NIC renamed across a reboot is found again (facts 1 and 12). `--node-ip` keeps the address, which IPAM holds for the NIC.
- **RC2, CSI as a committed render, embedded.** `carbon/cloud-init/k3s/_scaleway-csi.yaml` is the verbatim `helm template` output under a header naming the chart URL, its sha256, the command and `# Rendered from https://github.com/scaleway/scaleway-csi v0.3.6`. The master's user data carries it gzip -9 plus base64 (2,608 bytes); the boot decodes it and feeds it to `csi_fetch_mirrored` as a `file://` URL, so the image rewrite and its FATALs apply unchanged. Why embedded: a fetch needs a ref that exists before merge and survives a squash merge, and adds a GitHub dependency for a file the CLI already holds; plain, it would put the master near its 31 KiB cap. It is a file, not a directory, because `liveDrivers` reads every entry of `carbon/cloud-init/k3s` (`scripts/version-channel.mjs:414`).
- **Render command:** `helm template scaleway-csi scaleway-csi-0.2.2.tgz --namespace kube-system --skip-crds --set-json 'storageClasses=[]' --set-json 'volumeSnapshotClasses=[]' --set controller.scaleway.existingSecretName=scaleway-csi-secret --set controller.driver.image.tag=v0.3.6 --set node.driver.image.tag=v0.3.6 --set controller.snapshotter.enabled=false --set controller.snapshotController.enabled=false --set-json 'node.tolerations=[{"operator":"Exists"}]' --set controller.provisioner.image.tag=v6.3.0 --set controller.attacher.image.tag=v4.13.0 --set controller.resizer.image.tag=v2.2.1 --set controller.liveness.image.tag=v2.20.0 --set node.registrar.image.tag=v2.18.0 --set node.liveness.image.tag=v2.20.0`. It renders no Secret and no StorageClass; the node DaemonSet tolerates every taint (the db node mounts its PVC), so no patch is needed.
- **Sidecars are Hetzner's exact tags and digests** (`CSI_SIDECAR_MIRRORS.hetzner`, `src/lib/images.js:405-445`), which provisioner v6.3.0 with `--feature-gates=Topology=true` runs on Hetzner today. The snapshotter and snapshot controller are dropped (no CRDs, no snapshot class). No new ghcr package and no new sidecar tag. The driver image `scaleway/scaleway-csi:v0.3.6` stays on Docker Hub, as Linode's and Vultr's drivers do.
- **RC6, storage.** StorageClass `scaleway-block-vibecarbon`: provisioner `csi.scaleway.com`, `reclaimPolicy: Delete`, `allowVolumeExpansion: true`, `volumeBindingMode: WaitForFirstConsumer`, no parameters (the driver's default, 5,000 IOPS). `K8S_MIN_VOLUME_GI = 5`: the minimum is unconfirmed (1 GB in the driver and SDK, 5 GB in the console, fact 7), so the larger.
- **RC5, volumes by captured id only.** `ORPHAN_VOLUME_REGION_GUESS = false`; `CSI_DRIVERS['csi.scaleway.com']` parses `<zone>/<uuid>`.
- **`deleteServer` deletes only the root volume.** Today it deletes every SBS volume in `server.volumes` (`scaleway.js:1018-1020`), so an autoscaler scale-down would delete a PVC's volume still attached to the worker. It deletes `volumes['0']` only, as the Pulumi provider's own server delete does: v2.92.1 `server.go` L1311-1322 deletes `root_volume.0.volume_id` and nothing else. Destroy still reaps CSI volumes through `serverVolumeIds` and the PV capture.
- **The autoscaler pod gets the project id.** `createServer` refuses without `SCALEWAY_DEFAULT_PROJECT_ID` (`scaleway.js:884-891`), and the carbon-autoscaler container's env holds only `PROVIDER_API_TOKEN` and `CARBON_AUTOSCALER_CONFIG` (`carbon/k8s/base/cluster-autoscaler/deployment.yaml:93-100`). So today every in-cluster create would fail. A provider member, `static k8sAutoscalerEnv()`, names the operator variables the in-cluster provider reads besides the token: the base returns `{}`, and Scaleway returns `{ SCALEWAY_DEFAULT_PROJECT_ID }`. It needs only the project id, because `createServer` is the only reader the autoscaler reaches: `createSSHKey` (`:1268`) and `deleteSSHKeyByName` (`:1520`) run from the CLI, and the Instance API authenticates with `X-Auth-Token` alone. Each entry goes into the `carbon-autoscaler-config` Secret under its own name, and the Deployment maps it into the pod env. This is Task 5.
- **RC8, regions.** `k8sRegionProblem` stays the base null for every zone. fr-par-2 and nl-ams-2 are the first suspects if a run fails on block storage.
- **`k8sCloudSecrets({ token, region })`.** `applyCloudSecrets` passes `options.region`, the value `buildProgramConfig` gets as `location` (`k3s.js:6369`). On Scaleway that value is a zone, such as `fr-par-1`, never the derived region `fr-par`, because `REGIONS` are zones (`scaleway.js:317`). Scaleway returns one Secret with the four keys of fact 8. It reads the access key and project id with the helper `buildIacEnv` uses (`scaleway.js:288-300`, shared, not copied), and it throws that helper's message when either is unset. It also throws when `region` is empty: an empty `SCW_DEFAULT_ZONE` would leave the CSI controller without a zone. Every other provider ignores `region`.
- **Sizes.** master and worker `['BASIC3-X2C-4G', 'DEV1-M', 'PLAY2-NANO']`, db `['DEV1-S', 'PLAY2-PICO', 'BASIC3-X2C-4G']` (a db candidate in each of `CPU_CLASSES`). DEV1-S has block bandwidth and needs no local volume (`min_size` 0), as DEV1-M does (`scaleway.js:366-369`). `K8S_IMAGE = 'ubuntu_resolute'`, the compose image.
- **`K8S_RETIRED_CLOUD_SECRETS`** carries the `kube-system/hcloud` entry with Vultr's `copyOf`; no Scaleway boot script ever wrote a Secret (`NO_LEGACY_BOOT_SECRETS`).
- **IAM docs (RC9).** Since a policy can be limited by `request.ip` (fact 11), `docs/security.md` says the CSI controller and the autoscaler call Scaleway's API from the cluster's nodes, so such a condition must admit the nodes' public addresses.

## ghcr packages and publish order

No new package and no new sidecar tag: every sidecar ref is one Hetzner already pulls. The `mirroredPackageNames()` checklist in `tests/unit/deploy/k8s-image-mirrors.test.ts` stays byte-identical (Task 3 proves it). `carbon-autoscaler:0.1.7` (Task 5) is a new tag of an existing public package, published by `publish-images.yml` on the push to main.

**Brandon's step, after the merge and before the first real Scaleway run:** check that the `publish-images` run on the merge commit is green, then:

```bash
DOCKER_CONFIG=$(mktemp -d) docker buildx imagetools inspect ghcr.io/hyperformant/carbon-autoscaler:0.1.7 >/dev/null && echo ok || echo MISSING
```

## Staging: censuses walk Scaleway part by part

Part B's helper puts a built-ahead provider into every switched census at once, but Scaleway's program, CSI and destroy code land in later tasks (RV3). Task 1 makes it per part:

- `export type K8sPart = 'boot' | 'program' | 'csi' | 'destroy';`
- `export const K8S_BUILT_AHEAD: Readonly<Record<string, readonly K8sPart[]>> = { scaleway: ['boot'] };`
- `export function k8sCensusProviders(part: K8sPart)`: the k8s sellers, then the built-ahead providers whose list holds `part`, each group in registry order. It throws on a missing or unknown `part`, because vitest does not type-check: a call site left at `k8sCensusProviders()` must fail loudly, never quietly drop Scaleway.

Every consumer is found with `grep -rn --exclude='.env*' "K8S_BUILT_AHEAD\|k8sCensusProviders" tests src scripts`. On main e7b09398 that finds two direct readers of `K8S_BUILT_AHEAD`, whose shape changes, and ten helper call sites. On the RC10 base it can find more: give each new one its part by the rule below.

| Consumer | Today | After Task 1 |
|---|---|---|
| `tests/unit/providers/iac-dispatch.test.ts:22`, `:40` | `K8S_BUILT_AHEAD.includes(id)`, which throws a TypeError at module load on a Record | `(K8S_BUILT_AHEAD[id] ?? []).includes('program')` |
| `tests/unit/providers/k8s-built-ahead.test.ts:9-38` | array operations | rewritten (Task 1 Step 1) |
| `tests/_shared/k3s-boot-scripts.ts:55` | `k8sCensusProviders()` | `'boot'` |
| `tests/unit/deploy/k8s-user-data-secret-census.test.ts:112` | one list for both halves | split. `bootProviders = k8sCensusProviders('boot')` feeds the walk length check (`:123-124`), and `programProviders = k8sCensusProviders('program')` feeds the program half (`:148`, `:151`) |
| `tests/unit/iac/k3s-token-census.test.ts:63`, `k8s-floating-ip-output-census.test.ts:61`, `floating-ip-backstop-census.test.ts:73` | no argument | `'program'` |
| `tests/unit/deploy/k8s-cloud-secrets.test.ts:298`, `tests/unit/diagnose/k8s-empty-assets.test.ts:64`, `tests/integration/docker/k8s-cloud-secrets-takeover.test.ts:99` | no argument | `'csi'` |
| `tests/unit/destroy/k8s-backstop-sweep.test.ts:1114`, `csi-volumes-after-servers.test.ts:270-272` | no argument | `'destroy'` |
| `tests/unit/iac/k8s-firewall-round-trip-census.test.ts` (RC10) | whatever RC10 wrote | `'program'`. It runs programs, so Scaleway joins it in Task 2. If RC10 filters `PROVIDERS` by `SUPPORTED_TIERS`, Task 2 switches it to `k8sCensusProviders('program')`, which still walks the registry |

`k3s-server-flags.test.ts` is not a call site: `:170` is a comment, and the file walks through `k3s-boot-scripts.ts`. The rule for a consumer not listed: whatever runs a boot script takes `'boot'`, a program `'program'`, the CSI manifest or `k8sCloudSecrets` `'csi'`, and destroy code `'destroy'`. Tasks 2, 3 and 4 append their part. Task 6 sets `{}` and rewrites the guard test.

## Census coverage

"Verbose" means `pnpm test:unit <file> --reporter=verbose 2>&1 | grep -i scaleway` prints a passing Scaleway case. "Row" means a named Scaleway entry the test reads.

| Census or list | File | Scaleway entry | Task | Proof |
|---|---|---|---|---|
| boot-script walk | `tests/_shared/k3s-boot-scripts.ts` | `k8sCensusProviders('boot')`; `masterAddedVars(provider)` | 1, 3 | walk lists scaleway's three roles |
| k3s-server-flags | `tests/unit/deploy/k3s-server-flags.test.ts` | "Scaleway scripts" block | 1 | row |
| user data takes no credential | `tests/unit/deploy/k8s-user-data-secret-census.test.ts` | `'boot'`, then `'program'` | 1, 2 | verbose |
| host reporter | `tests/unit/deploy/host-reporter-census.test.ts` | worker walk; autoscaler row `['scaleway', ScalewayProvider, 'fr-par-1', 'DEV1-M']` | 1, 5 | row |
| no apt, jq, docker | `tests/unit/deploy/k3s-no-apt.test.ts` | both scripts | 1 | row |
| boot timing marks | `tests/unit/deploy/boot-timing.test.ts` | both scripts, Vultr's phase lists | 1 | row |
| include resolution | `tests/unit/iac/cloud-init-include.test.ts` | both scripts; db role | 1 | row |
| core images from mirror | `tests/unit/deploy/core-images-from-mirror-census.test.ts` | `ROLE_SCRIPTS` gains `'scaleway-'` | 1 | row |
| node roles | `tests/unit/deploy/node-roles-census.test.ts` | scaleway worker script | 1 | row |
| built-ahead guard | `tests/unit/providers/k8s-built-ahead.test.ts` | `{ scaleway: [...] }` | 1, 6 | row |
| iac-dispatch, k3s token, floating-IP output | `iac-dispatch.test.ts`, `k3s-token-census.test.ts` (`LOCATION.scaleway = 'fr-par-1'`), `k8s-floating-ip-output-census.test.ts` | `'program'` | 2 | verbose |
| floating-IP backstop | `tests/unit/iac/floating-ip-backstop-census.test.ts` | `'program'`; `'k8s scaleway:instance/ip:Ip'` | 2 | row |
| state secrets, server-create timeouts | `state-secret-census.test.ts`, `server-create-timeouts-census.test.ts` | `PROGRAMS['scaleway-k8s.js']`, `['scaleway-k8s.js', 'userData']`, `K8S` list | 2 | row |
| pulumi-recorder | `tests/_shared/pulumi-recorder.ts` | `names` gains `'network'` | 2 | state-secret-census runs the program |
| naming parity | `tests/unit/providers/k8s-naming-parity.test.ts` | auto (`*-k8s.js`) | 2 | verbose |
| operator rules after up | `tests/unit/deploy/k8s-operator-rules-after-up.test.ts` | stays `['vultr']` | 2 | unchanged, re-run |
| firewall round trip (RC10) | `tests/unit/iac/k8s-firewall-round-trip-census.test.ts` | `'program'`; a Scaleway row mapping `inboundRules` to the REST wire shape | 2 | verbose |
| access CIDR math | `tests/unit/access/cidr-match.test.ts` | `cidrContainsIp` moved to `src/lib/cidr.js`, re-exported | 2 | unchanged, re-run |
| db-port scrub | `tests/unit/providers/operator-firewall-db-port-scrub.test.ts` | Scaleway block | 2 | unchanged, re-run |
| CSI manifests fixture | `tests/_shared/csi-install-rewrite.ts` | `UPSTREAM_CSI_MANIFESTS.scaleway` | 3 | row |
| image mirrors | `tests/unit/deploy/k8s-image-mirrors.test.ts` | version row, `it.each` lists, `CSI_REPO.scaleway`, `file://` install | 3 | row; verbose |
| version channel | `tests/unit/lib/version-channel-plan.test.ts` | `_scaleway-csi.yaml`; repo `scaleway/scaleway-csi` | 3 | row |
| cloud secrets | `k8s-cloud-secrets.test.ts`; `tests/_shared/cloud-secret-readers.ts`; `legacy-master-init-secrets.ts` | `'csi'`; readers; companions; `NO_LEGACY_BOOT_SECRETS` | 3 | verbose |
| takeover, diagnose assets | `tests/integration/docker/k8s-cloud-secrets-takeover.test.ts`, `tests/unit/diagnose/k8s-empty-assets.test.ts` | `'csi'` | 3 | `pnpm test:docker` names scaleway; verbose |
| provider-expected | `tests/_shared/provider-expected.ts` | `k8sImage`, `k8sAssets`, `k8sStorageClass` | 2, 3 | row |
| storage-class literal, volume floor | `k8s-storage-class-literal-guard.test.ts`, `k8s-volume-floor.test.ts` | new literal; floor 5 | 3 | verbose; row |
| destroy accessors | `tests/unit/providers/destroy-field-accessors.test.ts` | `serverNetworkIds` | 4 | row |
| k8s backstop | `k8s-backstop-targets.test.ts`, `k8s-backstop-sweep.test.ts` | cases; `'destroy'` | 4 | row; verbose |
| orphaned volumes, CSI capture | new `orphaned-volumes-cleanup-scaleway.test.ts`; `csi-volume-capture.test.ts`; new `tests/_shared/scaleway-csi-pv.ts` | Scaleway volumes; `csi.scaleway.com` PV | 4 | row |
| volumes after servers | `tests/unit/destroy/csi-volumes-after-servers.test.ts` | `['scaleway', 'Scaleway', true]` | 4 | row |
| reserved-IP wiring | `tests/unit/destroy/reserved-ip-label-backstop-wiring.test.ts` | Scaleway k8s rows | 4 | row |
| VPC partial listing | `tests/unit/providers/vpc-delete-partial-listing.test.ts` | Scaleway row | 4 | row |
| e2e sweep, probes | `sweep-scaleway.test.ts`, `stack-probes.test.ts`, `sweep-pass-transcript` snapshot | k8s fixture; `network.Vpc`, `network.PrivateNetwork` | 4 | row |
| autoscaler tag | `tests/unit/autoscaler/image-ref.test.ts` | `'0.1.7'` | 5 | row |
| autoscaler pod env | `tests/unit/autoscaler/manifest.test.ts` (`:189`), `tests/unit/deploy/autoscaler-secret.test.ts`, new `tests/unit/autoscaler/autoscaler-env-census.test.ts` | the `SCALEWAY_DEFAULT_PROJECT_ID` entry; Secret keys | 5 | row |
| supported tiers, deploy mode, failover hint | `supported-tiers.test.ts`, `resolve-deploy-mode.test.ts`, `failover-mode-hint.test.ts` | Scaleway accepts k8s and k8s-ha | 6 | row |
| scenarios, selection, budgets | `scaleway-reference-scenarios.test.ts`, `selection-grammar.test.ts`, `deploy-budget.test.ts`, `calibrate-deploy-budgets.test.ts` | s3, s4; 3 and 15; seeded rows | 6 | row |
| registry censuses | role-candidates, default-sizes-unpinned, provider-contract, supported-tiers-scenario-coverage, readme-provider-coverage, provider-token-variables, gitops-provider-token | auto | 6 | verbose |
| region tests | `region-for-tier.test.ts`, `standby-region-by-price.test.ts`, new `scaleway-k8s-regions.test.ts` | all four zones | 6 | row |
| cost grid | `tests/unit/scripts/cost-grid.test.ts` | Scaleway k8s amounts, volume extra | 6 | row |
| terminology | `tests/unit/docs/terminology-census.test.ts` | auto | 7 | verbose |

## Review Focus

Six failure modes most likely to reach a real user that no existing test exercises; each test lands in its task.

1. **No autoscaled worker is ever created.** The pod has no `SCALEWAY_DEFAULT_PROJECT_ID`, so every in-cluster `createServer` refuses before its first POST, and the cluster never grows. This one is certain, not conditional, and Task 5's other tests stub the env, so they would pass anyway. Task 5: `an autoscaled Scaleway create runs with only the pod's env`.
2. **An autoscaler scale-down deletes a database or app volume.** `deleteServer` deletes every SBS volume on the server, so a PVC volume still attached to a removed worker is destroyed. Task 5: `deleteServer deletes the root volume and never a pvc- volume still attached`.
3. **A short rules listing wipes 80 and 443.** An incomplete rules walk makes `applyOperatorCidrs` or the replication write PUT a partial list, and the site goes dark. Task 2: `findFirewallByName refuses an incomplete group or rules walk, and nothing is written`.
4. **Two environments reach each other's private ports.** A shared routed VPC with no PN filter exposes kubelet, flannel and Postgres across environments. Task 2: `every cluster has its own VPC and its Private Network sits in it`, including both sides of a k8s-ha pair.
5. **A reboot renames the private NIC** and flannel, pinned to the old name, cuts the node off its pods. Task 1: `vc-flannel-iface finds the NIC by MAC after a rename`, and no `--flannel-iface` on the command line.
6. **An autoscaled node is created without the cluster's firewall (RC12, every provider).** `src/autoscaler/groups.js` `_lookupFirewallId` answered a not-found or a failed lookup with null, `_resolveFirewallId` cached that null for the cycle, and every later create went out with no `firewalls`: the project's default security group on Scaleway, no firewall at all on Hetzner. It now throws, naming the firewall, a rejected lookup is not cached, and the create records `errorInfo` (`firewall-not-found`), as a network failure does. Every provider's autoscaler config carries `firewallName: ${clusterName}-firewall` (`renderCarbonAutoscalerConfig`, required by `src/autoscaler/config.js`), and every k8s program declares that firewall unconditionally, so a healthy cluster never refuses. Task 5: `tests/unit/autoscaler/groups.test.ts`, `no create ever reaches createServer without a firewall id`, with the refusal cases (null, no id, a rejected lookup) and `a failed lookup is not remembered`.

The foreign-IP case left this list, because it needs a foreign IP at the exact address. Its tests stay in Task 4.

---

### Task 1: Boot scripts and census staging

**Files:**
- Create: `carbon/cloud-init/k3s/_scaleway-metadata.sh`, `carbon/cloud-init/k3s/scaleway-master-init.sh`, `carbon/cloud-init/k3s/scaleway-worker-init.sh`
- Modify: `src/lib/providers/scaleway.js:510-531` (the three user-data statics stop throwing; `getK8sProgram` keeps throwing until Task 2)
- Modify: `tests/_shared/k8s-built-ahead.ts`, every consumer in the Staging table (found by its grep), and `tests/unit/providers/k8s-built-ahead.test.ts`
- Create: `tests/unit/deploy/scaleway-metadata.test.ts`, `tests/unit/providers/scaleway-k8s-user-data.test.ts`
- Modify: `tests/unit/deploy/k3s-server-flags.test.ts`, `k3s-no-apt.test.ts`, `boot-timing.test.ts`, `tests/unit/iac/cloud-init-include.test.ts`, `core-images-from-mirror-census.test.ts`, `node-roles-census.test.ts`

**Interfaces:**
- Produces: `ScalewayProvider.getK8sMasterUserData({ k3s_version, k3s_token })` renders `scaleway-master-init.sh` through `loadCloudInit` and `renderScript`, as `vultr.js` does; Task 3 adds the CSI vars. `getK8sWorkerUserData({ k3s_version, k3s_token, master_ip })` renders `scaleway-worker-init.sh`; `getK8sDbUserData` renders it with `{ role: 'db' }`. No template takes the subnet, so `renderCarbonAutoscalerConfig` (`k3s.js:1142`) renders autoscaled workers unchanged.
- Produces the shell contract of `_scaleway-metadata.sh`: with `K3S_UNIT` set before the include (`k3s` on the master, `k3s-agent` on the others), it defines `scw_private_iface <tries>`, sets `PUBLIC_IP`, `PRIVATE_IP`, `PRIVATE_IFACE`, `NODE_ID`, `NODE_ZONE` and `NODE_NAME`, and installs the flannel drop-in; or prints a line starting `FATAL:` to stderr and exits 1.

The include is the one fixed-shape piece:

```bash
# Scaleway metadata (one JSON document) and the Private Network NIC, found by
# its MAC prefix 02:00:00, never by name: the name can change across reboots.
# Pulumi attaches the NIC after power-on, so the first call waits for it.
scw_private_iface() {
  local name
  for _ in $(seq 1 "$1"); do
    name=$(ip -o link show | awk '{ for (f = 1; f < NF; f++) if ($f == "link/ether" && index($(f + 1), "02:00:00:") == 1) { n = $2; sub(/:$/, "", n); sub(/@.*/, "", n); print n } }')
    if [ "$(printf '%s\n' "$name" | grep -c .)" = 1 ] && ip -o -4 addr show dev "$name" | grep -q ' inet '; then
      echo "$name"; return 0
    fi
    sleep 2
  done
  return 1
}
SMETA=""
for _ in $(seq 1 15); do
  SMETA=$(curl -sf --max-time 5 'http://169.254.42.42/conf?format=json') && [ -n "$SMETA" ] && break
  sleep 2
done
read -r PUBLIC_IP NODE_ID NODE_ZONE NODE_NAME <<SMETAEOF
$(printf '%s' "$SMETA" | python3 -I -c '
import json, sys
try:
    m = json.load(sys.stdin)
except ValueError:
    m = {}
v4 = [i.get("address") for i in m.get("public_ips_v4") or [] if i.get("address")]
pub = v4[0] if v4 else (m.get("public_ip") or {}).get("address")
print(pub or "-", m.get("id") or "-", (m.get("location") or {}).get("zone_id") or "-", m.get("hostname") or "-")
')
SMETAEOF
[ "$PUBLIC_IP" != "-" ] && [ -n "$PUBLIC_IP" ] || { echo "FATAL: no public address in Scaleway metadata" >&2; exit 1; }
[ "$NODE_ID" != "-" ] || { echo "FATAL: no server id in Scaleway metadata" >&2; exit 1; }
[ "$NODE_ZONE" != "-" ] || { echo "FATAL: no zone in Scaleway metadata" >&2; exit 1; }
PRIVATE_IFACE=$(scw_private_iface 90) || { echo "FATAL: no single Private Network interface (MAC 02:00:00:...) with an address after 180 s; is the server attached to the cluster's Private Network?" >&2; exit 1; }
PRIVATE_IP=$(ip -o -4 addr show dev "$PRIVATE_IFACE" | awk '{ split($4, a, "/"); print a[1]; exit }')
mkdir -p /etc/rancher/k3s/config.yaml.d /usr/local/sbin "/etc/systemd/system/$K3S_UNIT.service.d"
{ echo '#!/bin/bash'; declare -f scw_private_iface
  echo 'n=$(scw_private_iface 30) || { echo "FATAL: no Private Network interface" >&2; exit 1; }'
  echo 'printf "flannel-iface: %s\n" "$n" > /etc/rancher/k3s/config.yaml.d/50-flannel-iface.yaml'
} > /usr/local/sbin/vc-flannel-iface
chmod 755 /usr/local/sbin/vc-flannel-iface
printf '[Service]\nExecStartPre=/usr/local/sbin/vc-flannel-iface\n' > "/etc/systemd/system/$K3S_UNIT.service.d/10-flannel-iface.conf"
/usr/local/sbin/vc-flannel-iface
```

`declare -f` writes the one finder into the start-time script, so boot and every k3s start run the same code. `NODE_NAME` is then validated and applied exactly as `vultr-master-init.sh` does (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`, `hostnamectl set-hostname`, FATAL otherwise). Read `renderScript` (`src/lib/iac/cloud-init.js:229`) before writing: it substitutes only `${<var>}` for the keys it is given, so `$(f + 1)` and `$n` pass through.

Both scripts copy `vultr-master-init.sh` and `vultr-worker-init.sh` (phase marks master `p n k r x e`, worker `p n w k e`; the k3s version check; `_host-firewall-off.sh`, `_container-signals.sh`, `_stable-flowlabel.sh`, `_k3s-system-image-mirror.yaml`, `_host-reporter.sh` after `get.k3s.io` on the worker). They change only these:
- `K3S_UNIT=k3s` (master) or `K3S_UNIT=k3s-agent`, then `# @include _scaleway-metadata.sh` replaces the Vultr identity block.
- No `--flannel-iface` flag (the drop-in carries it). `--kubelet-arg="provider-id=scaleway://$NODE_ID"`. No `--flannel-backend`, no `--disable-cloud-controller`, no `cloud-provider=external`.
- Every other Vultr server and agent flag stays, `--node-ip "$PRIVATE_IP"` and `--advertise-address "$PRIVATE_IP"` included.
- The master installs no CSI yet; Task 3 adds it between `_m x` and `_m e`.

- [ ] **Step 1: Write the failing tests.**
  - `scaleway-metadata.test.ts` runs the include under `bash -c 'set -euo pipefail; ...'` with `spawnSync`, `K3S_UNIT=k3s-agent`, and a temp `PATH` holding fake `curl` and `ip`, a no-op `sleep`, and links to the real `python3`, `awk`, `grep`, `seq`, `mkdir`, `chmod` and `cat`. Before running, the test replaces the include's three system roots (`/usr/local/sbin`, `/etc/rancher`, `/etc/systemd`) with temp dirs in its text, so nothing touches the host. Cases:
    - `exports the six values`: metadata with `public_ips_v4: [{address: 203.0.113.10}]`, `id`, `location.zone_id: fr-par-1`, `hostname: acme-prod-master`; `ip -o link` lists `ens2` (`de:00:00:11:22:33`) and `ens5` (`02:00:00:aa:bb:cc`); `ip -o -4 addr show dev ens5` prints `10.130.5.3/24`. A trailing echo prints `203.0.113.10 10.130.5.3 ens5 <uuid> fr-par-1 acme-prod-master`.
    - `falls back to public_ip.address` when `public_ips_v4` is empty.
    - `no 02:00:00 NIC: FATAL after the wait`; `two 02:00:00 NICs: FATAL`; `the NIC holds no IPv4 yet: FATAL`; `metadata never answers: FATAL on the public address` (`curl` exits 22).
    - `the drop-in names the unit and the start-time script`: `10-flannel-iface.conf` is under `k3s-agent.service.d` for `K3S_UNIT=k3s-agent` and reads exactly `[Service]\nExecStartPre=/usr/local/sbin/vc-flannel-iface\n`.
    - `vc-flannel-iface finds the NIC by MAC after a rename` (Review Focus 5): run the written script with the fake `ip` now naming the `02:00:00` NIC `ens6`; `50-flannel-iface.yaml` reads `flannel-iface: ens6\n`.
  - `scaleway-k8s-user-data.test.ts`, modelled on `vultr-k8s-user-data.test.ts`:
    - Placeholder sets: master `['k3s_token', 'k3s_version']`; worker and db add `master_ip`.
    - The master contains `provider-id=scaleway://$NODE_ID`, `--advertise-address "$PRIVATE_IP"` and `K3S_UNIT=k3s`, and no `--flannel-iface`, `--flannel-backend`, `--disable-cloud-controller` or `cloud-provider=external`; the worker has `K3S_UNIT=k3s-agent`.
    - `_host-firewall-off.sh` and `_container-signals.sh` are included before the k3s install on every role.
    - Each role, with a 64-character token, a full k3s version and a private address, is under `28 * 1024` bytes; the master under `31 * 1024`.
    - Both templates, the include and the db render are pure ASCII.
    - `refuses a metadata hostname that is not one DNS label` (64 characters, an underscore, empty): FATAL, `hostnamectl` never called. A longer server name stays the cloud's affair (Task 5).
  - `k3s-server-flags.test.ts`: a "Scaleway scripts" block mirroring Vultr's, with `SCALEWAY_VARS` (`PRIVATE_IP`, `PUBLIC_IP`, `NODE_ID`, the template values): `--node-ip` private, `--node-external-ip` public, the provider id, `--advertise-address`, `--write-kubeconfig-mode=600`, `--system-default-registry`, and no `--flannel-iface`. The walk shows scaleway's master booting from `['scaleway-master-init.sh']` and its worker and db from `['scaleway-worker-init.sh']`.
  - `k8s-built-ahead.test.ts`: `every entry is a registered provider that does not sell k8s yet`, `every part named is a K8sPart`, and `k8sCensusProviders('boot') is the k8s sellers then scaleway` while `k8sCensusProviders('program')` has no scaleway. Also `k8sCensusProviders() and k8sCensusProviders('nope') throw`, and `no consumer calls k8sCensusProviders without a part`: a source scan of the grep's files for `k8sCensusProviders()`.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm test:unit tests/unit/deploy/scaleway-metadata.test.ts tests/unit/providers/scaleway-k8s-user-data.test.ts tests/unit/deploy/k3s-server-flags.test.ts tests/unit/providers/k8s-built-ahead.test.ts`. Expected: FAIL (missing files; the statics throw). After Step 3, `pnpm test:unit tests/unit/providers/iac-dispatch.test.ts` must pass too: it is the consumer that breaks at load if its rewrite is missed.
- [ ] **Step 3: Implement.** Write the include, both scripts, the statics and the staged helper. Run the Staging grep and apply its table row by row: the `iac-dispatch` rewrite, the user-data census split, and a part for every call site. Then add both scripts to the hand-lists in **Files**. `k3s-boot-scripts.ts` adds `csiImageRewriteVars(provider)` to a master only while `CSI_SIDECAR_MIRRORS[provider]` exists (it throws for Scaleway until Task 3), as Part B's Task 1 did; Task 3 makes it unconditional again.
- [ ] **Step 4: Run the suite.** `pnpm test:unit`. Expected: PASS. Then `pnpm test:unit tests/unit/deploy/k3s-server-flags.test.ts tests/unit/deploy/k8s-user-data-secret-census.test.ts tests/unit/deploy/host-reporter-census.test.ts --reporter=verbose 2>&1 | grep -i scaleway`. Expected: passing Scaleway cases from each.
- [ ] **Step 5: Commit.** Subject `feat(scaleway): k3s boot scripts for k8s nodes`.

### Task 2: `scaleway-k8s.js` Pulumi program and the security group

**Files:**
- Create: `src/lib/iac/programs/scaleway-k8s.js`
- Modify: `src/lib/providers/scaleway.js`: `K8S_IMAGE = 'ubuntu_resolute'` (`:454`); `getK8sProgram` imports the program dynamically, as `vultr.js` does (`:529`); `findFirewallByName` (`:1340`) throws on an incomplete walk; `buildReplicationFirewallRules` (`:1426`) puts the operator-locked rules last
- Modify: `src/lib/providers/base.js:1031-1037`, the `findFirewallByName` doc. It says the method "must swallow errors rather than throw". New text: null when no firewall has the name; a provider whose listing can come back incomplete (Scaleway, Vultr) throws instead of returning null, and every caller catches or propagates the throw (`groups.js:338`, `k8s-ha.js:623`, `compose/ha.js:982`, `scaleway.js:1500`).
- Modify: `src/lib/cidr.js` gains `cidrContainsIp`, moved from `src/lib/operator-ip.js:106`. `operator-ip.js` imports and re-exports it, so `tests/unit/access/cidr-match.test.ts` is unchanged. The program cannot import `operator-ip.js`: that file pulls in `config.js`, `fetch-retry.js` and `providers/index.js` (`operator-ip.js:35-40`), which makes a cycle through `scaleway.js`.
- Create: `tests/unit/iac/scaleway-k8s.test.ts` (mock harness of `tests/unit/iac/vultr-k8s.test.ts`), `tests/unit/providers/scaleway-firewall-partial-listing.test.ts`
- Modify: `tests/_shared/k8s-built-ahead.ts` (`scaleway: ['boot', 'program']`), `tests/_shared/pulumi-recorder.ts`, `tests/_shared/provider-expected.ts` (scaleway `k8sImage: 'ubuntu_resolute'`; the stale comment at `:140-142` about the CCM's `instance/<zone>/<uuid>` form becomes: no CCM runs, and k3s takes `scaleway://<server uuid>`, Task 1's `--kubelet-arg`), `tests/unit/iac/k8s-firewall-round-trip-census.test.ts` (RC10; its part, and a Scaleway row that maps `{ action, protocol, port, ipRange }` to `{ action, protocol, direction: 'inbound', ip_range: ipRange, dest_port_from: port, dest_port_to: port }`), and the `'program'` censuses and rows in the table

**Interfaces:**
- Produces: `buildScalewayK8sProgram(config)`, taking `buildVultrK8sProgram`'s config contract and returning Vultr's output names: `masterIp, masterId, masterPrivateIp, dbIp, dbPrivateIp, workerIps, floatingIp, networkId, sshKeyId, k3sToken, clusterName, vpcCidr`.
- Produces: `export function privateIpv4In(privateIps, cidr)`: the `address` of the first entry that is IPv4 (`net.isIPv4`) and inside `cidr`, else null. The inside check is `cidrContainsIp(cidr, address, 4)` from `src/lib/cidr.js`. The family argument is required: without it the check is false for every IPv4 address (`operator-ip.js:106-113`), so every master would get "no address in the cluster's Private Network" and every deploy would stop.
- Consumes: `config.replicationPeerIp` (RC10; validated upstream by `replicationPeerIpFor`) and `ScalewayProvider.SERVER_RESOURCE_TYPE` (`'scaleway:instance/server:Server'`, `scaleway.js:260`, the key `create-timeout.js:120` holds), written `SERVER` below.
- Produces: `buildReplicationFirewallRules(fw, peerIp)` returns the shared result with the operator-locked rules moved last (Rule order), still null when the peer's rule is already right.
- Produces: `findFirewallByName(name)` throws `Error('Scaleway listed only part of zone <zone>\'s security groups (or of <name>\'s rules), so nothing was changed')` on any incomplete walk, still returns null when a complete listing has no match, and is unchanged otherwise. `deleteFirewallByName` already turns a throw into `apiError`.

Refusals as Vultr's, in its wording: `requireOperatorCidrs(config, { k8sApi: true })`, `requireK3sToken`, the 63-character node-name refusal on `${clusterName}-ca-xxxxxxxx`. `clusterName` is `stackIdentity(config).name` (RV1); `zone` is `config.location`; `region` is `zone.replace(/-\d+$/, '')`; `vpcCidr` is `vpcCidrForCluster(clusterName, 24)`; `bareId = (id) => String(id).split('/').pop()`, as `scaleway-compose.js` has it.
- **SSH key.** With `existingSshKeyId`, none. Otherwise `iam.SshKey` `${clusterName}-${zone}-key` (Scaleway keys are Project-wide; servers take no key input).
- **Network.** `network.Vpc` `vpc` (`name: ${clusterName}-network`, `region`, `tags`), then `network.PrivateNetwork` `network` (same name, `region`, `vpcId: vpc.id`, `ipv4Subnet: { subnet: vpcCidr }`, `tags`).
- **Security group.** `instance.SecurityGroup` `firewall`: `name: ${clusterName}-firewall`, `zone`, `stateful: true`, `inboundDefaultPolicy: 'drop'`, `outboundDefaultPolicy: 'accept'`, `tags`, and `inboundRules` in this order: 80 from `0.0.0.0/0`, 80 from `::/0`, 443 from `0.0.0.0/0`, 443 from `::/0`, each `{ action: 'accept', protocol: 'TCP', port, ipRange }`; then, only when `config.replicationPeerIp` is set, `{ action: 'accept', protocol: 'UDP', port: 51821, ipRange: `${replicationPeerIp}/32` }`, which maps field for field to `buildPeerRule` and has no description because `buildPeerRule` has none; then 22 from each `allowedSshIps` CIDR, then 6443 from each `allowedK8sApiIps` CIDR, both TCP. The Rule order decision says why 51821 sits there.
- **IPs.** `instance.Ip` `ingress`, `db-ip` and `worker-${i + 1}-ip`: `zone`, `type: 'routed_ipv4'`, `tags: encodeLabels({ ...labels, role })` (`labels` from `stackIdentity`, which carry `project` and `environment`).
- **Servers.** `instance.Server` `master`, `db`, `worker-${i + 1}`, named `${clusterName}-master`, `-db`, `-worker-${i + 1}`: `zone`, `type`, `image: ScalewayProvider.K8S_IMAGE`, `securityGroupId: firewall.id`, `ipIds: [<its ip>.id]`, `privateNetworks: [{ pnId: network.id }]`, `rootVolume { volumeType: 'sbs_volume', sizeInGb: 40, deleteOnTermination: true }`, `userData: pulumi.secret({ 'cloud-init': ... })`, tags as Vultr's (db `role: db`, `node-pool: db-pool`; workers `'cluster-autoscaler/node': 'static'`). Master: `serverResourceOptions(SERVER, { deleteBeforeReplace: true })`. db: the same. Workers: `workerResourceOptions(SERVER, { deleteBeforeReplace: true, dependsOn: masterDeps, joinTarget: { masterId, masterPrivateIp, k3sVersion: config.k3sVersion } })`, with no `omitJoinTrigger`, as `vultr-k8s.js:314-321` has it. The workers wait on the master's address anyway, so leaving the trigger out would gain nothing (`create-timeout.js:181-183`). Linode's and Hetzner's `omitJoinTrigger: !config.k3sTokenReplayed` (`linode-k8s.js:321`, `hetzner-k8s.js:363`) is not copied: on a first deploy it would drop the trigger that the bare-id test below reads.
- **The master's address and id.** `masterId = config.priorMaster?.id ?? master.id.apply(bareId)`, and the join trigger uses that same value, so state's trigger and a scale's `priorMaster.id` (read from the `masterId` output, `converge-cluster.js:111`) spell the id alike. `masterPrivateIp = config.priorMaster?.privateIp ?? master.privateIps.apply(...)`, which throws when `privateIpv4In` gives null: `Scaleway gave the master no address in the cluster's Private Network ${vpcCidr}, so the other nodes cannot join it. If your API key's policy lacks IPAMReadOnly, Scaleway hides that address; add it and deploy again.` The db and workers depend on the master unless `priorMaster` is set, as Vultr's.
- **Outputs.** `masterIp` and `floatingIp` are `ingress.address`; `dbIp` `dbIp.address`; `workerIps` the worker IPs' addresses; `dbPrivateIp` is `privateIpv4In(db.privateIps, vpcCidr)`, and when that is null it throws `Scaleway gave the database node no address in the cluster's Private Network ${vpcCidr}, so the cluster cannot reach its database. If your API key's policy lacks IPAMReadOnly, Scaleway hides that address; add it and deploy again.`; `networkId` `network.id.apply(bareId)`; `sshKeyId` through `sshKeyIdOutput`; `k3sToken` secret; `vpcCidr`; `clusterName`.

- [ ] **Step 1: Write the failing tests.**
  - `scaleway-k8s.test.ts`:
    - The output keys equal Vultr's.
    - `the security group is the one operator-ip pushes to`: for a k8s config (`prod`) and both k8s-ha sides, its `name` equals `firewallName(projectName, side)`.
    - The `inboundRules` are exactly the ordered list above, with and without `replicationPeerIp: '198.51.100.7'`. Without it, no rule names 51821.
    - `the next up plans no rule change after an access push` (RC3): for a k8s-ha side with `replicationPeerIp: '198.51.100.7'`, build the group's REST rules from the program's `inboundRules`. Run `applyOperatorCidrs` against a stubbed `findFirewallByName` with a new CIDR list, map the captured PUT body back to `inboundRules` form, and compare with the program run for a config whose `allowedSshIps` and `allowedK8sApiIps` are that list: equal, in order, 51821 included. `buildReplicationFirewallRules(fw, '198.51.100.7')` on the declared rules returns null. RC10's round-trip census asserts the same through its Scaleway row; this test pins the position.
    - `after a first deploy's REST bootstrap, the next up plans no rule change`: take the REST form of the rules the program declares without `replicationPeerIp`, apply `buildReplicationFirewallRules(fw, '198.51.100.7')`, map the result back, and compare with the program run with the peer: equal, in order.
    - `every cluster has its own VPC and its Private Network sits in it` (Review Focus 4): one `Vpc` and one `PrivateNetwork` named `${clusterName}-network`, the PN's `vpcId` is the Vpc's id, `ipv4Subnet.subnet` and the `vpcCidr` output equal `vpcCidrForCluster(clusterName, 24)`; the two k8s-ha sides get different VPC names and subnets.
    - Every server has `privateNetworks` of exactly that PN, `securityGroupId`, one `ipIds` entry of its own `Ip`, and `deleteBeforeReplace: true`; no server has `enableDynamicIp`.
    - The ingress, db and worker IPs carry `project:<P>` and `environment:<E>` as separate tags.
    - `privateIpv4In([{ address: 'fd00::3' }, { address: '10.130.5.3' }], '10.130.5.0/24')` is `'10.130.5.3'` (the case that fails without the family argument); it skips an IPv4 outside the subnet; the db and worker user data carry the master's address from the mocks; an empty `privateIps` on the master or the db fails the program with its message above.
    - `the join trigger names the master by its bare id on deploy and on scale`: the deploy-time trigger with mocked `master.id = 'fr-par-1/<uuid>'` and a scale run with `priorMaster: { id: '<uuid>', privateIp }` give the same string, and `masterId` is `<uuid>`.
    - With `priorMaster`, the user data carries `priorMaster.privateIp` and the db does not depend on the master.
    - The SSH key rules and the node-name refusal, as Vultr's.
  - `scaleway-firewall-partial-listing.test.ts` (Review Focus 3), stubbed fetch, `findFirewallByName refuses an incomplete group or rules walk, and nothing is written`: an incomplete group walk makes `findFirewallByName` throw, `applyOperatorCidrs` reject and `deleteFirewallByName` return `{ deleted: false, everExisted: false, apiError }`; an incomplete rules walk makes `applyOperatorCidrs` and the replication path reject; in each case no PUT and no DELETE was sent.
  - Census edits per the table; the recorder's `names` gains `'network'`.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm test:unit tests/unit/iac/scaleway-k8s.test.ts tests/unit/providers/scaleway-firewall-partial-listing.test.ts tests/unit/providers/iac-dispatch.test.ts tests/unit/iac/k8s-firewall-round-trip-census.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Check every k8s `up` path.** `grep -rn --exclude='.env*' "\.up(" src/lib/iac/ src/lib/deploy/ src/scale.js src/failover.js`: every k8s stack's `up` goes through `prepareStackForUp` (`src/lib/iac/index.js:1164-1214`), which refreshes first. Report a caller that does not; add no second path.
- [ ] **Step 5: Run the suite.** `pnpm test:unit`. Expected: PASS. Then the verbose grep over `iac-dispatch`, `k3s-token-census`, `k8s-floating-ip-output-census`, `k8s-naming-parity` and `k8s-firewall-round-trip-census`: passing Scaleway cases from each.
- [ ] **Step 6: Commit.** Subject `feat(scaleway): Pulumi program for k8s clusters`. The body names the partial-listing fix in `findFirewallByName`, which also covers compose, and the one rule order every writer now keeps.

### Task 3: CSI driver, storage class, volume floor and mirrors

**Files:**
- Create: `carbon/cloud-init/k3s/_scaleway-csi.yaml` (the render, header first)
- Modify: `carbon/cloud-init/k3s/scaleway-master-init.sh` (CSI block between `_m x` and `_m e`)
- Modify: `src/lib/iac/cloud-init.js`: `EMBEDDED_CSI_MANIFESTS = { scaleway: { var: 'scaleway_csi_manifest', file: '_scaleway-csi.yaml', path: '/root/scaleway-csi.upstream.yaml' } }`; `embeddedManifestVars(providerId)` (`{}` for a provider with none; otherwise `{ [var]: gzipSync(<file bytes>, { level: 9 }).toString('base64') }`, cached); `masterAddedVars(providerId)` = `{ ...csiImageRewriteVars(providerId), ...embeddedManifestVars(providerId) }`
- Modify: `src/lib/images.js`: `SCALEWAY_CSI_VERSION = 'v0.3.6'` with the chart in the Sources comment (`:356-370`); `CSI_SIDECAR_MIRRORS.scaleway` (`:400`)
- Modify: `src/lib/providers/scaleway.js`: `getK8sMasterUserData` renders with `masterAddedVars('scaleway')`; `K8S_ASSETS` (`:432`) `{ csiNodeDaemonSet: 'daemonset/scaleway-csi-node', csiControllerSelector: 'app=scaleway-csi-controller', ccmDeployment: '', ccmSelector: '', networkEnvVar: '' }`; `K8S_STORAGE_CLASS = 'scaleway-block-vibecarbon'` (`:448`); `static K8S_MIN_VOLUME_GI = 5`; `k8sCloudSecrets({ token, region })`; `K8S_RETIRED_CLOUD_SECRETS`; one private helper for the access key and project id, used by `buildIacEnv` too
- Modify: `src/lib/providers/base.js` (`k8sCloudSecrets` doc names `{ token, region }`, the region being what `REGIONS` keys, a zone on Scaleway); `src/lib/deploy/k8s/k3s.js:2775` (`applyCloudSecrets` takes `region` and calls `k8sCloudSecrets({ token, region })` at `:2784`) and its one production caller `:6685` (`region: options.region`, placed after `token: options.apiToken`)
- Modify: `src/lib/providers/scaleway.js` `getServer` (`:1151`), so the token check reads a refusal right: when `_findServerZone` (`:823`) finds no zone, it throws with `status: 404`, or `status: 403` when a zone answered 403, instead of a plain "not found in any zone"; a probe answer other than 403 or 404 (a 401 included) throws with that `status`
- Modify: `scripts/version-channel.mjs` (`RENDERED_DRIVER`, read by `driverPinsIn`)
- Modify tests: `tests/_shared/k3s-boot-scripts.ts` (unconditional `masterAddedVars(provider)`), `tests/_shared/csi-install-rewrite.ts`, `tests/_shared/cloud-secret-readers.ts`, `tests/_shared/legacy-master-init-secrets.ts`, `tests/unit/deploy/k8s-image-mirrors.test.ts`, `tests/unit/lib/version-channel-plan.test.ts`, `tests/unit/deploy/k8s-cloud-secrets.test.ts`, `tests/integration/docker/k8s-cloud-secrets-takeover.test.ts`, `tests/unit/diagnose/k8s-empty-assets.test.ts`, `tests/unit/deploy/k8s-volume-floor.test.ts`, `tests/unit/providers/scaleway-k8s-user-data.test.ts`, `tests/_shared/provider-expected.ts`, `tests/_shared/k8s-built-ahead.ts` (`'csi'`)

**How an `envFrom` reader is recorded.** Fact 8's controller reads the whole Secret through `envFrom`. The takeover test already records such a reader as one ref with `key: '(envFrom)'` (`k8s-cloud-secrets-takeover.test.ts:249-255`) and compares the record with `refs` (`:414`). The unit census, however, computes the required keys from `refs` (`k8s-cloud-secrets.test.ts:345-351`). So the record holds both, in this one form:

```ts
scaleway: {
  manifests: ['carbon/cloud-init/k3s/_scaleway-csi.yaml'],
  refs: [{ workload: 'deployment/scaleway-csi-controller', namespace: 'kube-system', secret: 'scaleway-csi-secret', key: '(envFrom)' }],
  envFromKeys: { 'kube-system/scaleway-csi-secret': ['SCW_ACCESS_KEY', 'SCW_DEFAULT_PROJECT_ID', 'SCW_DEFAULT_ZONE', 'SCW_SECRET_KEY'] },
},
```

- `refs` is exactly what the takeover's `secretRefs` reads off the installed controller, so `:414` passes unchanged.
- `envFromKeys` (a new optional field on the record type, `Record<'<namespace>/<secret>', string[]>`) lists the keys the reader requires, from fact 8.
- The unit census expands each non-optional `(envFrom)` ref into its `envFromKeys` entry, and every other ref into its `key`. It also asserts that every `(envFrom)` ref has an entry and that every entry is named by one.
- `nothing upstream reads a retired one` (`:494-503`) treats an `(envFrom)` ref as reading every key of its Secret, so a retired Secret of that name fails it whatever its `keys`.

**Every `k8sCloudSecrets` and `applyCloudSecrets` call in the two census files.** Scaleway's `k8sCloudSecrets` throws without the operator companions or a region, so each call gets both:
- `tests/_shared/cloud-secret-readers.ts` exports:
  - `CLOUD_SECRETS_ZONE = 'fr-par-1'`;
  - `OPERATOR_COMPANIONS = { SCALEWAY_ACCESS_KEY: 'SCWTESTACCESSKEY00000', SCALEWAY_DEFAULT_PROJECT_ID: '00000000-0000-4000-8000-000000000001' }`, with `stubOperatorCompanions()`, which runs `vi.stubEnv` over it;
  - `cloudSecretsOf(Provider, token)`, which is `Provider.k8sCloudSecrets({ token, region: CLOUD_SECRETS_ZONE })`;
  - `COMPANION_VALUES = { scaleway: { SCW_ACCESS_KEY: <the stub>, SCW_DEFAULT_PROJECT_ID: <the stub>, SCW_DEFAULT_ZONE: CLOUD_SECRETS_ZONE } }`.
- `tests/unit/deploy/k8s-cloud-secrets.test.ts`:
  - `stubOperatorCompanions()` runs once at module scope, because `GITOPS_UNREAD` (`:685-692`) calls `k8sCloudSecrets` while the tests are collected. It runs again in a top-level `beforeEach`, because the `afterEach` at `:840-842` unstubs every env.
  - These calls become `cloudSecretsOf(...)`: `:343, :364, :369, :403, :441, :588, :647, :688, :726, :815, :820, :1167, :1227, :1642, :1666, :1743, :2157, :2184, :2240`. The `TwoSecrets` stub class (`:697`) keeps its signature and ignores `region`.
  - Every `applyCloudSecrets({...})` gains `region: CLOUD_SECRETS_ZONE`: the `apply` helper `:563`, and `:997`, `:1038`, `:1067`, `:1117`.
  - The source pin at `:2584-2586` gains `region: options.region, ` after `token: options.apiToken, `.
  - `:352-354` checks each value against `COMPANION_VALUES[id]?.[key] ?? TOKEN`, over `Object.entries`.
  - The token-check block assumes one read under `Authorization: Bearer` (`expectOneRead`, `:829-834`), plus a per-provider not-found message (`:806-811`). Scaleway sends `X-Auth-Token` and probes a zone first (`_findServerZone`). So the fake fetch (`:276-277`) also records `x-auth-token`, and `expectOneRead` becomes `expectMasterReads`. Every read must be of the master's URL under the provider's own header. The count is 1 for everyone else, as now. For Scaleway it is the zones probed until one answers, plus the read itself when one does: 2 when the fake answers, 1 on a 401, every zone on a 403 or 404. The not-found map gains Scaleway's message from the `getServer` change above.
- `tests/integration/docker/k8s-cloud-secrets-takeover.test.ts`:
  - `stubOperatorCompanions()` runs in the file's `beforeEach`, with `vi.unstubAllEnvs()` in its `afterEach`.
  - `hand` (`:333-340`) passes `region: CLOUD_SECRETS_ZONE`, and `expected` (`:341`) is `cloudSecretsOf(Provider, token)`.
  - The `beforeAll` at `:284-295` applies a non-`https` entry as `join(REPO_ROOT, url)`, so the committed render is what reaches k3s.

**Interfaces:**
- Produces: `CSI_SIDECAR_MIRRORS.scaleway`, Hetzner's refs: `daemonset/scaleway-csi-node` with `csi-node-driver-registrar` (v2.18.0) and `liveness-probe` (`sig-storage/livenessprobe` v2.20.0); `deployment/scaleway-csi-controller` with `csi-provisioner` v6.3.0, `csi-attacher` v4.13.0, `csi-resizer` v2.2.1, `liveness-probe` v2.20.0; digests copied from the Hetzner entries.
- Produces: `RENDERED_DRIVER = /^# Rendered from https:\/\/github\.com\/([\w.-]+\/[\w.-]+) (v\d[\d.]*)$/gm`; `driverPinsIn` adds its matches, so `liveDrivers` checks `scaleway/scaleway-csi`'s `go.mod` at v0.3.6.
- Produces: `k8sCloudSecrets({ token, region })` returns `[{ namespace: 'kube-system', name: 'scaleway-csi-secret', stringData: { SCW_ACCESS_KEY, SCW_SECRET_KEY: token, SCW_DEFAULT_PROJECT_ID, SCW_DEFAULT_ZONE: region } }]`. `region` is the zone (`options.region`). It throws on an empty `region`, and throws the shared helper's message when an operator companion is unset. Every other provider ignores `region`.
- Produces (Task 5 consumes it): `scalewayOperatorIds()`, the private helper that reads `{ accessKey, projectId }` with `readOperatorVar` and throws the `buildIacEnv` message naming whichever is missing. `buildIacEnv` and `k8sCloudSecrets` both call it.

The master's CSI block, after `# @include _csi-image-mirror.sh`:

```bash
printf '%s' "${scaleway_csi_manifest}" | base64 -d | gunzip > /root/scaleway-csi.upstream.yaml \
  || { echo "FATAL: the embedded CSI manifest does not decode" >&2; exit 1; }
```

then Vultr's 3-try FATAL loop with `csi_fetch_mirrored file:///root/scaleway-csi.upstream.yaml /root/csi-driver.yaml \` on one line and `&& kubectl apply -f /root/csi-driver.yaml; then` on the next (the shape the census parses), then the StorageClass of RC6 in its own 3-try loop. No snapshot CRDs, no toleration patch, no Secret.

- [ ] **Step 1: Render and record.** In the scratchpad, download the chart, check its sha256 against fact 6, run the render command of RC2, and confirm the render is ASCII with exactly the eight `image:` lines of fact 6 and the decisions. Write the header plus the render to `_scaleway-csi.yaml`. Record `UPSTREAM_CSI_MANIFESTS.scaleway` from it, and `CLOUD_SECRET_READERS.scaleway` in the form above. Check in the render that the controller's only Secret reference is the `envFrom` of `scaleway-csi-secret` and the node's none; if not, record what is there. `manifestUrls` matches `(?:https|file):\/\/` and maps `csi_fetch_mirrored file://<path>` to `carbon/cloud-init/k3s/<file>` through `EMBEDDED_CSI_MANIFESTS`, throwing on a `file://` path the table does not hold. Also check whether the render quotes the driver image. Add `'scaleway'` to `NO_LEGACY_BOOT_SECRETS`.
- [ ] **Step 2: Write the failing tests.**
  - k8s-image-mirrors: the version row `['scaleway', 'carbon/cloud-init/k3s/_scaleway-csi.yaml', /scaleway\/scaleway-csi:(v[\d.]+)"?/]` with `SCALEWAY_CSI_VERSION` (the quote optional, whatever Step 1 found); Scaleway joins the two `it.each` lists; `CSI_REPO.scaleway = 'scaleway/scaleway-csi'`; the install regex accepts `(?:https|file):\/\/`, and for a `file://` install the test checks that the URL is the table's `path`, that the master's embedded value decodes to the committed file byte for byte, and that its header names `CSI_REPO` and the version. `mirroredPackageNames()` is not edited and still passes.
  - version-channel-plan: `driverPinsIn` over the k3s directory yields `{ repo: 'scaleway/scaleway-csi', tag: 'v0.3.6' }`, and `the header tag equals every scaleway/scaleway-csi image tag in the render and SCALEWAY_CSI_VERSION`.
  - k8s-cloud-secrets, with the call-site changes above: `SCW_SECRET_KEY` holds the token, and the three others hold `COMPANION_VALUES.scaleway`. `applyCloudSecrets passes the cluster's region` (a spy on `k8sCloudSecrets` sees `{ token, region: 'fr-par-1' }`). `Scaleway refuses with no zone or no companions`: an empty `region` throws, and so does an unset `SCALEWAY_DEFAULT_PROJECT_ID`, whose message names the variable. `an envFrom ref expands to its envFromKeys`, and `an (envFrom) ref without envFromKeys fails the census`.
  - getServer (in `scaleway.test.ts`): a master in no zone throws `status: 404`; a 401 from the probe throws `status: 401`.
  - k8s-volume-floor: `ScalewayProvider.K8S_MIN_VOLUME_GI is 5`, and a 1Gi claim renders as 5Gi with it.
  - scaleway-k8s-user-data: the master's placeholder set gains `Object.keys(masterAddedVars('scaleway'))`; still under 31 KiB.
- [ ] **Step 3: Run them and confirm they fail.** `pnpm test:unit tests/unit/deploy/k8s-image-mirrors.test.ts tests/unit/lib/version-channel-plan.test.ts tests/unit/deploy/k8s-cloud-secrets.test.ts tests/unit/deploy/k8s-volume-floor.test.ts tests/unit/providers/scaleway.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** `applyK3sManifests` already runs `csiSidecarSetImagePlan(providerId)` for every provider. `csiUpstreamImagePins` gains nothing: the render pulls no floating image.
- [ ] **Step 5: Run the suites.** `pnpm test:unit`, then `pnpm test:docker` (the takeover test applies the committed render to a real k3s; `csi-repin-noop.test.ts` covers it through `UPSTREAM_CSI_MANIFESTS`). Expected: PASS. Then the verbose grep over `k8s-image-mirrors`, `k8s-cloud-secrets`, `k8s-empty-assets` and `k8s-storage-class-literal-guard`.
- [ ] **Step 6: Commit.** Subject `feat(scaleway): block storage CSI driver, storage class and mirrors`. The body says the sidecars are Hetzner's published refs, so nothing new is published, and how to re-render (the header's command).

### Task 4: Destroy and sweeps

**Files:**
- Modify: `src/lib/providers/scaleway.js`: `static K8S_DESTROY_BACKSTOP = true`; `static ORPHAN_VOLUME_REGION_GUESS = false`; `listNetworksDetailed()`; `deleteNetworkByName(name)`; `deleteReservedIpByAddress(address)`; `reservedIpLabelMatch(address, labels)`; `serverNetworkIds(server)` (`:1743`)
- Modify: `src/lib/csi-volumes.js` (`CSI_DRIVERS['csi.scaleway.com']`)
- Modify: `tests/e2e/utils/sweep-scaleway.ts` (a VPC listing after the Private Networks, counted as `networks`), `tests/e2e/utils/stack-probes.ts` (`network.Vpc`, `network.PrivateNetwork`, regional ids `<region>/<uuid>`), `tests/e2e/utils/residue-audit.ts` if it lists Scaleway networks
- Create: `tests/_shared/scaleway-csi-pv.ts` (`scalewayPv(name, handle, zone = 'fr-par-1')`), `tests/unit/destroy/orphaned-volumes-cleanup-scaleway.test.ts`, `tests/unit/providers/scaleway-k8s-cleanup.test.ts`
- Modify: the Task 4 rows of the census table, and `tests/_shared/k8s-built-ahead.ts` (`'destroy'`)

**Interfaces** (the contracts `src/destroy.js` already reads from Vultr and Linode):
- `listNetworksDetailed()` returns `{ items, complete, status? }` over every region's PNs; `listNetworks()` keeps its soft-fail. Both new listings carry `project_id=<SCALEWAY_DEFAULT_PROJECT_ID>` when it is set, as `deleteSSHKeyByName` does (`scaleway.js:1520-1524`). The VPC API filters both by project (scaleway-sdk-go `api/vpc/v2/vpc_sdk.go`: `ListPrivateNetworksRequest` and `ListVPCsRequest` each have `ProjectID`, read 2026-11-26).
- `deleteNetworkByName(name)` returns `{ deleted, everExisted, apiError }` and `@throws when a listing cannot be read whole`, the contract of `deleteVpcByName` (`base.js:42-60`), which Scaleway cannot reuse: it deletes two objects at regional paths.
  - The steps: read the PN listing and the VPC listing (`/vpc/v2/regions/{region}/vpcs`, key `vpcs`) whole, both before any DELETE; match each exactly on `name`; then `DELETE /vpc/v2/regions/{region}/private-networks/{id}`, then `DELETE .../vpcs/{id}`, since a VPC holding a PN cannot go.
  - A partial PN or VPC listing throws `the Private Network listing could not be read whole (HTTP <status>)` (or `the VPC listing ...`, or `it stopped early` without a status) and deletes nothing. `deleteBackstopNetwork` then reports the network unverified, "could not confirm it is gone" (`destroy.js:4491-4497`). An `apiError` would have read as "delete refused (likely still has members)" (`:4480-4487`).
  - A 2xx or 404 is deleted. Any other answer to a DELETE is `apiError`, as in the base contract.
- `deleteReservedIpByAddress(address)` returns a `ReservedIpRelease`: a complete `listFlexibleIPsDetailed()` matched on `address`; none is `{ released: true }`; attached is `{ released: false, held: true, region: zone, reason: 'it is still attached to server <name>' }`, never deleted; otherwise `releaseFlexibleIP`, 2xx or 404 released, else `{ released: false, held: deleteRefused(status) ? true : null, region: zone, reason: deleteFailure('Scaleway', status) }`.
- `reservedIpLabelMatch(address, labels)` returns `{ found: false }` or `{ found: true, matches, tags: ip.tags, holder }`. `matches` needs both `encodeLabel('project', P)` and `encodeLabel('environment', E)` in the IP's tags and, when attached, in the holding server's tags (`getServer`); false for empty labels. `holder` is `server <name> (<id>)` when attached. A partial listing throws.
- `serverNetworkIds(server)` returns `(server.private_nics ?? []).map((n) => n.private_network_id)`.
- `volumeName` and `labelValue` keep the base: Scaleway volumes carry `name`, and `encodeLabel` leaves a `[a-z0-9-]` value as it is.
- `CSI_DRIVERS['csi.scaleway.com'] = { providerId: 'scaleway', regionKeys: ['topology.csi.scaleway.com/zone'], volumeId: (h) => <the uuid when h is <zone>/<uuid>, else null> }`.

- [ ] **Step 1: Write the failing tests.**
  - `scaleway-k8s-cleanup.test.ts` (stubbed fetch): each contract above; a partial PN listing, or a complete PN listing with a partial VPC listing, throws and sends no DELETE; the PN goes before the VPC; both listings carry `project_id`; a VPC named `default` is never matched. The foreign-IP cases: `an attached IP whose server lacks our tags is foreign and never deleted`, `an attached IP of ours is held, not deleted`, and `acme on stack prod-primary and acme-prod on environment primary never match each other`.
  - `k8s-backstop-targets` and `k8s-backstop-sweep`: Scaleway gets Vultr's target names; the security group, SSH key, flexible IP by address and network by name are each asked once, the network last; the "is set on" test names Scaleway.
  - `orphaned-volumes-cleanup-scaleway.test.ts`: a detached `pvc-<uuid>` volume whose id the capture listed is deleted; with no capture and an incomplete identity it is deferred `no-owner-signal`, never deleted; a hand-named `pvc-backups` is never matched.
  - `csi-volume-capture`: `scalewayPv('pvc-...', 'fr-par-1/<uuid>')` yields the uuid; `<uuid>` alone and `fr-par-1/x` yield null.
  - `csi-volumes-after-servers`: `['scaleway', 'Scaleway', true]`. `reserved-ip-label-backstop-wiring`: Scaleway's k8s rows. `destroy-field-accessors`: `serverNetworkIds reads private_nics[].private_network_id, [] when none`. `vpc-delete-partial-listing`: a Scaleway row, whose three cases (`:87-110`) expect the throw on a failed first page and on a failed later page, and the destroy report "could not confirm", never "already gone".
  - `sweep-scaleway.test.ts`: `sweeps a k8s cluster's leftovers by prefix`: servers `acme-s3-master`, `-db`, `-worker-1`, PN and VPC `acme-s3-network`, flexible IPs tagged `project:acme`, `environment:s3`, security group `acme-s3-firewall` and SSH key `acme-s3-fr-par-1-key` are each deleted; an unattached `pvc-<uuid>` volume is reported, not deleted. Update the transcript snapshot only for the new VPC listing line.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm test:unit tests/unit/providers/scaleway-k8s-cleanup.test.ts tests/unit/destroy/orphaned-volumes-cleanup-scaleway.test.ts tests/unit/destroy/k8s-backstop-sweep.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** No provider-id branch in destroy: the backstop gate keys on `K8S_DESTROY_BACKSTOP` and `savedReservedIpOwner` (`src/destroy.js:4030`) already asks `reservedIpLabelMatch`.
- [ ] **Step 4: Run the suites.** `pnpm test:unit && pnpm test:integration`. Expected: PASS. Then the verbose grep over `k8s-backstop-sweep`, `csi-volumes-after-servers` and `sweep-reserved-ip-coverage`.
- [ ] **Step 5: Commit.** Subject `feat(destroy): clean up Scaleway k8s leftovers`.

### Task 5: Autoscaled workers get the project id and join the Private Network

**Files:**
- Modify: `src/lib/providers/scaleway.js` `createServer` (`:876`): after the user-data PATCH and the flexible IP, before poweron, each `config.networks` entry is attached with `POST /instance/v1/zones/{zone}/servers/{id}/private_nics` `{ private_network_id }` (fact 10); a non-2xx deletes the half-made server with `await this.deleteServer(server.id).catch(() => {})`, which also releases its flexible IP (step 5), exactly as the IP-failure path does (`:960-963`), then throws with the status and the network id. The groups.js failure path only records `errorInfo` (`:290-305`), and the next refresh would count a labelled stopped server as running (`:553-576`). The doc comment drops "networks is a no-op". The create body still sends no hostname.
- Modify: `src/lib/providers/scaleway.js` `deleteServer` (`:1008`): step 4 deletes only `server.volumes['0']` when it is an `sbs_volume`
- Modify: `src/lib/providers/base.js` (`static k8sAutoscalerEnv()` returns `{}`; its doc says what the Decision says) and `src/lib/providers/scaleway.js` (`static k8sAutoscalerEnv()` returns `{ SCALEWAY_DEFAULT_PROJECT_ID: scalewayOperatorIds().projectId }`, Task 3's helper, so an unset id fails the deploy before any apply, in `buildIacEnv`'s words)
- Modify: `src/lib/deploy/k8s/autoscaler-secret.js`: `carbonAutoscalerSecretYaml({ token, configJson, env = {} })` writes each `env` entry as a `stringData` key under its own name, `JSON.stringify`'d as `token` is, after `config.json`
- Modify: `src/lib/deploy/k8s/k3s.js`, the autoscaler Secret apply (~4830-4875):
  - The Secret is written with `env: ProviderClass.k8sAutoscalerEnv()`.
  - `readSecretFingerprints` reads `keys: ['token', ...Object.keys(env)]`, and the reader restart (`findSecretReaders`) runs when `{ token: apiToken, ...env }` changed, since the pod reads its env only at start.
  - The token check still runs only when the token changed.
- Modify: `src/scale.js:2835`: the bounds re-patch passes the same `env: ProviderClass.k8sAutoscalerEnv()`. `repatchClusterAutoscaler` (`src/scale.js:2777`) has no provider in scope: add a `Provider` parameter and pass the caller's (`Provider` at `:2388`, the call at `:3045`). Both writers apply client-side (`k3s.js:4834-4836`), so an apply without the key would delete it.
- Modify: `carbon/k8s/base/cluster-autoscaler/deployment.yaml:93-100`: the carbon-autoscaler container's `env` gains `{ name: SCALEWAY_DEFAULT_PROJECT_ID, valueFrom: { secretKeyRef: { name: carbon-autoscaler-config, key: SCALEWAY_DEFAULT_PROJECT_ID, optional: true } } }` after `PROVIDER_API_TOKEN`. `optional`, so every other provider's pod starts without it. The census below holds the manifest to the provider table.
- Modify: `src/lib/images.js` (`CARBON_AUTOSCALER_TAG = '0.1.7'`, history line `0.1.7: Scaleway createServer attaches the cluster's Private Network before power-on and cleans up after a failed attach, and deleteServer keeps attached PVC volumes. Its pod now gets SCALEWAY_DEFAULT_PROJECT_ID from the carbon-autoscaler-config Secret.`)
- Modify: `tests/unit/autoscaler/image-ref.test.ts`, `tests/unit/autoscaler/manifest.test.ts` (`:189`, the sidecar env gains the entry), `tests/unit/deploy/autoscaler-secret.test.ts`, `tests/unit/deploy/host-reporter-census.test.ts`, `tests/unit/providers/scaleway.test.ts` (the billing-leak cases keep passing), `tests/unit/lib/operator-env-census.test.ts` if it flags the new container env name (its `PROVIDER_API_TOKEN` note at `:162-165` is the model)
- Create: `tests/unit/providers/scaleway-create-server.test.ts`, `tests/unit/autoscaler/autoscaler-env-census.test.ts`
- Modify (RC12, controller ruling): `src/autoscaler/groups.js` `_lookupFirewallId` throws on not-found and on a lookup error, naming the firewall; `_resolveFirewallId` drops a rejected lookup from `_firewallIdPromise`; `_createInBackground` records `errorInfo` `firewall-not-found` and never calls `createServer` without `firewalls`. Tests: `tests/unit/autoscaler/groups.test.ts` (Review Focus 6), with the stubs in `service-roundtrip.test.ts` and `healthcheck.test.ts` given a firewall.

**Interfaces:**
- Produces: `k8sAutoscalerEnv()` on every provider class; `carbonAutoscalerSecretYaml({ token, configJson, env })`.
- Consumes: `scalewayOperatorIds()` (Task 3); `serverNetworkIds` (Task 4); `src/autoscaler/groups.js` `createConfig` `{ name, serverType, region, image, userData, labels, sshKeys, networks: [networkId], firewalls }` and `_lookupNetworkId` (`listNetworks()` by `${clusterName}-network`), unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `scaleway-create-server.test.ts` (stubbed fetch, call order recorded): with `networks: ['pn-uuid']` and `firewalls: ['sg-uuid']`, the calls are server POST (with `security_group`), user-data PATCH, IP POST, `private_nics` POST with `{ private_network_id: 'pn-uuid' }`, then poweron. Without `networks`, no `private_nics` call. A 403 on `private_nics` rejects with a message naming `pn-uuid` and HTTP 403; no poweron is sent, and the server is terminated and its IP released. A 70-character `name` sends no `hostname` key.
  - The groups.js path end to end: a node group whose `listNetworks` returns `{ id: 'pn-uuid', name: 'acme-prod-network' }` attaches `pn-uuid`.
  - Review Focus 1, in `autoscaler-env-census.test.ts`, `an autoscaled Scaleway create runs with only the pod's env`:
    - Render the Secret with `carbonAutoscalerSecretYaml` and Scaleway's `k8sAutoscalerEnv()`.
    - Build the carbon-autoscaler container's env from `deployment.yaml`'s `env` entries, resolved against that Secret's `stringData`.
    - Delete every `SCALEWAY_*` and `SCW_*` from `process.env` (`vi.stubEnv(name, undefined)`), then set only that env.
    - Run `new ScalewayProvider(<PROVIDER_API_TOKEN>).createServer(...)` with a stubbed fetch. Its server POST carries `project: <the stubbed id>`.
    - With the entry removed from a copy of the manifest, it rejects with `SCALEWAY_DEFAULT_PROJECT_ID is not set`.
  - The same census, walking `PROVIDERS`: every key of each provider's `k8sAutoscalerEnv()` (companions stubbed) has exactly that `deployment.yaml` entry, `optional: true` included; every optional `carbon-autoscaler-config` entry in the manifest is some provider's key; the base returns `{}`.
  - `autoscaler-secret.test.ts`: the `env` keys are written, one line each, and with no `env` the YAML is byte-identical to today's. A test of the scale re-patch's call (`scale.js:2835`) passes `ProviderClass.k8sAutoscalerEnv()`.
  - Review Focus 2: `deleteServer deletes the root volume and never a pvc- volume still attached`: a server with `volumes: { '0': { id: 'root', volume_type: 'sbs_volume' }, '1': { id: 'pvc-vol', volume_type: 'sbs_volume', name: 'pvc-<uuid>' } }` gets one Block API DELETE, for `root`.
  - `image-ref.test.ts` expects `'0.1.7'`; host-reporter-census gains the Scaleway autoscaler row.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm test:unit tests/unit/providers/scaleway-create-server.test.ts tests/unit/autoscaler/autoscaler-env-census.test.ts tests/unit/autoscaler/manifest.test.ts tests/unit/deploy/autoscaler-secret.test.ts tests/unit/autoscaler/image-ref.test.ts tests/unit/providers/scaleway.test.ts`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the suite.** `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit.** Subject `feat(scaleway): autoscaled workers join the cluster Private Network`. The body says three things. `publish-images.yml` publishes `carbon-autoscaler:0.1.7` on the push to main. The pod now gets the project id from its Secret, without which no in-cluster create could succeed. And `deleteServer` now keeps every volume but the root, as the Pulumi provider's delete does.

### Task 6: Turn the tiers on

**Files:**
- Modify: `src/lib/providers/scaleway.js`: `SUPPORTED_TIERS = ['compose', 'compose-ha', 'k8s', 'k8s-ha']` (`:258`); `ROLE_CANDIDATES` (`:370`) gains the Sizes of Decisions; `FALLBACK_SERVER_TYPES` (`:344`) gains exactly `'DEV1-S': { vcpu: 2, ram: 2, disk: 20 }` and `'PLAY2-PICO': { vcpu: 1, ram: 2, disk: 40 }`, because `role-candidates-census` wants every `ROLE_CANDIDATES` entry in it (`:52`). The 2026-10-22 fixture has DEV1-S at 2 vCPU and 2 GiB, and PLAY2-PICO at 1 and 2 GiB, both x86_64 with `min_size` 0; `DEFAULT_K8S_NODE_TYPE` stays `'BASIC3-X2C-4G'`; stale "compose-only" comments go, here and at `src/lib/deploy/prompts.js:265` ("Scaleway: compose")
- Modify: `src/lib/scaleway-guided-setup.js:161` (the minimal permission list adds `PrivateNetworksFullAccess`, `VPCFullAccess` and `IPAMReadOnly`, with why: the cluster's Private Network and its addresses)
- Modify: `tests/_shared/k8s-built-ahead.ts` (`{}`); rewrite `k8s-built-ahead.test.ts` to `k8sCensusProviders(part) is the k8s sellers for every part`
- Modify: `tests/config.ts`: `providers.scaleway.scenarios` gains `{ mode: 'k8s', dnsProvider: 'scaleway', envPrefix: 's3' }` and `{ mode: 'k8s-ha', dnsProvider: 'scaleway', envPrefix: 's4' }`; `defaultSelection: ['compose', 'k8s', 'k8s-ha']`; `capacityPreferences.scaleway.scaleTo` becomes exactly `{ 'DEV1-M': 'DEV1-L', 'BASIC3-X2C-4G': 'BASIC3-X4C-8G', 'DEV1-S': 'DEV1-M' }`, today's two entries plus one. On the fixture the picker defaults compose, master and worker to DEV1-M (14.74, against PLAY2-NANO 20.10 and BASIC3-X2C-4G 28.80) and db to DEV1-S (6.55, against PLAY2-PICO 10.42) in all four zones, so `every type the picker defaults to ... has a ladder entry` (`default-sizes-unpinned-census.test.ts:136-153`) asks for DEV1-S alone. It passes `in the fallback catalog` (`:82-95`) once DEV1-S is there, and `a bigger server` with 4 GiB against 2. No PLAY2 entry is added, so PLAY2-MICRO stays out of the fallback catalog. If the picker chooses differently when the step runs, add exactly the entries the census names, each with its target in `FALLBACK_SERVER_TYPES`, and say so in the commit; fix the stale comments near `:233` and `:378`
- Modify: `tests/e2e/checks/deploy-budgets.json` with `addSeeds`, exactly as the Vultr plan's Task 6 runs it. Expected: only `scaleway/k8s/any` and `scaleway/k8s-ha/any`, each `samples: 0` with `seededFrom`.
- Modify: `carbon/src/client/components/sections/vendor-matrix.tsx` (Scaleway `k8s` and `k8s-ha` `'yes'`); README's perf table, regenerated as the Vultr plan's Task 6 does
- Modify: `docs/security.md`: Scaleway in the token rows and rotation steps, in the `kube-system/hcloud` retiring list the gitops census builds, and a sentence: "If your Scaleway policy limits `request.ip`, let in your cluster nodes' public addresses too: the CSI driver and the autoscaler call Scaleway's API from the nodes."
- Modify: `scripts/cost-grid.js`: `BILLING_EXTRAS.scaleway.volume = { perGbHour: 0.000118, gb: 11, hoursPerMonth: 730, source: 'https://www.scaleway.com/en/pricing/storage/', checked: <date read>, verified: false, note: 'the 10Gi db volume is 10.74 GB, billed as 11 if the API rounds up to whole GB; SBS 5K price, as the root volume' }`; the Scaleway branch of `extrasFor` adds it per cluster
- Modify tests: `supported-tiers.test.ts` (Scaleway accepts k8s and k8s-ha; the refusal case uses a stub class with `SUPPORTED_TIERS: ['compose']`, and its text is copied from what the code prints), `resolve-deploy-mode.test.ts` (Scaleway is offered the three shipping modes), `failover-mode-hint.test.ts` (Scaleway joins the providers with a failover mode; a stub class covers "no failover mode yet"), `scaleway-reference-scenarios.test.ts`, `selection-grammar.test.ts`, `deploy-budget.test.ts`, `prompt-provider-select.test.ts`, `region-for-tier.test.ts`, `standby-region-by-price.test.ts`, `cost-grid.test.ts`, and every `tests/unit/e2e` test that pins 13
- Create: `tests/unit/providers/scaleway-k8s-regions.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `scaleway-k8s-regions.test.ts` (RC8): `k8sRegionProblem` is null for every zone in `REGIONS`, and `assertRegionSupportedForTier(ScalewayProvider, tier, zone)` does not throw for `k8s` and `k8s-ha` in each.
  - `region-for-tier`: Scaleway's k8s list is all four zones. `standby-region-by-price`: `getDefaultStandbyRegion('fr-par-1', ['master', 'db', 'worker'])` is `nl-ams-1` on the fixture.
  - `scaleway-reference-scenarios`: s1 to s4 in order (s2 compose-ha stays registered), `defaultSelection` `['compose', 'k8s', 'k8s-ha']`, the exact scaleTo above. `selection-grammar`: `--provider scaleway` gives three and `--provider all` 15.
  - `deploy-budget`: `scaleway/k8s and scaleway/k8s-ha have a seeded budget until their first cold deploy passes`, as Vultr's.
  - `cost-grid`, on the 2026-10-22 fixture: `computeEnvMonthly(ScalewayProvider, 'k8s')` is `{ monthly: 58.27, locations: ['fr-par-1'] }` (DEV1-M 14.74308 twice, DEV1-S 6.55248, 3 x 3.65 IPv4, 3 x 3.4456 root, 0.000118 x 11 x 730 = 0.94754); `'k8s-ha'` is `{ monthly: 94.71, locations: ['fr-par-1', 'nl-ams-1'] }` (plus a standby DEV1-M and DEV1-S, two IPv4, two roots and its own volume). If the picker chooses other types, recompute with the same arithmetic and say so in the commit. The extras test names the volume's source, date and `verified: false`.
  - The guided-setup copy names the three permission sets.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm test:unit tests/unit/providers/scaleway-k8s-regions.test.ts tests/unit/providers/supported-tiers.test.ts tests/unit/e2e/scaleway-reference-scenarios.test.ts tests/unit/scripts/cost-grid.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Every census row moves to its new value, never loosened.
- [ ] **Step 4: Run the gate.** `pnpm lint && pnpm test:unit && pnpm test:integration`. Expected: PASS.
- [ ] **Step 5: Prove every registry census walks Scaleway.** Run the Vultr plan's Task 6 Step 5 loop with `grep -ci scaleway`, adding `tests/unit/deploy/gitops-provider-token.test.ts` and `tests/unit/providers/role-candidates-census.test.ts`. Expected: every count above 0.
- [ ] **Step 6: Commit.** Subject `feat(scaleway): k8s and k8s-ha modes`.

### Task 7: Docs

**Files:**
- Modify: `README.md` (Scaleway joins the fully supported sentence; its cost row, copied by hand from `node scripts/cost-grid.js` output, since `--write` without the other tokens would drop their rows; every line saying Scaleway runs compose only)
- Modify: `FEATURES.md` (the k8s refusal example: every provider now runs k8s, so the example and the lines after it say that)
- Modify: `carbon/README.md` (Scaleway row), `carbon/content/docs/deployment.mdx` (Scaleway modes `compose`, `k8s`, `k8s-ha`), `carbon/src/client/locales/en.json` (Scaleway runs all three)
- Check: `carbon/content/docs/cli.mdx:874-875` says compose scale is not available on Scaleway, but Scaleway compose scale shipped in #375. If `src/scale.js` has no Scaleway refusal, the sentence goes; Scaleway's k8s scale is the shared converge path either way.
- Modify: `docs/tests.md` (15 scenarios: compose, k8s and k8s-ha on all five providers), `.claude/skills/running-e2e-matrix/SKILL.md` (`--provider scaleway` runs three; `all` is 15; s1 to s4)

- [ ] **Step 1: Find every stale claim.** `grep -rn --exclude='.env*' -i -E "scaleway[^.]*(compose only|compose-only|only run|run compose|not built|aren't built|13 scenarios)|\b13\b[^.]*scenario" README.md FEATURES.md docs carbon/content carbon/README.md carbon/src/client .claude/skills`. Expected: the lines above, plus any it finds.
- [ ] **Step 2: Edit them.** Builder outcomes first, no em dashes, no "free" next to servers.
- [ ] **Step 3: Run the checks.** `pnpm lint && pnpm test:unit tests/unit/docs tests/unit/metrics tests/unit/scripts/cost-grid.test.ts`. Expected: PASS, the terminology census naming Scaleway. If the template build ran, `rm -rf carbon/dist`.
- [ ] **Step 4: Commit.** Subject `docs: Scaleway runs k8s and k8s-ha`.

## Rulings made during execution

Recorded while the plan ran (SDD ledger, 2026-11-26). RC1 to RC9 are in Global Constraints; these bound the tasks after them.

- **RC10.** The k8s-ha replication rule (UDP 51821 from the peer database node) is declared inline by every inline-rule program, fed by `replicationPeerIpFor(envConfig, stackName)`, so a scale or failover up never drops it. It shipped first as its own PR (#594, docs/plans/2026-11-26-ha-replication-rule.md); Scaleway's program declares it from Task 2, after 80/443 and before the operator rules, the order `applyOperatorCidrs` and `buildReplicationFirewallRules` write.
- **RC11.** The pre-flight review's findings were folded into the plan before Task 1: `deleteNetworkByName` throws on a partial listing, the autoscaler gets `SCALEWAY_DEFAULT_PROJECT_ID` through its Secret and pod env, one `envFrom` reference, the census staging table, `cidrContainsIp(…, 4)` in cidr.js, the resolved sizes and the confirmed NIC hot-plug.
- **RC12.** The autoscaler's firewall lookup fails closed on every provider: not-found and errors refuse the create with `errorInfo`, and a failed lookup is never cached. An autoscaled node with no firewall exposes kubelet and flannel; refusing a scale-up is the safe failure.
- **RC13.** Scaleway's API returns rules in its own row form (six `editable: false` outbound SMTP drops first, bare host ranges, a null `dest_port_to` for one port). `canonicalScalewayRule` and `canonicalIpRange` normalise every comparison read, and `setFirewallRules` omits the editable:false rows and numbers positions 1 to n.
- **RC14.** Boot fails closed: the Private Network NIC is found by MAC prefix `02:00:00` and waited for 180 s; a missing NIC, an empty address, a NIC that carries the default route, or a private address equal to the public one is FATAL. `enableDefaultRoutePropagation: false` is pinned on the Private Network.
- **RC15.** Destroy deletes by exact identity: both network listings are read whole (scoped by project) before any delete, only objects tagged with our project and environment are deleted, a same-name untagged object is recorded as foreign, and a flexible IP whose holder is foreign is left alone (an unreadable holder is reported unverified).
- **RC16.** An autoscaled worker attaches the Private Network before poweron; any failure after the server POST deletes the half-made server and names the step; `deleteServer` deletes only the root volume, so PVC data survives a scale-down; destroy also releases unattached flexible IPs tagged with the cluster and environment.
- **RC17.** A Scaleway k8s deploy or scale reads `k8sAutoscalerEnv()` before anything changes, so a missing project id refuses up front instead of leaving a Secret without the key.
- **RC18.** Refusal tests that relied on Scaleway being compose-only now use stub providers, and the compose-only sizing fallback keeps a stub-driven test, since the code path stays.
- **RC19.** Every Scaleway listing stays inside `SCALEWAY_DEFAULT_PROJECT_ID`: the Instance API walks (servers, flexible IPs, security groups) and the Block API walk send the `project` query and also keep only rows of that project, so an organization-wide key never lets a sweep, the autoscaler or `access` act on another project's same-named resources. Project ids compare without case. `deleteServer` terminates only a server it read in the configured project; a read that fails is refused, never guessed. The e2e orphan sweep scopes its own walks the same way and deletes security groups by the id it listed. Two same-named security groups in one project are refused rather than guessed between. The plan scoped the VPC API in Task 4 and missed the Instance API; the final review caught it.
- **RC20.** Review minors are taken or parked by name. Parked as cross-provider follow-ups: a refused security-group or SSH-key delete reads as gone in destroy (Scaleway, DigitalOcean, Linode, Vultr); shared boot-script includes across providers; `cleanupAutoscalerWorkers` matching the cluster network by name alone.

## Out of scope

- **Real-server runs and any release.** After Parts A, B and C have merged: Brandon's ghcr check, the A3 proof run, then `e2e-us-perf.yml` for all 15 default scenarios. Scaleway runs from GitHub (the fr-par route from the home network drops). The first green runs replace the seeded budgets through the calibration rule and the bot perf PR.
- **New ghcr packages**, mirroring the driver container, and the snapshotter and snapshot controller.
- **After real-server proof:** this plan's decisions go into `docs/history.md` and the file is deleted.

## Open risks

- **The k8s-ha replication rule after a scale or failover** is RC10's (`docs/plans/2026-11-26-ha-replication-rule.md`), not an open risk here: Scaleway's program declares the rule from Task 2 on, and the round-trip census walks it. The first s4 run should still show no security-group change in the per-resource markers after its scale step, as RC10's out-of-scope note asks of every provider.
- **NIC timing.** The boot waits 180 s for the hot-plugged NIC and its DHCP address (facts 1 and 2). A slower attach fails the boot loudly with the FATAL line.
- **IPAM read.** If `privateIps` is empty at create (timing or a missing `IPAMReadOnly`), the deploy stops with the program's message instead of booting nodes that cannot join.
- **Volume sizes.** Whether the Block API accepts a 5,368,709,120-byte (5Gi) request or wants whole GB is unconfirmed (fact 7). If it refuses, a Gi-to-GB rounding member beside `K8S_MIN_VOLUME_GI` is the fix; the first db PVC is the probe.
- **CSI from the pod network.** The node plugin reads `169.254.42.42` without hostNetwork; the first run proves the route.
- **Quotas.** A cluster holds one flexible IP per node, plus one per autoscaled worker; s3 and s4 together hold 10 of the 20 a payment-validated account gets (scaleway-facts section 10). 500 security group rules per Organization (fact 4).
- **Docker Hub pulls** of `scaleway/scaleway-csi` (`IfNotPresent`).
- **Version channel.** scaleway-csi's Kubernetes minor (36) is behind k3s (37), as Vultr's is; the channel already holds k3s patches for Linode's driver.
- **User-data size** is undocumented; the scripts stay under the repo caps.
