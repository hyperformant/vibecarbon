#!/bin/bash
set -euo pipefail

# Boot timing marks, read by src/lib/deploy/boot-timing.js
_m(){ echo "$1 $(date +%s.%N)">>/var/log/vcboot||true;}
_m p

# Note: This script runs AS PART of cloud-init (user_data), so we cannot wait for
# cloud-init to complete (that would cause a deadlock). The script starts immediately.

# sshd concurrency headroom - same rationale as docker-ce-setup.yaml's
# 99-vibecarbon-concurrency.conf: the deploy fans concurrent ssh (builds,
# tunnels, probes) past Ubuntu's MaxStartups 10:30:100 default, which drops
# connections at the door (kex_exchange_identification reset; 2026-08-23).
mkdir -p /etc/ssh/sshd_config.d
printf 'MaxStartups 100:30:200\nMaxSessions 64\n' > /etc/ssh/sshd_config.d/99-vibecarbon-concurrency.conf
systemctl reload ssh || systemctl reload sshd || true

_m n

# Validate k3s version is set
K3S_TARGET_VERSION="${k3s_version}"
if [ -z "$K3S_TARGET_VERSION" ]; then
  echo "ERROR: k3s_version not set"
  exit 1
fi
echo "Installing k3s version: $K3S_TARGET_VERSION"

# Node identity via DigitalOcean's metadata service (169.254.169.254,
# path root /metadata/v1/ -- see master-init.sh for the equivalent
# provider's differently-shaped metadata endpoint). The VPC private IP
# does not need interface-name discovery here: DigitalOcean's config-drive
# cloud-init datasource applies the VPC network config during first boot,
# so eth1 is already present and addressed by the time this script runs
# (M3 dossier SS3/SS4) -- contrast master-init.sh's private-NIC-name grep
# plus lease-trigger workaround, needed there because that provider
# attaches the private network AFTER boot. Still bound the retry and FATAL on empty
# metadata: never install k3s with an empty --node-ip (see
# master-init.sh's RCA comment -- the failure mode it describes is
# provider-agnostic, only the metadata source differs here).
fetch_metadata() {
  local path="$1"
  local val=""
  for i in $(seq 1 15); do
    val=$(curl -sf --max-time 5 "http://169.254.169.254/metadata/v1/$path" || true)
    if [ -n "$val" ]; then
      break
    fi
    sleep 2
  done
  echo "$val"
}

PUBLIC_IP=$(fetch_metadata "interfaces/public/0/ipv4/address")
if ! echo "$PUBLIC_IP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "FATAL: could not determine public IPv4 from DigitalOcean metadata; refusing to install k3s with an empty node-external-ip"
  exit 1
fi
echo "Public IP: $PUBLIC_IP"

PRIVATE_IP=$(fetch_metadata "interfaces/private/0/ipv4/address")
if ! echo "$PRIVATE_IP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "FATAL: could not determine private VPC IPv4 from DigitalOcean metadata; refusing to install k3s with an empty node-ip"
  exit 1
fi
echo "Private IP: $PRIVATE_IP"

DROPLET_ID=$(fetch_metadata "id")
if ! echo "$DROPLET_ID" | grep -qE '^[0-9]+$'; then
  echo "FATAL: could not determine droplet id from DigitalOcean metadata; refusing to install k3s without a provider-id"
  exit 1
fi
echo "Droplet ID: $DROPLET_ID"

# @include _container-signals.sh

# Configure containerd to mirror pulls for the local registry running on
# THIS master, to this master's OWN private IP. Cluster-autoscaler-spawned
# workers pull the app image from here on-demand (sideload only reaches
# workers that exist at sideload time). k3s only reads
# /etc/rancher/k3s/registries.yaml on agent start, so this MUST land
# before the k3s install step below.
#
# master-init.sh's compute-provider equivalent can hardcode this mirror to
# a template-supplied static private IP, because that provider's IaC
# program pins every master's private IP at create time. DigitalOcean's
# VPC has no equivalent static-IP assignment -- this master doesn't know
# its own private IP until the metadata fetch above resolves it at boot --
# so this block runs AFTER that fetch and mirrors to the runtime
# $PRIVATE_IP instead of a template var.
#
# Plain http://$PRIVATE_IP:5000 -- the registry runs HTTP on the private
# network. Do NOT add `insecure_skip_verify: true` here: that flag only
# affects HTTPS endpoints, and recent k3s versions place it incorrectly
# when present (k3s-io/k3s#13215), which can break containerd config
# generation.
mkdir -p /etc/rancher/k3s
cat > /etc/rancher/k3s/registries.yaml << REGEOF
mirrors:
  "$PRIVATE_IP:5000":
    endpoint:
      - "http://$PRIVATE_IP:5000"
