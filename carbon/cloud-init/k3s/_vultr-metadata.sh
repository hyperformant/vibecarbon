# Vultr instance metadata: one JSON document. Interfaces are matched by
# network-type, never by position or kernel name.
VMETA=""
for _ in $(seq 1 15); do
  VMETA=$(curl -sf --max-time 5 http://169.254.169.254/v1.json) && [ -n "$VMETA" ] && break
  sleep 2
done
read -r PUBLIC_IP PRIVATE_IP NODE_ID NODE_NAME <<VMETAEOF
$(printf '%s' "$VMETA" | python3 -I -c '
import json, sys
try:
    m = json.load(sys.stdin)
except ValueError:
    m = {}
def addr(kind):
    for i in m.get("interfaces") or []:
        if i.get("network-type") == kind and (i.get("ipv4") or {}).get("address"):
            return i["ipv4"]["address"]
    return "-"
print(addr("public"), addr("private"), m.get("instance-v2-id") or "-", m.get("hostname") or "-")
')
VMETAEOF
[ "$PUBLIC_IP" != "-" ] && [ -n "$PUBLIC_IP" ] || { echo "FATAL: no public address in Vultr metadata" >&2; exit 1; }
[ "$PRIVATE_IP" != "-" ] || { echo "FATAL: no private (VPC) address in Vultr metadata; is the instance attached to the cluster VPC?" >&2; exit 1; }
[ "$NODE_ID" != "-" ] || { echo "FATAL: no instance-v2-id in Vultr metadata" >&2; exit 1; }
PRIVATE_IFACE=""
for _ in $(seq 1 15); do
  PRIVATE_IFACE=$(ip -o -4 addr show | awk -v ip="$PRIVATE_IP" '{ split($4, a, "/"); if (a[1] == ip) { print $2; exit } }')
  [ -n "$PRIVATE_IFACE" ] && break
  sleep 2
done
[ -n "$PRIVATE_IFACE" ] || { echo "FATAL: no interface holds the VPC address $PRIVATE_IP" >&2; exit 1; }
