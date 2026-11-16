# Host reporter - SHARED SNIPPET. Installs /usr/local/lib/vibecarbon/host-reporter.sh
# and the systemd units that run it, so every server says whether it needs a
# restart (Ubuntu's /var/run/reboot-required). k8s nodes publish the state as
# the node annotation vibecarbon.dev/host-state; compose servers write
# /run/vibecarbon-host/state.json for the app's bind mount. POSIX sh, busybox
# safe, no brace-style placeholders (renderScript substitutes those).
# Only root installs: the guard is an if-block, not an exit, so it is safe both
# inside withHostReporter's subshell and spliced into a cloud-init script.
if [ "$(id -u)" = 0 ]; then
mkdir -p /usr/local/lib/vibecarbon
cat > /usr/local/lib/vibecarbon/host-reporter.sh <<'VC_HOST_REPORTER_EOF'
#!/bin/sh
PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH
# Prints or publishes this host's restart state. See carbon/cloud-init/k3s/_host-reporter.sh.
FLAG=/var/run/reboot-required
PKGS=/var/run/reboot-required.pkgs
KUBELET_KUBECONFIG=/var/lib/rancher/k3s/agent/kubelet.kubeconfig
HOST_DIR=/run/vibecarbon-host

if [ -e "$FLAG" ]; then
  required=true
  since="\"$(date -u -r "$FLAG" +%Y-%m-%dT%H:%M:%SZ)\""
else
  required=false
  since=null
fi
list=""
if [ -f "$PKGS" ]; then
  list=$(grep -v '^$' "$PKGS" | sort -u | head -n 20 | sed 's/.*/"&"/' | tr '\n' ',' | sed 's/,$//')
fi
json=$(printf '{"v":1,"host":"%s","rebootRequired":%s,"since":%s,"packages":[%s]}' "$(hostname)" "$required" "$since" "$list")

if [ "$1" = "--print" ]; then
  printf '%s\n' "$json"
  exit 0
fi

if command -v k3s >/dev/null 2>&1; then
  # A k3s node: a missing kubeconfig means the agent has not written it yet, so
  # fail and let the unit's Restart=on-failure retry instead of writing a
  # compose-style file.
  [ -e "$KUBELET_KUBECONFIG" ] || exit 1
  name=$(kubectl --kubeconfig "$KUBELET_KUBECONFIG" --request-timeout=30s auth whoami -o jsonpath='{.status.userInfo.username}') || exit 1
  name=${name#system:node:}
  [ -n "$name" ] || exit 1
  kubectl --kubeconfig "$KUBELET_KUBECONFIG" --request-timeout=30s annotate --overwrite node "$name" "vibecarbon.dev/host-state=$json" || exit 1
  exit 0
fi

mkdir -p "$HOST_DIR"
chmod 755 "$HOST_DIR"
printf '%s\n' "$json" > "$HOST_DIR/state.json.tmp" || exit 1
chmod 644 "$HOST_DIR/state.json.tmp"
mv "$HOST_DIR/state.json.tmp" "$HOST_DIR/state.json"
VC_HOST_REPORTER_EOF
chmod 755 /usr/local/lib/vibecarbon/host-reporter.sh
cat > /etc/systemd/system/vibecarbon-host-reporter.service <<'VC_HOST_REPORTER_UNIT_EOF'
[Unit]
Description=Report whether this host needs a restart

[Service]
Type=oneshot
ExecStart=/usr/local/lib/vibecarbon/host-reporter.sh
TimeoutStartSec=120
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
VC_HOST_REPORTER_UNIT_EOF
cat > /etc/systemd/system/vibecarbon-host-reporter.path <<'VC_HOST_REPORTER_PATH_EOF'
[Unit]
Description=Watch for a pending restart

[Path]
PathChanged=/var/run/reboot-required
PathChanged=/var/run/reboot-required.pkgs

[Install]
WantedBy=multi-user.target
VC_HOST_REPORTER_PATH_EOF
systemctl daemon-reload
systemctl enable vibecarbon-host-reporter.service vibecarbon-host-reporter.path
systemctl restart vibecarbon-host-reporter.path
systemctl start --no-block vibecarbon-host-reporter.service
fi
