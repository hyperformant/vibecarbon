# Container signals - SHARED SNIPPET (loadCloudInit's `# @include`), before
# the k3s install. With Ubuntu 26.04's restrict_unprivileged_unconfined=1, a
# newer kernel makes k3s's runc 1.4 start containers as
# cri-containerd.apparmor.d//&unconfined, and containerd's profile then denies
# every signal inside a container: postgres never starts. Off restores the
# plain label; the userns restriction stays on. Remove once k3s keeps the
# plain label (containerd/containerd#14485, k3s-io/k3s#13625). A key that
# exists but cannot be set fails the boot. Evidence:
# tests/unit/deploy/container-signals-census.test.ts.
printf 'kernel.apparmor_restrict_unprivileged_unconfined = 0\n' > /etc/sysctl.d/99-vibecarbon-container-signals.conf
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_unconfined ]; then
  sysctl -q -w kernel.apparmor_restrict_unprivileged_unconfined=0
fi
