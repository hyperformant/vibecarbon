/**
 * Pulumi program for a single DigitalOcean k3s cluster (M3 — reference
 * provider full-stack proof).
 *
 * Mirrors hetzner-k8s.js's structure: one call to
 * `buildDigitalOceanK8sProgram(config)` returns a Pulumi inline program (a
 * function) that declares the cloud resources; the Automation API wrapper
 * in `../index.js` runs it. Diverges from the Hetzner program in exactly
 * the ways DigitalOcean's platform differs (see the dossier at
 * `.superpowers/sdd/m3-dossier-do-k8s.md`):
 *
 *   - A `digitalocean.Vpc` has no separate subnet/zone concept (one flat
 *     region-scoped network) and no static per-server IP assignment — the
 *     master/supabase/worker droplets' private IPs are only known AFTER
 *     Pulumi creates them, not pinned at declare time like Hetzner's
 *     `10.0.1.1`/`10.0.1.2`/`10.0.1.10+`.
 *   - `digitalocean.Firewall` attaches by TAG (not by droplet id list),
 *     scoped to the cluster via a single `cluster:<name>` tag every
 *     droplet below also carries. DO's firewall-create API 422s unless
 *     every tag it references already exists (verified against the
 *     DigitalOcean OpenAPI spec: `firewall.yml`'s `tags` field composes the
 *     shared `existing_tags_array.yml` schema — "Tag names must exist in
 *     order to be referenced in a request" — whereas `droplet_create.yml`'s
 *     `tags` field uses its own schema: "Tag names can either be existing
 *     or new tags," i.e. droplet creation auto-creates a missing tag).
 *     `Vpc`/`ReservedIp`/`ReservedIpAssignment`/`SshKey` have no `tags`
 *     input in `@pulumi/digitalocean` at all, so `Firewall` is the ONLY
 *     resource here needing a pre-created `digitalocean.Tag` (M3 Task 9b) —
 *     see the `tag`/`firewall` declarations below for the dependsOn chain.
 *   - `digitalocean.ReservedIp` + `ReservedIpAssignment` replace Hetzner's
 *     `FloatingIp` + `FloatingIpAssignment` (DO renamed the concept; API
 *     shape differs, same purpose — stable ingress).
 *   - No `PlacementGroup` equivalent — DO has no droplet spread/
 *     anti-affinity primitive (M3 dossier §8-repo). Workers are NOT spread
 *     across failure domains the way Hetzner's workers are.
 *   - User-data is rendered via the provider's own
 *     `DigitalOceanProvider.getK8s{Master,Supabase,Worker}UserData`
 *     statics (M3 Tasks 3 + 5) rather than this program calling
 *     loadCloudInit/renderScript directly — unlike hetzner-k8s.js, which
 *     predates those statics and was deliberately left on its own direct
 *     call site (Task 3 report) to avoid touching the frozen Hetzner
 *     render path mid-refactor. This program is new, so it wires straight
 *     through the statics from the start.
 *   - Every rendered user-data string is run through
 *     `transliterateToAscii` (from `./digitalocean-compose.js`) before
 *     being handed to a Droplet's `userData` — DO's user-data delivery
 *     pipeline double-encodes non-ASCII bytes into invalid YAML (RCA in
 *     digitalocean-compose.js). The three templates are pure ASCII today
 *     (pinned by tests/unit/providers/digitalocean-k8s-user-data.test.ts),
 *     so this is a defensive no-op today, not a currently-load-bearing
 *     transform — but it's the wire contract for ANY DO user-data, so it
 *     is applied unconditionally rather than only when a non-ASCII byte
 *     happens to be present.
 *
 * Resources declared:
 *   - SshKey (optional — reuse existing by ID for HA)
 *   - Vpc
 *   - Tag (pre-created `cluster:<name>` tag — see Task 9b note below)
 *   - Firewall (tag-attached)
 *   - ReservedIp + ReservedIpAssignment (to master)
 *   - Master droplet (cloud-init: do-master-init.sh via the provider static)
 *   - Supabase droplet (cloud-init: do-supabase-init.sh via the provider static)
 *   - Worker droplets × N (cloud-init: do-worker-init.sh via the provider static)
 *
 * Outputs: masterIp, masterPrivateIp, supabaseIp, supabasePrivateIp,
 * workerIps, floatingIp, networkId, sshKeyId, k3sToken, clusterName — the
 * SAME key set hetzner-k8s.js exports (wire contract; renderCarbonAutoscaler-
 * Config and deployK3s read these generically through `infraOutputs`
 * regardless of provider). masterPrivateIp/supabasePrivateIp are REAL
 * Pulumi-assigned addresses here (not hardcoded literals — DO has no
 * static-IP assignment to pin them to, unlike Hetzner's byte-identical
 * `10.0.1.1`/`10.0.1.2`). PLUS one DO-only additive key (M3 Task 9c):
 * vpcCidr — the Vpc's actual `ipRange` (config.vpcIpRange, or this
 * function's own default when omitted), threaded to applyK3sManifests so
 * DO deploys can extend the S3-purposed NetworkPolicy egress rules with an
 * allowance for the cluster's own VPC (see DigitalOceanProvider.
 * getS3EgressExtraCidrs). Hetzner's program does not return this key at
 * all — its S3 endpoints resolve to public IPs and never need it.
 */