# @include _k3s-system-image-mirror.yaml
REGEOF

# Install the k3s master.
# The k3s token joins agents only: --agent-token, and no --token. It sits in
# every node's user data and in the stack's state, so it must not be the
# server token, which lets a machine join as another server and read the
# datastore, CA keys included. k3s makes that one itself, at random, on this
# box, and no second server ever joins
# (tests/integration/docker/k3s-agent-token.test.ts).
# --node-ip is this node's PRIVATE (VPC) IP and --node-external-ip is its
# PUBLIC IP. The DigitalOcean Cloud Controller Manager discovers/matches
# nodes by provider-id (pre-seeded below via --kubelet-arg=provider-id),
# not by --node-ip, so there is none of master-init.sh's public-vs-private
# --node-ip tension (that constraint is about a firewall admitting the
# other provider's CCM to reach the node over its public IP; this
# provider's CCM never dials the node over --node-ip at all).
# --advertise-address is the PRIVATE IP: it's what every pod's 10.43.0.1
# Endpoints DNATs to, and what agents dial for the apiserver<->kubelet
# reverse tunnel.
# --tls-san covers the public and private IPs only. The cluster has no
# other ingress address: its domain points at this droplet's own public IP
# (digitalocean-k8s.js), and that traffic terminates at traefik on 80/443,
# never on the k8s API port.
# --kubelet-arg=provider-id pre-seeds the CCM's node<->droplet match
# (removes any name-matching fragility for autoscaler-spawned workers).
# --disable-cloud-controller + --kubelet-arg=cloud-provider=external
# disable k3s's own built-in dummy cloud controller so it doesn't fight
# the DigitalOcean CCM installed below.
# --disable=servicelb: ingress is routed by us, and we never create a
# `type: LoadBalancer` Service, so k3s's bundled klipper servicelb is dead
# weight -- disabling it avoids klipper racing on hostPorts.
# --flannel-iface=eth1 pins pod-to-pod (VXLAN) traffic to the VPC
# interface. No --flannel-backend flag here: the k3s default vxlan
# backend is used, NOT the WireGuard-backed flannel this repo hardens
# some other k3s deploys with -- that hardening was driven by a
# replication incident specific to a different provider/transport, not a
# general requirement, and DigitalOcean's flat 1500-MTU VPC underlay has
# no known issue at vxlan's auto-computed 1450 MTU. The d3 e2e scenario
# validates this in practice.
# --system-default-registry: k3s system images come only from our ghcr mirror
# (registries.yaml above; K3S_SYSTEM_IMAGE_MIRRORS). Agents inherit it.
_m k
K3S_INSTALL_OK=false
for attempt in 1 2 3 4 5; do
  if curl -sfL --max-time 120 --retry 3 --retry-delay 10 https://get.k3s.io | INSTALL_K3S_VERSION="${k3s_version}" sh -s - server \
      --disable-default-registry-endpoint \
      --cluster-init \
      --agent-token "${k3s_token}" \
      --tls-san "$PUBLIC_IP" \
      --tls-san "$PRIVATE_IP" \
      --node-ip "$PRIVATE_IP" \
      --node-external-ip "$PUBLIC_IP" \
      --advertise-address "$PRIVATE_IP" \
      --flannel-iface "eth1" \
      --disable traefik \
      --disable=servicelb \
      --disable gateway-api-crd \
      --disable-cloud-controller \
      --system-default-registry "vibecarbon-system.invalid" \
      --kubelet-arg="cloud-provider=external" \
      --kubelet-arg="provider-id=digitalocean://$DROPLET_ID" \
      --write-kubeconfig-mode=600; then
    K3S_INSTALL_OK=true
    break
  fi
  echo "k3s install attempt $attempt failed (likely transient GitHub/CDN issue), retrying in 20s..."
  sleep 20
