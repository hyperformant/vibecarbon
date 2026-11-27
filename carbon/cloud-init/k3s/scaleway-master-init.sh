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
# the server's unit k3s). It refuses to go on without any of them: never
# install k3s with an empty --node-ip.
K3S_UNIT=k3s
# @include _scaleway-metadata.sh
echo "Public IP: $PUBLIC_IP"
echo "Private IP: $PRIVATE_IP on $PRIVATE_IFACE"
echo "Server ID: $NODE_ID in $NODE_ZONE"

# k3s names the node after the hostname, so it must be a valid node name.
# Scaleway's metadata gives the server's hostname, which the program sets
# unique in the cluster; apply it here so a reboot keeps it.
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
# THIS master, to this master's OWN private IP. Cluster-autoscaler-spawned
# workers pull the app image from here on-demand (sideload only reaches
# workers that exist at sideload time). k3s only reads
# /etc/rancher/k3s/registries.yaml on agent start, so this MUST land
# before the k3s install step below. The private IP is the Private Network
# address found above, so it is a shell variable, not a template var.
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
# --node-ip is this node's PRIVATE (Private Network) IP and --node-external-ip
# its PUBLIC IP. --kubelet-arg=provider-id=scaleway://<server id> names the
# node to k3s's embedded cloud controller and to the shared parsers, which
# read the server id after the prefix. There is no Scaleway CCM here and no
# external cloud-provider mode: the embedded cloud controller keeps the
# preset providerID and clears the uninitialized taint. The flannel interface
# is not a flag: the drop-in above writes it to config.yaml.d before every
# start, so a NIC renamed across a reboot is found again. Flannel keeps its
# default backend, vxlan.
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
      --disable traefik \
      --disable=servicelb \
      --disable gateway-api-crd \
      --system-default-registry "vibecarbon-system.invalid" \
      --kubelet-arg="provider-id=scaleway://$NODE_ID" \
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

# The ready marker (end of script) is written AFTER the CSI driver and the
# StorageClass are in place. The CSI controller reads its credentials from
# Secret kube-system/scaleway-csi-secret (envFrom), which deployK3s applies
# from the operator's machine once the apiserver serves (applyCloudSecrets),
# before the app install, so the secret key never rides in this user data and
# no volume is asked for before the driver can make one. Each step below
# retries (the API server can be briefly unavailable) and stops the boot when
# its tries run out: a cluster that cannot provision or mount a volume must
# never report ready.

# @include _csi-image-mirror.sh

# scaleway-csi ships only a Helm chart, so its render is committed
# (_scaleway-csi.yaml, whose header says how to re-render it) and carried
# here compressed: nothing is downloaded, so a chart release never changes
# what this node installs.
printf '%s' "${scaleway_csi_manifest}" | base64 -d | gunzip > /root/scaleway-csi.upstream.yaml \
  || { echo "FATAL: the embedded CSI manifest does not decode" >&2; exit 1; }

# Install the Scaleway CSI driver (v0.3.6) from that render, on our mirrors
# (csi_fetch_mirrored). Helm names no namespace on the namespaced objects, so
# the apply does. Its node plugin already tolerates every taint (the render's
# values), so it runs on the db node too and needs no patch.
CSI_INSTALL_OK=false
for i in 1 2 3; do
  if csi_fetch_mirrored file:///root/scaleway-csi.upstream.yaml /root/csi-driver.yaml \
    && kubectl apply -n kube-system -f /root/csi-driver.yaml; then
    CSI_INSTALL_OK=true
    break
  fi
  echo "CSI driver install attempt $i failed, retrying in 10s..."
  sleep 10
done
if [ "$CSI_INSTALL_OK" != "true" ]; then
  echo "FATAL: could not install the Scaleway CSI driver after 3 attempts -- no volume could be provisioned" >&2
  exit 1
fi

# Our own StorageClass: bound in the zone and on the node the pod lands on,
# Delete reclaim, expandable. No parameters: the driver's default type, block
# storage at 5,000 IOPS. Scaleway's CSI volumes carry no tags.
SC_APPLIED=false
for i in 1 2 3; do
  if kubectl apply -f - << SCEOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: scaleway-block-vibecarbon
provisioner: csi.scaleway.com
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
SCEOF
  then
    SC_APPLIED=true
    break
  fi
  echo "StorageClass apply attempt $i failed, retrying in 10s..."
  sleep 10
done
if [ "$SC_APPLIED" != "true" ]; then
  echo "FATAL: could not apply the scaleway-block-vibecarbon StorageClass after 3 attempts" >&2
  exit 1
fi

echo "k3s master installation complete!"

# Final marker: vibecarbon's deployK3s waiter polls for /tmp/k3s-ready
# before fetching kubeconfig + applying app manifests.
_m e
touch /tmp/k3s-ready
