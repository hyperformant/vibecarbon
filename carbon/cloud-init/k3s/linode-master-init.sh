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

# Node identity via Linode's Metadata Service (169.254.169.254). Two calls
# to get a token (PUT, 1 h expiry) and then plain-text reads of /v1/instance
# and /v1/network (`key: value` lines, no jq needed). The VPC address is on
# eth1 from the initrd and in the metadata from bootcmd, so it is there by
# the time this script runs; the retry only covers a slow metadata answer.
# The token is fetched once and reused: the service rate-limits requests.
# Still bound the retry and FATAL on empty metadata: never install k3s with
# an empty --node-ip.
METADATA_TOKEN=""
for i in $(seq 1 15); do
  METADATA_TOKEN=$(curl -sf --max-time 5 -X PUT -H "Metadata-Token-Expiry-Seconds: 3600" http://169.254.169.254/v1/token || true)
  if [ -n "$METADATA_TOKEN" ]; then
    break
  fi
  sleep 2
done

fetch_metadata() {
  local path="$1"
  local val=""
  for i in $(seq 1 15); do
    val=$(curl -sf --max-time 5 -H "Metadata-Token: $METADATA_TOKEN" "http://169.254.169.254/v1/$path" || true)
    if [ -n "$val" ]; then
      break
    fi
    sleep 2
  done
  echo "$val"
}

# Value of one `key: value` line, with any /32 suffix dropped.
metadata_value() {
  echo "$1" | sed -n "s/^$2: *//p" | head -n 1 | sed 's|/.*$||'
}

INSTANCE_META=$(fetch_metadata "instance")
NETWORK_META=$(fetch_metadata "network")

PUBLIC_IP=$(metadata_value "$NETWORK_META" "ipv4.public")
if ! echo "$PUBLIC_IP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "FATAL: could not determine public IPv4 from Linode metadata; refusing to install k3s with an empty node-external-ip"
  exit 1
fi
echo "Public IP: $PUBLIC_IP"

PRIVATE_IP=$(metadata_value "$NETWORK_META" "ipv4.vpc")
if ! echo "$PRIVATE_IP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "FATAL: could not determine private VPC IPv4 from Linode metadata; refusing to install k3s with an empty node-ip"
  exit 1
fi
echo "Private IP: $PRIVATE_IP"

NODE_ID=$(metadata_value "$INSTANCE_META" "id")
if ! echo "$NODE_ID" | grep -qE '^[0-9]+$'; then
  echo "FATAL: could not determine Linode id from Linode metadata; refusing to install k3s without a provider-id"
  exit 1
fi
echo "Linode ID: $NODE_ID"

# Configure containerd to mirror pulls for the local registry running on
# THIS master, to this master's OWN private IP. Cluster-autoscaler-spawned
# workers pull the app image from here on-demand (sideload only reaches
# workers that exist at sideload time). k3s only reads
# /etc/rancher/k3s/registries.yaml on agent start, so this MUST land
# before the k3s install step below. The private IP comes from the
# metadata fetch above, so it is a shell variable, not a template var.
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

# --node-ip is this node's PRIVATE (VPC) IP and --node-external-ip its
# PUBLIC IP. --kubelet-arg=provider-id=linode://<id> is what the Linode CSI
# driver and k3s's embedded cloud controller read to identify the node. There
# is no Linode CCM here and no external cloud-provider mode: k3s's own embedded
# cloud controller keeps the preset providerID and clears the uninitialized
# taint. --flannel-iface=eth1 pins pod-to-pod (VXLAN) traffic to the VPC
# interface; no --flannel-backend flag (vxlan default).
# --advertise-address is the PRIVATE IP: it's what every pod's 10.43.0.1
# Endpoints DNATs to, and what agents dial for the apiserver<->kubelet
# reverse tunnel. --tls-san covers the public and private IPs only: the
# stable ingress address terminates at traefik on 80/443, never at the k8s
# API port.
# --disable=servicelb: ingress is routed by us, and we never create a
# `type: LoadBalancer` Service, so k3s's bundled klipper servicelb is dead
# weight -- disabling it avoids klipper racing on hostPorts.
# --system-default-registry: k3s system images come only from our ghcr mirror
# (registries.yaml above; K3S_SYSTEM_IMAGE_MIRRORS). Agents inherit it.
_m k
K3S_INSTALL_OK=false
for attempt in 1 2 3 4 5; do
  if curl -sfL --max-time 120 --retry 3 --retry-delay 10 https://get.k3s.io | INSTALL_K3S_VERSION="${k3s_version}" sh -s - server \
      --disable-default-registry-endpoint \
      --cluster-init \
      --token "${k3s_token}" \
      --tls-san "$PUBLIC_IP" \
      --tls-san "$PRIVATE_IP" \
      --node-ip "$PRIVATE_IP" \
      --node-external-ip "$PUBLIC_IP" \
      --advertise-address "$PRIVATE_IP" \
      --flannel-iface "eth1" \
      --disable traefik \
      --disable=servicelb \
      --disable gateway-api-crd \
      --system-default-registry "vibecarbon-system.invalid" \
      --kubelet-arg="provider-id=linode://$NODE_ID" \
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

# The ready marker (end of script) is written AFTER the linode Secret, the
# CSI driver and the StorageClass are in place, so deployK3s's waiter never
# proceeds to the app install before volumes can be provisioned.

# The Linode API token, read by the CSI driver (Secret kube-system/linode,
# key `token`).
kubectl -n kube-system create secret generic linode \
  --from-literal=token="${linode_token}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Install the Linode Block Storage CSI driver from its pinned release asset
# (v1.1.5; its images are pinned inside the asset). Its node plugin tolerates
# every taint, so the tainted dedicated=db node needs no patch. Retry --
# kubectl apply can fail if the API server is briefly unavailable.
CSI_INSTALL_OK=false
for i in 1 2 3; do
  if kubectl apply -f https://github.com/linode/linode-blockstorage-csi-driver/releases/download/v1.1.5/linode-blockstorage-csi-driver-v1.1.5.yaml; then
    CSI_INSTALL_OK=true
    break
  fi
  echo "CSI driver install attempt $i failed, retrying in 10s..."
  sleep 10
done
if [ "$CSI_INSTALL_OK" != "true" ]; then
  echo "FATAL: could not install the Linode CSI driver after 3 attempts -- no volume could be provisioned" >&2
  exit 1
fi

# Our own StorageClass: the shipped ones are untagged and default to Retain.
# volumeTags carries the project tag (encoded as the destroy sweep matches
# it: `project:<name>` with characters outside [A-Za-z0-9:_-] as `-`), so
# every volume the driver creates can be found and removed with its project.
PROJECT_TAG=$(printf 'project:%s' "${project_name}" | tr -c 'A-Za-z0-9:_-' '-')
SC_APPLIED=false
for i in 1 2 3; do
  if kubectl apply -f - << SCEOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: linode-block-storage-vibecarbon
provisioner: linodebs.csi.linode.com
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
parameters:
  linodebs.csi.linode.com/volumeTags: "$PROJECT_TAG"
SCEOF
  then
    SC_APPLIED=true
    break
  fi
  echo "StorageClass apply attempt $i failed, retrying in 10s..."
  sleep 10
done
if [ "$SC_APPLIED" != "true" ]; then
  echo "FATAL: could not apply the linode-block-storage-vibecarbon StorageClass after 3 attempts" >&2
  exit 1
fi

echo "k3s master installation complete!"

# Final marker: vibecarbon's deployK3s waiter polls for /tmp/k3s-ready
# before fetching kubeconfig + applying app manifests.
_m e
touch /tmp/k3s-ready