done
if [ "$K3S_INSTALL_OK" != "true" ]; then
  echo "k3s install failed after 5 attempts -- check GitHub CDN status" >&2
  exit 1
fi

# Wait for k3s to be ready (max 3 minutes -- if it hasn't started by then, something is wrong)
_m r
K3S_READY=false
for i in $(seq 1 36); do
  if kubectl get nodes 2>/dev/null | grep -q "Ready"; then
    K3S_READY=true
    break
  fi
  echo "Waiting for k3s to be ready... ($i/36)"
  sleep 5
done
if [ "$K3S_READY" != "true" ]; then
  echo "FATAL: k3s did not become ready within 3 minutes"
  echo "k3s service status:"
  systemctl status k3s --no-pager 2>&1 || true
  journalctl -u k3s --no-pager -n 20 2>&1 || true
  exit 1
fi

_m x

# Marker for vibecarbon's deployK3s waiter -- set AFTER the CCM/CSI
# install below completes (see end of script). Keeps the early-readiness
# signal distinct from "fully provisioned and ready for app install."
#
# No Secret here: the CCM and the CSI driver both read the DigitalOcean API
# token from ONE `digitalocean`/`access-token` Secret (DigitalOcean's
# self-managed docs), which deployK3s applies from the operator's machine
# once the apiserver serves (applyCloudSecrets), so the token never rides in
# this user data. Every node boots tainted
# node.cloudprovider.kubernetes.io/uninitialized until the CCM reconciles it
# (M3 dossier SS1), and the CCM waits for that Secret; the kubelet starts it
# on its own retry once deployK3s applies it.

# Install the DigitalOcean Cloud Controller Manager, pinned to v0.1.72. The URL
# is the git tag, so neither the version nor the path can move underneath us.
#
# Retry up to 3 times -- kubectl apply can fail if the API server is briefly
# unavailable.
for i in 1 2 3; do
  kubectl apply -f https://raw.githubusercontent.com/digitalocean/digitalocean-cloud-controller-manager/v0.1.72/releases/digitalocean-cloud-controller-manager/v0.1.72.yml && break
  echo "CCM install attempt $i failed, retrying in 10s..."
  sleep 10
done

# Install the DigitalOcean CSI driver (pinned v4.19.0): CRDs first, then
# the driver -- crds.yaml must land before driver.yaml since the driver's
# resources depend on those CRDs existing. Deliberately no
# snapshot-controller.yaml: we don't wire VolumeSnapshots here, matching
# how the equivalent provider's path leaves snapshots unwired too.
for i in 1 2 3; do
  kubectl apply -f https://raw.githubusercontent.com/digitalocean/csi-digitalocean/v4.19.0/deploy/kubernetes/releases/csi-digitalocean-v4.19.0/crds.yaml && break
  echo "CSI crds install attempt $i failed, retrying in 10s..."
  sleep 10
done
for i in 1 2 3; do
  kubectl apply -f https://raw.githubusercontent.com/digitalocean/csi-digitalocean/v4.19.0/deploy/kubernetes/releases/csi-digitalocean-v4.19.0/driver.yaml && break
  echo "CSI driver install attempt $i failed, retrying in 10s..."
  sleep 10
done

