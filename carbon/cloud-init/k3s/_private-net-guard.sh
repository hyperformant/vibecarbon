# ===========================================================================
# Private-NIC address guard - SHARED SNIPPET, spliced into master-init.sh /
# supabase-init.sh / worker-init.sh by the `# @include` directive that
# loadCloudInit() resolves (src/lib/iac/cloud-init.js). Requires
# PRIVATE_IFACE + PRIVATE_IP, so it must sit AFTER the private-NIC wait loop.
#
# WHY (RCA 2026-08-05, 4-day-old k8s-ha rig): two of three nodes went NotReady
# with node.kubernetes.io/unreachable. uptime 4d21h, never rebooted, k3s-agent
# still ACTIVE - but enp7s0 had NO IPv4 address. Its DHCP lease was lost
# mid-life and never re-acquired, severing the 10.0.1.x path to the master;
# kubelet's apiserver tunnel then died with TLS-handshake timeouts. The dhcpcd
# self-heal in the wait loop above only runs during cloud-init - it guards
# BOOT. Nothing guarded day 4, and the exposure grows with uptime. Hetzner's
# Ubuntu images leave the private NIC out of cloud-init's network-config (that
# covers the public NIC only) and let `hc-utils` auto-start a DHCP client for
# it, so the address is lease-derived for the node's whole life.
#
# DESIGN - DHCP stays the acquisition path, unchanged, so this adds nothing to
# the happy path and its worst case is exactly today's behaviour. A watchdog
# re-acquires on loss and, only if DHCP will not answer, pins the address
# statically from the Hetzner metadata service. Metadata rather than a
# render-time constant because it is the only source covering every node
# class: cluster-autoscaler workers are created with `networks: [networkId]`
# and no `ip` (src/autoscaler/groups.js), so Hetzner picks their address at
# create time and no constant exists for them.
#
# systemd loop + `ip addr add` rather than a netplan drop-in: Hetzner's docs
# require uninstalling/deactivating hc-utils before hand-writing static config
# (its DHCP client otherwise fights it), and a netplan drop-in can clobber
# cloud-init's own config - see master-init.sh's floating-ip.service, which
# chose this same mechanism for the same reason.
# ===========================================================================

