#!/bin/bash
set -euo pipefail

# Note: This script runs AS PART of cloud-init (user_data), so we cannot wait for
# cloud-init to complete (that would cause a deadlock). The script starts immediately.

# apt's default behaviour on lock contention is to try once and exit 100,
# and unattended-upgrades holds dpkg's lock right through first boot --
# which is exactly when cloud-init runs this. `-o DPkg::Lock::Timeout`
# makes apt block on the lock instead. See src/lib/deploy/apt.js for the
# RCA and the live verification.
#
# This replaced a `fuser` poll loop that was broken two ways: it polled
# /var/lib/dpkg/lock, lists/lock and archives/lock but never
# /var/lib/dpkg/lock-frontend -- the lock that actually fails the install
# -- and being a pre-check it was TOCTOU, since unattended-upgrades could
# take the lock in the gap between the loop passing and apt-get starting.

# Update apt lists + install the packages we need. `apt-get upgrade` was
# removed from the critical path -- unattended-upgrades handles security
# patches async. Saves 30-60s per deploy.

# sshd concurrency headroom - same rationale as docker-ce-setup.yaml's
# 99-vibecarbon-concurrency.conf: the deploy fans concurrent ssh (builds,
# tunnels, probes) past Ubuntu's MaxStartups 10:30:100 default, which drops
# connections at the door (kex_exchange_identification reset; 2026-08-23).
mkdir -p /etc/ssh/sshd_config.d
printf 'MaxStartups 100:30:200\nMaxSessions 64\n' > /etc/ssh/sshd_config.d/99-vibecarbon-concurrency.conf
systemctl reload ssh || systemctl reload sshd || true

apt-get -o DPkg::Lock::Timeout=300 update -qq
apt-get -o DPkg::Lock::Timeout=300 install -y -qq curl jq

# Validate k3s version is set
K3S_TARGET_VERSION="${k3s_version}"
if [ -z "$K3S_TARGET_VERSION" ]; then
  echo "ERROR: k3s_version not set"
  exit 1
fi
echo "Installing k3s version: $K3S_TARGET_VERSION"

# Node identity via DigitalOcean's metadata service -- see do-master-init.sh
# for the full comment on why this needs no interface-name discovery and
# no post-boot-attach race (M3 dossier SS3/SS4). Still bound the retry and
# FATAL on empty metadata: never install k3s with an empty --node-ip.
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

# Configure containerd to mirror pulls for the local registry running on
# the master, to the master's private IP. The master's private IP IS
# known at render time here (workers are rendered with the master already
# created -- see digitalocean-k8s.js, M3 Task 5), so this is a template
# var (${master_ip}) exactly like worker-init.sh's own registry mirror,
# NOT a metadata-derived runtime var like do-master-init.sh's mirror block
# (which has no master_ip to be given -- it IS the master).
#
# Plain http://${master_ip}:5000 -- the registry runs HTTP on the private
# network. Do NOT add `insecure_skip_verify: true` (see do-master-init.sh).
mkdir -p /etc/rancher/k3s
cat > /etc/rancher/k3s/registries.yaml << REGEOF
mirrors:
  "${master_ip}:5000":
    endpoint:
      - "http://${master_ip}:5000"
REGEOF

# Wait for master k3s API to be ready before joining (private IP -- see
# do-master-init.sh's install comment for why --node-ip there is the
# private IP; the API is reachable over the VPC with no public-vs-private
# firewall tension to route around).
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

# Install k3s agent with pre-shared token.
# --node-ip is this node's PRIVATE (VPC) IP -- see do-master-init.sh's
# k3s-install comment for why this provider's --node-ip carries none of
# worker-init.sh's public-vs-firewall tension. --kubelet-arg=provider-id
# pre-seeds the CCM's node<->droplet match (same rationale as the
# master). --flannel-iface pins pod-to-pod traffic to the VPC interface;
# no --flannel-backend flag (vxlan default -- see do-master-init.sh).
K3S_INSTALL_OK=false
for attempt in 1 2 3 4 5; do
  if curl -sfL --max-time 120 --retry 3 --retry-delay 10 https://get.k3s.io | INSTALL_K3S_VERSION="${k3s_version}" K3S_URL="https://${master_ip}:6443" K3S_TOKEN="${k3s_token}" sh -s - agent \
      --node-ip "$PRIVATE_IP" \
      --node-external-ip "$PUBLIC_IP" \
      --flannel-iface "eth1" \
      --kubelet-arg="cloud-provider=external" \
      --kubelet-arg="provider-id=digitalocean://$DROPLET_ID"; then
    K3S_INSTALL_OK=true
    break
  fi
  echo "k3s worker install attempt $attempt failed (likely transient GitHub/CDN issue), retrying in 20s..."
  sleep 20
done
if [ "$K3S_INSTALL_OK" != "true" ]; then
  echo "k3s worker install failed after 5 attempts -- check GitHub CDN status" >&2
  exit 1
fi

echo "k3s worker installation complete!"