# csi-do-node (the CSI NODE plugin, a DaemonSet) ships from upstream with
# NO tolerations at all (confirmed against the v4.19.0 driver.yaml itself
# -- its spec.template.spec has no tolerations key), so it never schedules
# onto the tainted dedicated=db node (do-db-init.sh taints it
# dedicated=db:NoSchedule). That node's CSINode object then never
# gets the driver's `region` topologyKey, so the block-storage PV bound to
# the db PVC (which carries nodeAffinity: region In [<region>]) can
# never satisfy scheduling there, and the db pod sits Pending forever
# ("volume node affinity conflict" -- RCA: DO d3 rig, battery kept-rig
# deploy iteration 2, verified live: `kubectl get csinode` showed EMPTY
# topologyKeys for the database node while master/worker-1 both showed
# ["region"], and `kubectl get ds -n kube-system` showed csi-do-node with
# no tolerations and pods only on master + worker-1).
#
# master-init.sh's CSI install avoids this class of bug entirely: the
# equivalent provider's CSI node DaemonSet ships upstream with its OWN
# explicit toleration set (confirmed against the exact CSI release
# master-init.sh installs): {effect: NoExecute, operator: Exists},
# {effect: NoSchedule, operator: Exists}, {key: CriticalAddonsOnly,
# operator: Exists}. This provider's CSI release ships no equivalent, so
# we patch one in here rather than forking driver.yaml. A single bare
# {operator: Exists} (no key, no effect) is a strict superset of that
# three-entry set for anything that actually blocks scheduling: it
# tolerates every NoSchedule/NoExecute taint that set does, plus any
# custom key (dedicated=db included) with neither key- nor
# effect-scoping needed. It also tolerates PreferNoSchedule, which was
# never a scheduling blocker to begin with, so the broader match is
# harmless. This is a deliberate delta vs upstream csi-digitalocean --
# tainted dedicated nodes must still run the CSI node plugin so their
# local volumes can mount -- applied as a patch (not baked into a forked
# driver.yaml) so future version bumps keep pulling the unmodified
# upstream manifest. `--type=merge` is a JSON Merge Patch (RFC 7386): it
# REPLACES the `tolerations` array wholesale rather than appending to it
# -- safe today because csi-do-node ships no `tolerations` key to
# replace, but re-diff this block against any future csi-digitalocean
# version bump that adds one.
#
# Hard-fail on exhaustion, mirroring the k3s-install boolean-flag idiom
# above (K3S_INSTALL_OK): unlike the CCM/CSI-apply loops above (which
# fall through silently -- their objects are still reachable and
# self-healing via kubectl's own reconciliation on a later apply), a
# silently-exhausted patch here would still let the ready marker below
# get written and let deployK3s's waiter proceed as if healthy,
# reproducing the exact multi-hour db Pending wedge this patch
# exists to fix, just with zero signal until the next database rollout
# timeout.
CSI_NODE_TOLERATION_OK=false
for i in 1 2 3; do
  if kubectl patch daemonset csi-do-node -n kube-system --type=merge -p \
      '{"spec":{"template":{"spec":{"tolerations":[{"operator":"Exists"}]}}}}'; then
    CSI_NODE_TOLERATION_OK=true
    break
  fi
  echo "csi-do-node toleration patch attempt $i failed, retrying in 10s..."
  sleep 10
done
if [ "$CSI_NODE_TOLERATION_OK" != "true" ]; then
  echo "FATAL: could not patch csi-do-node with a universal toleration after 3 attempts -- the db pod (and any pod on a tainted dedicated node) will wedge Pending forever with a volume node affinity conflict" >&2
  echo "csi-do-node DaemonSet status:"
  kubectl get daemonset csi-do-node -n kube-system -o wide 2>&1 || true
  kubectl describe daemonset csi-do-node -n kube-system 2>&1 || true
  exit 1
fi

# DigitalOcean's CSI controller has no volume-label-injection env var (no
# analogue of a per-volume ownership-label knob) -- if per-volume
# attribution for shared-project sweep safety is ever needed here, it
# would be a tag applied at the DigitalOcean volume-API level, not a CSI
# controller env var. Out of scope for M3 (M3 dossier SS2 confirms no
# label-injection env exists on this driver).

echo "k3s master installation complete!"

# Final marker: vibecarbon's deployK3s waiter polls for /tmp/k3s-ready
# before fetching kubeconfig + applying app manifests. Written here so the
# marker only fires after k3s + CCM + CSI are all in place -- i.e., the
# cluster is ready for the token and real workloads, not just "k3s daemon
# is up."
_m e
touch /tmp/k3s-ready
