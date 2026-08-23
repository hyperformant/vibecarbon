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
# removed from the critical path - unattended-upgrades handles security
# patches async. Saves 30-60s per deploy.

# sshd concurrency headroom - same rationale as docker-ce-setup.yaml's
# 99-vibecarbon-concurrency.conf: the deploy fans concurrent ssh (builds,
# tunnels, probes) past Ubuntu's MaxStartups 10:30:100 default, which drops
# connections at the door (kex_exchange_identification reset; 2026-08-23).
mkdir -p /etc/ssh/sshd_config.d
printf 'MaxStartups 100:30:200\nMaxSessions 64\n' > /etc/ssh/sshd_config.d/99-vibecarbon-concurrency.conf
systemctl reload ssh || systemctl reload sshd || true

apt-get -o DPkg::Lock::Timeout=300 update -qq
apt-get -o DPkg::Lock::Timeout=300 install -y -qq curl jq docker.io docker-buildx

# Validate k3s version is set
K3S_TARGET_VERSION="${k3s_version}"
if [ -z "$K3S_TARGET_VERSION" ]; then
  echo "ERROR: k3s_version not set"
  exit 1
fi
echo "Installing k3s version: $K3S_TARGET_VERSION"

# IDENTICAL block in master-init.sh / worker-init.sh / supabase-init.sh - keep in sync.
# (Three-way duplication is acceptable here because the cloud-init scripts are
# rendered independently per role; extracting a shared snippet would require
# restructuring the renderScript() pipeline. Out of scope for Phase 1.)
# Configure containerd to mirror pulls for 10.0.1.1:5000 to the local registry
# we run on master. Cluster-autoscaler-spawned workers pull the app image from
# here on-demand (sideload only reaches workers that exist at sideload time).
# k3s only reads /etc/rancher/k3s/registries.yaml on agent start, so this MUST
# land before the k3s install step below.
#
# Plain http://10.0.1.1:5000 - the registry runs HTTP on the private network.
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

# Configure Floating IP on the OS so the kernel accepts packets destined for it.
# Hetzner routes the Floating IP to this server at the network level, but without
# a local address binding the kernel drops the packets.
# Use `ip addr add` instead of netplan - a separate netplan file that redefines
# ethernets.eth0 can override Hetzner's cloud-init config and drop the primary IP.
ip addr add ${floating_ip}/32 dev eth0 2>/dev/null || true

# Persist across reboots via a long-running systemd service (netplan-safe).
# Must be Type=simple (not oneshot) so it survives DHCP renewals - when networkd
# re-applies the cloud-init netplan config it can flush manually-added addresses.
# The loop re-adds the floating IP within 30 seconds if that happens.
cat > /etc/systemd/system/floating-ip.service << FIPEOF
[Unit]
Description=Maintain Hetzner Floating IP
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/bash -c 'while true; do if ! ip addr show eth0 | grep -q "${floating_ip}"; then ip addr add ${floating_ip}/32 dev eth0 && echo "Floating IP re-added"; fi; sleep 30; done'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
FIPEOF
systemctl daemon-reload
# `--now`, not a bare `enable`: enable only arms the unit for the NEXT boot, and
# these masters are not rebooted. Without it the `ip addr add` above is the only
# thing holding the address for the node's entire life, and the 30s re-add loop
# this block exists to install never runs - a netplan re-apply or a networkd
# DHCP-renewal flush then drops the Floating IP for good, taking public ingress
# down while every node stays Ready and kubectl looks clean.
# Same shape as _private-net-guard.sh, which enables THEN starts its watchdog.
systemctl enable --now floating-ip.service || true

# Get node IPs for k3s configuration.
# Fetch the public IPv4 robustly: k3s installs with --node-ip "$PUBLIC_IP" below,
# and the Hetzner CCM matches the node against the API by this IP to clear the
# node.cloudprovider.kubernetes.io/uninitialized taint. The metadata service can
# be slow/empty on first boot - a single curl that returns "" silently installs
# k3s with `--node-ip ""`, leaving the node InternalIP=<none> and breaking
# control-plane<->kubelet comms (RCA 2026-06-23, ash/US: cert-manager-webhook
# never became Ready because its node was unreachable). Retry the metadata
# endpoint, fall back to the default-route source address, and FAIL the provision
# rather than install a node with an empty node-ip.
PUBLIC_IP=""
for i in $(seq 1 30); do
  PUBLIC_IP=$(curl -sf --max-time 5 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 || true)
  if echo "$PUBLIC_IP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then break; fi
  PUBLIC_IP=""
  sleep 2
