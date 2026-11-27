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

# Node identity from Scaleway's metadata service (the public address, the
# server id, the zone and the hostname), and the Private Network interface,
# found by its MAC. The include also installs the k3s unit's drop-in that
# names that interface to flannel at every start (K3S_UNIT: get.k3s.io names
# an agent's unit k3s-agent). It refuses to go on without any of them: never
# install k3s with an empty --node-ip.
K3S_UNIT=k3s-agent
# @include _scaleway-metadata.sh
echo "Public IP: $PUBLIC_IP"
echo "Private IP: $PRIVATE_IP on $PRIVATE_IFACE"
echo "Server ID: $NODE_ID in $NODE_ZONE"

# k3s names the node after the hostname, so it must be a valid node name.
# Scaleway's metadata gives the server's hostname, which its creator (the
# program, or the autoscaler) sets unique in the cluster; apply it here so a
# reboot keeps it.
if ! echo "$NODE_NAME" | grep -qE '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'; then
  echo "FATAL: Scaleway hostname \"$NODE_NAME\" is not a valid Kubernetes node name (lowercase letters, digits and hyphens, at most 63 characters)" >&2
  exit 1
fi
hostnamectl set-hostname "$NODE_NAME"
echo "Node name: $NODE_NAME"

# @include _host-firewall-off.sh
# @include _container-signals.sh
# @include _stable-flowlabel.sh

# Configure containerd to mirror pulls for the local registry running on
# the master, at the master's private IP. Scaleway assigns Private Network
# addresses, so this node is rendered with the master already created and
# its address read back; it is a template var (${master_ip}).
#
# Plain http://${master_ip}:5000 -- the registry runs HTTP on the private
# network. Do NOT add `insecure_skip_verify: true` (see scaleway-master-init.sh).
mkdir -p /etc/rancher/k3s
cat > /etc/rancher/k3s/registries.yaml << REGEOF
mirrors:
  "${master_ip}:5000":
    endpoint:
      - "http://${master_ip}:5000"
# @include _k3s-system-image-mirror.yaml
REGEOF

_m w
# Wait for the master k3s API (private IP, over the Private Network) before joining.
MAX_RETRIES=120
RETRY_COUNT=0

echo "Waiting for master k3s API to be ready..."
while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if curl -sk --max-time 5 "https://${master_ip}:6443/readyz" >/dev/null 2>&1; then
    echo "Master k3s API is ready!"
    break
  fi

  if [ $((RETRY_COUNT % 12)) -eq 0 ]; then
    echo "Master not ready yet... ($RETRY_COUNT/$MAX_RETRIES)"
  fi
  RETRY_COUNT=$((RETRY_COUNT + 1))
  sleep 5
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
  echo "Warning: Master may not be fully ready, attempting to join anyway..."
fi

# --node-ip is this node's PRIVATE (Private Network) IP and --node-external-ip
# its PUBLIC IP. --kubelet-arg=provider-id=scaleway://<server id> names the
# node to k3s's embedded cloud controller and to the shared parsers. There is
# no Scaleway CCM here and no external cloud-provider mode: the embedded
# cloud controller keeps the preset providerID and clears the uninitialized
# taint. The flannel interface is not a flag: the drop-in above writes it to
# config.yaml.d before every start, so a NIC renamed across a reboot is found
# again. Flannel keeps its default backend, vxlan.
# The database node runs this same install: loadCloudInit fills the role
# slots on the lines below with its labels and taint and its name in the
# log lines (AGENT_ROLES in src/lib/iac/cloud-init.js).
_m k
K3S_INSTALL_OK=false
for attempt in 1 2 3 4 5; do
  if curl -sfL --max-time 120 --retry 3 --retry-delay 10 https://get.k3s.io | INSTALL_K3S_VERSION="${k3s_version}" K3S_URL="https://${master_ip}:6443" K3S_TOKEN="${k3s_token}" sh -s - agent \
      --disable-default-registry-endpoint \
      --node-ip "$PRIVATE_IP" \
      --node-external-ip "$PUBLIC_IP" \
      --kubelet-arg="provider-id=scaleway://$NODE_ID"@{role_flags}; then
    K3S_INSTALL_OK=true
    break
  fi
  echo "k3s @{role_label} install attempt $attempt failed (likely transient GitHub/CDN issue), retrying in 20s..."
  sleep 20
done
if [ "$K3S_INSTALL_OK" != "true" ]; then
  echo "k3s @{role_label} install failed after 5 attempts -- check GitHub CDN status" >&2
  exit 1
fi

# The database node's user data leaves this include out: the deploy
# installs the reporter there over SSH (AGENT_ROLES, cloud-init.js).
# @include _host-reporter.sh

echo "k3s @{role_name} installation complete!"
_m e
