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

# Node identity from Vultr's metadata service: the public and VPC addresses,
# the instance id and the hostname, and the kernel interface that holds the
# VPC address (cloud-init configured it from the same metadata before this
# script runs). It refuses to go on without any of them: never install k3s
# with an empty --node-ip.
# @include _vultr-metadata.sh
echo "Public IP: $PUBLIC_IP"
echo "Private IP: $PRIVATE_IP on $PRIVATE_IFACE"
echo "Instance ID: $NODE_ID"

# k3s names the node after the hostname, so it must be a valid node name.
# The program sets each instance's hostname, unique in the cluster; apply it
# here so a reboot keeps it.
if ! echo "$NODE_NAME" | grep -qE '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'; then
  echo "FATAL: Vultr hostname \"$NODE_NAME\" is not a valid Kubernetes node name (lowercase letters, digits and hyphens, at most 63 characters)" >&2
  exit 1
fi
hostnamectl set-hostname "$NODE_NAME"
echo "Node name: $NODE_NAME"

# @include _container-signals.sh
# @include _stable-flowlabel.sh

# Configure containerd to mirror pulls for the local registry running on
# THIS master, to this master's OWN private IP. Cluster-autoscaler-spawned
# workers pull the app image from here on-demand (sideload only reaches
# workers that exist at sideload time). k3s only reads
# /etc/rancher/k3s/registries.yaml on agent start, so this MUST land
# before the k3s install step below. The private IP comes from the
# metadata read above, so it is a shell variable, not a template var.
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
# --node-ip is this node's PRIVATE (VPC) IP and --node-external-ip its
# PUBLIC IP. --kubelet-arg=provider-id=vultr://<instance-v2-id> is what the
# Vultr CSI driver and k3s's embedded cloud controller read to identify the
# node. There is no Vultr CCM here and no external cloud-provider mode: k3s's
# own embedded cloud controller keeps the preset providerID and clears the
# uninitialized taint. --flannel-iface pins pod-to-pod (VXLAN) traffic to the
# VPC interface found above; flannel keeps its default backend, vxlan.
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
      --agent-token "${k3s_token}" \
      --tls-san "$PUBLIC_IP" \
      --tls-san "$PRIVATE_IP" \
      --node-ip "$PRIVATE_IP" \
      --node-external-ip "$PUBLIC_IP" \
      --advertise-address "$PRIVATE_IP" \
      --flannel-iface "$PRIVATE_IFACE" \
      --disable traefik \
      --disable=servicelb \
      --disable gateway-api-crd \
      --system-default-registry "vibecarbon-system.invalid" \
      --kubelet-arg="provider-id=vultr://$NODE_ID" \
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

echo "k3s master installation complete!"

# Final marker: vibecarbon's deployK3s waiter polls for /tmp/k3s-ready
# before fetching kubeconfig + applying app manifests.
_m e
touch /tmp/k3s-ready