# Record the known-good configuration the guard restores. Gateway/network come
# from the routes DHCP just installed, so the fallback reproduces a
# configuration observed working on THIS node rather than one we invented.
mkdir -p /etc/vibecarbon
PN_INSTALL_MAC=$(cat /sys/class/net/"$PRIVATE_IFACE"/address 2>/dev/null || echo "")
PN_INSTALL_MTU=$(cat /sys/class/net/"$PRIVATE_IFACE"/mtu 2>/dev/null || echo "")
PN_INSTALL_GW=$(ip -4 route show dev "$PRIVATE_IFACE" 2>/dev/null | awk '/ via / {print $3; exit}' || true)
PN_INSTALL_NET=$(ip -4 route show dev "$PRIVATE_IFACE" 2>/dev/null | awk '/ via / {print $1; exit}' || true)
PN_INSTALL_META=$(curl -sf --max-time 5 http://169.254.169.254/hetzner/v1/metadata/private-networks 2>/dev/null || true)
# The `|| true` on each pipeline is load-bearing: the enclosing role script
# runs under `set -euo pipefail`, where `head -1` closing the pipe early can
# SIGPIPE sed and take the whole cloud-init down. A best-effort guard install
# must never be able to fail a deploy.
if [ -z "$PN_INSTALL_GW" ]; then
  PN_INSTALL_GW=$(printf '%s\n' "$PN_INSTALL_META" | sed -n 's/^[- ]*gateway:[ ]*\([^ ]*\).*/\1/p' | head -1 || true)
fi
if [ -z "$PN_INSTALL_NET" ]; then
  PN_INSTALL_NET=$(printf '%s\n' "$PN_INSTALL_META" | sed -n 's/^[- ]*network:[ ]*\([^ ]*\).*/\1/p' | head -1 || true)
fi
# Last resort, only reached if the live routing table AND metadata both came
# back empty: Hetzner's defaults for our networks (ip_range 10.0.0.0/8,
# gateway = its first address). 1450 is the Hetzner private-network MTU -
# DHCP delivers it via option 26, a hand-added address does not, and a silent
# 1500 blackholes large frames through flannel.
if [ -z "$PN_INSTALL_NET" ]; then PN_INSTALL_NET=10.0.0.0/8; fi
if [ -z "$PN_INSTALL_GW" ]; then PN_INSTALL_GW=10.0.0.1; fi
if [ -z "$PN_INSTALL_MTU" ]; then PN_INSTALL_MTU=1450; fi

cat > /etc/vibecarbon/private-net.env << PNCONFEOF
PN_IFACE=$PRIVATE_IFACE
PN_IP=$PRIVATE_IP
PN_MAC=$PN_INSTALL_MAC
PN_MTU=$PN_INSTALL_MTU
PN_GATEWAY=$PN_INSTALL_GW
PN_NETWORK=$PN_INSTALL_NET
PNCONFEOF

cat > /usr/local/sbin/vibecarbon-private-net-guard << 'PNGUARDEOF'
#!/bin/bash
# vibecarbon private-network address guard - see the RCA and design in
# carbon/cloud-init/k3s/_private-net-guard.sh. `set -e` is deliberately
# absent: a watchdog that exits on one failed `ip` or `curl` stops guarding,
# and surviving a broken network is the entire point.
set -uo pipefail

CONF=/etc/vibecarbon/private-net.env
LOGFILE=/var/log/vibecarbon-private-net.log
METADATA_URL=http://169.254.169.254/hetzner/v1/metadata/private-networks
# Kubernetes marks a node NotReady after node-monitor-grace-period (40s), so
# detect-and-repair has to fit inside that to keep a lease loss invisible.
POLL_SECONDS=10
DHCP_WAIT_SECONDS=15

PN_IFACE=""
PN_IP=""
PN_MAC=""
PN_MTU=1450
PN_GATEWAY=""
PN_NETWORK=""

log() {
  logger -t vibecarbon-private-net -- "$1" 2>/dev/null || true
  printf '%s %s\n' "$(date -Is)" "$1" >> "$LOGFILE" 2>/dev/null || true
}

# Metadata block for MAC $2 out of blob $1, falling back to the first block.
# Hetzner serves YAML; awk/sed rather than a YAML dependency keeps the
# recovery path working when the network is already down.
meta_block() {
  printf '%s\n' "$1" | awk -v want="$2" '
    /^-/ { n += 1; block[n] = "" }
    n > 0 {
      block[n] = block[n] $0 "\n"
      line = tolower($0); gsub(/[ \t]+/, " ", line); sub(/^ /, "", line); sub(/^- /, "", line)
      if (want != "" && line == "mac_address: " want) hit = n
    }
    END { if (hit == 0) hit = 1; printf "%s", block[hit] }
  '
}

# Field $2 out of block $1, anchored on the exact key so `network:` does not
# also match `network_id:`/`network_name:`.
meta_value() {
  printf '%s\n' "$1" | sed -n "s/^[- ]*$2:[ ]*\([^ ]*\).*/\1/p" | head -1
}

# RFC1918 only. REJECTS 169.254.x IPv4LL, which is what a DHCP client
# self-assigns when it cannot get a lease - accepting that as healthy would
# make the guard a no-op in precisely the failure it exists for.
is_private_ipv4() {
  printf '%s' "$1" | grep -qE '^(10\.[0-9]+|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\.[0-9]+\.[0-9]+$'
}

# Stored name first (stable for a node's life), then MAC, then the Hetzner
# private-NIC naming shape. Never matches the public interface.
resolve_iface() {
  if [ -n "$PN_IFACE" ] && [ -e /sys/class/net/"$PN_IFACE" ]; then
    printf '%s' "$PN_IFACE"
    return 0
  fi
  if [ -n "$PN_MAC" ]; then
    for d in /sys/class/net/*; do
      [ -r "$d/address" ] || continue
      if [ "$(cat "$d/address" 2>/dev/null)" = "$PN_MAC" ]; then
        basename "$d"
        return 0
      fi
    done
  fi
  ip -o link show 2>/dev/null | awk -F': ' '/^[0-9]+: en[a-z]+[0-9]+s[0-9]+/ {print $2; exit}'
}

current_ip() {
  ip -4 -o addr show dev "$1" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1
}

route_ok() {
  [ -n "$PN_NETWORK" ] || return 0
  ip -4 route show dev "$1" 2>/dev/null | grep -q "^$PN_NETWORK "
}

# A surviving address with a dropped route into the network range is the same
# outage wearing a different hat, and the check costs one `ip route show`.
# The address is a /32, so the gateway sits on no connected subnet and the
# route needs `onlink` - Hetzner's own documented static configuration.
ensure_route() {
  [ -n "$PN_NETWORK" ] || return 0
  [ -n "$PN_GATEWAY" ] || return 0
  route_ok "$1" && return 0
  ip route replace "$PN_NETWORK" via "$PN_GATEWAY" dev "$1" onlink 2>/dev/null || true
  route_ok "$1" && log "restored route $PN_NETWORK via $PN_GATEWAY dev $1"
  return 0
}

# Re-read the authoritative address/gateway/network for this NIC. Only called
# on the unhealthy path, so a healthy node never talks to metadata at all.
refresh_expectation() {
  MAC=$(cat /sys/class/net/"$1"/address 2>/dev/null || echo "")
  if [ -n "$MAC" ]; then PN_MAC="$MAC"; fi
  BLOB=$(curl -sf --max-time 5 "$METADATA_URL" 2>/dev/null || true)
  if [ -z "$BLOB" ]; then return 0; fi
  BLOCK=$(meta_block "$BLOB" "$PN_MAC")
  M_IP=$(meta_value "$BLOCK" ip)
  M_GW=$(meta_value "$BLOCK" gateway)
  M_NET=$(meta_value "$BLOCK" network)
  if is_private_ipv4 "$M_IP"; then PN_IP="$M_IP"; fi
  if [ -n "$M_GW" ]; then PN_GATEWAY="$M_GW"; fi
  if [ -n "$M_NET" ]; then PN_NETWORK="$M_NET"; fi
  return 0
}

repair() {
  IFACE="$1"
  log "private NIC $IFACE has no usable address/route - repairing"
  ip link set dev "$IFACE" up 2>/dev/null || true

  # 1. DHCP first: it is the path hc-utils manages, and the one that stays
  #    correct if Hetzner ever re-assigns the address. `-n` rebinds a RUNNING
  #    dhcpcd (the incident's shape: daemon alive, lease gone) and starts one
  #    if none is running; `-1` is the one-shot fallback for a daemon that is
  #    wedged rather than merely idle.
  if command -v dhcpcd >/dev/null 2>&1; then
    timeout 20 dhcpcd -n "$IFACE" >/dev/null 2>&1 || true
    timeout 20 dhcpcd -1 "$IFACE" >/dev/null 2>&1 || true
  elif command -v networkctl >/dev/null 2>&1; then
    networkctl renew "$IFACE" >/dev/null 2>&1 || true
  fi
  WAITED=0
  while [ "$WAITED" -lt "$DHCP_WAIT_SECONDS" ]; do
    CUR=$(current_ip "$IFACE")
    if is_private_ipv4 "$CUR"; then
      log "private NIC $IFACE recovered via DHCP: $CUR"
      ensure_route "$IFACE"
      return 0
    fi
    sleep 3
    WAITED=$((WAITED + 3))
  done

  # 2. DHCP would not answer. Pin the address statically.
  refresh_expectation "$IFACE"
  if ! is_private_ipv4 "$PN_IP"; then
    log "no expected private IP known for $IFACE (metadata unreachable, nothing recorded) - retrying"
    return 1
  fi
  ip addr add "$PN_IP"/32 dev "$IFACE" 2>/dev/null || true
  ip link set dev "$IFACE" mtu "$PN_MTU" 2>/dev/null || true
  ensure_route "$IFACE"
  CUR=$(current_ip "$IFACE")
  if is_private_ipv4 "$CUR"; then
    log "private NIC $IFACE pinned statically: $PN_IP/32 mtu $PN_MTU via $PN_GATEWAY"
    return 0
  fi
  log "private NIC $IFACE still unaddressed after static pin - retrying in $POLL_SECONDS s"
  return 1
}

if [ -r "$CONF" ]; then
  # shellcheck source=/dev/null
  . "$CONF"
fi
log "guard started (iface=$PN_IFACE expect=$PN_IP net=$PN_NETWORK gw=$PN_GATEWAY mtu=$PN_MTU)"

# k3s/kubelet are NOT restarted after a repair: remotedialer and the kubelet's
# apiserver client both reconnect on their own once the path is back, and
# bouncing the agent would evict pods for a fault that just healed.
while true; do
  IFACE=$(resolve_iface)
  if [ -z "$IFACE" ]; then
    log "no private NIC present on this host - retrying"
    sleep "$POLL_SECONDS"
    continue
  fi
  CUR=$(current_ip "$IFACE")
  if is_private_ipv4 "$CUR" && route_ok "$IFACE"; then
    sleep "$POLL_SECONDS"
    continue
  fi
  repair "$IFACE" || true
  sleep "$POLL_SECONDS"
done
PNGUARDEOF
chmod 0755 /usr/local/sbin/vibecarbon-private-net-guard

cat > /etc/systemd/system/vibecarbon-private-net.service << 'PNUNITEOF'
[Unit]
Description=vibecarbon private-network address guard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/sbin/vibecarbon-private-net-guard
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
PNUNITEOF

systemctl daemon-reload || true
systemctl enable vibecarbon-private-net.service || true
systemctl restart vibecarbon-private-net.service || true
echo "Private-NIC address guard installed (iface $PRIVATE_IFACE, ip $PRIVATE_IP)"
