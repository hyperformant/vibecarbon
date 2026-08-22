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
# removed from the critical path — unattended-upgrades handles security
# patches async. Saves 30-60s per deploy.
apt-get -o DPkg::Lock::Timeout=300 update -qq
apt-get -o DPkg::Lock::Timeout=300 install -y -qq curl jq

# Validate k3s version is set
K3S_TARGET_VERSION="${k3s_version}"
if [ -z "$K3S_TARGET_VERSION" ]; then
  echo "ERROR: k3s_version not set"
  exit 1
fi
echo "Installing k3s version: $K3S_TARGET_VERSION"

# IDENTICAL block in master-init.sh / worker-init.sh / supabase-init.sh — keep in sync.
# (Three-way duplication is acceptable here because the cloud-init scripts are
# rendered independently per role; extracting a shared snippet would require
# restructuring the renderScript() pipeline. Out of scope for Phase 1.)
# Configure containerd to mirror pulls for 10.0.1.1:5000 to the local registry
# running on master. Cluster-autoscaler-spawned workers pull the app image from
# here on-demand (sideload only reaches workers that exist at sideload time).
# k3s only reads /etc/rancher/k3s/registries.yaml on agent start, so this MUST
# land before the k3s install step below.
#
# Plain http://10.0.1.1:5000 — the registry runs HTTP on the private network.
# Do NOT add `insecure_skip_verify: true` here: that flag only affects HTTPS
# endpoints, and recent k3s versions place it incorrectly when present
# (k3s-io/k3s#13215), which can break containerd config generation.
mkdir -p /etc/rancher/k3s
cat > /etc/rancher/k3s/registries.yaml << 'REGEOF'
mirrors:
  "10.0.1.1:5000":
    endpoint:
      - "http://10.0.1.1:5000"
REGEOF

# Get node IPs for k3s configuration.
# Robust public-IPv4 fetch — see master-init.sh for the full RCA. A single curl
# that returns "" installs k3s with `--node-ip ""`, leaving the node
# InternalIP=<none> and unreachable from the control plane. Retry the metadata
# endpoint, fall back to the default-route source address, and FAIL rather than
# install an empty node-ip.
PUBLIC_IP=""
for i in $(seq 1 30); do
  PUBLIC_IP=$(curl -sf --max-time 5 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 || true)
  if echo "$PUBLIC_IP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then break; fi
  PUBLIC_IP=""
  sleep 2
done
if [ -z "$PUBLIC_IP" ]; then
  echo "Metadata public-ipv4 unavailable after retries — deriving from default route"
  PUBLIC_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[\d.]+' || true)
fi
if ! echo "$PUBLIC_IP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "FATAL: could not determine public IPv4 for --node-ip; refusing to install k3s with an empty node-ip"
  exit 1
fi
echo "Public IP: $PUBLIC_IP"

# Wait for the private network interface (10.0.x.x) to be assigned.
# Hetzner attaches the private network after the server boots, so the interface
# may not exist yet when cloud-init runs. grep exits 1 if no match, which kills
# the script under set -euo pipefail — so we retry with || true.
#
# This must happen BEFORE the master-readyz probe below, because that probe
# uses the master's private IP (10.0.1.1) — unreachable until our private NIC
# is up. Workers stuck in master-readyz with no private NIC was the failure
# mode in k8s-ha 2026-05-01 deploy run (yir52p, primary-worker-1): hung 600s
# in "Master not ready yet..." while enp7s0 sat in state DOWN with no IP.
PRIVATE_IFACE=""
RETRY_COUNT=0
MAX_RETRIES=120
DHCP_TRIGGERED=false
echo "Waiting for private network interface..."
while [ -z "$PRIVATE_IFACE" ] && [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  PRIVATE_IFACE=$(ip -4 addr show | grep 'inet 10\.0\.' | awk '{print $NF}' || true)
  if [ -z "$PRIVATE_IFACE" ]; then
    # After 30s with no 10.0.x.x address, actively trigger dhcpcd on any
    # unmanaged enp* NIC. Hetzner ships dhcpcd-base + auto-starts dhcpcd at
    # boot, but it races with the post-boot Hetzner private-network
    # attachment. When dhcpcd loses the race the interface stays DOWN and no
    # IP is ever requested — running `dhcpcd -1 <iface>` once obtains the
    # lease idempotently. Skip if already triggered or dhcpcd missing.
    if [ "$DHCP_TRIGGERED" = "false" ] && [ $RETRY_COUNT -ge 6 ] && command -v dhcpcd >/dev/null 2>&1; then
      CANDIDATE=$(ip -o link show 2>/dev/null | awk -F': ' '/^[0-9]+: en[a-z]+[0-9]+s[0-9]+/ {print $2}' | grep -v '^eth' | head -1 || true)
      if [ -n "$CANDIDATE" ]; then
        DHCP_TRIGGERED=true
        echo "Private NIC $CANDIDATE has no lease after 30s — triggering dhcpcd"
        ip link set "$CANDIDATE" up 2>&1 || true
        dhcpcd -1 "$CANDIDATE" 2>&1 | sed 's/^/  dhcpcd: /' || true
      fi
    fi
    if [ $((RETRY_COUNT % 12)) -eq 0 ]; then
      echo "Private interface not ready yet... ($RETRY_COUNT/$MAX_RETRIES)"
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    sleep 5
  fi
done
if [ -z "$PRIVATE_IFACE" ]; then
  echo "FATAL: Private network interface not found after $MAX_RETRIES retries"
  exit 1
fi
echo "Private interface: $PRIVATE_IFACE"
PRIVATE_IP=$(ip -4 addr show "$PRIVATE_IFACE" 2>/dev/null | grep -oP 'inet \K[\d.]+' || echo "")

# The loop above only guards BOOT. Install the lifetime guard now that we have
# a working private NIC to record. This same file is the cluster-autoscaler's
# node template (renderCarbonAutoscalerConfig), so CA-spawned workers — the
# node class with no render-time IP — are covered by the same code path.
# @include _private-net-guard.sh

# Wait for master k3s API to be ready before joining (uses private IP — must
# come AFTER private-NIC bring-up above).
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
# --node-ip must be the PUBLIC IP so Hetzner CCM can match it (see master-init.sh).
# Bash retry loop around the whole pipeline — the k3s install script fetches
# from github.com which returns transient 504s under load. 5 attempts, 20s backoff.
K3S_INSTALL_OK=false
for attempt in 1 2 3 4 5; do
  if curl -sfL --max-time 120 --retry 3 --retry-delay 10 https://get.k3s.io | INSTALL_K3S_VERSION="${k3s_version}" K3S_URL="https://${master_ip}:6443" K3S_TOKEN="${k3s_token}" sh -s - agent \
      --node-ip "$PUBLIC_IP" \
      --node-external-ip "$PUBLIC_IP" \
      --flannel-iface "$PRIVATE_IFACE" \
      --kubelet-arg="cloud-provider=external"; then
    K3S_INSTALL_OK=true
    break
  fi
  echo "k3s worker install attempt $attempt failed (likely transient GitHub/CDN issue), retrying in 20s..."
  sleep 20
done
if [ "$K3S_INSTALL_OK" != "true" ]; then
  echo "k3s worker install failed after 5 attempts — check GitHub CDN status" >&2
  exit 1
fi

echo "k3s worker installation complete!"