done
if [ -z "$PUBLIC_IP" ]; then
  echo "Metadata public-ipv4 unavailable after retries - deriving from default route"
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
# the script under set -euo pipefail - so we retry with || true.
PRIVATE_IFACE=""
RETRY_COUNT=0
MAX_RETRIES=120
DHCP_TRIGGERED=false
echo "Waiting for private network interface..."
while [ -z "$PRIVATE_IFACE" ] && [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  PRIVATE_IFACE=$(ip -4 addr show | grep 'inet 10\.0\.' | awk '{print $NF}' || true)
  if [ -z "$PRIVATE_IFACE" ]; then
    # See worker-init.sh for the dhcpcd-race RCA. Same recovery applies here.
    if [ "$DHCP_TRIGGERED" = "false" ] && [ $RETRY_COUNT -ge 6 ] && command -v dhcpcd >/dev/null 2>&1; then
      CANDIDATE=$(ip -o link show 2>/dev/null | awk -F': ' '/^[0-9]+: en[a-z]+[0-9]+s[0-9]+/ {print $2}' | grep -v '^eth' | head -1 || true)
      if [ -n "$CANDIDATE" ]; then
        DHCP_TRIGGERED=true
        echo "Private NIC $CANDIDATE has no lease after 30s - triggering dhcpcd"
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
  echo "Hetzner private network may not be attached to this server."
  exit 1
fi
echo "Private interface: $PRIVATE_IFACE"
PRIVATE_IP=$(ip -4 addr show "$PRIVATE_IFACE" 2>/dev/null | grep -oP 'inet \K[\d.]+' || echo "")

# The loop above only guards BOOT. Install the lifetime guard now that we have
# a working private NIC to record. Shared with supabase-init.sh/worker-init.sh
# via loadCloudInit's @include, so the three copies cannot drift.
# @include _private-net-guard.sh

# Install k3s master with pre-shared token.
# --node-ip must be the PUBLIC IP so Hetzner CCM can match it against the Hetzner API
# and remove the node.cloudprovider.kubernetes.io/uninitialized taint.
# --flannel-iface routes pod-to-pod traffic over the private network.
# --advertise-address must be the PRIVATE IP (statically 10.0.1.1 - assigned by
# the Pulumi program's master ServerNetwork, same constant supabase-init.sh and
# worker-init.sh join through). It steers BOTH (a) the in-cluster `kubernetes`
# Endpoints every pod's 10.43.0.1 DNATs to, and (b) the supervisor endpoint
# k3s agents dial for the apiserver→kubelet reverse tunnel (remotedialer).
# With the public IP here, both paths dial master-public:6443 - which the
# Hetzner firewall admits from OPERATOR CIDRs only since the H-2 closeout
# (c99f571) - so agent tunnels retry forever ("Failed to connect to proxy...
# connection timed out") and every kubectl exec/logs to a non-master node
# 502s, and any apiserver-dependent pod scheduled off-master is locked out.
# RCA 2026-07-17 e4 rig - the first real k8s deploy after the H-2 closeout
# (the Actions billing outage had suppressed e2e coverage of it).
# Private-sourced 6443 is admitted by the firewall's private-range rule, and
# CA-spawned workers get the tunnel for free (no public allowlisting).
#
# The k3s install script itself fetches https://github.com/k3s-io/k3s/releases/... and
# GitHub routinely returns 504 for brief windows. The outer curl has --retry 3, but
# GitHub failures happen inside the install script where we can't hand --retry through.
# Wrap the whole pipeline in a bash retry loop - up to 5 attempts with 20s backoff -
# so a transient CDN hiccup doesn't kill a fresh provision.
K3S_INSTALL_OK=false
for attempt in 1 2 3 4 5; do
  if curl -sfL --max-time 120 --retry 3 --retry-delay 10 https://get.k3s.io | INSTALL_K3S_VERSION="${k3s_version}" sh -s - server \
      --cluster-init \
      --token "${k3s_token}" \
      --tls-san "$PUBLIC_IP" \
      --tls-san "${floating_ip}" \
      --tls-san "10.0.1.1" \
      --node-ip "$PUBLIC_IP" \
      --node-external-ip "$PUBLIC_IP" \
      --advertise-address "10.0.1.1" \
      --flannel-iface "$PRIVATE_IFACE" \
      --disable traefik \
      --disable servicelb \
      --disable-cloud-controller \
      --flannel-backend=wireguard-native \
      --kubelet-arg="cloud-provider=external" \
      --write-kubeconfig-mode=644; then
    K3S_INSTALL_OK=true
    break
  fi
  echo "k3s install attempt $attempt failed (likely transient GitHub/CDN issue), retrying in 20s..."
  sleep 20
done
if [ "$K3S_INSTALL_OK" != "true" ]; then
  echo "k3s install failed after 5 attempts - check GitHub CDN status" >&2
  exit 1
fi

# Wait for k3s to be ready (max 3 minutes - if it hasn't started by then, something is wrong)
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

# Marker for vibecarbon's deployK3s waiter - set AFTER hcloud Secret + CCM/CSI
# install below complete (see end of script). Keeps the early-readiness signal
# distinct from "fully provisioned and ready for app install."

# Create secret for Hetzner Cloud Controller Manager
kubectl -n kube-system create secret generic hcloud \
  --from-literal=token="${hcloud_token}" \
  --from-literal=network="${network_id}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Create secret for Hetzner CSI Driver
kubectl -n kube-system create secret generic hcloud-csi \
  --from-literal=token="${hcloud_token}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Install Hetzner Cloud Controller Manager
# Use ccm.yaml (not ccm-networks.yaml) since k3s manages pod networking via flannel
# Retry up to 3 times - kubectl apply can fail if API server is briefly unavailable
for i in 1 2 3; do
  kubectl apply -f https://github.com/hetznercloud/hcloud-cloud-controller-manager/releases/download/v1.20.0/ccm.yaml && break
  echo "CCM install attempt $i failed, retrying in 10s..."
  sleep 10
done

# Install Hetzner CSI Driver
#
# VERSION WINDOW - v2.18.1 is the NEWEST release upstream supports on
# Kubernetes v1.31 (what INSTALL_K3S_VERSION pins): the driver supports the
# latest three k8s minors, and v2.18.2's changelog entry is "drop Kubernetes
# v1.31 support". The FLOOR is v2.15.0, below which the volume-label line
# below does nothing. Both ends are asserted by
# tests/unit/deploy/k8s-image-mirrors.test.ts, which also re-derives the
# sig-storage sidecar tags src/lib/images.js re-pins onto our ghcr mirrors -
# bump this URL and that fixture fails until the tags are re-derived too.
for i in 1 2 3; do
  kubectl apply -f https://raw.githubusercontent.com/hetznercloud/csi-driver/v2.18.1/deploy/kubernetes/hcloud-csi.yml && break
  echo "CSI install attempt $i failed, retrying in 10s..."
  sleep 10
done

# Label every CSI-created volume with this project. Hetzner volumes are named
# pvc-<uuid> with no owner information; anything enumerating the (shared)
# Hetzner project - e2e sweeps especially - cannot otherwise attribute them.
# RCA 2026-07-18: a concurrent CI matrix's sweep deleted another live rig's
# volumes while they were legitimately DETACHED mid-reseed (db scaled to zero
# during the pilot-light reconverge), because "unattached pvc-*" was the only
# available heuristic. HCLOUD_VOLUME_EXTRA_LABELS makes the CSI controller
# stamp `project=<name>` on creation; sweeps filter on it (server parity -
# servers already carry the same label from the Pulumi program, which is also
# why the value is already known-valid to Hetzner's label validator).
#
# This line was a NO-OP from 2026-07-18 until the v2.18.1 bump: volume
# labelling only landed upstream in v2.14.0, and the v2.9.0 controller read
# exactly one env var (HCLOUD_VOLUME_DEFAULT_LOCATION), so every volume leaked
# in the three occurrences #236 catalogues was unlabelled. On v2.18.1 the
# controller parses this into extra labels and stamps them on every
# CreateVolume (cmd/main.go:128 -> internal/driver/controller.go:87-91,118),
# alongside the driver's own managed-by / pvc-name / pvc-namespace / pv-name
# defaults. Deleting this line re-opens the attribution gap.
kubectl -n kube-system set env deployment/hcloud-csi-controller \
  HCLOUD_VOLUME_EXTRA_LABELS="project=${project_name}" || \
  echo "WARN: could not set CSI volume labels - volumes will be unattributed"

echo "k3s master installation complete!"

# Final marker: vibecarbon's deployK3s polls for /tmp/k3s-ready before fetching
# kubeconfig + applying app manifests. Written here so the marker only fires
# after k3s + hcloud secrets + CCM + CSI are all in place - i.e., the cluster
# is ready for real workloads, not just "k3s daemon is up."
touch /tmp/k3s-ready