import { randomBytes } from 'node:crypto';
import * as digitalocean from '@pulumi/digitalocean';
import * as pulumi from '@pulumi/pulumi';
import { DigitalOceanProvider, encodeLabels } from '../../providers/digitalocean.js';
import { transliterateToAscii } from './digitalocean-compose.js';

/**
 * @typedef {Object} K8sStackConfig
 * @property {string} projectName
 * @property {string} environment      Environment name (used for cluster name + tags)
 * @property {string} sshPublicKey     OpenSSH-format public key
 * @property {string} [existingSshKeyId]  If set, skip creating a new SSH key
 *                                        (HA case: shared key across clusters)
 * @property {string} [k3sToken]          Pre-shared k3s node-join token
 *                                        (auto-generated if omitted)
 * @property {string} location         DigitalOcean region slug (e.g. nyc3).
 *                                      Unlike Hetzner, DO VPCs are single-
 *                                      region — there is no separate
 *                                      network-zone concept to derive.
 * @property {string} masterServerType
 * @property {string} supabaseServerType
 * @property {string} workerServerType
 * @property {number} minWorkers   Static floor of worker droplets (provisioned by Pulumi). Default 1.
 * @property {number} maxWorkers   Upper bound for cluster-autoscaler. Not consumed by Pulumi; flows to the CA Deployment in applyK3sManifests. Default 3.
 * @property {string} k3sVersion
 * @property {string} [vpcIpRange]  Default '10.10.0.0/20' — deliberately NOT
 *                                  Hetzner's '10.0.0.0/8': DO's Vpc.ipRange
 *                                  must be between /16 and /24 (DO API
 *                                  constraint), and a region-scoped VPC has
 *                                  no need for an /8-sized range in the
 *                                  first place.
 * @property {string} [image]      Base droplet image slug. Defaults to
 *                                  `DigitalOceanProvider.K8S_IMAGE` — kept as
 *                                  a config field (not a re-typed literal)
 *                                  so callers can override it, but the
 *                                  default is sourced from the SAME static
 *                                  `renderCarbonAutoscalerConfig` reads for
 *                                  CA-spawned workers, so the two can never
 *                                  drift apart.
 * @property {Record<string,string>} [labels]  Flat key/value pairs, encoded
 *                                  into DO tags via `encodeLabels` (colon-
 *                                  joined, `/` → `-`; see digitalocean.js).
 * @property {string[]} [allowedSshIps]       CIDR list, REQUIRED (no default — H-2 guard)
 * @property {string[]} [allowedK8sApiIps]    CIDR list, REQUIRED (no default — H-2 guard;
 *                                             public 6443 is operator-only)
 * @property {string} apiToken         DigitalOcean API token. Baked into the
 *                                     master cloud-init as `do_token` so the
 *                                     node can write the single `digitalocean`
 *                                     kube-system Secret that the DO CCM and
 *                                     CSI driver both read on boot.
 */

/**
 * Build an inline Pulumi program for the given cluster config.
 * @param {K8sStackConfig} config
 * @returns {() => Promise<Record<string, unknown>>}
 */
