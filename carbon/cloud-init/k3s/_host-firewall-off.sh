# Host firewall off. Vultr's Ubuntu image boots with UFW active, which drops
# the cluster's own traffic (the API on 6443, the kubelet on 10250, flannel
# on 8472/udp) and ingress. The cloud firewall group is the node's one
# network filter, as on the other providers. `ufw disable` also writes
# ENABLED=no to /etc/ufw/ufw.conf, so it stays off after a reboot.
if command -v ufw >/dev/null 2>&1; then
  ufw --force disable >/dev/null || { echo "FATAL: could not disable UFW; left on, it drops the cluster's own traffic (6443, 10250, 8472/udp) and ingress" >&2; exit 1; }
  echo "UFW disabled: the cloud firewall group filters this node"
fi
