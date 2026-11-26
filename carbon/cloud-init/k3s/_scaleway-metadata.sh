# Scaleway metadata (one JSON document) and the Private Network NIC, found by
# its MAC prefix 02:00:00, never by name: the name can change across reboots.
# Pulumi attaches the NIC after power-on, so the first call waits for it.
scw_private_iface() {
  local name
  for _ in $(seq 1 "$1"); do
    name=$(ip -o link show | awk '{ for (f = 1; f < NF; f++) if ($f == "link/ether" && index($(f + 1), "02:00:00:") == 1) { n = $2; sub(/:$/, "", n); sub(/@.*/, "", n); print n } }')
    if [ "$(printf '%s\n' "$name" | grep -c .)" = 1 ] && ip -o -4 addr show dev "$name" | grep -q ' inet '; then
      echo "$name"; return 0
    fi
    sleep 2
  done
  return 1
}
SMETA=""
for _ in $(seq 1 15); do
  SMETA=$(curl -sf --max-time 5 'http://169.254.42.42/conf?format=json') && [ -n "$SMETA" ] && break
  sleep 2
done
read -r PUBLIC_IP NODE_ID NODE_ZONE NODE_NAME <<SMETAEOF
$(printf '%s' "$SMETA" | python3 -I -c '
import json, sys
try:
    m = json.load(sys.stdin)
except ValueError:
    m = {}
v4 = [i.get("address") for i in m.get("public_ips_v4") or [] if i.get("address")]
pub = v4[0] if v4 else (m.get("public_ip") or {}).get("address")
print(pub or "-", m.get("id") or "-", (m.get("location") or {}).get("zone_id") or "-", m.get("hostname") or "-")
')
SMETAEOF
[ "$PUBLIC_IP" != "-" ] && [ -n "$PUBLIC_IP" ] || { echo "FATAL: no public address in Scaleway metadata" >&2; exit 1; }
[ "$NODE_ID" != "-" ] || { echo "FATAL: no server id in Scaleway metadata" >&2; exit 1; }
[ "$NODE_ZONE" != "-" ] || { echo "FATAL: no zone in Scaleway metadata" >&2; exit 1; }
PRIVATE_IFACE=$(scw_private_iface 90) || { echo "FATAL: no single Private Network interface (MAC 02:00:00:...) with an address after 180 s; is the server attached to the cluster's Private Network?" >&2; exit 1; }
PRIVATE_IP=$(ip -o -4 addr show dev "$PRIVATE_IFACE" | awk '{ split($4, a, "/"); print a[1]; exit }')
mkdir -p /etc/rancher/k3s/config.yaml.d /usr/local/sbin "/etc/systemd/system/$K3S_UNIT.service.d"
{ echo '#!/bin/bash'; declare -f scw_private_iface
  echo 'n=$(scw_private_iface 30) || { echo "FATAL: no Private Network interface" >&2; exit 1; }'
  echo 'printf "flannel-iface: %s\n" "$n" > /etc/rancher/k3s/config.yaml.d/50-flannel-iface.yaml'
} > /usr/local/sbin/vc-flannel-iface
chmod 755 /usr/local/sbin/vc-flannel-iface
printf '[Service]\nExecStartPre=/usr/local/sbin/vc-flannel-iface\n' > "/etc/systemd/system/$K3S_UNIT.service.d/10-flannel-iface.conf"
/usr/local/sbin/vc-flannel-iface
