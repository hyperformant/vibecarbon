# Stable IPv6 flow label - SHARED SNIPPET (loadCloudInit's `# @include`),
# before the k3s install and every pull. Linux gives a socket a new IPv6 flow
# label on duplicate data or a retransmit timeout; the path to GitHub's
# package CDN picks the server by flow label, so a server that never had the
# connection resets the pull. Sockets read this when they open. Evidence:
# tests/unit/deploy/stable-flowlabel-census.test.ts.
printf 'net.core.txrehash = 0\n' > /etc/sysctl.d/99-vibecarbon-stable-flowlabel.conf
if [ -e /proc/sys/net/core/txrehash ]; then
  sysctl -q -w net.core.txrehash=0
fi