export function buildDigitalOceanK8sProgram(config) {
  const clusterName = `${config.projectName}-${config.environment}`;
  const labels = {
    project: config.projectName,
    environment: config.environment,
    ...(config.labels ?? {}),
  };
  // Operator-IP firewall lock (H-2) — byte-parity with hetzner-k8s.js and
  // digitalocean-compose.js's identical guard. An empty list = nothing can
  // SSH in or hit the k8s API; refuse to build a program that would do
  // that rather than silently apply an open `0.0.0.0/0`.
  if (!config.allowedSshIps?.length) {
    throw new Error(
      'allowedSshIps required (no default; pass operatorCidrs from .vibecarbon.json or set ALLOWED_SSH_IPS=...)',
    );
  }
  if (!config.allowedK8sApiIps?.length) {
    throw new Error(
      'allowedK8sApiIps required (no default; pass operatorCidrs from .vibecarbon.json or set ALLOWED_SSH_IPS=...)',
    );
  }
  const allowedSshIps = config.allowedSshIps;
  const allowedK8sApiIps = config.allowedK8sApiIps;
  const k3sToken = config.k3sToken ?? randomBytes(32).toString('hex');
  const vpcIpRange = config.vpcIpRange ?? '10.10.0.0/20';
  const image = config.image ?? DigitalOceanProvider.K8S_IMAGE;
  const minWorkers = config.minWorkers ?? 1;
  const clusterTag = `cluster:${clusterName}`;

  return async () => {
    // SSH key — either reuse an existing one (HA shared key) or create.
    // DO SshKey has no tags/labels input (untaggable resource — mirrors
    // digitalocean-compose.js's identical comment).
    let sshKeyId; // frozen-contract shape: string | Output<string>
    let sshKeyIdForDroplet; // Droplet.sshKeys wants Input<string>[] too
    if (config.existingSshKeyId) {
      sshKeyId = config.existingSshKeyId;
      sshKeyIdForDroplet = config.existingSshKeyId;
    } else {
      const sshKey = new digitalocean.SshKey('ssh-key', {
        name: `${clusterName}-${config.location}-key`,
        publicKey: config.sshPublicKey,
      });
      sshKeyId = sshKey.id;
      sshKeyIdForDroplet = sshKey.id;
    }

    // Private network. DO VPCs are region-scoped with no separate
    // subnet/zone object (contrast hetzner-k8s.js's Network+NetworkSubnet
    // pair) and assign member droplets' private IPs dynamically — there is
    // no static-IP `networks: [{ip}]` equivalent to pin master/supabase/
    // worker addresses at declare time.
    const network = new digitalocean.Vpc('network', {
      name: `${clusterName}-network`,
      region: config.location,
      ipRange: vpcIpRange,
    });

    // Pre-create the cluster tag (M3 Task 9b) — the firewall below
    // references `clusterTag` by name, and DO's firewall-create API 422s
    // ("tag ... does not exist") unless that tag already exists as a real
    // Tag resource; droplets don't have this requirement (DO auto-creates
    // any droplet tag that's new — see the module doc's Firewall bullet for
    // the verified source). Named off the SAME `clusterTag` const every
    // droplet below also carries — never a hand-copied literal.
    const tag = new digitalocean.Tag('cluster-tag', { name: clusterTag });

    // Firewall — attached by TAG (every droplet below carries `clusterTag`),
    // not by droplet-id list. DO firewalls have no droplet-count cap this
    // way (contrast the id-list form's max-10 limit). Captured in a
    // variable (M3 Task 5b) so every droplet below can `dependsOn` it —
    // tag-based attachment means a droplet created BEFORE the firewall
    // exists sits default-OPEN until the firewall catches up; explicit
    // ordering closes that window.
    const firewall = new digitalocean.Firewall(
      'firewall',
      {
        name: `${clusterName}-firewall`,
        tags: [clusterTag],
        inboundRules: [
          { protocol: 'tcp', portRange: '22', sourceAddresses: allowedSshIps },
          { protocol: 'tcp', portRange: '80', sourceAddresses: ['0.0.0.0/0', '::/0'] },
          { protocol: 'tcp', portRange: '443', sourceAddresses: ['0.0.0.0/0', '::/0'] },
          { protocol: 'tcp', portRange: '6443', sourceAddresses: allowedK8sApiIps },
          // Internal cluster traffic (flannel vxlan 8472/udp, kubelet 10250,
          // the app registry mirror on 5000, etc.) — scoped to the VPC CIDR,
          // not 0.0.0.0/0, mirroring hetzner-k8s.js's private-network-range
          // internal rules.
          { protocol: 'tcp', portRange: '1-65535', sourceAddresses: [vpcIpRange] },
          { protocol: 'udp', portRange: '1-65535', sourceAddresses: [vpcIpRange] },
          { protocol: 'icmp', sourceAddresses: [vpcIpRange] },
        ],
        outboundRules: [
          { protocol: 'tcp', portRange: '1-65535', destinationAddresses: ['0.0.0.0/0', '::/0'] },
          { protocol: 'udp', portRange: '1-65535', destinationAddresses: ['0.0.0.0/0', '::/0'] },
          { protocol: 'icmp', destinationAddresses: ['0.0.0.0/0', '::/0'] },
        ],
      },
      // dependsOn the pre-created Tag (M3 Task 9b) — closes the ordering
      // window that caused the 422: `tags: [clusterTag]` above is the same
      // string, byte-for-byte, `tag` was created with; this just tells
      // Pulumi the Tag resource must land first.
      { dependsOn: [tag] },
    );

    // Master droplet. Cloud-init derives its own public/private IPs and
    // droplet id from DigitalOcean's metadata service AT BOOT (see
    // do-master-init.sh), so unlike hetzner-k8s.js's master render (which
    // needs the floating IP + network id as template vars), the master
    // user-data here needs neither its own private IP (unknowable
    // pre-create) nor the Reserved IP (assigned to the master AFTER it
    // already exists, below) — its var set is exactly
    // {k3s_version, k3s_token, do_token}.
    const masterUserDataRaw = await DigitalOceanProvider.getK8sMasterUserData({
      k3s_version: config.k3sVersion,
      k3s_token: k3sToken,
      do_token: config.apiToken ?? '',
    });
    const master = new digitalocean.Droplet(
      'master',
      {
        name: `${clusterName}-master`,
        region: config.location,
        size: config.masterServerType,
        image,
        vpcUuid: network.id,
        sshKeys: [sshKeyIdForDroplet],
        tags: encodeLabels({ ...labels, role: 'master', cluster: clusterName }),
        userData: transliterateToAscii(masterUserDataRaw),
      },
      // dependsOn firewall (M3 Task 5b): DO firewalls attach by tag, not by
      // droplet-id list — a droplet created before the firewall resource
      // exists sits default-OPEN until Pulumi later reconciles it. Ordering
      // closes that window. Supabase/workers below also depend on firewall
      // explicitly, rather than relying on their (also-present) dependsOn
      // master to carry it transitively.
      { dependsOn: [firewall] },
    );

    // Reserved IP (stable ingress) + assignment to master. Created after
    // the master (needs its droplet id) — unlike hetzner-k8s.js's floating
    // IP, which is created BEFORE the master so its address can be baked
    // into the master's cloud-init as a --tls-san entry. do-master-init.sh
    // deliberately has no such entry (see its own comment): DO's Reserved
    // IP uses a provider-managed anchor mechanism, terminates at traefik
    // on 80/443, and never touches the k8s API port — so the API server's
    // certificate never needs to cover it, and there is no ordering
    // constraint forcing this resource before the master.
    //
    // KNOWN GAP (investigated 2026-07-30, deliberately NOT fixed here): on DO
    // k8s destroys the reserved IP survives `pulumi destroy` and is only
    // removed by destroy.js's name/address backstop
    // (provider.deleteReservedIpByAddress — which does clean the cloud). Read
    // against terraform-provider-digitalocean (the provider
    // @pulumi/digitalocean 4.76 bridges), two upstream landmines sit on this
    // exact topology, and BOTH are silent:
    //
    //   1. `digitalocean_reserved_ip`'s Delete only performs the Unassign
    //      action when `droplet_id` is set in ITS OWN state
    //      (digitalocean/reservedip/resource_reserved_ip.go — `if _, ok :=
    //      d.GetOk("droplet_id"); ok { ...Unassign... }` guarding the final
    //      `ReservedIPs.Delete`). We assign via the separate
    //      ReservedIpAssignment below, so `droplet_id` is never on THIS
    //      resource — every correctness guarantee therefore rests on the
    //      sibling assignment still being in state at destroy time.
    //   2. `digitalocean_reserved_ip_assignment`'s Read DELETES ITSELF FROM
    //      STATE (`d.SetId("")`) whenever the API reports the IP as not
    //      assigned to that exact droplet id
    //      (resource_reserved_ip_assignment.go — `if reservedIP.Droplet == nil
    //      || reservedIP.Droplet.ID != dropletID`). destroyStack runs
    //      `stack.refresh()` before every destroy (src/lib/iac/index.js), so a
    //      single such Read — DO's assign/unassign are async actions, and the
    //      IP is briefly unassigned around any droplet replacement — silently
    //      removes the only resource that would have unassigned. Its Delete
    //      also dereferences `reservedIP.Droplet.ID` with no nil guard, i.e. a
    //      provider panic on an already-unassigned IP (same shape as the
    //      hcloud Firewall-delete nil-deref upStack already works around).
    //
    // The clean fix is to drop ReservedIpAssignment and set `dropletId`
    // directly on the ReservedIp (the provider's own docs say the two
    // mechanisms exist and "cannot be used together"), which restores the
    // unassign-then-delete path and removes the panic-prone resource. It is
    // NOT applied because migrating an EXISTING stack makes Pulumi delete the
    // assignment and then update the ReservedIp to add `droplet_id`, which
    // calls `ReservedIPActions.Assign` on an IP already assigned to that same
    // droplet — a 422 that would wedge deploy/destroy on any live DO env until
    // the stack is recreated. Not cheap, not safe: the backstop stays the
    // mechanism, and this comment is the map for whoever revisits it.
    const reservedIp = new digitalocean.ReservedIp('ingress', {
      region: config.location,
    });
    new digitalocean.ReservedIpAssignment('ingress-assignment', {
      ipAddress: reservedIp.ipAddress,
      dropletId: master.id.apply((id) => Number.parseInt(id, 10)),
    });

    // Supabase droplet — joins master via k3s agent, pinned to the
    // dedicated Supabase node-pool (label + NoSchedule taint baked into
    // do-supabase-init.sh's k3s agent argv). master_ip MUST be the
    // master's REAL private IP, only known once Pulumi has created it —
    // unlike Hetzner's hardcoded '10.0.1.1', DO has no static-IP
    // assignment to pin this to ahead of time (M3 dossier §4-repo).
    const supabaseUserData = pulumi.all([master.ipv4AddressPrivate]).apply(([masterPrivateIp]) =>
      DigitalOceanProvider.getK8sSupabaseUserData({
        k3s_version: config.k3sVersion,
        k3s_token: k3sToken,
        master_ip: masterPrivateIp,
      }).then(transliterateToAscii),
    );
    const supabase = new digitalocean.Droplet(
      'supabase',
      {
        name: `${clusterName}-supabase`,
        region: config.location,
        size: config.supabaseServerType,
        image,
        vpcUuid: network.id,
        sshKeys: [sshKeyIdForDroplet],
        tags: encodeLabels({
          ...labels,
          role: 'supabase',
          'node-pool': 'supabase-pool',
          cluster: clusterName,
        }),
        userData: supabaseUserData,
      },
      // dependsOn firewall explicitly (M3 Task 5b), not just transitively
      // through master — see master's own dependsOn comment.
      { dependsOn: [master, firewall] },
    );

    // Workers. NO PlacementGroup here — DO has no droplet spread/anti-
    // affinity primitive (hcloud.PlacementGroup's DO equivalent simply
    // doesn't exist; M3 dossier §8-repo). Every worker shares the SAME
    // rendered user-data (all join the same master over the same private
    // IP), so it's computed once outside the loop, mirroring
    // hetzner-k8s.js's workerUserData reuse.
    const workerUserData = pulumi.all([master.ipv4AddressPrivate]).apply(([masterPrivateIp]) =>
      DigitalOceanProvider.getK8sWorkerUserData({
        k3s_version: config.k3sVersion,
        k3s_token: k3sToken,
        master_ip: masterPrivateIp,
      }).then(transliterateToAscii),
    );
    const workers = [];
    for (let i = 0; i < minWorkers; i++) {
      workers.push(
        new digitalocean.Droplet(
          `worker-${i + 1}`,
          {
            name: `${clusterName}-worker-${i + 1}`,
            region: config.location,
            size: config.workerServerType,
            image,
            vpcUuid: network.id,
            sshKeys: [sshKeyIdForDroplet],
            // 'cluster-autoscaler/node': 'static' encodes to
            // 'cluster-autoscaler-node:static' (Task 1 canonical tag
            // contract) — distinguishes Pulumi-static workers from
            // CA-spawned ones, which the destroy sweep relies on.
            tags: encodeLabels({
              ...labels,
              role: 'worker',
              'node-pool': 'worker-pool',
              'cluster-autoscaler/node': 'static',
              cluster: clusterName,
            }),
            userData: workerUserData,
          },
          // dependsOn firewall explicitly (M3 Task 5b), not just
          // transitively through master — see master's own dependsOn
          // comment.
          { dependsOn: [master, firewall] },
        ),
      );
    }

    return {
      masterIp: master.ipv4Address,
      // REAL output (not hardcoded) — see module doc + Task 2's Hetzner
      // byte-identical contrast.
      masterPrivateIp: master.ipv4AddressPrivate,
      supabaseIp: supabase.ipv4Address,
      supabasePrivateIp: supabase.ipv4AddressPrivate,
      workerIps: workers.map((w) => w.ipv4Address),
      floatingIp: reservedIp.ipAddress,
      networkId: network.id,
      sshKeyId: typeof sshKeyId === 'string' ? sshKeyId : sshKeyId.apply((id) => String(id)),
      k3sToken,
      clusterName,
      // M3 Task 9c: the Vpc's actual ipRange (a plain string — Vpc.ipRange
      // is an input we set, not a Pulumi-computed Output, so no .apply()
      // needed). DO-only additive output key; see the module doc above.
      vpcCidr: vpcIpRange,
    };
  };
}
